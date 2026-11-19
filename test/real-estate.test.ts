import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { discovery } from '../src/discovery';
import { feeds } from '../src/ingest';
import { parseFeed, type Item } from '../src/parse';
import { redditTopic } from '../src/reddit';
import renderer from '../src/render';
import { sources } from '../src/sources';
import { sitemapRoute, type SyndicationEnv } from '../src/syndication';
import { clickRoute, totalClicks, type ClickEnv } from '../src/trending';

const seen = Date.parse('2026-11-14T04:30:00Z');
const rioUrl = 'https://www.elnuevodia.com/negocios/bienes-raices/notas/mansion-costera-en-rio-grande-se-vende-por-27-millones/';
const bahiaTitle = 'Bahia Beach property sells for $28.5 million';

function story(partial: Partial<Item> & Pick<Item, 'url' | 'title' | 'source'>): Item {
 return { summary: 'Resumen.', image: '', time: seen, observed: false, section: 'negocios', reason: 'keywords', ...partial };
}

it('classifies saved property, crime, and home-fire fixtures without new publishers', () => {
 const endi = sources.find(s => s.id === 'endi')!;
 const parsed = parseFeed(readFileSync(`test/fixtures/${endi.files[0]}`, 'utf8'), endi, seen);
 const rio = parsed.find(i => i.url === rioUrl);
 expect(rio?.section).toBe('bienes-raices');
 expect(rio?.reason).toBe('url');
 expect(parsed.find(i => i.title.includes('hogar de cuido'))?.section).toBe('policiales');
 const wapa = sources.find(s => s.id === 'wapa')!;
 const fires = parseFeed(readFileSync(`test/fixtures/${wapa.files[0]}`, 'utf8'), wapa, seen);
 const fire = fires.find(i => /incendio en su casa/i.test(i.title));
 expect(fire?.section).not.toBe('bienes-raices');
 expect(sources.some(s => /clasificados|investate|caribbean property/i.test(`${s.id} ${s.name} ${s.homepage}`))).toBe(false);
 expect(JSON.stringify(feeds)).not.toMatch(/clasificadosonline|investate/i);
 expect(redditTopic('Housing market and mortgage rates')).toBe('bienes-raices');
 expect(redditTopic('House fire on Calle Loiza')).not.toBe('bienes-raices');
 expect(redditTopic('Bank robbery downtown')).not.toBe('bienes-raices');
});

it('shows Real Estate in the More menu and on its own Spanish and English pages', async () => {
 const rio = story({ url: rioUrl, source: 'endi', title: 'Mansión costera en Río Grande se vende por $27 millones' });
 const bahia = story({ url: 'https://example.com/bahia-28-5/', source: 'sjds', title: bahiaTitle, summary: 'The estate closed.', originalLanguage: 'en', time: seen - 1000 });
 const business = story({ url: 'https://example.com/nasdaq/', source: 'nimb', title: 'Nasdaq futures fall as AI stocks tumble', summary: 'Stocks fell.', originalLanguage: 'en' });
 const manual = story({ url: 'https://example.com/manual-mansion/', source: 'nimb', title: 'Mansión costera importada', reason: 'manual-import' });
 const crime = story({ url: 'https://example.com/casa-fuego/', source: 'wapa', title: 'Incendio en una casa en San Juan', section: 'otras', reason: 'fallback' });
 const data = { items: [rio, bahia, business, manual, crime], translations: { [rio.url]: { originalTitle: rio.title, originalSummary: rio.summary, title: 'Coastal mansion in Rio Grande sells for $27 million', summary: 'A coastal property for sale.' } }, feeds: [] };
 const spanish = await renderer.fetch(new Request('https://news.dev.pr/s/bienes-raices'), data).text();
 const menuAt = spanish.indexOf('<details class="more-nav">');
 const tabs = spanish.slice(spanish.indexOf('<nav class="nav"'), menuAt);
 expect(tabs).toContain('/s/politica?lang=es');
 expect(tabs).toContain('/s/negocios?lang=es');
 expect(tabs).toContain('/s/policiales?lang=es');
 expect(tabs).not.toContain('/s/bienes-raices');
 const menu = spanish.slice(menuAt, spanish.indexOf('</details>', menuAt));
 expect(menu).toContain('Más secciones');
 expect(menu).toContain('Bienes raíces');
 expect(menu).toContain('/s/bienes-raices?lang=es');
 expect(spanish).toContain('<h1>Bienes raíces</h1>');
 expect(spanish).toContain('aria-current="page"');
 expect(spanish).toContain('Mansión costera en Río Grande se vende por $27 millones');
 expect(spanish).toContain(bahiaTitle);
 expect(spanish).not.toContain('Nasdaq futures');
 expect(spanish).not.toContain('Mansión costera importada');
 expect(spanish).not.toContain('Incendio en una casa');
 expect(spanish).toContain('2 noticias · Más recientes primero');
 expect(spanish).toContain('name="source"');
 expect(spanish).toContain(':root[data-theme=dark]');
 expect(spanish).toContain('@media(max-width:480px)');
 expect(spanish).not.toContain('.listings');
 expect(spanish).not.toContain('clasificadosonline.com');
 expect(spanish).not.toContain('Anuncios de propiedades');
 expect(spanish).not.toContain('>En venta</a>');
 expect(spanish).not.toContain('>En alquiler</a>');
 expect(spanish).toContain('.tabs{display:flex;flex-wrap:wrap');
 const english = await renderer.fetch(new Request('https://news.dev.pr/s/bienes-raices?lang=en'), data).text();
 expect(english).toContain('<html lang="en">');
 expect(english).toContain('<h1>Real Estate</h1>');
 expect(english).toContain('More sections');
 expect(english).toContain('>Real Estate</a>');
 expect(english).toContain('Coastal mansion in Rio Grande sells for $27 million');
 expect(english).toContain(bahiaTitle);
 expect(english).not.toContain('>Mansión costera en Río Grande');
 expect(english).not.toContain('clasificadosonline.com');
 expect(english).not.toContain('Property listings');
 expect(english).not.toContain('>For sale</a>');
 expect(english).not.toContain('>For rent</a>');
 const unread = await renderer.fetch(new Request('https://news.dev.pr/s/bienes-raices?lang=en'), { ...data, translations: {} }).text();
 expect(unread).not.toContain('Mansión costera');
 expect(unread).toContain(bahiaTitle);
 const filtered = await renderer.fetch(new Request('https://news.dev.pr/s/bienes-raices?source=sjds&lang=en'), data).text();
 expect(filtered).toContain(bahiaTitle);
 expect(filtered).not.toContain('Coastal mansion');
 expect(filtered).toContain('source=sjds');
 const legacy = await renderer.fetch(new Request('https://news.dev.pr/s/negocios'), data).text();
 expect(legacy).toContain('Economía, Negocios y Tecnología');
 expect(legacy).toContain('Mansión costera importada');
 expect(legacy).not.toContain('clasificadosonline.com');
 const home = await renderer.fetch(new Request('https://news.dev.pr/'), data).text();
 // Once per article inside <main>; the "Última hora" ticker above it intentionally repeats the newest.
 const homeMain = home.slice(home.indexOf('<main'), home.indexOf('</main>'));
 for (const title of [rio.title, bahiaTitle, business.title, manual.title]) expect(homeMain.split('>' + title + '</a>').length - 1).toBe(1);
 expect(home).toContain('Bienes raíces');
 expect(home).not.toContain('clasificadosonline.com');
});

it('paginates the section without an external property catalog', async () => {
 const items = Array.from({ length: 31 }, (_, n) => story({
  url: `https://example.com/propiedad-${n}/`, source: n % 2 ? 'endi' : 'metro', title: `Casa en venta número ${n}`, time: seen - n * 1000, originalLanguage: 'en',
 }));
 const page = await renderer.fetch(new Request('https://news.dev.pr/s/bienes-raices?page=2&lang=en'), { items, translations: {}, feeds: [] }).text();
 expect(page).toContain('Casa en venta número 30');
 expect(page).not.toContain('Casa en venta número 0');
 expect(page).toContain('/s/bienes-raices?page=1&amp;lang=en');
 expect(page).not.toContain('Property listings');
 expect(page).not.toContain('Browse listings on ClasificadosOnline');
 expect(page).not.toContain('clasificadosonline.com');
 expect(page).not.toContain('>For sale</a>');
 expect(page).not.toContain('>For rent</a>');
 expect(page).toContain('/click?url=' + encodeURIComponent(items[30].url));
 expect(page).not.toContain('$28.5');
 const spanish = await renderer.fetch(new Request('https://news.dev.pr/s/bienes-raices'), { items: items.slice(0, 1), translations: {}, feeds: [] }).text();
 expect(spanish).not.toContain('Anuncios de propiedades');
 expect(spanish).not.toContain('Explora anuncios en ClasificadosOnline');
 expect(spanish).not.toContain('clasificadosonline.com');
 expect(spanish).not.toContain('>En venta</a>');
 expect(spanish).not.toContain('>En alquiler</a>');
 const other = await renderer.fetch(new Request('https://news.dev.pr/s/policiales'), { items, translations: {}, feeds: [] }).text();
 expect(other).not.toContain('clasificadosonline.com');
 const sourcesPage = await renderer.fetch(new Request('https://news.dev.pr/fuentes'), { items: items.slice(0, 2), translations: {}, feeds: [] }).text();
 expect(sourcesPage.slice(sourcesPage.indexOf('El Nuevo Día'), sourcesPage.indexOf('El Nuevo Día') + 500)).toContain('1 ');
 expect(sourcesPage).not.toContain('clasificadosonline.com');
});

it('lists the section in both sitemaps and does not count ClasificadosOnline as an article', async () => {
 const fallback = await discovery(new Request('https://news.dev.pr/sitemap.xml'))!.text();
 expect(fallback).toContain('https://news.dev.pr/s/bienes-raices');
 expect(fallback).toContain('https://news.dev.pr/s/bienes-raices?lang=en');
 expect(fallback).not.toContain('clasificadosonline.com');
 const sql = new DatabaseSync(':memory:');
 for (const migration of ['0001_live.sql', '0002_archive.sql', '0003_search_clicks.sql', '0008_click_totals.sql']) sql.exec(readFileSync(`migrations/${migration}`, 'utf8'));
 const DB = { prepare(text: string) { let args: any[] = []; return { bind(...v: any[]) { args = v; return this; }, async first() { return sql.prepare(text).get(...args) ?? null; }, async all() { return { results: sql.prepare(text).all(...args) }; }, async run() { return { meta: { changes: Number(sql.prepare(text).run(...args).changes) } }; } }; }, async batch(statements: { run: () => Promise<unknown> }[]) { for (const statement of statements) await statement.run(); } } as unknown as D1Database;
 const xml = await (await sitemapRoute(new Request('https://news.dev.pr/sitemap.xml'), { DB } as SyndicationEnv))!.text();
 expect(xml).toContain('https://news.dev.pr/s/bienes-raices</loc>');
 expect(xml).toContain('https://news.dev.pr/s/bienes-raices?lang=en</loc>');
 expect(xml).not.toContain('clasificadosonline.com');
 const env = { DB } as ClickEnv;
 const article = 'https://example.com/propiedad-conocida/';
 sql.prepare('INSERT INTO articles(url,source,payload,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?)').run(article, 'endi', JSON.stringify(story({ url: article, source: 'endi', title: 'Propiedad en venta número 1' })), seen, seen, seen);
 for (const catalog of ['https://www.clasificadosonline.com/RealEstate.asp', 'https://www.clasificadosonline.com/Rentals.asp']) {
  const missed = await clickRoute(new Request(`https://news.dev.pr/click?url=${encodeURIComponent(catalog)}`), env);
  expect(missed?.status).toBe(404);
 }
 expect(await totalClicks(env)).toMatchObject({ clicks: 0 });
 const known = await clickRoute(new Request(`https://news.dev.pr/click?url=${encodeURIComponent(article)}`), env);
 expect(known?.status).toBe(302);
 expect(known?.headers.get('Location')).toBe(article);
 expect(await totalClicks(env)).toMatchObject({ clicks: 1 });
 const catalogClicks = sql.prepare('SELECT COUNT(*) AS n FROM article_click_totals WHERE url LIKE ?').get('%clasificadosonline%') as { n: number };
 expect(catalogClicks.n).toBe(0);
});
