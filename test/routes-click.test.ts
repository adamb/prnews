import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/ingest';
import type { Item } from '../src/parse';

const NOW = Date.parse('2026-11-14T05:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function mkEnv() {
  const sql = new DatabaseSync(':memory:');
  for (const migration of ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0007_queue_history.sql', '0008_click_totals.sql']) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  let lastText = '';
  const DB = {
    prepare(text: string) {
      lastText = text;
      let args: any[] = [];
      return {
        bind(...v: any[]) { args = v; return this; },
        async first() { return sql.prepare(text).get(...args) ?? null; },
        async all() { return { results: sql.prepare(text).all(...args) }; },
        async run() { return { meta: { changes: Number(sql.prepare(text).run(...args).changes) } } },
      };
    },
    async batch(statements: any[]) { for (const s of statements) await s.run(); return { meta: { changes: 0 } }; },
  } as unknown as D1Database;
  const env: Env = { DB, CONTACT_EMAIL: 'contact@news.dev.pr' } as unknown as Env;
  return { sql, env, DB };
}

const item = (url: string, title = 'Titular', time = NOW - HOUR): Item =>
  ({ url, source: 'noticel', title, summary: 'Resumen.', image: '', time, observed: false, section: 'otras', reason: 'test' });

const seed = (sql: DatabaseSync, item: Item) =>
  sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)')
    .run(item.url, item.source, JSON.stringify(item), item.time, item.time, item.time);

it('serves the hall of fame through the worker with totals and honest empty state; other methods rejected', async () => {
  const { sql, env } = mkEnv();
  const empty = await worker.fetch(new Request('https://news.dev.pr/hall'), env).then(r => r.text());
  expect(empty).toContain('Salón de la fama');
  expect(empty).toContain('No se inventan clics ni popularidad');
  expect(empty).not.toContain('Titular'); // nothing fabricated before any click exists
  const aged = item('https://example.com/vieja/', 'Titular viejo', NOW - 15 * DAY);
  seed(sql, aged);
  for (let c = 0; c < 3; c++) await worker.fetch(new Request(`https://news.dev.pr/click?url=${encodeURIComponent(aged.url)}`), env);
  sql.prepare('DELETE FROM articles WHERE url=?').run(aged.url);
  const full = await worker.fetch(new Request('https://news.dev.pr/hall?lang=en'), env).then(r => r.text());
  expect(full).toContain('Titular viejo');
  expect(full).toContain('/click?url='+encodeURIComponent('https://example.com/vieja/'));
  expect(full).toContain('3 clicks · published more than 14 days ago');
  const method = await worker.fetch(new Request('https://news.dev.pr/hall', { method: 'POST' }), env);
  expect(method.status).toBe(405);
});

it('stats endpoint renders the click ledger and analytics failure state without per-request API calls', async () => {
  const { env } = mkEnv();
  const html = await worker.fetch(new Request('https://news.dev.pr/stats'), env).then(r => r.text());
  expect(html).toContain('Clics salientes');
  expect(html).toContain('Todavía no hay clics registrados'); // 0008 applied here, but a fresh install has no clicks yet
  expect(html).toContain('No disponible ahora'); // no token configured in this env: unavailable, not zero
  expect(html).toContain('dash.cloudflare.com');
  expect(html).not.toContain('reason'); // failure reasons stay server-side, nothing user-facing is faked
});

it('clicks through the worker endpoint count once per GET, skip HEAD, and survive expiry', async () => {
  const { sql, env } = mkEnv();
  const url = 'https://example.com/story/';
  seed(sql, item(url));
  const count = () => (sql.prepare('SELECT clicks FROM site_click_totals WHERE id=1').get() as { clicks: number }).clicks;
  const get = await worker.fetch(new Request(`https://news.dev.pr/click?url=${encodeURIComponent(url)}`, { redirect: 'manual' }), env);
  expect(get.status).toBe(302);
  expect(get.headers.get('Location')).toBe(url);
  await worker.fetch(new Request(`https://news.dev.pr/click?url=${encodeURIComponent(url)}`, { method: 'HEAD', redirect: 'manual' }), env);
  expect(count()).toBe(1); // HEAD never counts
  const homepage = await worker.fetch(new Request('https://news.dev.pr/'), env).then(r => r.text());
  expect(homepage).toContain('Lo más leído'); // rolling 24h most-read stays on the homepage (bottom placement)
  expect(homepage).toContain('Últimas 24 horas');
  sql.exec('DELETE FROM articles');
  const expired = await worker.fetch(new Request(`https://news.dev.pr/click?url=${encodeURIComponent(url)}`, { redirect: 'manual' }), env);
  expect(expired.status).toBe(302); // known archive destination still redirects and counts
  expect(count()).toBe(2);
});

