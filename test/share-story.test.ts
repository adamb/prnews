import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import renderer from '../src/render';
import worker from '../src/index';
import { key, valid } from '../src/lighter';
import type { Env } from '../src/ingest';
import type { Item } from '../src/parse';
import type { Translation } from '../src/i18n';

const now = Date.now();
let n = 0;
const story = (over: Partial<Item> & { title: string }): Item => ({
 url: `https://example.org/noticel/${++n}`, source: 'noticel', summary: 'El portavoz confirmó el cambio de horario esta mañana.', image: '', time: now - 60_000, observed: false, section: 'politica', reason: 'test', ...over,
});
const render = (path: string, items: Item[], extra: Record<string, unknown> = {}) =>
 renderer.fetch(new Request('https://news.dev.pr' + path), { items, translations: {}, feeds: [], ...extra });
const headOf = (html: string) => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const articleOf = (html: string, title: string) => {
 const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
 const at = main.indexOf('>' + esc(title) + '</a>');
 return main.slice(main.lastIndexOf('<article', at), main.indexOf('</article>', at));
};
const shareScript = (html: string) => {
 const start = html.indexOf("closest('.share-ask')");
 return html.slice(start, html.indexOf('})();', start));
};

describe('share control', () => {
 const item = story({ title: 'La agencia anunció un nuevo horario de oficina' });

 it('puts a share button with an absolute-able permalink on a card that has an id, and omits it otherwise', async () => {
  const withId = await (await render('/', [item], { storyIds: { [item.url]: 42 } })).text();
  const card = articleOf(withId, item.title);
  expect(card).toContain('class="share-ask"');
  expect(card).toContain('data-share-path="/story?id=42"');
  expect(card).toContain('data-share-lang="es"');
  expect(card).toContain('>Compartir<');
  expect(card).not.toContain('lang=en');
  const bare = await (await render('/', [item])).text();
  expect(articleOf(bare, item.title)).not.toContain('share-ask');
  expect(bare).not.toContain('property="og:');
  expect(bare).not.toContain('rel="canonical"');
 });

 it('adds lang=en to the shared path on the English edition and keeps the button quiet on brief cards', async () => {
  const englishItem = story({ title: 'The agency posted a new office schedule', summary: 'A spokesperson confirmed the new hours this morning.', originalLanguage: 'en' });
  const html = await (await render('/?lang=en', [englishItem], { storyIds: { [englishItem.url]: 42 } })).text();
  const card = articleOf(html, englishItem.title);
  expect(card).toContain('data-share-path="/story?id=42&amp;lang=en"');
  expect(card).toContain('data-share-lang="en"');
  expect(card).toContain('>Share<');
  expect(html).toContain('.card.brief .share-ask,.card.mid .share-ask{min-height:28px;padding:3px 0;border:0;font-size:11.5px}');
  expect(html).toContain('.share-ask:focus-visible{outline:3px solid var(--accent);outline-offset:3px}');
  const script = shareScript(html);
  expect(script).toContain('navigator.share({title:title, url:url})');
  expect(script).toContain('writeText');
  expect(script).toContain('textContent');
  expect(script).toContain('Enlace copiado');
  expect(script).toContain('Link copied');
  expect(script).toContain('location.assign(url)');
  expect(script).toContain('location.origin+path');
  expect(script).not.toContain('innerHTML');
  expect(script).not.toContain('cookie');
  expect(script).not.toContain('beacon');
  expect(script).not.toContain('gtag');
 });
});

describe('story social preview', () => {
 const headline = 'Titular con & "comillas" <y>';
 const excerpt = 'Extracto con & y "comillas" que no se reescribe.';
 const satire = 'La agencia abrió un comité para admirar su propia espera con calma y sin prisa.';
 const item = story({ title: headline, summary: excerpt, image: 'https://img.example/photo.jpg' });
 const english: Translation = { originalTitle: headline, originalSummary: excerpt, title: 'Headline with & "quotes" <and>', summary: 'Excerpt with & and "quotes" left verbatim.' };

 it('emits escaped verbatim Open Graph tags for the Spanish story, including a safe https image', async () => {
  expect(valid(satire, item, 'es')).toBe(true);
  const html = await (await render('/story?id=7', [item], { story: true, storyIds: { [item.url]: 7 }, lighter: { [key(item, 'es')]: satire } })).text();
  const head = headOf(html);
  expect(head).toContain('<link rel="canonical" href="https://news.dev.pr/story?id=7">');
  expect(head).toContain('<meta property="og:type" content="article">');
  expect(head).toContain('<meta property="og:site_name" content="news.dev.pr">');
  expect(head).toContain(`<meta property="og:title" content="${esc(headline)}">`);
  expect(head).toContain(`<meta property="og:description" content="${esc(excerpt)}">`);
  expect(head).toContain('<meta property="og:url" content="https://news.dev.pr/story?id=7">');
  expect(head).toContain('<meta property="og:locale" content="es_PR">');
  expect(head).toContain('<meta property="og:image" content="https://img.example/photo.jpg">');
  expect(head).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(head).not.toContain(satire);
  expect(html).not.toContain(satire);
  expect(html).toContain('class="card lead');
  expect(html).toContain('Ver la sátira guardada');
  expect(html).toContain('/click?url=' + encodeURIComponent(item.url));
  expect(html).toContain('data-share-path="/story?id=7"');
  expect(excerpt.length).toBeLessThanOrEqual(300);
  expect(head).toContain(esc(excerpt));
 });

 it('uses the English headline, excerpt, locale, and lang=en permalink', async () => {
  const html = await (await render('/story?id=7&lang=en', [item], { story: true, storyIds: { [item.url]: 7 }, translations: { [item.url]: english } })).text();
  const head = headOf(html);
  expect(head).toContain(`<meta property="og:title" content="${esc(english.title)}">`);
  expect(head).toContain(`<meta property="og:description" content="${esc(english.summary)}">`);
  expect(head).not.toContain(`content="${esc(headline)}"`);
  expect(head).toContain('<meta property="og:locale" content="en_US">');
  expect(head).toContain('<link rel="canonical" href="https://news.dev.pr/story?id=7&amp;lang=en">');
  expect(head).toContain('<meta property="og:url" content="https://news.dev.pr/story?id=7&amp;lang=en">');
  expect(html).toContain('data-share-path="/story?id=7&amp;lang=en"');
  expect(html).toContain('>Share<');
 });

 it('omits og:image for http, stock, and publisher placeholders, and uses a summary card', async () => {
  const http = story({ title: 'Horario por http', summary: excerpt, image: 'http://img.example/photo.jpg' });
  const httpHtml = await (await render('/story?id=8', [http], { story: true, storyIds: { [http.url]: 8 } })).text();
  const httpHead = headOf(httpHtml);
  expect(httpHead).not.toContain('og:image');
  expect(httpHead).not.toContain('http://img.example/photo.jpg');
  expect(httpHead).toContain('<meta name="twitter:card" content="summary">');

  const stock = 'https://cdn.example/stock.jpg';
  const copies = [0, 1, 2, 3].map(i => story({ title: `Historia distinta número ${i} del archivo municipal`, summary: `Extracto propio número ${i} sobre el horario.`, image: stock }));
  const stockHtml = await (await render('/story?id=9', copies, { story: true, storyIds: { [copies[0].url]: 9 } })).text();
  const stockHead = headOf(stockHtml);
  expect(stockHead).not.toContain('og:image');
  expect(stockHead).not.toContain('stock.jpg');
  expect(stockHead).toContain('<meta name="twitter:card" content="summary">');

  const placeholder = story({ title: 'Tarjeta de Metro', summary: excerpt, image: 'https://www.metro.pr/og-default.jpg' });
  const placeholderHead = headOf(await (await render('/story?id=10', [placeholder], { story: true, storyIds: { [placeholder.url]: 10 } })).text());
  expect(placeholderHead).not.toContain('og:image');
  expect(placeholderHead).not.toContain('og-default.jpg');

  const plain = story({ title: 'Sin foto', summary: excerpt, image: '' });
  const plainHead = headOf(await (await render('/story?id=11', [plain], { story: true, storyIds: { [plain.url]: 11 } })).text());
  expect(plainHead).not.toContain('og:image');
  expect(plainHead).toContain('<meta name="twitter:card" content="summary">');
 });

 it('puts no Open Graph tags on other pages or on an unavailable story', async () => {
  const home = await (await render('/', [item], { storyIds: { [item.url]: 7 } })).text();
  const section = await (await render('/s/politica', [item], { storyIds: { [item.url]: 7 } })).text();
  const about = await (await render('/about', [])).text();
  for (const html of [home, section, about]) {
   expect(html).not.toContain('property="og:');
   expect(html).not.toContain('rel="canonical"');
   expect(html).not.toContain('twitter:card');
  }
  const missing = await render('/story?id=99', [], { story: true });
  expect(missing.status).toBe(404);
  const missingHtml = await missing.text();
  expect(missingHtml).not.toContain('property="og:');
  expect(missingHtml).not.toContain('rel="canonical"');
  expect(missingHtml).not.toContain('twitter:card');
  expect(missingHtml).toContain('Noticia no disponible');
  const invalid = await (await render('/story?id=nope', [item], { story: true })).text();
  expect(headOf(invalid)).not.toContain('property="og:');
  expect(articleOf(invalid, item.title)).not.toContain('share-ask');
 });
});

describe('story id query', () => {
 function setup() {
  const sql = new DatabaseSync(':memory:');
  for (const file of ['migrations/0001_live.sql', 'migrations/0003_search_clicks.sql', 'migrations/0011_lighter.sql']) sql.exec(readFileSync(file, 'utf8'));
  const seen: string[] = [];
  const DB = {
   prepare(text: string) {
    seen.push(text);
    let args: unknown[] = [];
    return {
     bind(...values: unknown[]) { args = values; return this; },
     async first() { return sql.prepare(text).get(...(args as never[])) ?? null; },
     async all() { return { results: sql.prepare(text).all(...(args as never[])) }; },
     async run() { const result = sql.prepare(text).run(...(args as never[])); return { meta: { changes: Number(result.changes) } }; },
    };
   },
   async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())); },
  };
  return { sql, seen, env: { DB } as unknown as Env };
 }
 const insert = (sql: DatabaseSync, item: Item, translation: string | null = null) => {
  sql.prepare('INSERT INTO articles(url,source,payload,translation,first_seen,updated_at,published_at) VALUES(?,?,?,?,?,?,?)')
   .run(item.url, item.source, JSON.stringify(item), translation, item.time, item.time, item.time);
 };

 it('joins story ids in the one page query, leaves /api/live alone, and renders the saved satire on /story', async () => {
  const { sql, seen, env } = setup();
  const kept = story({ title: 'Horario nuevo en las oficinas de Bayamón', summary: 'El portavoz confirmó el cambio de horario esta mañana.' });
  const orphan = story({ title: 'El ferri de Culebra añade una salida', summary: 'La autoridad portuaria publicó el itinerario de la tarde.' });
  insert(sql, kept);
  insert(sql, orphan);
  sql.prepare('DELETE FROM story_ids WHERE url=?').run(orphan.url);
  const id = (sql.prepare('SELECT id FROM story_ids WHERE url=?').get(kept.url) as { id: number }).id;
  const satire = 'La agencia abrió un comité para admirar su propia espera con calma y sin prisa.';
  const satireEn = 'The agency opened another committee to admire its own waiting room.';
  expect(valid(satire, kept, 'es')).toBe(true);
  expect(valid(satireEn, kept, 'en')).toBe(true);
  sql.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').run(key(kept, 'es'), satire, 1, 0);
  sql.prepare('INSERT INTO lighter_cache(key,text,attempts,next_try) VALUES(?,?,?,?)').run(key(kept, 'en'), satireEn, 1, 0);
  seen.length = 0;
  const home = await worker.fetch(new Request('https://news.dev.pr/?source=share-query'), env);
  expect(home.headers.get('Cache-Control')).toBe('public, max-age=60');
  const homeHtml = await home.text();
  expect(seen.filter(sqlText => sqlText.includes('LEFT JOIN story_ids'))).toEqual([
   'SELECT a.payload AS payload,a.translation AS translation,s.id AS story_id FROM articles a LEFT JOIN story_ids s ON s.url=a.url WHERE a.published_at>=? ORDER BY a.published_at DESC LIMIT 10000',
  ]);
  expect(seen.some(sqlText => /story_ids WHERE url IN/.test(sqlText))).toBe(false);
  expect(articleOf(homeHtml, kept.title)).toContain(`data-share-path="/story?id=${id}"`);
  expect(articleOf(homeHtml, orphan.title)).not.toContain('share-ask');
  expect(headOf(homeHtml)).not.toContain('property="og:');
  seen.length = 0;
  const live = await worker.fetch(new Request('https://news.dev.pr/api/live'), env);
  expect(live.status).toBe(200);
  expect(seen).toContain('SELECT payload,translation FROM articles WHERE published_at>=? ORDER BY published_at DESC LIMIT 10000');
  expect(seen.some(sqlText => sqlText.includes('story_ids'))).toBe(false);

  const page = await worker.fetch(new Request(`https://news.dev.pr/story?id=${id}`), env);
  expect(page.status).toBe(200);
  const storyHtml = await page.text();
  const storyHead = headOf(storyHtml);
  expect(storyHtml).toContain('class="card lead');
  expect(storyHtml).toContain('Ver la sátira guardada');
  expect(storyHtml).toContain('/click?url=' + encodeURIComponent(kept.url));
  expect(storyHtml).toContain(`data-share-path="/story?id=${id}"`);
  expect(storyHead).toContain(`<meta property="og:title" content="${esc(kept.title)}">`);
  expect(storyHead).toContain(`<meta property="og:description" content="${esc(kept.summary)}">`);
  expect(storyHead).not.toContain(satire);
  expect(storyHead).not.toContain(satireEn);
  expect(storyHtml).not.toContain(satire);
  expect(storyHtml).not.toContain(satireEn);

  const english: Translation = { originalTitle: kept.title, originalSummary: kept.summary, title: 'Bayamón offices posted a new schedule', summary: 'A spokesperson confirmed the schedule change this morning.' };
  sql.prepare('UPDATE articles SET translation=? WHERE url=?').run(JSON.stringify(english), kept.url);
  const englishPage = await worker.fetch(new Request(`https://news.dev.pr/story?id=${id}&lang=en`), env);
  const englishHtml = await englishPage.text();
  const englishHead = headOf(englishHtml);
  expect(englishHead).toContain(`<meta property="og:title" content="${esc(english.title)}">`);
  expect(englishHead).toContain('<meta property="og:locale" content="en_US">');
  expect(englishHead).toContain(`<link rel="canonical" href="https://news.dev.pr/story?id=${id}&amp;lang=en">`);
  expect(englishHtml).toContain(`data-share-path="/story?id=${id}&amp;lang=en"`);
  expect(englishHtml).toContain('Show the saved satire');
  expect(headOf(englishHtml)).not.toContain(satireEn);

  const missing = await worker.fetch(new Request('https://news.dev.pr/story?id=99999'), env);
  expect(missing.status).toBe(404);
  const missingHtml = await missing.text();
  expect(missingHtml).not.toContain('property="og:');
  expect(missingHtml).not.toContain('SQLITE');
  expect(missingHtml).not.toContain('no such table');
 });
});
