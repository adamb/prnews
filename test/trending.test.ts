import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupClicks, CLICK_BUCKET_MS, CLICK_WINDOW_MS, clickRoute, lookupDestination, recordClick, topClicked, type ClickEnv } from '../src/trending';
import type { Item } from '../src/parse';

const NOW = Date.parse('2026-11-14T05:00:00Z');
const HOUR = 3_600_000;

function setup() {
  const sql = new DatabaseSync(':memory:');
  for (const migration of ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  const real = {
    prepare(text: string) {
      let args: any[] = [];
      return {
        bind(...v: any[]) { args = v; return this; },
        async first() { return sql.prepare(text).get(...args) ?? null; },
        async all() { return { results: sql.prepare(text).all(...args) }; },
        async run() { return { meta: { changes: Number(sql.prepare(text).run(...args).changes) } } },
      };
    },
  };
  const DB: ClickEnv = { DB: {
    prepare: (t: string) => real.prepare(t) as any,
    // D1 batches run transactionally in order; executing sequentially mirrors that.
    async batch(statements: { run(): Promise<unknown> }[]) { for (const s of statements) await s.run(); return { meta: { changes: 0 } }; },
  } as unknown as D1Database };
  return { sql, DB, real };
}

const item = (url: string, title = 'Titular', source = 'noticel'): Item =>
  ({ url, source, title, summary: 'Resumen.', image: '', time: NOW - HOUR, observed: false, section: 'otras', reason: 'test' });

function seed(sql: DatabaseSync, item: Item) {
  sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)')
    .run(item.url, item.source, JSON.stringify(item), item.time, item.time, item.time);
}

const redirects = (key: string, db: ClickEnv, method = 'GET') =>
  clickRoute(new Request(`https://news.dev.pr/click?${key}`, { method }), db, NOW);

it('redirects only DB-known article urls or story ids, and never the request text', async () => {
  const { sql, DB } = setup();
  const foreign = 'https://example.com/apagon/';
  seed(sql, item(foreign));
  const get = await redirects(`url=${encodeURIComponent(foreign)}`, DB);
  expect(get?.status).toBe(302);
  expect(get?.headers.get('Location')).toBe(foreign); // destination is the stored article URL
  const id = (sql.prepare('SELECT id FROM story_ids WHERE url=?').get(foreign) as { id: number }).id;
  const byId = await redirects(`id=${id}`, DB);
  expect(byId?.headers.get('Location')).toBe(foreign);
  expect((await redirects(`id=${id}&url=${encodeURIComponent(foreign)}`, DB))?.headers.get('Location')).toBe(foreign);
  for (const [query, status] of [
    ['url=https%3A%2F%2Fevil.example.org', 404], // never redirects unregistered destinations
    ['url=//evil.example.org/s', 404],
    ['url=javascript%3Aalert(1)', 404],
    ['url=https%3A%2F%2Fexample.com%2Fapagon', 404], // key must match exactly, no prefixes
    [`id=${id + 1}`, 404],
    ['id=0', 404],
    ['id=nonsense', 404],
    ['', 404],
  ] as [string, number][]) {
    const response = await redirects(query, DB);
    expect(response?.status, query).toBe(status);
    expect(response?.headers.get('Location') ?? '').not.toMatch(/evil/);
  }
  expect((await clickRoute(new Request('https://news.dev.pr/click?url=https%3A%2F%2Fevil.example.org', { method: 'POST' }), DB, NOW))?.status).toBe(405);
  expect(await clickRoute(new Request('https://news.dev.pr/', { method: 'GET' }), DB, NOW)).toBeUndefined();
});

it('never opens a redirect to schemes or hosts outside the stored HTTP(S) article URL', async () => {
  const { sql, DB } = setup();
  seed(sql, item('https://example.com/ok/'));
  expect(await lookupDestination(DB, 'https://example.com/ok/')).toBe('https://example.com/ok/');
  seed(sql, item('javascript:alert(1)')); // corrupt/foreign keys are refused even when known to the DB
  expect(await lookupDestination(DB, 'javascript:alert(1)')).toBe('');
  expect(await lookupDestination(DB, 'https://example.com/nope/')).toBe('');
  expect(await lookupDestination(DB, '')).toBe('');
});

it('counts one hourly bucket per GET, HEAD without counting, and redirects when counting fails', async () => {
  const { sql, DB, real } = setup();
  const url = 'https://example.com/apagon/';
  seed(sql, item(url));
  await redirects(`url=${encodeURIComponent(url)}`, DB);
  await redirects(`url=${encodeURIComponent(url)}`, DB, 'HEAD'); // HEAD never counts
  await redirects(`url=${encodeURIComponent(url)}`, DB);
  const rows = sql.prepare('SELECT url, SUM(clicks) AS clicks FROM article_click_buckets GROUP BY url').all() as { url: string; clicks: number }[];
  expect(rows).toEqual([{ url, clicks: 2 }]);
  const countingEnv: ClickEnv = {
    DB: {
      prepare(text: string) {
        if (/article_click_buckets/.test(text)) throw new Error('d1 unavailable');
        return real.prepare(text);
      },
    } as unknown as D1Database,
  };
  const response = await redirects(`url=${encodeURIComponent(url)}`, countingEnv);
  expect(response?.status).toBe(302); // a counting failure must still redirect the known destination
  expect(response?.headers.get('Location')).toBe(url);
});

it('aggregates clicks per article into hourly buckets with a rolling-24h top list', async () => {
  const { sql, DB } = setup();
  const urls = ['https://example.com/a/', 'https://example.com/b/', 'https://example.com/c/', 'https://example.com/d/', 'https://example.com/e/', 'https://example.com/f/'];
  for (const url of urls) seed(sql, item(url));
  await recordClick(DB, urls[0], NOW);
  await recordClick(DB, urls[0], NOW - 2 * HOUR);
  await recordClick(DB, urls[0], NOW - 25 * HOUR); // outside the rolling window
  await recordClick(DB, urls[1], NOW - 23 * HOUR);
  await recordClick(DB, urls[2], NOW - HOUR);
  await recordClick(DB, urls[2], NOW - HOUR);
  await recordClick(DB, urls[3], NOW - HOUR);
  await recordClick(DB, urls[4], NOW - HOUR);
  await recordClick(DB, urls[5], NOW - HOUR);
  expect(CLICK_BUCKET_MS).toBe(1000);
  expect(CLICK_WINDOW_MS).toBe(24 * HOUR);
  const top = await topClicked(DB, NOW);
  expect(top.map(t => [t.item.url, t.clicks])).toEqual([[urls[0], 2], [urls[2], 2], [urls[1], 1], [urls[3], 1], [urls[4], 1]]); // 24h only, capped at 5, ties by url
  const rows = sql.prepare('SELECT COUNT(*) AS n FROM article_click_buckets').get() as { n: number };
  expect(rows.n).toBe(8); // only (article, hour, count) rows exist — no per-visitor data
});

it('cleanup keeps the rolling window plus margin and drops the rest', async () => {
  const { sql, DB } = setup();
  seed(sql, item('https://example.com/a/'));
  await recordClick(DB, 'https://example.com/a/', NOW);
  await recordClick(DB, 'https://example.com/a/', NOW - 40 * HOUR);
  await recordClick(DB, 'https://example.com/a/', NOW - 60 * HOUR);
  await cleanupClicks(DB, NOW);
  const buckets = (sql.prepare('SELECT bucket FROM article_click_buckets ORDER BY bucket DESC').all() as { bucket: number }[]).map(b => b.bucket);
  const recent = Math.floor(NOW / CLICK_BUCKET_MS);
  expect(buckets).toEqual([recent, recent - 40 * HOUR / CLICK_BUCKET_MS]); // 48h margin, but 72h-old data is gone
  expect((await topClicked(DB, NOW)).map(t => t.clicks)).toEqual([1]);
});

it('creates stable story ids for articles and leaves them intact over rotation', async () => {
  const { sql, DB } = setup();
  seed(sql, item('https://example.com/first/'));
  seed(sql, item('https://example.com/second/'));
  const ids = sql.prepare('SELECT id, url FROM story_ids ORDER BY id').all() as { id: number; url: string }[];
  expect(ids.length).toBe(2);
  expect((await lookupDestination(DB, String(ids[0].id)))).toBe('https://example.com/first/');
  sql.exec('DELETE FROM articles'); // rotation: buckets get cleaned up, but story ids and totals persist
  expect(await lookupDestination(DB, String(ids[0].id))).toBe('https://example.com/first/'); // permalink rows keep old destinations redirectable (and countable)
  expect((sql.prepare('SELECT COUNT(*) AS n FROM story_ids').get() as { n: number }).n).toBe(2); // ids are never recycled
  const fts = sql.prepare('SELECT COUNT(*) AS n FROM articles_fts').get() as { n: number };
  expect(fts.n).toBe(0); // retention/rotation also trims the maintained index
});

afterEach(() => vi.restoreAllMocks());
