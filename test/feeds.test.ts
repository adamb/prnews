import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sources } from '../src/sources';
import { unavailableSources } from '../src/additional-sources';
import { parseFeed, canonical, publisherPlaceholder, summary, safeUrl } from '../src/parse';
import { classify } from '../src/sections';
import worker from '../src/render';
const seen = Date.parse('2026-11-14T04:30:00Z');
function feed(id: string) { const s = sources.find(s => s.id === id)!; return parseFeed(readFileSync(`test/fixtures/${s.files[0]}`, 'utf8'), s, seen); }
describe('saved feeds', () => {
 for (const source of sources.filter(s => s.files.length)) it(`parses ${source.name}`, () => {
  const items = feed(source.id);
  expect(items.length).toBeGreaterThanOrEqual(source.id==='claridad'?5:10);
  for (const item of items) {
   expect(item.title).toBeTruthy(); expect(item.url).toMatch(/^https:\/\//);
   expect(item.summary.length).toBeLessThanOrEqual(300);
   expect(item.summary).not.toMatch(/<\/?\w|The post .*appeared/);
   expect(item.time).toBeLessThanOrEqual(seen);
  }
 });
 it('uses Telemundo excerpts and observation times', () => {
  const items = feed('telemundo');
  expect(items[0].summary).toContain('falla en el sistema');
  expect(new Set(items.map(i => i.summary)).size).toBeGreaterThan(40);
  expect(items.every(i => i.observed && i.time === seen)).toBe(true);
 });
 it('decodes La Perla entities', () => {
  expect(feed('laperla').map(i => i.title).join(' ')).not.toMatch(/&(?:[a-z]+|#\d+);/i);
 });
 it('cleans NotiCel URLs and boilerplate', () => {
  for (const item of feed('noticel')) { expect(item.url).not.toContain('utm_'); expect(item.summary).not.toContain('The post'); }
 });
});
it('treats the Metro default card as no image and keeps a real Metro enclosure', () => {
 const source = sources.find(s => s.id === 'metro')!;
 const xml = `<?xml version="1.0"?><rss><channel><item><title>Sin foto propia</title><link>https://www.metro.pr/noticias/2026/11/14/sin-foto/</link><pubDate>Sat, 14 Nov 2026 01:00:00 +0000</pubDate><description>Texto</description><enclosure url="https://www.metro.pr/og-default.jpg" type="image/jpeg"/></item><item><title>Con foto</title><link>https://www.metro.pr/noticias/2026/11/14/con-foto/</link><pubDate>Sat, 14 Nov 2026 00:30:00 +0000</pubDate><description>Texto</description><enclosure url="https://www.metro.pr/api/image/LHDX6RI6KNHBBFXYUEMKVOMNWQ.jpg?w=640" type="image/jpeg"/></item></channel></rss>`;
 const [logo, photo] = parseFeed(xml, source, seen);
 expect(publisherPlaceholder('https://www.metro.pr/og-default.jpg?w=1200')).toBe(true);
 expect(logo.image).toBe('');
 expect(logo.title).toBe('Sin foto propia');
 expect(photo.image).toBe('https://www.metro.pr/api/image/LHDX6RI6KNHBBFXYUEMKVOMNWQ.jpg?w=640');
 expect(photo.title).toBe('Con foto');
});
it('normalizes URLs and rejects unsafe schemes', () => {
 expect(canonical('https://EXAMPLE.com/story?utm_source=rss&keep=1#x', 'https://example.com')).toBe('https://example.com/story/?keep=1');
 expect(safeUrl('javascript:alert(1)')).toBe('');
 expect(summary('<p>Hello &amp; world</p> The post Test appeared first on Site.')).toBe('Hello & world');
});
it('prioritizes paths over categories and keywords', () => {
 expect(classify('https://example.com/opinion/a/', ['Deportes'], 'LUMA').section).toBe('opinion');
 expect(classify('https://example.com/a/', ['Deportes'], 'LUMA').section).toBe('deportes');
 expect(classify('https://example.com/a/', [], 'Apagón de LUMA').section).toBe('energia');
 expect(classify('https://example.com/a/', [], 'Una historia distinta').section).toBe('otras');
});
it('serves the snapshot, sections, attribution and 404s', async () => {
 for (const path of ['/', '/s/politica', '/fuentes', '/about']) {
  const res = worker.fetch(new Request('https://example.com' + path));
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain('class="notice"'); // technical banner removed; snapshot pages carry no feed-status block
 }
 expect(worker.fetch(new Request('https://example.com/s/nope')).status).toBe(404);
 expect(worker.fetch(new Request('https://example.com/nope')).status).toBe(404);
 const home = await worker.fetch(new Request('https://example.com')).text();
 expect(home).toContain('rel="noopener noreferrer"');
 expect(home).toContain('Visto');
});

it('keeps the selected language across navigation and pagination', async () => {
 const english = await worker.fetch(new Request('https://example.com/s/mundo?page=2&lang=en')).text();
 expect(english).toContain('<html lang="en">');
 expect(english).toContain('United States & World');
 expect(english).toContain('/s/mundo?page=2&amp;lang=es');
 expect(english).toContain('/s/mundo?page=1&amp;lang=en');
 expect(english).toContain('/about?lang=en');
 expect(english).toContain('Translated · Original in Spanish'); // translation disclosure lives on the item label
 expect(english).not.toContain('class="notice"');
 const spanish = await worker.fetch(new Request('https://example.com/?lang=invalid')).text();
 expect(spanish).toContain('<html lang="es-PR">');
 expect(spanish).toContain('Un vistazo a Puerto Rico');
});

it('localizes supporting pages, errors, and HEAD responses', async () => {
 for (const [path, phrase] of [['/fuentes', 'Journalism from the island'], ['/about', 'A window into Puerto Rico news'], ['/missing', 'Page not found']]) {
  const response = worker.fetch(new Request('https://example.com' + path + '?lang=en'));
  expect(response.headers.get('content-language')).toBe('en');
  expect(await response.text()).toContain(phrase);
 }
 const head = worker.fetch(new Request('https://example.com/s/invalid?lang=en', {method:'HEAD'}));
 expect(head.status).toBe(404);
 expect(await head.text()).toBe('');
});
it('links every source and blocked outlet to its verified publisher site, in both editions', async () => {
  for (const [lang, label] of [['es', 'Visitar sitio web'], ['en', 'Visit website']] as const) {
   const html = await worker.fetch(new Request(`https://example.com/fuentes?lang=${lang}`)).text();
   for (const s of sources) expect(html).toContain(`<a href="${s.homepage}" target="_blank" rel="noopener noreferrer">`);
   for (const s of unavailableSources) expect(html).toContain(`<a href="${s.homepage}" target="_blank" rel="noopener noreferrer">`);
   expect(html).toContain(label);
  }
 });
it('keeps Reddit discussions in Community without republishing post bodies', async () => {
 const items = feed('reddit_puertorico');
 expect(items).toHaveLength(25);
 for (const item of items) {
  expect(item.section).toBe('comunidad');
  expect(item.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/PuertoRico\/comments\//i);
  expect(item.summary.length).toBeGreaterThan(0);
  expect(item.summary).not.toMatch(/submitted by|\/u\/|\[comments\]/);
 }
 const html = await worker.fetch(new Request('https://example.com/s/comunidad')).text();
 expect(html).toContain('Discusión de la comunidad · Publicación original');
 expect(html).toContain('Conversaciones de Reddit, no noticias verificadas.');
 expect(html).not.toContain('Original in Spanish · Translation unavailable');
});
it('decodes Reddit thumbnail query parameters without turning them into URL fragments', () => {
 const item = feed('reddit_puertorico').find(i=>i.image.includes('preview.redd.it'))!;
 const image = new URL(item.image);
 expect(image.hash).toBe('');
 expect(image.searchParams.get('auto')).toBe('webp');
 expect(image.searchParams.get('s')).toMatch(/^[a-f0-9]+$/);
 expect(item.image).not.toMatch(/&#?\w+;/);
});
it('parses El Vocero with valid .html links, images and section mapping', () => {
 const items=feed('elvocero');
 expect(items).toHaveLength(50);
 expect(items[0].url).toMatch(/\.html$/);
 expect(items[0].section).toBe('policiales');
 expect(items[0].image).toContain('bloximages');
 expect(items.find(i=>i.url.includes('/escenario/'))?.section).toBe('entretenimiento');
 expect(canonical('https://www.elvocero.com/a.html?utm_source=rss','https://www.elvocero.com')).toBe('https://www.elvocero.com/a.html');
});
