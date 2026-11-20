import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { XMLValidator } from 'fast-xml-parser';
import renderer from '../src/render';
import { discovery } from '../src/discovery';
import { sitemapRoute, storyPermalink, type SyndicationEnv } from '../src/syndication';
import type { Item } from '../src/parse';
import type { Translation } from '../src/i18n';

const headOf = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
const html = async (path: string, extra: Record<string, unknown> = {}) =>
  headOf(await (await renderer.fetch(new Request('https://news.dev.pr' + path), { items: [], translations: {}, feeds: [], ...extra })).text());

const ORIGIN = 'https://news.dev.pr';
const alternate = (lang: string, href: string) => `<link rel="alternate" hreflang="${lang}" href="${href}">`;
const pair = (es: string, en: string) =>
  alternate('es', es) + alternate('en', en) + alternate('x-default', es);

describe('hreflang and canonical', () => {
  it('points the Spanish and English home at each other, with x-default on the Spanish URL', async () => {
    const es = await html('/');
    const en = await html('/?lang=en');
    const links = pair(`${ORIGIN}/`, `${ORIGIN}/?lang=en`);
    expect(es).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
    expect(es).toContain(links);
    expect(en).toContain(`<link rel="canonical" href="${ORIGIN}/?lang=en">`);
    expect(en).toContain(links);
    expect(es).not.toContain('lang=es');
    expect(es).not.toContain('name="robots"');
    expect(en).not.toContain('name="robots"');
    expect(es.match(/rel="canonical"/g)).toHaveLength(1);
    expect(en.match(/rel="alternate"/g)).toHaveLength(3);
  });

  it('uses the same pair on a section, and canonicalizes pagination to that page', async () => {
    const es = await html('/s/politica');
    const en = await html('/s/politica?lang=en');
    const links = pair(`${ORIGIN}/s/politica`, `${ORIGIN}/s/politica?lang=en`);
    expect(es).toContain(`<link rel="canonical" href="${ORIGIN}/s/politica">`);
    expect(es).toContain(links);
    expect(en).toContain(`<link rel="canonical" href="${ORIGIN}/s/politica?lang=en">`);
    expect(en).toContain(links);
    const page = await html('/s/politica?page=2&utm_source=x');
    const pageEn = await html('/s/politica?utm_campaign=1&lang=en&page=2');
    const pageLinks = pair(`${ORIGIN}/s/politica?page=2`, `${ORIGIN}/s/politica?lang=en&amp;page=2`);
    expect(page).toContain(`<link rel="canonical" href="${ORIGIN}/s/politica?page=2">`);
    expect(page).toContain(pageLinks);
    expect(pageEn).toContain(`<link rel="canonical" href="${ORIGIN}/s/politica?lang=en&amp;page=2">`);
    expect(pageEn).toContain(pageLinks);
    expect(await html('/s/politica?page=1')).toContain(`<link rel="canonical" href="${ORIGIN}/s/politica">`);
    expect(await html('/?lang=es&fbclid=abc')).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
    expect(await html('/?lang=en&utm_source=newsletter')).toContain(`<link rel="canonical" href="${ORIGIN}/?lang=en">`);
  });

  it('adds hreflang beside the story canonical, and omits English when that edition is unavailable', async () => {
    const item: Item = {
      url: 'https://example.org/noticel/horario', source: 'noticel', title: 'Titular con & "comillas"', summary: 'Extracto.',
      image: '', time: Date.now(), observed: false, section: 'politica', reason: 'test',
    };
    const english: Translation = { originalTitle: item.title, originalSummary: item.summary, title: 'Headline', summary: 'Excerpt.' };
    const spanish = await html('/story?id=7', { items: [item], story: true, storyIds: { [item.url]: 7 } });
    expect(spanish.match(/rel="canonical"/g)).toHaveLength(1);
    expect(spanish).toContain(`<link rel="canonical" href="${ORIGIN}/story?id=7">`);
    expect(spanish).toContain(alternate('es', `${ORIGIN}/story?id=7`));
    expect(spanish).toContain(alternate('x-default', `${ORIGIN}/story?id=7`));
    expect(spanish).not.toContain('hreflang="en"');
    expect(spanish).toContain('property="og:title"');
    const unavailable = await renderer.fetch(new Request(`${ORIGIN}/story?id=7&lang=en`), { items: [item], translations: {}, feeds: [], story: true });
    expect(unavailable.status).toBe(404);
    const unavailableHead = headOf(await unavailable.text());
    expect(unavailableHead).not.toContain('rel="alternate"');
    expect(unavailableHead).not.toContain('rel="canonical"');

    const ready = { items: [item], translations: { [item.url]: english }, story: true, storyIds: { [item.url]: 7 } };
    const es = await html('/story?id=7', ready);
    const en = await html('/story?id=7&lang=en', ready);
    const links = pair(`${ORIGIN}/story?id=7`, `${ORIGIN}/story?id=7&amp;lang=en`);
    expect(es).toContain(links);
    expect(en).toContain(links);
    expect(en.match(/rel="canonical"/g)).toHaveLength(1);
    expect(en).toContain(`<link rel="canonical" href="${ORIGIN}/story?id=7&amp;lang=en">`);
    expect(es).not.toContain('name="robots"');
    expect(en).not.toContain('name="robots"');
  });

  it('keeps the other public pages indexable in both editions', async () => {
    const archive = { rows: [], next: null, date: '' };
    for (const path of ['/about', '/fuentes', '/comparar', '/signup', '/archive']) {
      const es = await html(path, path === '/archive' ? { archive } : {});
      const en = await html(path + '?lang=en', path === '/archive' ? { archive } : {});
      expect(es, path).toContain(`<link rel="canonical" href="${ORIGIN}${path}">`);
      expect(es, path).toContain(pair(`${ORIGIN}${path}`, `${ORIGIN}${path}?lang=en`));
      expect(en, path).toContain(`<link rel="canonical" href="${ORIGIN}${path}?lang=en">`);
      expect(es, path).not.toContain('name="robots"');
      expect(en, path).not.toContain('name="robots"');
    }
  });
});

describe('noindex', () => {
  const robots = '<meta name="robots" content="noindex,follow">';

  it('marks a source filter and every search page noindex, and leaves them crawlable', async () => {
    for (const path of ['/?source=noticel', '/?source=noticel&lang=en', '/s/politica?source=noticel', '/search', '/search?q=luz&lang=en&page=2']) {
      const head = await html(path);
      expect(head, path).toContain(robots);
      expect(head, path).not.toContain('rel="canonical"');
      expect(head, path).not.toContain('rel="alternate"');
    }
    const home = await html('/');
    expect(home).not.toContain('name="robots"');
    expect(home).toContain('rel="canonical"');
  });

  it('marks stats, the hall, and a filtered archive noindex without blocking the plain pages', async () => {
    const archive = { rows: [], next: null, date: '2026-11-01' };
    const hall = await html('/hall?lang=en', { hall: [] });
    const stats = await html('/stats');
    const dated = await html('/archive?date=2026-11-01&lang=en', { archive });
    const older = await html('/archive?before=10', { archive });
    for (const head of [hall, stats, dated, older]) {
      expect(head).toContain(robots);
      expect(head).not.toContain('rel="canonical"');
    }
    const plain = await html('/archive?lang=en', { archive: { rows: [], next: null, date: '' } });
    expect(plain).not.toContain('name="robots"');
    expect(plain).toContain(`<link rel="canonical" href="${ORIGIN}/archive?lang=en">`);
  });
});

describe('sitemap alternates', () => {
  const NOW = Date.parse('2026-11-14T05:00:00Z');

  function setup() {
    const sql = new DatabaseSync(':memory:');
    for (const migration of ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql']) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
    function prepare(text: string): any {
      let args: any[] = [];
      return { bind(...v: any[]) { args = v; return this; }, async first() { return sql.prepare(text).get(...args) ?? null; }, async all() { return { results: sql.prepare(text).all(...args) }; }, async run() { return { meta: { changes: Number(sql.prepare(text).run(...args).changes) } }; } };
    }
    const DB = { prepare, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
    return { sql, env: { DB } as SyndicationEnv };
  }

  const item = (url: string, title: string, source = 'noticel'): Item =>
    ({ url, source, title, summary: 'Resumen.', image: '', time: NOW - 3_600_000, observed: false, section: 'otras', reason: 'test' });

  function seed(sql: DatabaseSync, entry: Item, translation: Translation | null = null) {
    sql.prepare('INSERT INTO articles(url,source,payload,translation,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?,?)')
      .run(entry.url, entry.source, JSON.stringify(entry), translation ? JSON.stringify(translation) : null, entry.time, entry.time, entry.time);
    return (sql.prepare('SELECT id FROM story_ids WHERE url=?').get(entry.url) as { id: number }).id;
  }

  it('validates as XML, lists English story URLs only when that page returns 200, and keeps robots.txt open', async () => {
    const { sql, env } = setup();
    const spanish = item('https://example.com/es/', 'Solo español');
    const translated = item('https://example.com/both/', 'Titular original');
    const english = item('https://example.com/en/', 'Already English', 'sjds');
    const stale = item('https://example.com/stale/', 'Sin cambio');
    const esId = seed(sql, spanish);
    const bothId = seed(sql, translated, { originalTitle: translated.title, originalSummary: translated.summary, title: 'Original headline', summary: 'English summary.' });
    const enId = seed(sql, english);
    const staleId = seed(sql, stale, { originalTitle: stale.title, originalSummary: stale.summary, title: stale.title, summary: stale.summary });

    const response = await sitemapRoute(new Request(`${ORIGIN}/sitemap.xml`), env, NOW);
    const xml = await response!.text();
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="es"');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="en"');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="x-default"');
    expect(xml).not.toContain('example.com/');
    expect(xml).not.toContain('/search');
    expect(xml).not.toContain('source=');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;|apos;)/);

    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]!);
    const storyLocs = locs.filter(loc => loc.includes('/story?'));
    expect(storyLocs).toContain(storyPermalink(ORIGIN, esId));
    expect(storyLocs).not.toContain(`${storyPermalink(ORIGIN, esId)}&amp;lang=en`);
    expect(storyLocs).toContain(storyPermalink(ORIGIN, bothId));
    expect(storyLocs).toContain(`${storyPermalink(ORIGIN, bothId)}&amp;lang=en`);
    expect(storyLocs).toContain(`${storyPermalink(ORIGIN, enId)}&amp;lang=en`);
    expect(storyLocs).not.toContain(`${storyPermalink(ORIGIN, staleId)}&amp;lang=en`);
    const home = locs.filter(loc => loc === `${ORIGIN}/` || loc === `${ORIGIN}/?lang=en`);
    expect(home).toEqual([`${ORIGIN}/`, `${ORIGIN}/?lang=en`]);
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/"/>`);
    expect(xml).toContain(`<loc>${ORIGIN}/signup?lang=en</loc>`);

    const fallback = await discovery(new Request(`${ORIGIN}/sitemap.xml`))!.text();
    expect(XMLValidator.validate(fallback)).toBe(true);
    expect(fallback).toContain('<xhtml:link rel="alternate" hreflang="en"');
    expect(fallback).toContain(`${ORIGIN}/signup?lang=en`);
    expect(fallback).not.toContain('/story?');
    const staticLocs = locs.filter(loc => !loc.includes('/story?'));
    const fallbackLocs = [...fallback.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]!);
    expect(fallbackLocs).toEqual(staticLocs);

    const robots = await discovery(new Request(`${ORIGIN}/robots.txt`))!.text();
    expect(robots).toBe(`User-agent: *\nAllow: /\nDisallow: /internal/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
    for (const path of ['/search', '/stats', '/hall', '/alerts', '/archive']) expect(robots).not.toContain(path);
  });
});
