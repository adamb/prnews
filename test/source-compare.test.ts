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
    expect(en).toContain('An article the feed still lists, with an earlier date, counts on that earlier day.');
    expect(en).not.toContain('Earlier days in this window are a dash');
    const endi = en.slice(en.indexOf('data-source="endi"'), en.indexOf('data-source="', en.indexOf('data-source="endi"') + 1));
    expect(endi).not.toContain('before this feed was registered');
    const es = renderComparison(report, 'es');
    expect(es).toContain('antes de registrar el feed, no es un cero.');
    expect(es).toContain('Si el feed trae una nota con fecha anterior, ese día muestra el número, no un guion.');
    expect(es).not.toContain('Los días anteriores en esta ventana son un guion');
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

  it('keeps the Counts and Percentage labels readable when that metric is selected', () => {
    const report = buildComparison([
      item({ url: 'https://www.elnuevodia.com/dep/', source: 'endi', section: 'deportes', reason: 'manual-import' }),
      item({ url: 'https://www.elnuevodia.com/pol/', source: 'endi', section: 'politica', reason: 'manual-import' }),
    ], [endiOk], {}, NOW);
    const en = renderComparison(report, 'en');
    const es = renderComparison(report, 'es');
    expect(modeLabels(en)).toEqual(['Counts', 'Percentage']);
    expect(modeLabels(es)).toEqual(['Conteos', 'Porcentaje']);
    expect(en).not.toContain('Share of that outlet');
    expect(es).not.toContain('Porcentaje del medio');
    expect(en).toContain('own mix, not its size against the others');
    expect(en).toContain('Rounded percentages may not total 100');
    expect(es).toContain('la mezcla de ese medio');
    expect(es).toContain('puede no sumar 100');
    expect(en).toContain('data-pct="50"');
    expect(en).toContain('>50%</span>');
    expect(en).toContain('>100%</span>');
    const clickAt = en.indexOf("btn.addEventListener('click'");
    const click = en.slice(clickAt, en.indexOf('compare-chart', clickAt));
    expect(click).toContain("setAttribute('aria-checked'");
    expect(click).not.toContain('textContent');
    // The old checked rule lost to this generic button rule, so color became --bg on a panel background.
    expect(specOf('main button:not(.lighter-ask):not(.ticker-pause)')).toEqual([0, 2, 2]);
    expect(specOf('.compare-mode button[aria-checked="true"]')).toEqual([0, 2, 1]);

    const states = [
      ['unselected', false, false, false, false, 'var(--ink)', 'var(--panel)'],
      ['unselected hover', false, true, false, false, 'var(--ink)', 'var(--panel)'],
      ['unselected focus', false, false, true, false, 'var(--ink)', 'var(--panel)'],
      ['unselected active', false, false, false, true, 'var(--ink)', 'var(--panel)'],
      ['selected', true, false, false, false, 'var(--bg)', 'var(--ink)'],
      ['selected hover', true, true, false, false, 'var(--bg)', 'var(--ink)'],
      ['selected focus', true, false, true, false, 'var(--bg)', 'var(--ink)'],
      ['selected active', true, false, false, true, 'var(--bg)', 'var(--ink)'],
    ] as const;
    for (const [name, checked, hover, focus, active, color, background] of states) {
      const paint = togglePaint({ checked, hover, focus, active });
      expect({ state: name, color: squash(paint.color), background: squash(paint.background) }).toEqual({ state: name, color, background });
      for (const theme of ['light', 'dark'] as const) {
        const tokens = themeTokens(theme);
        const fg = resolveColor(paint.color, tokens);
        const bg = resolveColor(paint.background, tokens);
        const ratio = contrast(fg, bg);
        expect({ state: name, theme, fg, bg, ratio: Math.round(ratio * 100) / 100 >= 4.5 }).toEqual({
          state: name, theme, fg, bg, ratio: true,
        });
      }
    }
  });
});

function modeLabels(html: string): string[] {
  const start = html.indexOf('class="compare-mode"');
  const group = html.slice(start, html.indexOf('</div>', start));
  return [...group.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
}

type Spec = [number, number, number];
type Compound = {
  tag: string;
  id: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
  pseudos: string[];
  nots: Compound[];
  pseudoElement: boolean;
};
type Part = { comb: '' | ' ' | '>' | '+' | '~'; compound: Compound };
type El = { tag: string; id: string; classes: string[]; attrs: Record<string, string>; pseudos: Set<string> };
type Decl = { value: string; important: boolean; spec: Spec; index: number };
type CssRule = { parts: Part[]; decls: Record<string, { value: string; important: boolean }>; spec: Spec; index: number };

function squash(value: string): string {
  return value.replace(/\s+/g, '');
}

function specOf(selector: string): Spec {
  return specificity(tokenize(selector));
}

function themeTokens(theme: 'light' | 'dark'): Record<string, string> {
  const block = css.match(/@supports \(color:light-dark\(#000,#fff\)\)\{:root\{([^}]+)\}/)?.[1];
  if (!block) throw new Error('missing light-dark tokens');
  const tokens: Record<string, string> = {};
  for (const name of ['--bg', '--panel', '--ink']) {
    const found = block.match(new RegExp(`${name}:light-dark\\((#[0-9a-fA-F]{3,8}),(#[0-9a-fA-F]{3,8})\\)`));
    if (!found) throw new Error(`missing ${name}`);
    tokens[name] = theme === 'light' ? found[1] : found[2];
  }
  return tokens;
}

function resolveColor(value: string, tokens: Record<string, string>): string {
  const match = squash(value).match(/^var\((--[\w-]+)\)$/);
  if (!match || !tokens[match[1]]) throw new Error(`unresolved color ${value}`);
  return tokens[match[1]];
}

function contrast(foreground: string, background: string): number {
  const lum = (hex: string) => {
    const raw = hex.slice(1);
    const full = raw.length === 3 ? raw.split('').map(ch => ch + ch).join('') : raw;
    const channel = (n: number) => {
      const s = n / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const r = channel(parseInt(full.slice(0, 2), 16));
    const g = channel(parseInt(full.slice(2, 4), 16));
    const b = channel(parseInt(full.slice(4, 6), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(foreground), lum(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function togglePaint(state: { checked: boolean; hover: boolean; focus: boolean; active: boolean }): { color: string; background: string } {
  const button: El = {
    tag: 'button',
    id: '',
    classes: [],
    attrs: { type: 'button', role: 'radio', 'aria-checked': state.checked ? 'true' : 'false', 'data-mode': state.checked ? 'pct' : 'count' },
    pseudos: new Set([state.hover ? 'hover' : '', state.focus ? 'focus-visible' : '', state.active ? 'active' : ''].filter(Boolean)),
  };
  const ancestors: El[] = [
    { tag: 'div', id: '', classes: ['compare-mode'], attrs: { role: 'radiogroup' }, pseudos: new Set() },
    { tag: 'div', id: '', classes: ['compare-head'], attrs: {}, pseudos: new Set() },
    { tag: 'section', id: '', classes: [], attrs: { 'aria-labelledby': 'compare-topics' }, pseudos: new Set() },
    { tag: 'div', id: '', classes: ['compare'], attrs: { 'data-mode': state.checked ? 'pct' : 'count' }, pseudos: new Set() },
    { tag: 'main', id: 'contenido', classes: [], attrs: {}, pseudos: new Set() },
    { tag: 'body', id: '', classes: [], attrs: {}, pseudos: new Set() },
    { tag: 'html', id: '', classes: [], attrs: {}, pseudos: new Set() },
  ];
  const rules = parseCss(css).filter(rule => matches(rule.parts, button, ancestors));
  const color = winner(rules, 'color');
  const background = winner(rules, 'background');
  if (!color || !background) throw new Error(`toggle paint missing color or background (${rules.length} matching rules)`);
  return { color: color.value, background: background.value };
}

function winner(rules: CssRule[], prop: string): Decl | undefined {
  let best: Decl | undefined;
  for (const rule of rules) {
    const decl = rule.decls[prop];
    if (!decl) continue;
    const next = { ...decl, spec: rule.spec, index: rule.index };
    if (!best || beats(next, best)) best = next;
  }
  return best;
}

function beats(next: Decl, prev: Decl): boolean {
  if (next.important !== prev.important) return next.important;
  for (let i = 0; i < 3; i++) if (next.spec[i] !== prev.spec[i]) return next.spec[i] > prev.spec[i];
  return next.index >= prev.index;
}

function parseCss(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let index = 0;
  const walk = (body: string) => {
    let i = 0;
    while (i < body.length) {
      while (i < body.length && /\s/.test(body[i])) i++;
      if (i >= body.length) break;
      const open = body.indexOf('{', i);
      if (open < 0) break;
      const selector = body.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < body.length && depth) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        j++;
      }
      const inner = body.slice(open + 1, j - 1);
      if (selector.startsWith('@')) {
        if (/^@(media|supports)\b/.test(selector)) walk(inner);
      } else if (selector) {
        const decls: CssRule['decls'] = {};
        for (const part of inner.split(';')) {
          const colon = part.indexOf(':');
          if (colon < 0) continue;
          const prop = part.slice(0, colon).trim().toLowerCase();
          let value = part.slice(colon + 1).trim();
          const important = /!important\s*$/.test(value);
          if (important) value = value.replace(/!important\s*$/, '').trim();
          if (prop) decls[prop] = { value, important };
        }
        for (const one of splitSelectors(selector)) {
          const parts = tokenize(one);
          rules.push({ parts, decls, spec: specificity(parts), index });
        }
        index++;
      }
      i = j;
    }
  };
  walk(text);
  return rules;
}

function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  out.push(selector.slice(start));
  return out.map(item => item.trim()).filter(Boolean);
}

function tokenize(selector: string): Part[] {
  const parts: { comb: Part['comb']; raw: string }[] = [];
  let buf = '';
  let comb: Part['comb'] = '';
  let depth = 0;
  const push = () => {
    if (buf.trim()) parts.push({ comb, raw: buf.trim() });
    buf = '';
  };
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~' || ch === ' ' || ch === '\n' || ch === '\t')) {
      if (ch === ' ' || ch === '\n' || ch === '\t') {
        if (buf.trim()) {
          push();
          comb = ' ';
        }
        continue;
      }
      push();
      comb = ch;
      continue;
    }
    buf += ch;
  }
  push();
  return parts.map(part => ({ comb: part.comb, compound: parseCompound(part.raw) }));
}

function parseCompound(raw: string): Compound {
  const compound: Compound = { tag: '', id: '', classes: [], attrs: [], pseudos: [], nots: [], pseudoElement: false };
  const re = /::[-:\w]+|:not\(([^)]*)\)|:([-\w]+)|\.([-\w]+)|#([-\w]+)|\[([^\]]+)\]|([a-zA-Z][\w-]*)|\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    if (match.index !== last) throw new Error(`unparsed "${raw.slice(last, match.index)}" in "${raw}"`);
    last = match.index + match[0].length;
    if (match[0].startsWith('::')) compound.pseudoElement = true;
    else if (match[0].startsWith(':not')) compound.nots.push(parseCompound(match[1]));
    else if (match[2]) compound.pseudos.push(match[2]);
    else if (match[3]) compound.classes.push(match[3]);
    else if (match[4]) compound.id = match[4];
    else if (match[5]) compound.attrs.push(parseAttr(match[5]));
    else if (match[6]) compound.tag = match[6];
  }
  if (last !== raw.length) throw new Error(`unparsed tail "${raw.slice(last)}" in "${raw}"`);
  return compound;
}

function parseAttr(raw: string): { name: string; value?: string } {
  const eq = raw.indexOf('=');
  if (eq < 0) return { name: raw.trim() };
  let value = raw.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return { name: raw.slice(0, eq).replace(/[~|^$*]$/, '').trim(), value };
}

function specificity(parts: Part[]): Spec {
  const spec: Spec = [0, 0, 0];
  const add = (compound: Compound) => {
    if (compound.id) spec[0]++;
    spec[1] += compound.classes.length + compound.attrs.length + compound.pseudos.length;
    if (compound.tag) spec[2]++;
    for (const not of compound.nots) add(not);
  };
  for (const part of parts) add(part.compound);
  return spec;
}

function matches(parts: Part[], element: El, ancestors: El[]): boolean {
  const rec = (partIndex: number, node: El, nodeAncestors: El[]): boolean => {
    if (!matchesCompound(parts[partIndex].compound, node)) return false;
    if (partIndex === 0) return true;
    const comb = parts[partIndex].comb;
    if (comb === '>') {
      const parent = nodeAncestors[0];
      return !!parent && rec(partIndex - 1, parent, nodeAncestors.slice(1));
    }
    if (comb !== ' ' && comb !== '') return false;
    for (let i = 0; i < nodeAncestors.length; i++) {
      if (rec(partIndex - 1, nodeAncestors[i], nodeAncestors.slice(i + 1))) return true;
    }
    return false;
  };
  return parts.length > 0 && rec(parts.length - 1, element, ancestors);
}

function matchesCompound(compound: Compound, element: El): boolean {
  if (compound.pseudoElement) return false;
  if (compound.tag && compound.tag !== element.tag) return false;
  if (compound.id && compound.id !== element.id) return false;
  if (!compound.classes.every(name => element.classes.includes(name))) return false;
  for (const attr of compound.attrs) {
    if (!(attr.name in element.attrs)) return false;
    if (attr.value !== undefined && element.attrs[attr.name] !== attr.value) return false;
  }
  if (!compound.pseudos.every(name => element.pseudos.has(name))) return false;
  return compound.nots.every(not => !matchesCompound(not, element));
}
