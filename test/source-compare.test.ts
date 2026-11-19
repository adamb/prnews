import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { discovery } from '../src/discovery';
import { feeds } from '../src/ingest';
import type { Item } from '../src/parse';
import renderer from '../src/render';
import { css } from '../src/styles';
import { astDay, buildComparison, clicksBySource, COMPARE_WINDOW_MS, renderComparison, type FeedSnap } from '../src/source-compare';

const NOW = Date.parse('2026-11-19T19:00:00Z'); // 15:00 AST
const DAY = 86400000;

function item(partial: Partial<Item> & { url: string; source: string; time?: number }): Item {
  return { title: 'Titular', summary: 'Un resumen.', image: '', time: NOW - 2 * DAY, observed: false, section: 'otras', reason: 'keywords', ...partial };
}

const endiOk: FeedSnap = { source: 'endi', last_ok: NOW - 3600000, error: null };
const nimbPaused: FeedSnap[] = [];

describe('captured-article comparison', () => {
  it('bins days in AST and marks the open and current days partial', () => {
    expect(astDay(Date.parse('2026-11-19T03:30:00Z'))).toBe('2026-11-18');
    expect(astDay(Date.parse('2026-11-19T04:30:00Z'))).toBe('2026-11-19');
    const report = buildComparison([], [endiOk], {}, NOW);
    expect(report.days[0]).toMatchObject({ key: '2026-11-05', partial: true });
    expect(report.days.at(-1)).toMatchObject({ key: '2026-11-19', partial: true });
    expect(report.days.filter(day => !day.partial).length).toBe(report.days.length - 2);
    const midnight = Date.parse('2026-11-19T04:00:00Z');
    const aligned = buildComparison([], [endiOk], {}, midnight);
    expect(aligned.days[0]).toMatchObject({ key: '2026-11-05', partial: false });
    expect(aligned.days.at(-1)).toMatchObject({ key: '2026-11-19', partial: true });
  });

  it('counts one canonical URL, keeps observed dates, and drops rows outside the window', () => {
    const late = Date.parse('2026-11-19T03:30:00Z');
    const report = buildComparison([
      item({ url: 'https://www.elnuevodia.com/a/', source: 'endi', time: late, observed: true, image: 'https://img.example/a.jpg' }),
      item({ url: 'https://www.elnuevodia.com/a/', source: 'endi', time: NOW - DAY, section: 'deportes', title: 'Segunda revisión' }),
      item({ url: 'https://www.elnuevodia.com/old/', source: 'endi', time: NOW - COMPARE_WINDOW_MS - 1000 }),
      item({ url: 'https://www.elnuevodia.com/future/', source: 'endi', time: NOW + DAY }),
      item({ url: 'https://example.test/mystery/', source: 'not-a-source', time: NOW - DAY }),
    ], [endiOk], { endi: 3 }, NOW);
    const endi = report.newsrooms.find(row => row.id === 'endi')!;
    expect(endi.total).toBe(1);
    expect(endi.observed).toBe(1);
    expect(endi.withImage).toBe(1);
    expect(endi.clicks).toBe(3);
    expect(endi.days.find(day => day.count)?.observed).toBe(1);
    expect(report.days[endi.days.findIndex(day => day.count)]?.key).toBe('2026-11-18');
    expect(report.unknown).toBe(1);
    expect(report.maxDay).toBe(1);
  });

  it('uses the section the page shows, not the stored section, and folds grouped topics', () => {
    const report = buildComparison([
      item({ url: 'https://www.elnuevodia.com/venta/', source: 'endi', title: 'Casas en venta en Condado', summary: 'El mercado inmobiliario sigue activo.', section: 'otras' }),
      item({ url: 'https://www.elnuevodia.com/bsn/', source: 'endi', title: 'BSN quarterfinals stay alive', summary: 'Santurce wins.', section: 'otras' }),
      item({ url: 'https://newsismybusiness.com/import/', source: 'nimb', title: 'Casas en venta', summary: 'Mercado inmobiliario.', section: 'deportes', reason: 'manual-import' }),
      item({ url: 'https://www.elnuevodia.com/opinion/', source: 'endi', title: 'Una columna', summary: 'Texto.', section: 'opinion', reason: 'manual-import' }),
      item({ url: 'https://www.elnuevodia.com/escuela/', source: 'endi', title: 'La escuela abre', summary: 'Educación.', section: 'educacion', reason: 'manual-import' }),
    ], [endiOk], {}, NOW);
    const endi = report.newsrooms.find(row => row.id === 'endi')!;
    const nimb = report.newsrooms.find(row => row.id === 'nimb')!;
    expect(endi.topics['bienes-raices']).toBe(1);
    expect(endi.topics.deportes).toBe(1);
    expect(endi.topics.otras).toBe(1);
    expect(endi.topics.salud).toBe(1);
    expect(endi.topics.educacion).toBeUndefined();
    expect(nimb.topics.deportes).toBe(1);
    expect(nimb.topics['bienes-raices']).toBe(0);
  });

  it('keeps Reddit out of the newsroom matrix and labels a title match separately', () => {
    const report = buildComparison([
      item({ url: 'https://www.reddit.com/r/PuertoRico/comments/abc123/police/', source: 'reddit_puertorico', title: 'Police arrest downtown', summary: '', section: 'comunidad', reason: 'community' }),
      item({ url: 'https://www.elnuevodia.com/police/', source: 'endi', title: 'Police arrest downtown', summary: 'Un arresto.', section: 'policiales', reason: 'manual-import' }),
    ], [endiOk, { source: 'reddit_puertorico', last_ok: NOW, error: null }], {}, NOW);
    const endi = report.newsrooms.find(row => row.id === 'endi')!;
    expect(endi.topics.policiales).toBe(1);
    expect(report.newsrooms.some(row => row.id === 'reddit_puertorico')).toBe(false);
    expect(report.community.total).toBe(1);
    expect(report.community.topics.policiales).toBe(0);
    expect(report.community.crossTopics.policiales).toBe(1);
    expect(report.maxDay).toBe(1);
  });

  it('shows a captured zero only after a successful check, and a dash when the feed is paused or unchecked', () => {
    const report = buildComparison([
      item({ url: 'https://newsismybusiness.com/one/', source: 'nimb', time: NOW - 3 * DAY }),
    ], [{ source: 'endi', last_ok: null, error: 'HTTP 500' }], null, NOW);
    const endi = report.newsrooms.find(row => row.id === 'endi')!;
    const nimb = report.newsrooms.find(row => row.id === 'nimb')!;
    expect(endi.status).toBe('unchecked');
    expect(endi.days.every(day => day.missing && day.count === 0)).toBe(true);
    expect(nimb.status).toBe('paused');
    expect(nimb.days.filter(day => day.count === 1)).toHaveLength(1);
    expect(nimb.days.filter(day => day.missing)).toHaveLength(nimb.days.length - 1);
    expect(endi.clicks).toBeNull();
    expect(report.clicksAvailable).toBe(false);
    const live = buildComparison([], [endiOk, { source: 'noticel', last_ok: NOW, error: 'boom' }, { source: 'noticel', last_ok: NOW, error: null }], {}, NOW);
    expect(live.newsrooms.find(row => row.id === 'endi')!.days.every(day => !day.missing && day.count === 0)).toBe(true);
    expect(live.newsrooms.find(row => row.id === 'noticel')!.status).toBe('mixed');
  });

  it('keeps days before Radio Isla and WALO were registered as dashes', () => {
    const checked = { last_ok: NOW, error: null };
    const report = buildComparison([
      item({ url: 'https://radioisla.tv/backfill/', source: 'radioisla', time: Date.parse('2026-11-18T18:00:00Z'), title: 'Una nota del 18' }),
    ], [endiOk, { source: 'radioisla', ...checked }, { source: 'walo', ...checked }], {}, NOW);
    const cell = (id: string, key: string) => {
      const row = report.newsrooms.find(entry => entry.id === id)!;
      return row.days[report.days.findIndex(day => day.key === key)];
    };
    expect(report.days[0].key).toBe('2026-11-05');
    expect(report.days.at(-1)!.key).toBe('2026-11-19');
    expect(cell('radioisla', '2026-11-18')).toMatchObject({ count: 1, missing: false });
    expect(cell('radioisla', '2026-11-05')).toMatchObject({ count: 0, missing: true });
    expect(cell('radioisla', '2026-11-19')).toMatchObject({ count: 0, missing: false });
    expect(cell('walo', '2026-11-05').missing).toBe(true);
    expect(cell('walo', '2026-11-19')).toMatchObject({ count: 0, missing: false });
    expect(cell('endi', '2026-11-05')).toMatchObject({ count: 0, missing: false });
    expect(cell('nimb', '2026-11-19').missing).toBe(true);
    const en = renderComparison(report, 'en');
    expect(en).toContain('Radio Isla 1320');
    expect(en).toContain('WALO 1240');
    expect(en).toContain('before this feed was registered');
    expect(en).toContain('November 19, 2026');
    const radio = en.slice(en.indexOf('data-source="radioisla"'), en.indexOf('data-source="walo"'));
    expect(radio).toContain('before this feed was registered, not a zero.');
    expect(radio).toContain('0 captured articles');
    const endi = en.slice(en.indexOf('data-source="endi"'), en.indexOf('data-source="', en.indexOf('data-source="endi"') + 1));
    expect(endi).not.toContain('before this feed was registered');
    const es = renderComparison(report, 'es');
    expect(es).toContain('antes de registrar el feed, no es un cero.');
    expect(es).toContain('19 de noviembre de 2026');
  });

  it('does not read archive revisions when summing redirects', async () => {
    const sql = new DatabaseSync(':memory:');
    for (const file of ['migrations/0001_live.sql', 'migrations/0002_archive.sql', 'migrations/0003_search_clicks.sql', 'migrations/0008_click_totals.sql']) sql.exec(readFileSync(file, 'utf8'));
    const payload = JSON.stringify({ title: 'Nota', summary: '', image: '' });
    const put = (url: string, source: string, time: number) => sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').run(url, source, payload, time, time, time);
    put('https://www.elnuevodia.com/a/', 'endi', NOW - DAY);
    put('https://www.elnuevodia.com/b/', 'endi', NOW - 2 * DAY);
    put('https://www.elnuevodia.com/old/', 'endi', NOW - COMPARE_WINDOW_MS - DAY);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run('https://www.elnuevodia.com/a/', 2, NOW);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run('https://www.elnuevodia.com/b/', 5, NOW);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run('https://www.elnuevodia.com/old/', 9, NOW);
    sql.prepare('INSERT INTO article_click_totals(url,clicks,updated_at) VALUES(?,?,?)').run('https://www.elnuevodia.com/archive-only/', 4, NOW);
    const DB = { prepare(text: string) { return { bind(...args: SQLInputValue[]) { return { async all() { return { results: sql.prepare(text).all(...args) }; } }; } }; } };
    let seen = '';
    const logging = { prepare(text: string) { seen = text; return DB.prepare(text); } };
    const counts = await clicksBySource({ DB: logging as unknown as D1Database }, NOW);
    expect(counts).toEqual({ endi: 7 });
    expect(seen).toContain('article_click_totals');
    expect(seen).not.toContain('archive_revisions');
    const missing = await clicksBySource({ DB: { prepare() { throw new Error('no such table: article_click_totals'); } } as unknown as D1Database }, NOW);
    expect(missing).toBeNull();
  });
});

describe('comparison page', () => {
  const live = {
    items: [
      item({ url: 'https://www.elnuevodia.com/a/', source: 'endi', image: 'https://img.example/a.jpg', title: 'Casas en venta en Condado', summary: 'Mercado inmobiliario.' }),
      item({ url: 'https://www.reddit.com/r/PuertoRico/comments/abc123/police_story/', source: 'reddit_puertorico', title: 'Police arrest downtown', summary: '', section: 'comunidad' as const, reason: 'community' }),
    ],
    translations: {},
    feeds: [endiOk, { source: 'reddit_puertorico', last_ok: NOW, error: 'D1_ERROR: zz-feed-leak' }] as never,
    sourceClicks: { endi: 4 },
  };

  it('renders a bilingual report with one chart per outlet, a topic table, and no feed errors', async () => {
    const es = await renderer.fetch(new Request('https://news.dev.pr/comparar'), live).text();
    const en = await renderer.fetch(new Request('https://news.dev.pr/comparar?lang=en'), live).text();
    for (const html of [es, en]) {
      expect(html).toContain('class="compare"');
      expect(html).toContain('class="compare-heat"');
      expect(html).toContain('role="radiogroup"');
      expect(html).toContain('data-mode="count"');
      expect(html).toContain('data-mode="pct"');
      expect(html).toContain('<table class="compare-table"');
      expect(html).toContain('scope="row"');
      expect(html).not.toContain('zz-feed-leak');
      expect(html).not.toContain('D1_ERROR');
      expect(html).not.toContain('Casas en venta');
      expect(html).not.toContain('market share');
      expect(html).not.toContain('cuota de mercado');
      expect(html).not.toContain('>CTR<');
      expect(html.match(/<svg viewBox="0 0 280 /g)?.length).toBe(html.match(/class="compare-chart"/g)!.length);
    }
    const charts = es.match(/class="compare-chart"/g) ?? [];
    expect(charts.length).toBe(es.match(/data-source="/g)!.length);
    expect(es).toContain('data-source="endi"');
    expect(es).toContain('data-source="reddit_puertorico"');
    expect(es.slice(es.indexOf('id="compare-topics"'), es.indexOf('id="compare-days"'))).not.toContain('Reddit');
    expect(es).toContain('>1<');
    expect(en).toContain('What we captured from each outlet');
    expect(en).toContain('>1<');
    expect(en).toContain('>4<');
    expect(en).toContain('no click-through rate');
    expect(es).toContain('ni tasa de clics');
    expect(es).toContain('día parcial');
    expect(en).toContain('partial day');
    const bare = await renderer.fetch(new Request('https://news.dev.pr/comparar?lang=en'), { items: [], translations: {}, feeds: [endiOk] as never, sourceClicks: null }).text();
    expect(bare).toContain('unavailable');
    expect(bare).toContain('>0<');
    expect(bare).toContain('El Nuevo Día');
    expect(bare).not.toContain('class="compare-bar full"');
  });

  it('links the report from Stats and keeps the imageless-lead rules', async () => {
    const stats = await renderer.fetch(new Request('https://news.dev.pr/stats?lang=en'), { items: [], translations: {}, feeds: [] }).text();
    expect(stats).toContain('class="compare-invite"');
    expect(stats).toContain('href="/comparar?lang=en"');
    expect(stats).toContain('Open the report');
    expect(css).toContain('.card.lead.noimg,.card.hero.noimg{display:grid');
    expect(css).toContain('.tiles>.card.lead:not(.noimg) .picture{aspect-ratio:16/9}');
    expect(css).not.toContain('.tiles>.card.lead .picture{aspect-ratio:16/9}');
    expect(css).toContain('@media(max-width:390px)');
    expect(css).toContain('@media(min-width:1100px)');
    expect(css).toContain('.compare-heat');
    const xml = await discovery(new Request('https://news.dev.pr/sitemap.xml'))!.text();
    expect(xml).toContain('https://news.dev.pr/comparar');
    expect(xml).toContain('https://news.dev.pr/comparar?lang=en');
    expect(feeds.nimb).toEqual([]);
    expect(feeds.endi[0]).toContain('size=100');
  });

  it('agrees the rendered table with the aggregation for a partial zero day', () => {
    const report = buildComparison([], [endiOk], {}, NOW);
    const html = renderComparison(report, 'es');
    expect(html).toContain('5 nov*');
    expect(html).toContain('19 nov*');
    expect(html).toContain('<td>0</td>');
    expect(html).not.toContain('archive_revisions');
  });
});
