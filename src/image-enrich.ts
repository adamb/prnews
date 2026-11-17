import {imageUrl} from './archive';
import type {Env} from './ingest';
import * as he from 'he';

/**
 * Recovers a real publisher image for feed items that ship without one, at ingestion
 * time only (scheduled cron, never page views, never per render): the queue holds one
 * row per article URL, the scheduler fetches a bounded number of the publisher's public
 * article pages per run and reads their own og:image/twitter:image metadata, and the
 * found URL is stored on the article payload exactly like a feed-provided image — which
 * also queues it for the permanent R2 copy through the existing triggers. There is no
 * AI, no full-article copy, no paywall handling: metadata alone, or the honest
 * newspaper-illustration fallback when the publisher offers no usable image.
 */

/** Read the smallest usable slice of the page: og:image lives in <head>. */
const PAGE_READ_LIMIT = 512 * 1024;
const PAGE_TIMEOUT = 12000;
/** Bounded work: at most 12 pages and 2 concurrent fetches per 15-minute refresh. */
const PER_RUN = 12;
const CONCURRENCY = 2;
/** A publisher without an image exhausts its attempts and is then left to fall back. */
const MAX_ATTEMPTS = 4;
const nextDelay = (attempts: number) => Math.min(24 * 3600000, 3600000 * 2 ** attempts);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/** Ordered og:image/twitter:image metadata URLs from the page's <meta> tags.
 * Entity decoding must handle double-encoded publishers (raw `&amp;#38;` seen on
 * elnuevodia.com resizer URLs): decode until the value stops changing, bounded. */
export function extractImageCandidates(html: string): string[] {
 const candidates: string[] = [];
 for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
  const key = (/property\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)?.[2] ?? /name\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)?.[2] ?? '').toLowerCase();
  if (!/^(og:image(:secure_url)?|twitter:image(:src)?)$/.test(key)) continue;
  const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)?.[2];
  if (!content) continue;
  let value = he.decode(content).trim();
  for (let pass = 0; pass < 2 && /&(?:amp|#38|lt|gt|quot|apos);/i.test(value); pass++) value = he.decode(value).trim();
  if (value && !candidates.includes(value)) candidates.push(value);
 }
 return candidates;
}

/** Streams at most PAGE_READ_LIMIT bytes of the article page; redirects are followed. */
async function fetchPage(url: string): Promise<string> {
 const response = await fetch(url, {headers: {'User-Agent': 'news.dev.pr/1.0 (+https://news.dev.pr/about)'}, signal: AbortSignal.timeout(PAGE_TIMEOUT)});
 const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
 if (!response.ok || !HTML_TYPES.has(type)) {await response.body?.cancel(); throw new Error(`Article page unavailable or not HTML (${response.status}, ${type})`);}
 if (!response.body) throw new Error('Empty article response');
 const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
 for (; ;) {
  const {done, value} = await reader.read();
  if (done || !value) break;
  length += value.byteLength;
  chunks.push(value);
  if (length >= PAGE_READ_LIMIT) {await reader.cancel(); break;}
 }
 const total = chunks.reduce((n, c) => n + c.byteLength, 0);
 const bytes = new Uint8Array(total); let offset = 0;
 for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
 return new TextDecoder('utf-8', {fatal: false}).decode(bytes);
}

async function release(row: {url: string}, env: Env) {
 await env.DB.prepare('DELETE FROM image_enrich_queue WHERE url=?').bind(row.url).run();
}

async function fail(row: {url: string; attempts: number}, env: Env, now: number, message: string) {
 const attempts = row.attempts + 1;
 await env.DB.prepare('UPDATE image_enrich_queue SET attempts=?,next_attempt=?,error=? WHERE url=?')
  .bind(attempts, attempts >= MAX_ATTEMPTS ? now + 365 * 86400000 : now + nextDelay(attempts), message.slice(0, 300), row.url).run();
}

/** Processes the queue: enqueue recent image-less articles, then bounded page fetches. */
export async function enrichImages(env: Env, now: number = Date.now()) {
 const owner = crypto.randomUUID();
 const lock = await env.DB.prepare(`INSERT INTO jobs(id,lease_until,owner) VALUES('image-enrich',?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,owner=excluded.owner WHERE jobs.lease_until<?`).bind(now + 10 * 60000, owner, now).run();
 if (!lock.meta.changes) return {skipped: 'already running'};
 try {
  // One row per URL; rows already at the attempt cap are never re-queued, so a
  // publisher with no og:image converges to the honest fallback instead of churning.
  // Only https article URLs are ever queued — the same bound the page fetch enforces.
  const queued = await env.DB.prepare(`INSERT INTO image_enrich_queue(url)
   SELECT a.url FROM articles a
   WHERE a.published_at>=? AND COALESCE(json_extract(a.payload,'$.image'),'')=''
   AND a.url LIKE 'https://%'
   AND a.source NOT IN ('reddit_puertorico','nimb')
   AND NOT EXISTS (SELECT 1 FROM image_enrich_queue q WHERE q.url=a.url AND q.attempts>=?)
   ON CONFLICT(url) DO NOTHING`).bind(now - 14 * 86400000, MAX_ATTEMPTS).run();
  const rows = (await env.DB.prepare(`WITH ready AS (SELECT q.url,q.attempts,a.published_at, ROW_NUMBER() OVER (PARTITION BY a.source ORDER BY a.published_at DESC,q.url) AS source_rank FROM image_enrich_queue q JOIN articles a USING(url) WHERE q.next_attempt<=? AND q.attempts<? AND COALESCE(json_extract(a.payload,'$.image'),'')='') SELECT url,attempts FROM ready ORDER BY source_rank,published_at DESC,url LIMIT ?`).bind(now, MAX_ATTEMPTS, PER_RUN).all<{url: string; attempts: number}>()).results;
  let next = 0, enriched = 0, failed = 0;
  await Promise.all(Array.from({length: CONCURRENCY}, async() => {
   while (next < rows.length) {
    const row = rows[next++];
    try {
     const article = await env.DB.prepare("SELECT payload FROM articles WHERE url=?").bind(row.url).first<{payload: string}>();
     if (!article) {await release(row, env); continue;} // article rotated out of the 14-day window
     const item = JSON.parse(article.payload) as {image?: string};
     if (item.image) {await release(row, env); continue;} // feed delivered an image meanwhile
     const pageUrl = imageUrl(row.url); // https-only public hosts, same bounds as archive fetching
     const html = await fetchPage(pageUrl);
     let updated = 0;
     for (const raw of extractImageCandidates(html)) {
      // Resolve publisher metadata against the page (absolute, scheme-relative, or relative),
      // skip known non-image targets (SVG/video), and enforce the same public-https bounds
      // the archive copy enforces. The payload update is atomic: it fills the image only
      // while it is still missing, raises an archive revision, and queues the R2 copy.
      const candidate = (() => { try { const u = new URL(raw, pageUrl); return ['http:', 'https:'].includes(u.protocol) && !/\.(svg|gifv|mp4)$/.test(u.pathname) ? u.href : ''; } catch { return ''; } })();
      if (!candidate) continue;
      try {
       const store = await env.DB.prepare("UPDATE articles SET payload=json_set(payload,'$.image',?),updated_at=? WHERE url=? AND COALESCE(json_extract(payload,'$.image'),'')=''")
        .bind(imageUrl(candidate), now, row.url).run();
       if (store.meta.changes) {updated = 1; break;}
       break; // image is already present (or article rotated): nothing left to fill
      } catch {continue;}
     }
     if (updated) {enriched++; await release(row, env);}
     else {failed++; await fail(row, env, now, 'No usable og:image metadata from publisher');}
    } catch (error) {
     failed++;
     try {await fail(row, env, now, String(error instanceof Error ? error.message : error));}
     catch { /* queue row rotated away */ }
    }
   }
  }));
  const counts = await env.DB.prepare('SELECT COUNT(*) AS total, SUM(attempts>=?) AS exhausted FROM image_enrich_queue').bind(MAX_ATTEMPTS).first();
  return {queued: queued.meta.changes, processed: rows.length, enriched, failed, queue: counts};
 } finally {
  await env.DB.prepare("DELETE FROM jobs WHERE id='image-enrich' AND owner=?").bind(owner).run();
 }
}
