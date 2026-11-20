import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { repairArcticImages } from '../src/reddit-repair';
import type { Env } from '../src/ingest';
import type { Item } from '../src/parse';

function database(): D1Database {
 const sqlite = new DatabaseSync(':memory:');
 sqlite.exec(readFileSync('migrations/0001_live.sql', 'utf8'));
 sqlite.exec(readFileSync('migrations/0002_archive.sql', 'utf8'));
 sqlite.exec(readFileSync('migrations/0014_arctic_image_repair.sql', 'utf8'));
 function prepare(sql: string): any {
  let args: any[] = [];
  return { bind(...values: any[]) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } };
 }
 return { prepare, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const NOW = Date.parse('2026-11-19T12:00:00Z');
const poster = 'https://external-preview.redd.it/frame.png?format=pjpg&s=abc';
const original = 'https://i.redd.it/photo.jpg';
const redditItem = (id: string, over: Record<string, unknown> = {}): Item => ({
 url: `https://www.reddit.com/r/PuertoRico/comments/${id}/post/`, source: 'reddit_puertorico',
 title: `Post ${id}`, summary: 'Publicación compartida en r/PuertoRico.', image: '',
 time: NOW - 60_000, observed: false, section: 'comunidad', reason: 'community', ...over,
});
const insert = async (DB: D1Database, base: Item, translation: unknown = null) =>
 DB.prepare('INSERT INTO articles(url,source,payload,translation,translation_attempt,first_seen,updated_at,published_at) VALUES(?,?,?,?,0,?,?,?)')
  .bind(base.url, base.source, JSON.stringify(base), translation === null ? null : JSON.stringify(translation), base.time, base.time, base.time).run();
const payloadOf = async (DB: D1Database, url: string) => JSON.parse((await DB.prepare('SELECT payload FROM articles WHERE url=?').bind(url).first<{ payload: string }>())!.payload) as Item;
// Shapes exactly as the Arctic lookup returns them.
const arcticPost = (item: Item, over: Record<string, unknown> = {}) => ({
 id: item.url.split('/comments/')[1].split('/')[0], subreddit: 'PuertoRico',
 permalink: `/r/PuertoRico/comments/${item.url.split('/comments/')[1].split('/')[0]}/post/`,
 title: item.title, created_utc: item.time / 1000, ...over,
});

it('repairs a photo for a post that aged out of the newest-100 scan window, archives it, and keeps the translation', async () => {
 const DB = database();
 const stored = redditItem('vid1x', {title: 'Fiscalía anuncia cargos'});
 await insert(DB, stored, { originalTitle: stored.title, originalSummary: stored.summary, title: 'Prosecutor announces charges', summary: 'English summary.' });
 const post = arcticPost({ ...stored, title: 'Fiscalía anuncia cargos' } as Item, { thumbnail: 'self', url: 'https://v.redd.it/clip', preview: { images: [{ source: { url: poster } }] } });
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [post] }))));
 const env = { DB } as unknown as Env;
 const result = await repairArcticImages(env, NOW);
 expect(result).toEqual({ requested: 1, repaired: 1, terminal: 0 });
 const updated = await payloadOf(DB, stored.url);
 expect(updated.image).toBe(poster); // video poster frame, same rule as the feed scan
 expect(updated.title).toBe('Fiscalía anuncia cargos');
 // The payload trigger queued the permanent R2 copy, exactly like a feed image.
 expect((await DB.prepare('SELECT url FROM archive_images').all<any>()).results.map(r => r.url)).toEqual([poster]);
 // The stored translation is untouched by the image-only repair.
 expect(JSON.parse((await DB.prepare('SELECT translation FROM articles WHERE url=?').bind(stored.url).first<any>()).translation).title).toBe('Prosecutor announces charges');
});

it('terminates posts the Arctic archive says have no photo and never re-requests them', async () => {
 const DB = database();
 const text = redditItem('txt1', { title: 'Pregunta sobre el trámite' });
 await insert(DB, text);
 const post = arcticPost({ ...text, title: 'Pregunta sobre el trámite' } as Item, { thumbnail: 'self' });
 const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [post] })));
 vi.stubGlobal('fetch', fetcher);
 const env = { DB } as unknown as Env;
 for (let i = 0; i < 3; i++) await repairArcticImages(env, NOW + i * 7200000); // three hourly passes
 const stored = await payloadOf(DB, text.url);
 expect(stored.image).toBe(''); // honestly still imageless
 const row = await DB.prepare('SELECT attempts,error FROM arctic_image_repair WHERE url=?').bind(text.url).first<any>();
 expect(row.attempts).toBe(3); // capped terminal row
 expect(row.error).toContain('No photo in the Arctic record');
 expect(fetcher).toHaveBeenCalledTimes(1); // terminal on the first pass: no retries, no loops
});

it('backs off with bounded attempts when Arctic Shift answers HTTP 429, and caps at three', async () => {
 const DB = database();
 const item = redditItem('r429');
 await insert(DB, item);
 const fetcher = vi.fn(async () => new Response('', { status: 429 }));
 vi.stubGlobal('fetch', fetcher);
 const env = { DB } as unknown as Env;
 const first = await repairArcticImages(env, NOW);
 expect(first).toEqual({ requested: 1, error: 'HTTP 429' });
 expect(fetcher).toHaveBeenCalledTimes(1);
 const row = await DB.prepare('SELECT attempts,next_attempt FROM arctic_image_repair WHERE url=?').bind(item.url).first<any>();
 expect(row.attempts).toBe(1);
 expect(row.next_attempt).toBe(NOW + 3600000);
 for (let i = 0; i < 5; i++) await repairArcticImages(env, NOW + (i + 1) * 7200000); // five more passes
 expect(fetcher).toHaveBeenCalledTimes(3); // still capped: no loop, no unbounded load
 expect((await DB.prepare('SELECT COUNT(*) AS n FROM arctic_image_repair WHERE attempts>=3').first<any>()).n).toBe(1);
});

it('ends without an image when the lookup answers with a removed post or a Reddit placeholder', async () => {
 const DB = database();
 const removed = redditItem('rm1', { title: 'Eliminado' });
 const placeholder = redditItem('ph1', { title: 'Sin imagen' });
 await insert(DB, removed); await insert(DB, placeholder);
 const posts = [
  { ...arcticPost({ ...removed, title: 'Eliminado' } as Item), removed_by_category: 'moderator' },
  { ...arcticPost({ ...placeholder, title: 'Sin imagen' } as Item), thumbnail: 'default' },
 ];
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: posts }))));
 const result = await repairArcticImages({ DB } as unknown as Env, NOW);
 expect(result).toEqual({ requested: 2, repaired: 0, terminal: 2 });
 for (const url of [removed.url, placeholder.url]) {
  expect((await payloadOf(DB, url)).image).toBe(''); // no photo, honestly kept imageless
  expect((await DB.prepare('SELECT attempts FROM arctic_image_repair WHERE url=?').bind(url).first<any>()).attempts).toBe(3);
 }
});

it('runs at most one repair request per hour (the lease doubles as the cadence gate)', async () => {
 const DB = database();
 let calls = 0;
 vi.stubGlobal('fetch', vi.fn(async () => { calls++; return new Response(JSON.stringify({ data: [] })); }));
 const env = { DB } as unknown as Env;
 expect((await repairArcticImages(env, NOW)).requested).toBe(0); // no empty rows: nothing was queued, no request
 expect(calls).toBe(0);
 await insert(DB, redditItem('x1'), null);
 expect(await repairArcticImages(env, NOW)).toEqual({ skipped: 'already running' }); // the no-work pass still holds the hourly gate
 expect(calls).toBe(0);
 expect((await repairArcticImages(env, NOW + 61 * 60000)).requested).toBe(1); // next hour: one lookup
 expect(calls).toBe(1);
 expect(await repairArcticImages(env, NOW + 76 * 60000)).toEqual({ skipped: 'already running' }); // 15-min cron inside the hour
 expect(calls).toBe(1);
});
