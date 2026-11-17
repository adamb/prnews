import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { clickRoute, cleanupClicks, cumulativeTop, hallOfFame, HALL_TOP, recordClick, topClicked, totalClicks, type ClickEnv } from '../src/trending';
import { refreshWebAnalytics, webAnalyticsSnapshot, ANALYTICS_WINDOW_DAYS, ANALYTICS_TTL_MS } from '../src/analytics';
import renderer from '../src/render';
import type { Item } from '../src/parse';

const NOW = Date.parse('2026-11-14T05:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(migrations = ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql']) {
  const sql = new DatabaseSync(':memory:');
  for (const migration of migrations) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
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
    prepare: ((t: string) => real.prepare(t)) as any,
    async batch(statements: { run(): Promise<unknown> }[]) { for (const s of statements) await s.run(); return { meta: { changes: 0 } }; },
  } as unknown as D1Database };
  return { sql, DB, real };
}

const item = (url: string, title = 'Titular', source = 'noticel', time = NOW - HOUR): Item =>
  ({ url, source, title, summary: 'Resumen.', image: '', time, observed: false, section: 'otras', reason: 'test' });

function seed(sql: DatabaseSync, item: Item) {
  sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)')
    .run(item.url, item.source, JSON.stringify(item), item.time, item.time, item.time);
}

const redirectResponse = (key: string, db: ClickEnv, method = 'GET') =>
  clickRoute(new Request(`https://news.dev.pr/click?${key}`, { method }), db, NOW);

const perArticle = (sql: DatabaseSync) => (sql.prepare('SELECT url,clicks FROM article_click_totals ORDER BY url').all() as { url: string; clicks: number }[]);
const globalRow = (sql: DatabaseSync) => (sql.prepare('SELECT clicks FROM site_click_totals WHERE id=1').get() as { clicks: number } | undefined);

it('records one bucket, one per-article total, and one global total per GET, with HEAD never counting', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  const url = 'https://example.com/apagon/';
  seed(sql, item(url));
  await redirectResponse(`url=${encodeURIComponent(url)}`, DB);
  await redirectResponse(`url=${encodeURIComponent(url)}`, DB, 'HEAD'); // HEAD never counts anywhere
  await redirectResponse(`url=${encodeURIComponent(url)}`, DB);
  expect(perArticle(sql)).toEqual([{ url, clicks: 2 }]);
  expect(globalRow(sql)).toEqual({ clicks: 2 }); // ledger rows stay consistent with their buckets
  expect(sql.prepare('SELECT COUNT(*) AS n FROM article_click_totals').get()).toEqual({ n: 1 });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM site_click_totals').get()).toEqual({ n: 1 });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM article_click_buckets').get()).toEqual({ n: 1 });
});

it('keeps batch increments atomic: totals match buckets exactly under interleaved clicks', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  const url = 'https://example.com/a/';
  seed(sql, item(url));
  await Promise.all([recordClick(DB, url, NOW), recordClick(DB, url, NOW), recordClick(DB, url, NOW + 1)]);
  expect(perArticle(sql)).toEqual([{ url, clicks: 3 }]);
  expect(globalRow(sql)).toEqual({ clicks: 3 });
  const bucketSum = (sql.prepare('SELECT COALESCE(SUM(clicks),0) AS s FROM article_click_buckets').get() as { s: number }).s;
  expect(bucketSum).toBe(3);
});

it('backfills totals from retained buckets only, once, and a re-run cannot double-count', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql']);
  seed(sql, item('https://example.com/a/'));
  seed(sql, item('https://example.com/b/'));
  // pre-migration world: the old recordClick only wrote buckets
  sql.prepare("INSERT INTO article_click_buckets(url,bucket,clicks) VALUES(?,?,1),(?,?,1),(?,?,1),(?,?,1)")
    .run('https://example.com/a/', Math.floor(NOW / 1000), 'https://example.com/a/', Math.floor((NOW - 2 * HOUR) / 1000), 'https://example.com/b/', Math.floor((NOW - HOUR) / 1000), 'https://example.com/expired/', Math.floor((NOW - 60 * HOUR) / 1000));
  // Buckets older than retention were already deleted by cleanupClicks before the migration
  // existed; that 60-hour-old click is gone forever and must NOT be reconstructed or invented.
  await cleanupClicks(DB, NOW);
  expect((sql.prepare('SELECT COUNT(*) AS n FROM article_click_buckets').get() as { n: number }).n).toBe(3);
  sql.exec(readFileSync('migrations/0008_click_totals.sql', 'utf8'));
  const after = { per: perArticle(sql), site: globalRow(sql) };
  expect(after.per).toEqual([
    { url: 'https://example.com/a/', clicks: 2 },
    { url: 'https://example.com/b/', clicks: 1 },
  ]);
  expect(JSON.stringify(after.per)).not.toContain('expired'); // lost clicks are never fabricated
  expect(after.site).toEqual({ clicks: 3 });
  expect((sql.prepare('SELECT started_at>0 AS ok FROM site_click_totals WHERE id=1').get() as { ok: number }).ok).toBe(1);
  // simulate a repeated apply (D1 applies each migration once; the SQL itself must stay idempotent)
  sql.exec(readFileSync('migrations/0008_click_totals.sql', 'utf8'));
  expect(perArticle(sql)).toEqual(after.per);
  expect(globalRow(sql)).toEqual(after.site); // no double counting on any later re-run
  // a click recorded after the backfill continues the same ledger
  await recordClick(DB, 'https://example.com/b/', NOW);
  expect(perArticle(sql)).toContainEqual({ url: 'https://example.com/b/', clicks: 2 });
  expect(globalRow(sql)).toEqual({ clicks: 4 });
});

it('totals survive expiry and rotation; rolling most-read drops while cumulative lists persist', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  const url = 'https://example.com/old/';
  seed(sql, item(url, 'Titular viejo'));
  await recordClick(DB, url, NOW - 24 * HOUR);
  sql.exec('DELETE FROM articles'); // 14-day rotation
  await cleanupClicks(DB, NOW + 25 * HOUR); // 48h margin passes: all buckets expire
  expect((sql.prepare('SELECT COUNT(*) AS n FROM article_click_buckets').get() as { n: number }).n).toBe(0);
  expect(await topClicked(DB, NOW + 25 * HOUR)).toEqual([]); // rolling most-read no longer lists it
  expect(await totalClicks(DB)).toEqual({ clicks: 1, startedAt: expect.any(Number) as unknown as number }); // lifetime ledger survives
  const cumulative = await cumulativeTop(DB);
  expect(cumulative.map(c => [c.url, c.clicks])).toEqual([[url, 1]]);
  expect(cumulative[0]!.item.title).toBe('Titular viejo'); // metadata served from the permanent archive revision
});

it('redirects and counts rotated archive destinations, and never opens unknown ones', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  const url = 'https://example.com/archivada/';
  seed(sql, item(url));
  const id = (sql.prepare('SELECT id FROM story_ids WHERE url=?').get(url) as { id: number }).id;
  sql.exec('DELETE FROM articles'); // rotated out; story_ids + archive_revisions remain
  const byUrl = await redirectResponse(`url=${encodeURIComponent(url)}`, DB);
  expect(byUrl?.status).toBe(302);
  expect(byUrl?.headers.get('Location')).toBe(url); // stored destination, still counted
  const byId = await redirectResponse(`id=${id}`, DB);
  expect(byId?.headers.get('Location')).toBe(url);
  expect(globalRow(sql)).toEqual({ clicks: 2 });
  // unknown or unsafe keys still 404 exactly as before
  for (const [query, status] of [
    ['url=https%3A%2F%2Fevil.example.org', 404],
    ['url=javascript%3Aalert(1)', 404],
    [`id=${id + 1}`, 404],
    ['id=0', 404],
  ] as [string, number][]) {
    const response = await redirectResponse(query, DB);
    expect(response?.status, query).toBe(status);
    expect(response?.headers.get('Location') ?? '').not.toMatch(/evil|javascript/);
  }
  const stored = JSON.stringify(sql.prepare('SELECT * FROM article_click_totals').all());
  expect(stored).not.toContain('evil'); // unregistered destinations never enter any aggregate
});

it('hall of fame is honestly empty until an article both ages out and was clicked', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  const active = item('https://example.com/activo/', 'Titular activo');
  seed(sql, active);
  await recordClick(DB, active.url, NOW); // clicked but still within the 14-day window
  expect(await hallOfFame(DB)).toEqual([]); // nothing aged yet — no fabricated popularity
  const html = await renderer.fetch(new Request('https://news.dev.pr/hall'), { items: [], translations: {}, feeds: [], hall: await hallOfFame(DB), totals: await totalClicks(DB) }).text();
  expect(html).toContain('Todavía no hay artículos en el Salón de la fama');
  expect(html).toContain('No se inventan clics ni popularidad'); // the empty state explains the rule
  // the article ages past 14 days and rotation removes it from `articles`
  const aged = item('https://example.com/vieja/', 'Titular viejo', 'primerahora', NOW - 15 * DAY);
  seed(sql, aged);
  await recordClick(DB, aged.url, NOW);
  await recordClick(DB, aged.url, NOW + 1);
  await recordClick(DB, active.url, NOW + 2);
  sql.prepare('DELETE FROM articles WHERE url=?').run(aged.url); // only the aged article rotates
  const entries = await hallOfFame(DB);
  expect(entries.map(e => [e.url, e.clicks])).toEqual([['https://example.com/vieja/', 2]]); // the active article never qualifies
  expect(entries[0]!.item.title).toBe('Titular viejo');
  expect(entries[0]!.item.source).toBe('primerahora');
});

it('hall of fame is capped and ordered, and its page renders title, source, summary, original link and metric', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  for (let i = 0; i < HALL_TOP + 2; i++) {
    const aged = item(`https://example.com/vieja-${i}/`, `Titular ${i}`, 'noticel', NOW - (20 + i) * DAY);
    seed(sql, aged);
    for (let c = 0; c <= i; c++) await recordClick(DB, aged.url, NOW + i);
  }
  sql.exec('DELETE FROM articles');
  const entries = await hallOfFame(DB);
  expect(entries.length).toBe(HALL_TOP); // bounded
  const clicks = entries.map(e => e.clicks);
  expect([...clicks].sort((a, b) => b - a)).toEqual(clicks); // most clicked first
  const html = await renderer.fetch(new Request('https://news.dev.pr/hall'), { items: [], translations: {}, feeds: [], hall: entries, totals: { clicks: 55, startedAt: NOW - 5 * HOUR } }).text();
  expect(html).toContain('Titular 11'); // displayed archive title (top entries, desc by clicks)
  expect(html).toContain('/click?url='+encodeURIComponent('https://example.com/vieja-11/')); // tracked original destination
  expect(html).not.toContain('https://example.com/vieja-0/'); // bounded: only the top HALL_TOP rows render
  expect(html).not.toContain('Titular 0');
  expect(html).toContain('NotiCel');
  expect(html).toContain('clics · publicado hace más de 14 días'); // the metric is explicit
  expect(html).toContain('Métrica: clics acumulados desde'); // honest window on the metric
  const en = await renderer.fetch(new Request('https://news.dev.pr/hall?lang=en'), { items: [], translations: {}, feeds: [], hall: entries, totals: { clicks: 55, startedAt: NOW - 5 * HOUR } }).text();
  expect(en).toContain('Hall of fame');
  expect(en).toContain('clicks · published more than 14 days ago');
});

it('stats renders the cumulative ledger with its window and never converts clicks into visitors', async () => {
  const dayAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const analytics = { available: true, days: [{ date: dayAgo(9), pageviews: 7, visits: 6 }, { date: dayAgo(2), pageviews: 5, visits: 4 }, { date: dayAgo(1), pageviews: 12, visits: 9 }], totalPageviews: 24, totalVisits: 19, since: dayAgo(9), fetchedAt: Date.now() - HOUR };
  const html = await renderer.fetch(new Request('https://news.dev.pr/stats'), { items: [], translations: {}, feeds: [], history: [], totals: { clicks: 9, startedAt: Date.now() - HOUR }, popular: [{ url: 'https://example.com/a/', clicks: 6, item: item('https://example.com/a/', 'Titular a'), translation: null }], analytics }).text();
  expect(html).toContain('9 clics salientes acumulados');
  expect(html).toContain('Conteo acumulado desde');
  expect(html).toContain('Los clics no son visitantes ni páginas vistas'); // the ledger states its own limit
  expect(html).toContain('Titular a'); expect(html).toContain('6 clics');
  // last 7 days = offsets 1+2; last 14 = all three; measured total = the stored archive
  expect(html).toContain('Últimos 7 días: 17 páginas vistas · 13 visitas');
  expect(html).toContain('Últimos 14 días: 24 páginas vistas · 19 visitas');
  expect(html).toContain(`Total medido desde ${dayAgo(9)}: 24 páginas vistas · 19 visitas`);
  expect(html).toContain('peticiones del Worker no cuentan'); // never server request volume
  expect(html).not.toMatch(/visitantes únicos[^<]*:\s*\d/); // no invented unique-visitor numbers
  const empty = await renderer.fetch(new Request('https://news.dev.pr/stats'), { items: [], translations: {}, feeds: [], history: [], totals: { clicks: 0, startedAt: Date.now() - HOUR }, analytics: { available: false, reason: 'unavailable', days: [], totalPageviews: 0, totalVisits: 0, fetchedAt: null } }).text();
  expect(empty).toContain('Todavía no hay clics registrados');
  expect(empty).toContain('No disponible ahora'); // analytics missing shows unavailable, not a fake zero
  expect(empty).toContain('dash.cloudflare.com'); // precise dashboard link
});

it('web analytics refresh is cached, additive-durable, and fails safe without a token', async () => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  expect(await refreshWebAnalytics(DB)).toEqual({ refreshed: false, reason: 'unconfigured' });
  expect(await webAnalyticsSnapshot(DB)).toMatchObject({ available: false, reason: 'empty', totalPageviews: 0 });
  const env = { DB: DB.DB, CF_ANALYTICS_TOKEN: 'x'.repeat(40) } as any;
  let calls = 0;
  const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { calls++; return new Response(JSON.stringify({ data: { viewer: { accounts: [{ pageloads: [
    { count: 10, sum: { visits: 8 }, dimensions: { date: '2026-11-13' } },
    { count: 20, sum: { visits: 15 }, dimensions: { date: '2026-11-14' } },
  ] }] } } }), { status: 200 }); });
  const first = await refreshWebAnalytics(env, NOW);
  expect(first.refreshed).toBe(true);
  expect(calls).toBe(1);
  expect(await webAnalyticsSnapshot(DB)).toMatchObject({ available: true, since: '2026-11-13', totalPageviews: 30, totalVisits: 23 });
  await refreshWebAnalytics(env, NOW + HOUR); // fresh inside the TTL: no second call
  expect(calls).toBe(1);
  // stale again: revised same-day counts are upserted, not duplicated
  stub.mockImplementation(async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ pageloads: [{ count: 25, sum: { visits: 18 }, dimensions: { date: '2026-11-14' } }] }] } } }), { status: 200 }));
  await refreshWebAnalytics(env, NOW + ANALYTICS_TTL_MS + HOUR);
  expect((sql.prepare('SELECT COUNT(*) AS n FROM web_analytics_daily').get() as { n: number }).n).toBe(2);
  expect(await webAnalyticsSnapshot(DB)).toMatchObject({ available: true, totalPageviews: 35, totalVisits: 26 });
  // an API failure keeps the last cached snapshot instead of inventing a state
  stub.mockImplementation(async () => new Response('{"errors":[{"message":"quota"}]}', { status: 200 }));
  const failed = await refreshWebAnalytics(env, NOW + 2 * ANALYTICS_TTL_MS + 2 * HOUR); // well past the TTL of the last stored row
  expect(failed).toEqual({ refreshed: false, reason: 'graphql-error' });
  expect(await webAnalyticsSnapshot(DB)).toMatchObject({ available: true, totalPageviews: 35, totalVisits: 26 });
  stub.mockRestore();
  expect(ANALYTICS_WINDOW_DAYS).toBeLessThanOrEqual(8); // date-only grouping over this window can never hit the row limit
  expect(ANALYTICS_TTL_MS).toBeGreaterThanOrEqual(6 * 3600000); // bounded refresh: at most ~4 reads/day
});

afterEach(() => vi.restoreAllMocks());


it.each(['es', 'en'])('tracks Stats popular/pending and Hall links in %s through local redirects', async lang => {
  const { sql, DB } = setup(['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']);
  const article = item('https://example.com/original/?a=1&b=2', 'Titular de prueba', 'noticel', NOW - 20 * DAY);
  seed(sql, article);
  const entry = { url: article.url, clicks: 1, item: article, translation: null, capturedAt: NOW };
  const live = { items: [article], translations: {}, feeds: [], history: [], popular: [entry], hall: [entry] };
  const href = '/click?url='+encodeURIComponent(article.url);
  for (const path of ['/stats', '/hall']) {
    const html = await renderer.fetch(new Request(`https://news.dev.pr${path}?lang=${lang}`), live).text();
    expect(html.split(`href="${href}"`).length - 1).toBe(path === '/stats' ? 2 : 1);
    expect(html).not.toContain('href="https://example.com/original/');
    expect(globalRow(sql)?.clicks ?? 0).toBe(0);
  }
  for (const archived of [false, true]) {
    if (archived) sql.exec('DELETE FROM articles; DELETE FROM story_ids'); // archive-only fallback
    const head = await clickRoute(new Request('https://news.dev.pr'+href, { method: 'HEAD' }), DB, NOW);
    expect(head?.headers.get('Location')).toBe(article.url);
    expect(globalRow(sql)?.clicks ?? 0).toBe(archived ? 1 : 0);
    const get = await clickRoute(new Request('https://news.dev.pr'+href), DB, NOW);
    expect(get?.status).toBe(302);
    expect(get?.headers.get('Location')).toBe(article.url);
    expect(globalRow(sql)?.clicks).toBe(archived ? 2 : 1);
  }
  expect(perArticle(sql)).toEqual([{ url: article.url, clicks: 2 }]);
  sql.close();
});
