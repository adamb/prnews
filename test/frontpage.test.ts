import { describe, it, expect } from 'vitest';
import renderer from '../src/render';
import { fontRoute, FONT_PATH } from '../src/font';
import { clusterStories, headlineTokens, pickLead, planSection, sameEvent, withoutStockImages, SECTION_PREVIEW_TOTAL } from '../src/frontpage';
import { relativeTime, relativeClientScript } from '../src/reltime';
import { sourceMark } from '../src/brand';
import { css } from '../src/styles';
import type { Item } from '../src/parse';

const now = Date.now();
const MIN = 60000;
let counter = 0;
const story = (over: Partial<Item> & { title: string }): Item => ({
 url: `https://example.org/${over.source ?? 'endi'}/${++counter}`, source: 'endi', summary: 'Excerpt text.', image: '', time: now - 5 * MIN, observed: false, section: 'politica', reason: 'manual-import', ...over,
});
const render = (path: string, items: Item[], extra: object = {}) => renderer.fetch(new Request('https://news.dev.pr' + path), { items, translations: {}, feeds: [], ...extra }).text();
const mainOf = (html: string) => html.slice(html.indexOf('<main'), html.indexOf('</main>'));

describe('same-event folding', () => {
 const a = story({ source: 'metro', title: 'Arrestan a dos personas durante allanamiento en residencial de Ponce', time: now - 10 * MIN });
 const b = story({ source: 'laperla', title: 'Arrestan a dos personas durante allanamiento en residencial de Ponce', time: now - 130 * MIN });

 it('treats the same event from two newsrooms within hours as one story', () => {
  expect(sameEvent(a, b)).toBe(true);
  const [only, ...rest] = clusterStories([a, b]);
  expect(rest).toHaveLength(0);
  expect(only.item.title).toBe(a.title);
  expect(only.also.map(i => i.source)).toEqual(['laperla']);
 });
 it('keeps the original wording untouched on both items', () => {
  const [cluster] = clusterStories([a, b]);
  expect(cluster.item).toBe(a);
  expect(cluster.also[0]).toBe(b);
 });
 it('does not merge the same wording a day apart, the same newsroom, or different events', () => {
  expect(sameEvent(a, { ...b, time: a.time - 30 * 3600000 })).toBe(false);
  expect(sameEvent(a, { ...b, source: 'metro' })).toBe(false);
  const other = story({ source: 'noticel', title: 'Arrestan a un hombre por escándalo en residencial de Carolina', time: a.time });
  expect(sameEvent(a, other)).toBe(false);
  // Same people, different angle: must stay two stories.
  const x = story({ source: 'endi', title: 'China confirma la reunión entre Xi, Trump y Putin este jueves en Shenzhen' });
  const y = story({ source: 'metro', title: 'Cuatro claves de la cumbre de la APEC en la que Trump, Xi y Putin se verán las caras' });
  expect(sameEvent(x, y)).toBe(false);
 });
 it('never merges Reddit posts', () => {
  const r1 = story({ source: 'reddit_puertorico', title: a.title, time: a.time }), r2 = story({ source: 'endi', title: a.title, time: a.time });
  expect(sameEvent(r1, r2)).toBe(false);
 });
 it('compares accent-folded content words and ignores stop words', () => {
  expect([...headlineTokens('Más de 50 familias reciben títulos de propiedad en Peñuelas')]).toContain('titulo');
  expect(headlineTokens('de la el en')).toEqual(new Set());
 });
 it('leads a cluster with the member that has a picture', () => {
  const photo = { ...b, image: 'https://img.example/p.jpg' };
  const [cluster] = clusterStories([a, photo]);
  expect(cluster.item).toBe(photo);
  expect(cluster.also).toEqual([a]);
 });
 it('stays fast on a two-week catalog', () => {
  const many = Array.from({ length: 2500 }, (_, i) => story({ source: ['endi', 'metro', 'wapa', 'noticel'][i % 4], title: `Titular número ${i} sobre asuntos distintos ${i * 7} ${i % 13}`, time: now - i * 8 * MIN }));
  const t0 = performance.now();
  clusterStories(many);
  expect(performance.now() - t0).toBeLessThan(500);
 });
});

describe('lead and section composition', () => {
 it('picks a pictured, multiply-covered recent story as the hero and keeps Reddit and opinion off the top', () => {
  const quiet = story({ source: 'endi', title: 'Historia tranquila con foto', image: 'https://img.example/q.jpg' });
  const big = story({ source: 'metro', title: 'Mega operativo antidrogas con quince arrestos en Cataño hoy', image: 'https://img.example/b.jpg', time: now - 60 * MIN });
  const big2 = story({ source: 'wapa', title: 'Mega operativo antidrogas con quince arrestos en Cataño hoy', time: now - 70 * MIN });
  const reddit = story({ source: 'reddit_puertorico', title: 'Hilo de la comunidad', image: 'https://img.example/r.jpg', time: now - MIN });
  const column = story({ source: 'noticel', title: 'Columna de opinión', section: 'opinion', image: 'https://img.example/o.jpg', time: now - 2 * MIN });
  const lead = pickLead(clusterStories([reddit, column, quiet, big, big2]));
  expect(lead.hero?.item).toBe(big);
  expect(lead.hero?.also).toEqual([big2]);
  expect(lead.side.map(c => c.item)).toEqual([quiet]);
  expect([lead.hero, ...lead.side].some(c => c?.item === reddit || c?.item === column)).toBe(false);
 });
 it('prefers different newsrooms for the side stories and honors the skip set', () => {
  const stories = ['endi', 'endi', 'metro', 'wapa', 'noticel'].map((source, i) => story({ source, title: `Asunto único ${i} con palabras distintas ${i}${i}`, image: 'https://img.example/' + i, time: now - i * MIN }));
  const lead = pickLead(clusterStories(stories), new Set([stories[0].url]));
  expect(lead.hero?.item.url).not.toBe(stories[0].url);
  const rooms = lead.side.map(c => c.item.source);
  expect(new Set(rooms).size).toBe(rooms.length);
 });
 it('gives every section the same preview size, leading with a pictured story', () => {
  const cands = Array.from({ length: 40 }, (_, i) => ({ item: story({ title: `Noticia ${i} ${i * 3}`, image: i === 2 ? 'https://img.example/x.jpg' : '' }), also: [] }));
  const plan = planSection(cands);
  expect(1 + plan.mid.length + plan.brief.length).toBe(SECTION_PREVIEW_TOTAL);
  expect(plan.lead).toBe(cands[2]);
  expect(planSection(cands.slice(0, 2))).toMatchObject({ mid: [cands[1]], brief: [] });
 });
 it('treats a thumbnail shared by four or more stories as a stock graphic, never a story photo', () => {
  const stock = 'https://img.example/no-image.png';
  const four = ['a', 'b', 'c', 'd'].map(k => story({ title: 'Stock ' + k, image: stock }));
  const three = ['a', 'b', 'c'].map(k => story({ title: 'Reuse ' + k, image: 'https://img.example/reuse.jpg' }));
  const out = withoutStockImages([...four, ...three]);
  expect(out.slice(0, 4).every(i => i.image === '')).toBe(true);
  expect(out.slice(4).every(i => i.image === 'https://img.example/reuse.jpg')).toBe(true);
  expect(out[4]).toBe(three[0]); // untouched stories keep identity
  // Revisions of one article count once.
  const revisions = Array.from({ length: 5 }, () => ({ ...four[0], title: 'Same url' }));
  expect(withoutStockImages(revisions).every(i => i.image === stock)).toBe(true);
 });
});

describe('relative time', () => {
 const cases: [number, string, string][] = [[10 * 1000, 'ahora', 'just now'], [12 * MIN, 'hace 12 min', '12 min ago'], [59 * MIN, 'hace 59 min', '59 min ago'], [60 * MIN, 'hace 1 h', '1 h ago'], [5 * 3600000 + 59 * MIN, 'hace 5 h', '5 h ago'], [3 * 86400000, 'hace 3 d', '3 d ago']];
 it.each(cases)('formats %i ms', (ago, es, en) => {
  expect(relativeTime(now - ago, now, 'es')).toBe(es);
  expect(relativeTime(now - ago, now, 'en')).toBe(en);
 });
 it('falls back to an absolute date after a week and tolerates clock skew', () => {
  expect(relativeTime(now - 7 * 86400000, now, 'es')).toBeNull();
  expect(relativeTime(now + 5 * MIN, now, 'es')).toBe('ahora');
 });
 it('browser script follows exactly the same rule as the server', () => {
  const fixed = 1_800_000_000_000; // frozen clock: the comparison must not depend on millisecond timing
  for (const lang of ['es', 'en'] as const) for (const ago of [...cases.map(c => c[0]), 6.9 * 86400000, 7 * 86400000, 8 * 86400000, -5 * MIN]) {
   const node = { textContent: 'x', getAttribute: () => String(fixed - ago) };
   const doc = { documentElement: { lang }, querySelectorAll: () => ({ forEach: (fn: (e: unknown) => void) => fn(node) }), addEventListener() {}, hidden: false };
   new Function('document', 'setInterval', 'Date', relativeClientScript)(doc, () => 0, { now: () => fixed });
   expect(node.textContent).toBe(relativeTime(fixed - ago, fixed, lang) ?? 'x');
  }
 });
});

describe('front page markup', () => {
 it('renders headlines and excerpts verbatim, including a feed title that starts mid-word', async () => {
  // San Juan Daily Star's own feed briefly published "rump, Xi and Putin…" (slug rump-xi-and-putin…)
  // before correcting it. The page must show exactly what the source said, not repair or drop characters.
  const odd = story({ source: 'sjds', title: 'rump, Xi and Putin shake hands as leaders gather in China', summary: 'Leaders met in China on Thursday.', originalLanguage: 'en' });
  const html = await render('/', [odd]);
  expect(html).toContain('>rump, Xi and Putin shake hands as leaders gather in China</a>');
  expect(html).toContain('Leaders met in China on Thursday.');
  const archived = await render('/s/politica', [odd]);
  expect(archived).toContain('>rump, Xi and Putin shake hands as leaders gather in China</a>');
 });
 it('shows one story with a "También en" link for the second newsroom, and both on the section page', async () => {
  const a = story({ source: 'metro', title: 'Arrestan a dos personas durante allanamiento en residencial de Ponce', time: now - 10 * MIN });
  const b = story({ source: 'laperla', title: 'Arrestan a dos personas durante allanamiento en residencial de Ponce', time: now - 40 * MIN });
  const home = mainOf(await render('/', [a, b]));
  expect(home.split('>' + a.title + '</a>').length - 1).toBe(1);
  expect(home).toContain('También en');
  expect(home).toContain('La Perla del Sur</a>');
  expect(home).toContain(encodeURIComponent(b.url));
  const ea = story({ source: 'sjds', title: 'Two arrested during raid at Ponce public housing complex', time: now - 10 * MIN });
  const eb = story({ source: 'nimb', title: 'Two arrested during raid at Ponce public housing complex', time: now - 40 * MIN });
  const en = mainOf(await render('/?lang=en', [ea, eb]));
  expect(en).toContain('Also in');
  const section = mainOf(await render('/s/politica', [a, b]));
  expect(section.split('>' + a.title + '</a>').length - 1).toBe(2);
  expect(section).not.toContain('También en');
 });
 it('every picture sits in a fixed-ratio box with a monogram block underneath and a graceful error path', async () => {
  const withImage = story({ source: 'endi', title: 'Con imagen', image: 'https://img.example/a.jpg' });
  const without = story({ source: 'metro', title: 'Sin imagen', section: 'negocios' });
  const html = mainOf(await render('/', [withImage, without]));
  expect(html).toContain('<b>END</b>');
  expect(html).toContain('<b>METRO</b>');
  expect(html).toMatch(/<img src="https:\/\/img.example\/a.jpg" alt="" width="640" height="\d+"/);
  expect(html).toContain('onerror="this.hidden=true"');
  expect(html).toContain('referrerpolicy="no-referrer"');
  expect(css).toMatch(/\.picture\{[^}]*aspect-ratio:3\/2/);
  expect(css).toMatch(/\.card\.hero \.picture\{aspect-ratio:16\/9\}/);
  // The section-page lead ratio must not apply to an imageless card. It is more specific
  // than the shared monogram rule and was the 16/9 block on phones.
  expect(css).toContain('.tiles>.card.lead:not(.noimg) .picture{aspect-ratio:16/9}');
  expect(css).not.toContain('.tiles>.card.lead .picture{aspect-ratio:16/9}');
  expect(css).toContain('.card.lead.noimg,.card.hero.noimg{display:grid;grid-template-columns:minmax(0,1fr) 64px;grid-template-areas:"body pic"');
  // Only the first, above-the-fold image loads eagerly.
  expect(html.match(/loading="lazy"/g)?.length ?? 0).toBe(html.match(/<img /g)!.length - html.match(/fetchpriority="high"/g)!.length);
 });
 it('lays an imageless section lead out as text, and keeps a real lead photo', async () => {
  const bare = story({ source: 'sjds', title: 'Nasdaq futures rise without a photo', section: 'negocios' });
  const photo = story({ source: 'sjds', title: 'A different business story with a photograph', section: 'negocios', image: 'https://img.example/real.jpg' });
  const imageless = await render('/s/negocios?lang=en', [bare, photo]);
  const lead = imageless.slice(imageless.indexOf('<article'), imageless.indexOf('</article>'));
  expect(lead).toContain('class="card lead noimg"');
  expect(lead).toContain('<b>SJDS</b>');
  expect(lead).not.toContain('<img');
  expect(imageless).toContain('src="https://img.example/real.jpg"');
  const pictured = await render('/s/negocios?lang=en', [photo, bare]);
  expect(pictured).toContain('class="card lead"');
  expect(pictured).not.toContain('class="card lead noimg"');
  expect(pictured).toContain('src="https://img.example/real.jpg"');
  // The compact grid is not inside a min-width query, so a phone uses it too.
  const ruleAt = css.indexOf('.card.lead.noimg,.card.hero.noimg{display:grid');
  expect(ruleAt).toBeGreaterThan(css.indexOf('.tiles>.card.lead:not(.noimg) .picture{aspect-ratio:16/9}'));
  expect(css.slice(css.lastIndexOf('}', ruleAt), ruleAt)).not.toContain('@media');
 });
 it('gives every section the same preview size, so "Otras y Opinión" earns no extra weight', async () => {
  const big = Array.from({ length: 60 }, (_, i) => story({ source: ['endi', 'metro', 'wapa'][i % 3], title: `Asunto de otras cosas numero ${i} ${i * 11}`, section: 'otras', time: now - (i + 10) * MIN }));
  const small = Array.from({ length: 12 }, (_, i) => story({ source: ['endi', 'metro', 'wapa'][i % 3], title: `Tema politico distinto ${i} ${i * 17}`, section: 'politica', time: now - (i + 80) * MIN }));
  const html = await render('/', [...big, ...small]);
  const block = (slug: string) => { const at = html.indexOf(`id="sec-${slug}"`); const end = html.indexOf('</section>', at); return html.slice(at, end); };
  const count = (s: string) => s.match(/<article class="card/g)?.length ?? 0;
  expect(count(block('otras'))).toBe(SECTION_PREVIEW_TOTAL);
  expect(count(block('politica'))).toBe(SECTION_PREVIEW_TOTAL);
  expect(block('otras')).toContain('60 noticias');
  expect(block('politica')).toContain('12 noticias');
  expect(block('otras')).toContain('Ver todas');
 });
 it('draws a ranked "Lo más leído" rail with numerals and keeps ranked stories out of the sections', async () => {
  const stories = Array.from({ length: 4 }, (_, i) => story({ source: 'endi', title: `Historia popular distinta ${i} xx${i}`, time: now - (i + 1) * MIN }));
  const html = await render('/', stories, { trending: stories.slice(0, 3).map((item, i) => ({ item, clicks: 9 - i })) });
  const rail = html.slice(html.indexOf('class="rail"'), html.indexOf('</aside>'));
  expect(rail).toContain('Lo más leído');
  expect(rail.match(/class="num" aria-hidden="true">[123]</g)).toHaveLength(3);
  expect(rail).toContain('/click?url=' + encodeURIComponent(stories[0].url));
  expect(mainOf(html).split('>' + stories[0].title + '</a>').length - 1).toBe(1);
  expect(html).toContain('front has-rail');
  expect(await render('/', stories)).not.toContain('class="rail"');
 });
 it('shows the "Última hora" ticker on the front page only, with the newest newsroom stories', async () => {
  const newest = story({ source: 'noticel', title: 'Lo último de la mañana', time: now - MIN });
  const reddit = story({ source: 'reddit_puertorico', title: 'Charla comunitaria', time: now - 30 });
  const home = await render('/', [reddit, newest]);
  const ticker = home.slice(home.indexOf('class="ticker"'), home.indexOf('</section>', home.indexOf('class="ticker"')));
  expect(ticker).toContain('Última hora');
  expect(ticker).toContain('Lo último de la mañana');
  expect(ticker).not.toContain('Charla comunitaria');
  expect(ticker).toContain('aria-hidden="true"'); // the looping copy is hidden from assistive tech
  expect(ticker).toContain('aria-label="Pausar el desplazamiento"');
  expect(await render('/s/politica', [newest])).not.toContain('class="ticker"');
  expect(await render('/?lang=en', [{ ...newest, source: 'sjds' }])).toContain('>Latest<');
 });
 it('uses relative timestamps with an absolute tooltip, and keeps "Visto" for observed times', async () => {
  const seen = story({ title: 'Observada', observed: true, time: now - 3 * 3600000 });
  const html = mainOf(await render('/', [seen]));
  expect(html).toMatch(/Visto <time datetime="[^"]+" title="[^"]+ AST" data-rel="\d+">hace 3 h<\/time>/);
  const old = story({ title: 'Vieja', time: now - 9 * 86400000 });
  const oldHtml = mainOf(await render('/s/politica', [old]));
  expect(oldHtml).toMatch(/<time datetime="[^"]+" title="[^"]+">[^<]+AST<\/time>/);
  expect(oldHtml).not.toContain('data-rel');
 });
 it('escapes hostile text everywhere the new markup prints it', async () => {
  const evil = story({ source: 'endi', title: '<img src=x onerror=alert(1)>', summary: '"><script>alert(2)</script>', image: 'https://img.example/"onload="alert(3)' });
  const html = await render('/', [evil]);
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<script>alert(2)');
  expect(html).not.toContain('"onload="alert(3)');
 });
 it('keeps the source filter, section links and language toggle on the redesigned page', async () => {
  const html = await render('/?lang=en&source=endi', [story({ source: 'endi', title: 'Filtered story here' })]);
  expect(html).toContain('<option value="endi" selected>');
  expect(html).toContain('href="/s/politica?lang=en&amp;source=endi"');
  expect(html).toContain('>Español</a>');
  expect(html).toContain('A look at Puerto Rico');
 });
 it('keeps alerts one tap away on phones through the sections sheet', async () => {
  const html = await render('/?lang=en', []);
  const sheet = html.slice(html.indexOf('<details class="more-nav">'), html.indexOf('</details>'));
  expect(sheet).toContain('class="alerts-sheet" href="/alerts?lang=en">My alerts</a>');
 });
 it('tells people when there is nothing to show instead of an empty page', async () => {
  expect(await render('/', [])).toContain('No hay noticias para mostrar');
 });
 it('does not print raw errors or database messages', async () => {
  const html = await render('/fuentes', [], { feeds: [{ source: 'endi', url: 'https://x', error: 'D1_ERROR: no such table', last_ok: now }] });
  expect(html).not.toContain('D1_ERROR');
 });
});

describe('assets', () => {
 it('serves one variable woff2 font with immutable caching, GET and HEAD only', async () => {
  const get = fontRoute(new Request('https://news.dev.pr' + FONT_PATH))!;
  const bytes = new Uint8Array(await get.arrayBuffer());
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('wOF2');
  expect(bytes.length).toBeLessThan(50 * 1024);
  expect(get.headers.get('content-type')).toBe('font/woff2');
  expect(get.headers.get('cache-control')).toContain('immutable');
  const head = fontRoute(new Request('https://news.dev.pr' + FONT_PATH, { method: 'HEAD' }))!;
  expect(head.body).toBeNull();
  expect(fontRoute(new Request('https://news.dev.pr' + FONT_PATH, { method: 'POST' }))!.status).toBe(405);
  expect(fontRoute(new Request('https://news.dev.pr/other.woff2'))).toBeUndefined();
 });
 it('preloads the font and declares exactly one @font-face', async () => {
  const html = await render('/', []);
  expect(html).toContain(`<link rel="preload" href="${FONT_PATH}" as="font" type="font/woff2" crossorigin>`);
  expect(html.match(/@font-face\{font-family:Fraunces/g)).toHaveLength(1);
  expect(css).toContain('font-display:swap');
 });
 it('gives unknown sources a stable monogram', () => {
  expect(sourceMark('nuevo', 'Nuevo Diario Hoy')).toEqual(sourceMark('nuevo', 'Nuevo Diario Hoy'));
  expect(sourceMark('nuevo', 'Nuevo Diario Hoy').code).toBe('NDH');
 });
});

describe('theme and motion', () => {
 it('defines the palette once per theme, honors the stored choice, and respects reduced motion', () => {
  expect(css).toContain(':root[data-theme=dark]{color-scheme:dark}');
  expect(css).toContain(':root[data-theme=light]{color-scheme:light}');
  expect(css).toContain('@media(prefers-reduced-motion:reduce)');
  expect(css).toContain(':focus-visible{outline:3px solid var(--accent)');
 });
});
