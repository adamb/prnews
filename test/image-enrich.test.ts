import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { enrichImages, extractImageCandidates } from '../src/image-enrich';
import { preserveObserved } from '../src/ingest';
import type { Env } from '../src/ingest';
import type { Item } from '../src/parse';

function database(): D1Database {
 const sqlite = new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('migrations/0001_live.sql', 'utf8'));
 sqlite.exec(readFileSync('migrations/0002_archive.sql', 'utf8'));
 sqlite.exec(readFileSync('migrations/0006_archive_queue_conflict.sql', 'utf8'));
 sqlite.exec(readFileSync('migrations/0010_image_enrich.sql', 'utf8'));
 function prepare(sql: string): any {
  let args: any[] = [];
  return { bind(...values: any[]) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } };
 }
 return { prepare, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const og = 'https://cdn.noticel.com/2026/11/12074606/25-09-29-SENADO-DE-PUERTO-RICO-CELEBRA-SESION-ORDINARIA-EN-EL-HEMICICLO-EJMM-0016-.jpg';
const item = (over: Partial<Item> = {}): Item => ({
 url: 'https://noticel.com/noticias/20261116/senado-aprueba-programa-conecta-60/',
 source: 'noticel', title: 'Senado aprueba programa Conecta 60+',
 summary: 'Una medida aprobada por el Senado propone crear el programa Conecta 60+ para prevenir el aislamiento.',
 image: '', time: Date.parse('2026-11-16T09:48:00Z'), observed: false, section: 'politica', reason: 'test', ...over,
});
const insert = async (DB: D1Database, base: Item, translation: unknown = null) =>
 DB.prepare('INSERT INTO articles(url,source,payload,translation,translation_attempt,first_seen,updated_at,published_at) VALUES(?,?,?,?,0,?,?,?)')
  .bind(base.url, base.source, JSON.stringify(base), translation === null ? null : JSON.stringify(translation), base.time, base.time, base.time).run();
const payloadOf = async (DB: D1Database, url: string) => JSON.parse((await DB.prepare('SELECT payload FROM articles WHERE url=?').bind(url).first<{ payload: string }>())!.payload) as Item;

it('extracts publisher og:image metadata in publisher attribute order, skipping size/dimension variants', () => {
 const html = readFileSync('test/fixtures/noticel_conecta.html', 'utf8');
 expect(extractImageCandidates(html)[0]).toBe(og);
 const twitter = `<html><head><meta property="og:image" content="https://cdn.example.com/og.jpg"><meta content="https://cdn.example.com/twitter.png" property="twitter:image"><meta property="og:image:width" content="3200"></head></html>`;
 expect(extractImageCandidates(twitter)).toEqual(['https://cdn.example.com/og.jpg', 'https://cdn.example.com/twitter.png']);
 expect(extractImageCandidates('<html><body><img src="/no-metas.png"></body></html>')).toEqual([]);
 // Double-encoded entities (observed on elnuevodia.com resizer og:image) decode fully.
 const doubled = '<meta property="og:image" content="https://www.elnuevodia.com/resizer/v2/KHWSTI6RDBAHLOG6JS2GHNITFU.png?auth=3c9&#38;smart=true&#38;width=887">';
 expect(extractImageCandidates(doubled)).toEqual(['https://www.elnuevodia.com/resizer/v2/KHWSTI6RDBAHLOG6JS2GHNITFU.png?auth=3c9&smart=true&width=887']);
});

it('recovers the publisher og:image for stored feed items that shipped without an image, archives it, and is idempotent', async () => {
 const DB = database(), base = item();
 await insert(DB, base, { originalTitle: base.title, originalSummary: base.summary, title: 'Senate approves Conecta 60+ program', summary: 'A measure passed by the Senate…' });
 const pages = vi.fn(async (input: unknown) => {
  const href = String(input);
  return href.includes('senado-aprueba-programa-conecta-60')
  ? new Response(readFileSync('test/fixtures/noticel_conecta.html', 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  : new Response('', { status: 404 });
 });
 vi.stubGlobal('fetch', pages);
 const env = { DB } as unknown as Env;
 const now = Date.parse('2026-11-16T12:00:00Z');
 await enrichImages(env, now); await enrichImages(env, now); // second run must be a no-op
 const stored = await payloadOf(DB, base.url);
 expect(stored.image).toBe(og); // publisher's own public image, verified HTTP 200 image/jpeg on Nov 16, 2026
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM image_enrich_queue').first<any>()).n).toBe(0);
 expect(((await DB.prepare('SELECT url FROM archive_images').all<any>()).results.map(r => r.url))).toEqual([og]); // queued by the payload trigger, not re-copied
 const revisions = (await DB.prepare('SELECT image_url FROM archive_revisions').all<any>()).results;
 expect(revisions.filter(r => r.image_url === og).length).toBe(1); // one enriched revision, no duplicates
 expect(JSON.parse((await DB.prepare('SELECT translation FROM archive_revisions WHERE image_url=?').bind(og).first<any>()).translation).title).toBe('Senate approves Conecta 60+ program'); // translation survives the image repair
 expect(pages).toHaveBeenCalledTimes(1); // one page fetch total: ingestion-time only, cached in the payload
});

 it('falls back honestly when the publisher page offers no image, with bounded backoff and attempts', async () => {
 const DB = database(), now = Date.parse('2026-11-16T12:00:00Z');
 await insert(DB, item({ url: 'https://noticel.com/sin-imagen/' }));
 let calls = 0;
 vi.stubGlobal('fetch', async() => { calls++; return new Response('<html><head><title>no og</title></head></html>', { headers: { 'Content-Type': 'text/html' } }); });
 const env = { DB } as unknown as Env;
 await enrichImages(env, now);
 const row = await DB.prepare('SELECT attempts,next_attempt,error FROM image_enrich_queue WHERE url=?').bind('https://noticel.com/sin-imagen/').first<any>();
 expect(row.attempts).toBe(1);
 expect(row.error).toContain('No usable og:image');
 expect(row.next_attempt).toBeGreaterThan(now); // backoff, not immediate rework
 await enrichImages(env, now + 3600000); // still inside the backoff window: not reprocessed
 expect(calls).toBe(1);
 // exhausting the attempts leaves the row unqueued forever: the honest fallback stays
 for (const hours of [3, 8, 20]) await enrichImages(env, now + hours * 3600000);
 expect(calls).toBe(4);
 const finished = await DB.prepare('SELECT attempts,next_attempt FROM image_enrich_queue WHERE url=?').bind('https://noticel.com/sin-imagen/').first<any>();
 expect(finished.attempts).toBe(4);
 expect(finished.next_attempt).toBeGreaterThan(now + 365 * 86400000); // cap reached, never re-processed
 await enrichImages(env, now + 400 * 86400000);
 expect(calls).toBe(4); // and never re-enqueued
 expect((await payloadOf(DB, 'https://noticel.com/sin-imagen/')).image).toBe('');
});

it('rejects unsafe or non-HTML targets without fetching them, and never queues community or blocked sources', async () => {
 const DB = database(), now = Date.now();
 const fetcher = vi.fn(async() => new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }));
 vi.stubGlobal('fetch', fetcher);
 await insert(DB, item({ url: 'http://insecure.example/story/', source: 'noticel' }));     // not https
 await insert(DB, item({ url: 'https://www.reddit.com/r/PuertoRico/x/', source: 'reddit_puertorico' })); // excluded source
 await insert(DB, item({ url: 'https://newsismybusiness.com/x/', source: 'nimb' }));       // manual import, fetch paused
 await insert(DB, item({ url: 'https://noticel.com/api-endpoint/', source: 'noticel' }));
 await enrichImages({ DB } as unknown as Env, now);
 const queued = (await DB.prepare('SELECT url FROM image_enrich_queue').all<any>()).results.map(r => r.url);
 expect(queued).toEqual(['https://noticel.com/api-endpoint/']); // only safe, fetchable news articles are queued
 expect(fetcher).toHaveBeenCalledTimes(1);
 const row = await DB.prepare('SELECT error FROM image_enrich_queue WHERE url=?').bind('https://noticel.com/api-endpoint/').first<any>();
 expect(row.error).toContain('not HTML');
});

it('resolves a relative og:image against the publisher page and keeps enrichment across rescans', async () => {
 const DB = database(), now = Date.now();
 await insert(DB, item({ url: 'https://metro.pr/historia/' }));
 vi.stubGlobal('fetch', async() => new Response('<html><head><meta property="og:image" content="/fotos/portada.png"></head></html>', { headers: { 'Content-Type': 'text/html' } }));
 await enrichImages({ DB } as unknown as Env, now);
 expect((await payloadOf(DB, 'https://metro.pr/historia/')).image).toBe('https://metro.pr/fotos/portada.png');
 // A rescan of the still image-less feed must carry the recovered image forward, never drop it.
 const stored = await payloadOf(DB, 'https://metro.pr/historia/');
 const rescanned = preserveObserved({ ...item({ url: 'https://metro.pr/historia/' }), time: stored.time }, stored);
 expect(rescanned.image).toBe('https://metro.pr/fotos/portada.png');
 const feedWins = preserveObserved({ ...item({ url: 'https://metro.pr/historia/', image: 'https://metro.pr/feedimg.jpg' }) }, stored);
 expect(feedWins.image).toBe('https://metro.pr/feedimg.jpg'); // a newly delivered feed image still outranks the recovered one
});

it('gives new visible stories and each source service despite an older alphabetical backlog', async () => {
 const DB=database(), now=Date.now();
 for(let i=0;i<30;i++) await insert(DB,item({url:`https://aaa.example/${i}`,source:'wapa',time:now-86400000}));
 const recent=item({url:'https://noticel.com/z-new-visible',time:now});
 await insert(DB,recent);
 vi.stubGlobal('fetch',async()=>new Response('<meta property="og:image" content="https://cdn.example.com/image.jpg">',{headers:{'Content-Type':'text/html'}}));
 const result=await enrichImages({DB} as Env,now);
 expect(result.processed).toBe(12);
 expect((await payloadOf(DB,recent.url)).image).toContain('image.jpg');
});
