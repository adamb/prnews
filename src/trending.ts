import {quarantined, unavailableMessage} from './quarantine';
import { safeUrl, type Item } from './parse';
import type { Translation } from './i18n';

/**
 * Click → article redirect endpoint plus the privacy-safe aggregates it feeds:
 * per-second buckets per article only (no IP, cookies, or any other per-user data),
 * a rolling-24h top list, and bucket cleanup. Tables come from
 * migrations/0003_search_clicks.sql; the durable cumulative tables come from
 * migrations/0008_click_totals.sql.
 *
 * Redirect safety: the destination is always taken from a DB-known article row
 * (never from request user input); unknown ids/urls can only produce a 404.
 * DB-known means the current `articles` row, the stable `story_ids` permalink
 * row, or the permanent `archive_revisions` copy — all three store
 * ingestion-normalized original URLs, never request text.
 */
export interface ClickEnv { DB: D1Database }

export const CLICK_PATH = '/click';
export const CLICK_BUCKET_MS = 1000;
export const CLICK_WINDOW_MS = 86400000;
export const CLICK_TOP = 5;
/** Cleanup retains enough history to cover the rolling window plus clock skew. */
const CLICK_RETAIN_MS = 48 * 3600000;
/** Hall of fame / popular list size. Hall candidates are index-bounded. */
export const HALL_TOP = 10;
export const POPULAR_TOP = 10;

/**
 * Handles `GET/HEAD {url}/click?url=<article url>` and `/click?id=<story id>`.
 * Returns `undefined` for other paths so route order stays composable.
 * GET records one click; HEAD redirects without counting. A counting failure
 * never blocks the redirect for a DB-known destination.
 */
export async function clickRoute(request: Request, env: ClickEnv, now: number = Date.now()): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== CLICK_PATH) return undefined;
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  const id = url.searchParams.get('id');
  const key = id ? (digits(id) ? id : '') : safeParam(url.searchParams.get('url'), 2048);
  const destination = await lookupDestination(env, key);
  if (!destination) return new Response('Not found', { status: 404, headers });
  if (quarantined(destination)) return new Response(unavailableMessage(url.searchParams.get('lang') ?? 'es'), {status: 403, headers});
  if (request.method === 'GET') {
    try {
      await recordClick(env, destination, now);
      if (Math.random() < 0.05) await cleanupClicks(env, now); // opportunistic; also callable from cron
    } catch { /* redirecting known destinations must not depend on the counter */ }
  }
  return new Response(null, { status: 302, headers: { ...headers, Location: destination } });
}

const digits = (s: string) => /^[1-9]\d{0,8}$/.test(s);
const safeParam = (s: string | null, max: number) => s && s.length <= max ? s : '';

async function lookupByUrl(env: ClickEnv, key: string): Promise<string> {
  const direct = await env.DB.prepare('SELECT url FROM articles WHERE url=?').bind(key).first<{ url: string }>();
  if (direct) return safeUrl(direct.url);
  // story_ids is keyed by the same normalized article URL the archive pages use.
  const stored = await env.DB.prepare('SELECT url FROM story_ids WHERE url=?').bind(key).first<{ url: string }>();
  if (stored) return safeUrl(stored.url);
  // Manual-import/seed edge: a revised copy exists even where no permalink row does.
  const revision = await env.DB.prepare('SELECT url FROM archive_revisions WHERE url=?').bind(key).first<{ url: string }>();
  return revision ? safeUrl(revision.url) : '';
}

/** Narrow compatibility key for pre-fix news.pr links that carried a trailing slash. */
function legacyNewsprFallbackKey(key: string): string {
  if (!key.startsWith('https://news.pr/')) return '';
  try {
    const u = new URL(key);
    if (u.protocol !== 'https:' || u.hostname !== 'news.pr' || u.port !== '' || u.username || u.password) return '';
    if (u.pathname === '/' || !u.pathname.endsWith('/')) return '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.pathname === '/' ? '' : u.href;
  } catch { return ''; }
}

/**
 * Resolves the redirect target strictly from the DB. `url` must equal an
 * ingestion-normalized key that is already stored, or `id` a story_ids row.
 * Fallback order keeps old destinations redirectable — and therefore
 * countable — after the 14-day `articles` row rotates away: first the live
 * article, then the stable story permalink, then the latest permanent archive
 * revision. All three return the stored original URL that the archive/story
 * pages itself links to; safeUrl still guards the final value.
 */
export async function lookupDestination(env: ClickEnv, key: string): Promise<string> {
  if (!key) return '';
  try {
    if (digits(key)) {
      const row = await env.DB.prepare('SELECT s.url FROM story_ids s WHERE s.id=?').bind(Number(key)).first<{ url: string }>();
      return row ? safeUrl(row.url) : '';
    }
    const exact = await lookupByUrl(env, key);
    if (exact) return exact;
    const fallback = legacyNewsprFallbackKey(key);
    return fallback ? await lookupByUrl(env, fallback) : '';
  } catch { return ''; }
}

/**
 * Records one click atomically: second bucket (rolling window) + lifetime
 * per-article total + global total, all in one D1 batch (D1 batches are
 * transactional, so concurrent readers never observe a torn increment and the
 * UPSERTs serialize). Safe to call directly from cron/tests.
 */
export async function recordClick(env: ClickEnv, url: string, now: number = Date.now()): Promise<void> {
  if (!url) return;
  const bucket = Math.floor(now / CLICK_BUCKET_MS);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO article_click_buckets(url,bucket,clicks) VALUES(?,?,1) ON CONFLICT(url,bucket) DO UPDATE SET clicks=clicks+1').bind(url, bucket),
    env.DB.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,1,?) ON CONFLICT(url) DO UPDATE SET clicks=clicks+1,updated_at=excluded.updated_at').bind(url, bucket),
    env.DB.prepare('INSERT INTO site_click_totals(id,clicks,updated_at) VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET clicks=clicks+1,updated_at=excluded.updated_at').bind(bucket),
  ]);
}

/** Lifetime global total. Reads the single counter row; `startedAt` is when durable counting began. */
export async function totalClicks(env: ClickEnv): Promise<{ clicks: number; startedAt: number }> {
  const row = await env.DB.prepare('SELECT clicks,started_at FROM site_click_totals WHERE id=1').first<{ clicks: number; started_at: number }>();
  if (!row) return { clicks: 0, startedAt: 0 }; // 0008 pending; page labels must say counting is starting
  return { clicks: row.clicks, startedAt: row.started_at };
}

/** Lifetime per-article totals, most clicked first. Bounded: LIMIT via the rank index. Missing metadata skips the row. */
export async function cumulativeTop(env: ClickEnv, limit: number = POPULAR_TOP): Promise<{ url: string; clicks: number; item: Item; translation: Translation | null }[]> {
  const cap = Math.max(1, Math.min(POPULAR_TOP, limit));
  const rows = await env.DB.prepare(`SELECT t.url,t.clicks,
   CASE WHEN a.url IS NOT NULL THEN a.payload ELSE r.payload END AS payload,
   CASE WHEN a.url IS NOT NULL THEN a.translation ELSE r.translation END AS translation
   FROM article_click_totals t
   LEFT JOIN articles a ON a.url=t.url
   LEFT JOIN archive_revisions r ON r.url=t.url AND r.id=(SELECT MAX(id) FROM archive_revisions w WHERE w.url=t.url)
   WHERE t.clicks>0 ORDER BY t.clicks DESC,t.url ASC LIMIT ?`).bind(cap).all<{ url: string; clicks: number; payload: string; translation: string | null }>();
  return rows.results.flatMap(r => {
    try {
      const item = JSON.parse(r.payload) as Item;
      if (!item.url || !item.title || item.url !== r.url) return [];
      return [{ url: r.url, clicks: r.clicks, item, translation: r.translation ? safeParsed(r.translation) : null }];
    } catch { return []; }
  });
}

/**
 * Hall of fame: archived articles (their `articles` row is gone, i.e. published
 * more than 14 days ago) that still hold recorded lifetime clicks, most clicked
 * first. Empty until an article both ages out and was clicked since durable
 * counting began — there is no retroactive entry, no fabricated popularity, and
 * never a fabricated click count. Bounded: index-ordered LIMIT with an
 * anti-join lookup per candidate; no full archive scans.
 */
export interface HallEntry { url: string; clicks: number; item: Item; translation: Translation | null; capturedAt: number }
export async function hallOfFame(env: ClickEnv, limit: number = HALL_TOP): Promise<HallEntry[]> {
  const cap = Math.max(1, Math.min(HALL_TOP, limit));
  const rows = await env.DB.prepare(`SELECT t.url,t.clicks,r.payload,r.translation,r.captured_at
   FROM article_click_totals t
   JOIN archive_revisions r ON r.url=t.url AND r.id=(SELECT MAX(id) FROM archive_revisions w WHERE w.url=t.url)
   WHERE t.clicks>0 AND NOT EXISTS(SELECT 1 FROM articles a WHERE a.url=t.url AND a.published_at>=?)
   ORDER BY t.clicks DESC,t.url ASC LIMIT ?`).bind(Date.now()-14*86400000,cap).all<{ url: string; clicks: number; payload: string; translation: string | null; captured_at: number }>();
  return rows.results.flatMap(r => {
    try {
      const item = JSON.parse(r.payload) as Item;
      if (!item.url || !item.title || item.url !== r.url) return [];
      return [{ url: r.url, clicks: r.clicks, item, translation: r.translation ? safeParsed(r.translation) : null, capturedAt: r.captured_at }];
    } catch { return []; }
  });
}

const safeParsed = (s: string): Translation | null => { try { return JSON.parse(s) as Translation; } catch { return null; } };

/** Rolling-24h top articles by click count (max CLICK_TOP, ties broken by url). */
export async function topClicked(env: ClickEnv, now: number = Date.now(), limit: number = CLICK_TOP): Promise<{ item: Item; clicks: number }[]> {
  const rows=await env.DB.prepare(`SELECT a.payload,SUM(c.clicks) AS clicks FROM article_click_buckets c JOIN articles a ON a.url=c.url WHERE c.bucket>=? AND c.bucket<=? AND a.published_at>=? GROUP BY c.url ORDER BY clicks DESC,c.url ASC LIMIT ?`).bind(Math.ceil((now-CLICK_WINDOW_MS)/CLICK_BUCKET_MS),Math.floor(now/CLICK_BUCKET_MS),now-14*86400000,Math.max(1,Math.min(5,limit))).all<{payload:string;clicks:number}>();
  return rows.results.map(r=>({item:JSON.parse(r.payload) as Item,clicks:r.clicks}));
}

/** Deletes buckets older than the retention margin. Totals tables are never touched: lifetime counts survive expiry by design. */
export async function cleanupClicks(env: ClickEnv, now: number = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM article_click_buckets WHERE bucket<?').bind(Math.floor((now - CLICK_RETAIN_MS) / CLICK_BUCKET_MS)).run();
}
