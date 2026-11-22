import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ftsQuery, highlight, parseSearchTerms, SEARCH_PAGE_SIZE, searchArticles, type SearchEnv } from '../src/search';
import type { Item } from '../src/parse';

const NOW = Date.parse('2026-11-14T05:00:00Z');
const HOUR = 3_600_000;

function setup() {
  const sql = new DatabaseSync(':memory:');
  for (const migration of ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql']) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  function prepare(text: string): any { let args: any[] = []; return { bind(...v: any[]) { args = v; return this; }, async first() { return sql.prepare(text).get(...args) ?? null; }, async all() { return { results: sql.prepare(text).all(...args) }; }, async run() { return { meta: { changes: Number(sql.prepare(text).run(...args).changes) } }; } }; }
  const d1 = { prepare, async batch(s: any[]) { return Promise.all(s.map(i => i.run())); } } as unknown as D1Database;
  return { sql, DB: { DB: d1 } as SearchEnv, d1 };
}

const item = (url: string, title: string, summary: string, source = 'noticel', time = NOW - HOUR): Item =>
  ({ url, source, title, summary, image: '', time, observed: false, section: 'otras', reason: 'test' });

function seed(sql: DatabaseSync, item: Item, translation?: object) {
  sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at,translation) VALUES(?,?,?,?,?,?,?)')
    .run(item.url, item.source, JSON.stringify(item), item.time, item.time, item.time, translation ? JSON.stringify(translation) : null);
}

const titles = (r: { items: Item[] }) => r.items.map(i => i.title);

it('maintains the FTS index across inserts, valid translations, stale payloads and deletes', async () => {
  const { sql, DB } = setup();
  const a = item('https://example.com/apagon/', 'Apagón en Piñones', 'Restauran el servicio de LUMA en el área este.');
  seed(sql, a);
  expect(titles(await searchArticles(DB, { q: 'apagón' }, NOW))).toEqual(['Apagón en Piñones']);
  expect(titles(await searchArticles(DB, { q: 'APAGÓN' }, NOW)).length).toBe(1);
  const translation = { originalTitle: a.title, originalSummary: a.summary, title: 'Power outage in Piñones', summary: 'LUMA service restored in the east.' };
  sql.prepare('UPDATE articles SET translation=? WHERE url=?').run(JSON.stringify(translation), a.url);
  const results = await searchArticles(DB, { q: 'power outage' }, NOW);
  expect(titles(results)).toEqual(['Apagón en Piñones']);
  expect(results.terms).toEqual(['power', 'outage']);
  expect(results.engine).toBe('fts');
  sql.prepare('UPDATE articles SET payload=? WHERE url=?').run(JSON.stringify({ ...a, title: 'Apagón en Ponce' }), a.url);
  expect(await searchArticles(DB, { q: 'power outage' }, NOW)).toMatchObject({ items: [] }); // stale translation is no longer indexed
  expect(titles(await searchArticles(DB, { q: 'ponce' }, NOW))).toEqual(['Apagón en Ponce']);
  expect(titles(await searchArticles(DB, { q: 'piñones' }, NOW))).toEqual([]); // FTS rows follow the article, not the history
  sql.prepare('DELETE FROM articles WHERE url=?').run(a.url);
  expect(await searchArticles(DB, { q: 'ponce' }, NOW)).toMatchObject({ items: [] });
  const fts = sql.prepare('SELECT COUNT(*) AS n FROM articles_fts').get() as { n: number };
  expect(fts.n).toBe(0);
});

it('matches search over original text, translated text and excerpts', async () => {
  const { sql, DB } = setup();
  const a = item('https://example.com/a/', 'Junta aprueba presupuesto', 'El presupuesto incluye al Negociado de Energía.');
  seed(sql, a, { originalTitle: a.title, originalSummary: a.summary, title: 'Board approves budget', summary: 'The budget includes the Energy Bureau.' });
  const results = await searchArticles(DB, { q: 'presupuesto' }, NOW);
  expect(results.translations[a.url]).toMatchObject({ title: 'Board approves budget' });
  expect(titles(await searchArticles(DB, { q: 'energy bureau' }, NOW)).length).toBe(1);
  expect(titles(await searchArticles(DB, { q: 'luma' }, NOW)).length).toBe(0);
});

it('reduces user queries to safe tokens that cannot inject FTS or SQL', async () => {
  expect(parseSearchTerms('"luma" (apagón) OR *')).toEqual(['luma', 'apagón', 'OR']);
  expect(ftsQuery(['a', 'b'])).toBe('"a" "b"');
  const { sql, DB } = setup();
  expect(ftsQuery(parseSearchTerms("'; DROP TABLE articles; --"))).toBe('"DROP" "TABLE" "articles"');
  const before = (sql.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n;
  expect(await searchArticles(DB, { q: "'; DROP TABLE articles; --" }, NOW)).toMatchObject({ items: [], engine: 'fts' });
  expect((sql.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n).toBe(before);
  expect(await searchArticles(DB, { q: '   &  ^  : * ( ) ' }, NOW)).toMatchObject({ engine: 'filter' }); // no usable tokens
  expect(await searchArticles(DB, { q: '"' }, NOW)).toMatchObject({ engine: 'filter' });
});

it('applies source and English-readable filters (sjds/nimb or a valid translation)', async () => {
  const { sql, DB } = setup();
  const plain = item('https://example.com/plain/', 'Titular en español', 'Resumen.', 'noticel');
  const valid = item('https://example.com/valid/', 'Otro titular', 'Resumen.', 'noticel');
  const stale = item('https://example.com/stale/', 'Titular viejo', 'Resumen.', 'metro');
  seed(sql, plain);
  seed(sql, valid, { originalTitle: valid.title, originalSummary: valid.summary, title: 'Valid English', summary: 'English summary.' });
  seed(sql, stale, { originalTitle: 'Different original', originalSummary: 'Different summary', title: 'Stale English', summary: 'Stale summary.' });
  seed(sql, item('https://example.com/en/', 'English headline', 'English summary.', 'sjds'));
  const english = await searchArticles(DB, { english: true }, NOW);
  expect(titles(english).sort()).toEqual(['English headline', 'Otro titular']);
  expect(titles(await searchArticles(DB, { english: true, source: 'noticel' }, NOW))).toEqual(['Otro titular']);
  expect(titles(await searchArticles(DB, { source: 'sjds' }, NOW))).toEqual(['English headline']);
  expect(titles(await searchArticles(DB, { source: 'no-such-source' }, NOW)).length).toBe(4); // unknown ids are ignored
  expect(titles(await searchArticles(DB, { q: 'stale english' }, NOW)).length).toBe(0); // stale translation is not searchable either way
});

it('defaults to all history with optional recent filtering, pagination and newest-first ordering', async () => {
  const { sql, DB } = setup();
  for (let i = 0; i < 31; i++) seed(sql, item(`https://example.com/p${i}/`, `Página ${i}`, 'Resumen.', 'noticel', NOW - (i + 1) * HOUR));
  seed(sql, item('https://example.com/boundary/', 'Límite', 'Resumen.', 'noticel', NOW - 14 * 24 * HOUR)); // inside, exactly 14 days
  seed(sql, item('https://example.com/expired/', 'Expirada', 'Resumen.', 'noticel', NOW - 15 * 24 * HOUR));
  expect(SEARCH_PAGE_SIZE).toBe(30);
  const page1 = await searchArticles(DB, {}, NOW);
  expect(page1.items.length).toBe(30);
  expect(page1.hasNext).toBe(true);
  expect(page1.items[0].time).toBe(NOW - HOUR);
  const page2 = await searchArticles(DB, { page: 2 }, NOW);
  expect(titles(page2).sort()).toEqual(['Expirada', 'Límite', 'Página 30']);
  expect(titles(await searchArticles(DB, {page:2, range:'recent', source:'noticel'}, NOW)).sort()).toEqual(['Límite', 'Página 30']);
  expect(titles(await searchArticles(DB, {q:'Expirada'}, NOW))).toEqual(['Expirada']);
  expect(page2.hasNext).toBe(false);
  expect((await searchArticles(DB, { page: 999 }, NOW)).items.length).toBe(0);
  for (const invalid of [0, -1, undefined, NaN]) expect((await searchArticles(DB, { page: invalid as number }, NOW)).page).toBe(1);
  expect((await searchArticles(DB, { page: 2579 }, NOW)).page).toBe(50); // hard offset cap
});

it('falls back to escaped LIKE search when FTS is unavailable', async () => {
  const { sql, DB } = setup();
  const a = item('https://example.com/like/', 'Junta aprueba presupuesto', 'El presupuesto incluye al Negociado de Energía.');
  seed(sql, a, { originalTitle: a.title, originalSummary: a.summary, title: 'Board approves budget', summary: 'The budget includes the Energy Bureau.' });
  seed(sql, item('https://example.com/like2/', 'Solo español', 'Sin traducción.'));
  for (const trigger of ['articles_fts_add', 'articles_fts_del', 'articles_fts_upd']) sql.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  sql.exec('DROP TABLE articles_fts');
  const results = await searchArticles(DB, { q: 'presupuesto' }, NOW);
  expect(results.engine).toBe('like');
  expect(titles(results)).toEqual(['Junta aprueba presupuesto']);
  expect(titles(await searchArticles(DB, { q: 'energy bureau' }, NOW))).toEqual(['Junta aprueba presupuesto']); // valid translated text still matches
  expect(await searchArticles(DB, { q: 'aprobación' }, NOW)).toMatchObject({ items: [] });
});

it('highlights matches without ever emitting raw HTML', () => {
  const text = '<script>alert(1)</script> Apagón & más en Piñones';
  const html = highlight(text, ['apagón', 'piñones']);
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('<mark>Apagón</mark>');
  expect(html).toContain('<mark>Piñones</mark>');
  expect(html).toContain('&amp; más');
  expect(highlight('Todo bien', [])).toBe('Todo bien');
  expect(highlight('<b>todo</b> corta', ['corta', 'a'])).toBe('&lt;b&gt;todo&lt;/b&gt; <mark>corta</mark>'); // terms shorter than 2 chars are ignored
  expect(highlight('sin coincidencia', ['luma'])).toBe('sin coincidencia');
});

it('restores deleted historical copies with searchable text and original watermarks', async () => {
 const {sql,DB}=setup();
 const old=item('https://example.com/old','Histórico único','Resumen','noticel',NOW-365*24*HOUR);
 seed(sql,old);
 sql.prepare('DELETE FROM articles WHERE url=?').run(old.url);
 for(const name of ['0009_alerts.sql','0013_owner_signup_notice.sql','0018_history.sql']) sql.exec(readFileSync('migrations/'+name,'utf8'));
 expect(titles(await searchArticles(DB,{q:'Histórico'},NOW))).toEqual(['Histórico único']);
 expect((await searchArticles(DB,{q:'Histórico',range:'recent'},NOW)).items).toEqual([]);
 expect(sql.prepare('SELECT first_seen FROM articles WHERE url=?').get(old.url)!.first_seen).toBe(old.time);
});
