import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { excerpt, rssRoute, sitemapRoute, SITE_ORIGIN, SITEMAP_LIMIT, storyLookup, storyPermalink, syndicationRoute, type SyndicationEnv } from '../src/syndication';
import type { Item } from '../src/parse';

const NOW = Date.parse('2026-11-14T05:00:00Z');
const HOUR = 3_600_000;

function setup() {
  const sql = new DatabaseSync(':memory:');
  for (const migration of ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql']) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  function prepare(text: string): any { let args: any[] = []; return { bind(...v: any[]) { args = v; return this; }, async first() { return sql.prepare(text).get(...args) ?? null; }, async all() { return { results: sql.prepare(text).all(...args) }; }, async run() { return { meta: { changes: Number(sql.prepare(text).run(...args).changes) } }; } }; }
  const d1 = { prepare, async batch(s: any[]) { return Promise.all(s.map(i => i.run())); } } as unknown as D1Database;
  return { sql, DB: { DB: d1 } as SyndicationEnv, d1 };
}

const item = (url: string, title: string, source = 'noticel', time = NOW - HOUR): Item =>
  ({ url, source, title, summary: 'Resumen.', image: '', time, observed: false, section: 'otras', reason: 'test' });

function seed(sql: DatabaseSync, item: Item) {
  sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)')
    .run(item.url, item.source, JSON.stringify(item), item.time, item.time, item.time);
}

const storyIds = (sql: DatabaseSync) => (sql.prepare('SELECT id FROM story_ids ORDER BY id').all() as { id: number }[]).map(r => r.id);

it('serves XML-escaped RSS 2.0 with original article links, sources and pubDates', async () => {
  const { sql, DB } = setup();
  seed(sql, item('https://example.com/apagon/?utm=x', 'Apagón <masivo> & "luma"\'s fin', 'noticel', NOW - HOUR));
  seed(sql, item('https://example.com/en/', 'English story', 'sjds', NOW - 2 * HOUR));
  const response = await rssRoute(new Request('https://news.dev.pr/rss.xml'), DB, NOW);
  expect(response?.status).toBe(200);
  expect(response?.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
  const xml = await response!.text();
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml).toContain('<rss version="2.0">');
  expect(xml).toContain('<language>es-PR</language>');
  expect(xml).toContain('<link>https://example.com/apagon/?utm=x</link>'); // items link to the original article
  expect(xml).not.toContain('/story?id=');
  expect(xml).toContain('<guid isPermaLink="true">https://example.com/apagon/?utm=x</guid>');
  expect(xml).toContain('<title>Apagón &lt;masivo&gt; &amp; &quot;luma&quot;&#39;s fin</title>');
  expect(xml).toContain('<source url="https://noticel.com">NotiCel</source>');
  expect(xml).toContain('<pubDate>Sat, 14 Nov 2026 04:00:00 GMT</pubDate>');
  expect(xml).not.toMatch(/<(?!\/?(rss|channel|item|title|link|guid|pubDate|source|description|language|ttl|lastBuildDate)\b)[a-z]/); // no raw markup from titles
  const head = await rssRoute(new Request('https://news.dev.pr/rss.xml', { method: 'HEAD' }), DB, NOW);
  expect(head?.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
  expect(await head!.text()).toBe('');
  expect((await rssRoute(new Request('https://news.dev.pr/rss.xml', { method: 'POST' }), DB, NOW))?.status).toBe(405);
  expect(await rssRoute(new Request('https://news.dev.pr/other.xml'), DB, NOW)).toBeUndefined();
});

it('caps the feed at the latest 50 with excerpts only, never full article text', async () => {
  const { sql, DB } = setup();
  for (let i = 0; i < 55; i++) sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)')
    .run(`https://example.com/s${i}/`, 'noticel', JSON.stringify(item(`https://example.com/s${i}/`, `Historia ${i}`, 'noticel', NOW - i * HOUR)), NOW, NOW, NOW - i * HOUR);
  const xml = await (await rssRoute(new Request('https://news.dev.pr/rss.xml'), DB, NOW))!.text();
  expect(xml.match(/<item>/g)?.length).toBe(50);
  expect(xml).toContain('<title>Historia 0</title>'); // newest first
  expect(xml).not.toContain('Historia 50');
  expect(xml).not.toContain('Historia 54');
});

it('lists only own news.dev.pr story permalinks in the sitemap', async () => {
  const { sql, DB } = setup();
  seed(sql, item('https://example.com/a/', 'A', 'noticel', NOW - HOUR));
  seed(sql, item('https://example.com/b/', 'B', 'metro', NOW - 2 * HOUR));
  const response = await sitemapRoute(new Request('https://news.dev.pr/sitemap.xml'), DB, NOW);
  expect(response?.status).toBe(200);
  expect(response?.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
  const xml = await response!.text();
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  expect(locs.filter(l=>l.includes('/story?'))).toEqual(storyIds(sql).map(id => `${SITE_ORIGIN}/story?id=${id}`));
  expect(locs.every(l => l.startsWith(SITE_ORIGIN+'/'))).toBe(true); // own permalinks only
  expect(xml).not.toContain('example.com/a/'); // foreign article URLs are never listed
  expect((await rssRoute(new Request('https://news.dev.pr/feed.xml'), DB, NOW))?.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
  expect(await syndicationRoute(new Request('https://news.dev.pr/sitemap.xml'), DB, NOW)).toBeDefined();
  expect(await syndicationRoute(new Request('https://news.dev.pr/rss.xml'), DB, NOW)).toBeDefined();
  expect(await syndicationRoute(new Request('https://news.dev.pr/other'), DB, NOW)).toBeUndefined();
  const head = await sitemapRoute(new Request('https://news.dev.pr/sitemap.xml', { method: 'HEAD' }), DB, NOW);
  expect(head?.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
  expect(await head!.text()).toBe('');
  expect((await sitemapRoute(new Request('https://news.dev.pr/sitemap.xml', { method: 'POST' }), DB, NOW))?.status).toBe(405);
});

it('resolves /story ids through current articles with an archive fallback after rotation', async () => {
  const { sql, DB } = setup();
  const a = item('https://example.com/a/', 'Historia viva', 'noticel', NOW - HOUR);
  seed(sql, a);
  const id = storyIds(sql)[0];
  expect(storyPermalink('https://news.dev.pr/', id)).toBe('https://news.dev.pr/story?id=1');
  const live = await storyLookup(DB, id);
  expect(live).toMatchObject({ item: { url: a.url, title: a.title }, publishedAt: a.time, from: 'articles' });
  expect(live?.translation).toBeNull();
  sql.prepare('UPDATE articles SET translation=? WHERE url=?').run(JSON.stringify({ originalTitle: a.title, originalSummary: a.summary, title: 'Live story (EN)', summary: 'English summary.' }), a.url);
  expect((await storyLookup(DB, id))?.translation).toMatchObject({ title: 'Live story (EN)' });
  sql.exec('DELETE FROM articles'); // rotate out; archive_revisions keeps the payload (0002 trigger)
  const archived = await storyLookup(DB, id);
  expect(archived).toMatchObject({ item: { url: a.url, title: a.title }, from: 'archive' });
  expect((await storyLookup(DB, id + 999)) ?? null).toBeNull();
  expect(await storyLookup(DB, '12; DROP TABLE articles')).toBeNull();
  expect(await storyLookup(DB, '0')).toBeNull();
  expect(await storyLookup(DB, -1)).toBeNull();
  expect(SITEMAP_LIMIT).toBe(500);
});

it('clamps excerpts to 300 characters without breaking words', () => {
  expect(excerpt('corto')).toBe('corto');
  expect(excerpt('a'.repeat(350)).length).toBe(300);
  const words = excerpt('palabra '.repeat(80));
  expect(words.length).toBeLessThanOrEqual(300);
  expect(words.endsWith('palabra…')).toBe(true); // trims the partial word before the ellipsis
  expect(excerpt('x '.repeat(200))).toMatch(/x…$/);
});
