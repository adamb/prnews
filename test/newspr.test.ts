import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { additionalFeedURLs, additionalSources } from '../src/additional-sources';
import { isEnglishItem, isEnglishSource, sources } from '../src/sources';
import { parseFeed, type Item } from '../src/parse';
import { currentItem } from '../src/current-item';
import { classify } from '../src/sections';
import { translated, validTranslation, validSpanishTranslation, needsTranslation, needsSpanishTranslation, type Translation } from '../src/i18n';
import { clusterStories, sameEvent } from '../src/frontpage';
import { refresh, type Env } from '../src/ingest';

const seen = Date.parse('2026-11-19T23:30:00Z');
const newspr = sources.find(s => s.id === 'newspr')!;
const items = parseFeed(readFileSync(`test/fixtures/${newspr.files[0]}`, 'utf8'), newspr, seen);

describe('news.pr registry', () => {
 it('registers the public rss.xml (never the subscriber-gated /feed page)', () => {
  expect(additionalSources.some(s => s.id === 'newspr')).toBe(true);
  expect(additionalFeedURLs.newspr).toEqual(['https://news.pr/rss.xml']);
  expect(Object.keys(additionalFeedURLs).some(k => k.includes('feed/'))).toBe(false);
  expect(sources.filter(s => s.id === 'newspr').length).toBe(1);
 });
 it('is an English source, so its originals skip the Spanish→English queue', () => {
  expect(isEnglishSource('newspr')).toBe(true);
  for (const item of items) {
   expect(item.source).toBe('newspr');
   expect(isEnglishItem(item)).toBe(true);          // English source default; no per-article Spanish signal asserted
   expect(needsTranslation(item, {})).toBe(false);  // English edition renders the original: no redundant AI
  }
 });
});

describe('news.pr classification', () => {
 // One synthetic item per publisher label: the live capture does not carry every
 // label on every day (it had no Justice & Public Safety item at capture time).
 const labeled = (category: string, title = 'Headline for the label test', summary = 'Excerpt text'): Item =>
  parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>news.pr</title>${[category].map(c => `<item><title>${title}</title><link>https://news.pr/story/${c.replace(/\W+/g, '')}</link><guid>news-pr:${c}:v1</guid><pubDate>Thu, 19 Nov 2026 12:00:00 GMT</pubDate><category>${c}</category><description>${summary}</description></item>`).join('')}</channel></rss>`, newspr, seen)[0];
 it('maps the publisher’s exact categories to existing sections', () => {
  expect(items.length).toBeGreaterThanOrEqual(10);
  expect(labeled('Energy & Grid').section).toBe('energia');
  expect(labeled('energy & grid').section).toBe('energia');
  expect(labeled('Economy & Business').section).toBe('negocios');
  expect(labeled('Justice & Public Safety').section).toBe('policiales');
  expect(labeled('Sports').section).toBe('deportes');
  expect(labeled('Culture & Events').section).toBe('entretenimiento');
  expect(labeled('Education & Health').section).toBe('salud');
  expect(labeled('Federal & Fiscal').section).toBe('politica');
  for (const label of ['briefs', 'Environment & Climate', 'Infrastructure & Transport', 'Tourism & Travel', 'la isla que viene', 'general', 'More']) {
   const item = labeled(label);
   expect(item.reason === 'keywords' || item.reason === 'fallback').toBe(true); // falls through to the shared classifier
   expect(item.section).not.toBe('comunidad');
  }
  expect(items.filter(i => (i.categories ?? []).some(c => /energy & grid/i.test(c))).every(i => i.section === 'energia' && i.reason === 'category')).toBe(true);
 });
 it('keeps the same section when the renderer re-classifies stored items', () => {
  for (const item of items) expect(currentItem(item).section).toBe(item.section);
  // The stored categories are what makes render-time re-classification reproduce
  // the ingest-time result; without them a keyword match would override the feed label.
  const categoryItem = items.find(i => i.reason === 'category')!;
  expect(categoryItem).toBeTruthy();
  expect(classify(categoryItem.url, [], categoryItem.title + ' ' + categoryItem.summary, 'newspr').section)
   .not.toBe(categoryItem.section);
 });
 it('leaves other sources’ categories, payloads and render behavior untouched', () => {
  // Scope guard (F3): category preservation is news.pr-only. Every other source's
  // fixtures must keep the exact pre-news.pr render behavior — re-classification
  // from URL and keywords only, no stored categories — verified across all of them.
  const others = sources.filter(s => s.id !== 'newspr' && s.id !== 'reddit_puertorico');
  let checked = 0;
  for (const source of others) for (const file of new Set(source.files)) {
   const parsed = parseFeed(readFileSync(`test/fixtures/${file}`, 'utf8'), source, seen);
   for (const item of parsed) {
    checked++;
    expect(item.categories).toBeUndefined();                       // payloads keep their exact current shape
    expect(currentItem(item).section).toBe(classify(item.url, [], item.title + ' ' + item.summary).section); // the exact pre-news.pr expression
   }
  }
  expect(checked).toBeGreaterThanOrEqual(400);                      // every non-newspr, non-reddit fixture item
  // The concrete regression the global categories change caused: Radio Isla's flu
  // transmission report rendered under its keyword section (salud); the global
  // change moved it to Government & Politics. The news.pr-only scoping keeps the
  // rendered section exactly as deployed before this source existed.
  const radioisla = additionalSources.find(s => s.id === 'radioisla')!;
  const flu = parseFeed(readFileSync(`test/fixtures/${radioisla.files[0]}`, 'utf8'), radioisla, seen)
   .find(i => /influenza/i.test(i.title))!;
  expect(classify(flu.url, [], flu.title + ' ' + flu.summary).section).toBe('salud');
  expect(currentItem(flu).section).toBe('salud');                    // unchanged: never politica
 });
 describe('other sources: stored payload shape is unchanged', () => {
  it('does not store feed categories on non-newspr items at ingest', () => {
   const endi = sources.find(s => s.id === 'endi')!;
   const endiItems = parseFeed(readFileSync(`test/fixtures/${endi.files[0]}`, 'utf8'), endi, seen);
   expect(endiItems.some(i => i.categories)).toBe(false);
   expect(classify('https://www.elnuevodia.com/noticias/locales/x/', [], 'noticia', 'endi').section).toBe('otras');
  });
 });
});

describe('news.pr English→Spanish translation direction', () => {
 const item = items[0];
 const spanishEntry = (title = `Titular traducido del artículo`, summary = 'Resumen traducido con la información completa del suceso publicado hoy.'): Translation =>
  ({ target: 'es', originalTitle: item.title, originalSummary: item.summary, title, summary });
 it('waits for a Spanish translation, not an English one', () => {
  expect(needsSpanishTranslation(item, {})).toBe(true);
  expect(needsSpanishTranslation(item, { [item.url]: spanishEntry() })).toBe(false);
  // Every English-origin item is claimed by the reverse queue (2026-11-21 generalization);
  // a demonstrably Spanish payload from the same feed belongs to the shared ES→EN queue instead.
  expect(needsSpanishTranslation({ ...item, source: 'sjds' }, {})).toBe(true);
  expect(needsSpanishTranslation({ ...item, source: 'sjds', originalLanguage: 'es' as const }, {})).toBe(false);
 });
 it('rejects copy-through English and entries without the reverse marker', () => {
  expect(validSpanishTranslation(item, { ...spanishEntry(), title: item.title })).toBe(false);  // unchanged headline
  expect(validSpanishTranslation(item, { ...spanishEntry(), target: undefined } as Translation)).toBe(false); // EN-direction shape
  expect(validSpanishTranslation(item, { ...spanishEntry(), originalTitle: 'Changed later' })).toBe(false);  // stale revision
  expect(validSpanishTranslation(item, { ...spanishEntry(), title: 'The English headline stays here' })).toBe(false); // not Spanish
 });
 it('renders the original in English and the cached translation in Spanish', () => {
  const cache = { [item.url]: spanishEntry() };
  expect(translated(item, 'en', cache)).toEqual({ ...item, translated: false });   // English edition: original, no AI
  expect(translated(item, 'es', cache).translated).toBe(true);                       // Spanish edition: valid Spanish
  expect(translated(item, 'es', cache).title).toBe(`Titular traducido del artículo`);
  expect(translated(item, 'es', {}).translated).toBe(false);                        // no cache → English original stays
 });
 it('shows the Spanish translation on the Spanish page and the original on the English page', async () => {
  const renderer = (await import('../src/render')).default;
  const cache = { [item.url]: spanishEntry() };
  const es = await renderer.fetch(new Request('https://example.com/?lang=es'), { items: [item], translations: cache, feeds: [] }).text();
  expect(es).toContain('Titular traducido del artículo');
  const en = await renderer.fetch(new Request('https://example.com/?lang=en'), { items: [item], translations: cache, feeds: [] }).text();
  expect(en).toContain(item.title.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))); // the original English headline stays (HTML-escaped)
  expect(en).not.toContain('Titular traducido del artículo'); // no redundant AI output
 });
 it('invalidates the cache when the publisher revises the item', () => {
  const revised = { ...item, title: item.title + ' (updated)' };
  expect(needsSpanishTranslation(revised, { [item.url]: spanishEntry() })).toBe(true);
 });
});

describe('news.pr card labels and content language', () => {
 const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
 const esTitle = 'Titular traducido del artículo en español';
 const esSummary = 'Resumen traducido con la información completa del suceso publicado hoy.';
 const spanishItem: Item = { url: 'https://www.noticel.com/apagon-san-juan/', source: 'noticel', title: 'El apagón afectó a miles de familias en San Juan', summary: 'El servicio eléctrico se restableció durante la madrugada del jueves.', image: '', time: seen - 3600000, observed: false, section: 'energia', reason: 'test' };
 const englishTranslation: Translation = { originalTitle: spanishItem.title, originalSummary: spanishItem.summary, title: 'Power outage affected thousands of families in San Juan', summary: 'Electric service was restored early on Thursday morning.' };
 const sectionPage = (path: string, lang: 'es' | 'en', live: object) =>
  import('../src/render').then(({ default: renderer }) => renderer.fetch(new Request(`https://example.com${path}?lang=${lang}`), live as never).text());
 it('labels the Spanish edition’s translated news.pr card as Spanish text translated from English', async () => {
  const item = items[0];
  const cache = { [item.url]: { target: 'es' as const, originalTitle: item.title, originalSummary: item.summary, title: esTitle, summary: esSummary } };
  const es = await sectionPage(`/s/${item.section}`, 'es', { items: [item], translations: cache, feeds: [] });
  expect(es).toContain(esTitle);
  expect(es).toContain('lang="es"><a href="/click');          // heading content lang is the Spanish edition, not "en"
  expect(es).toContain('hreflang="en"');                     // the publisher link keeps the English original’s language
  expect(es).toContain('<p class="excerpt" lang="es">');     // excerpt carries the same content lang
  expect(es).toContain('<span class="language">Traducido · Original en inglés</span>');
  expect(es).not.toContain('Translated · Original in Spanish'); // the English-only label never leaks to the Spanish page
 });
 it('keeps the English original’s own card correct in both editions without a translation', async () => {
  const item = items[0];
  const es = await sectionPage(`/s/${item.section}`, 'es', { items: [item], translations: {}, feeds: [] });
  expect(es).toContain('lang="en"><a href="/click');                       // untranslated news.pr: English text keeps lang="en"
  expect(es).toContain('<p class="excerpt" lang="en">');
  expect(es).toContain('<span class="language">EN · En inglés</span>');   // existing Spanish-edition disclosure for English originals
  const en = await sectionPage(`/s/${item.section}`, 'en', { items: [item], translations: {}, feeds: [] });
  expect(en).toContain(escape(item.title));
  expect(en).toContain('lang="en"><a href="/click');
  expect(en).toContain('<span class="language">Original in English</span>'); // English original stays "Original in English"
  expect(en).not.toContain('Traducido · Original en inglés');
 });
 it('keeps the classic Spanish→English label and hreflang exactly as before', async () => {
  const cache = { [spanishItem.url]: englishTranslation };
  const en = await sectionPage('/s/energia', 'en', { items: [spanishItem], translations: cache, feeds: [] });
  expect(en).toContain('Translated · Original in Spanish');   // unchanged EN-edition disclosure
  expect(en).toContain('lang="en"><a href="/click');        // translated headline is English content
  expect(en).toContain('hreflang="es"');                    // publisher link keeps the Spanish original’s language
  expect(en).toContain(`<p class="excerpt" lang="en">`);
  expect(en).not.toContain('Traducido · Original en inglés');
  const es = await sectionPage('/s/energia', 'es', { items: [spanishItem], translations: cache, feeds: [] });
  expect(es).toContain('lang="es"><a href="/click');        // Spanish edition: original text, no translation label
  expect(es).not.toContain('<span class="language">');
 });
 it('localizes the community card label and keeps the translated community heading English-only content', async () => {
  const post: Item = { url: 'https://www.reddit.com/r/PuertoRico/comments/abc123/outage/', source: 'reddit_puertorico', title: 'El apagón de LUMA en San Juan', summary: 'Publicación compartida en r/PuertoRico.', image: '', time: seen - 3600000, observed: false, section: 'comunidad', reason: 'test' };
  const cache = { [post.url]: { originalTitle: post.title, originalSummary: post.summary, title: 'The LUMA outage in San Juan', summary: 'A community discussion about the outage.' } };
  const en = await sectionPage('/s/comunidad', 'en', { items: [post], translations: cache, feeds: [] });
  expect(en).toContain('Community discussion · Translated'); // same English wording as before
  expect(en).toContain('lang="en"><a href="/click');
  expect(en).toContain('<p class="reddit-summary" lang="en">');
  const es = await sectionPage('/s/comunidad', 'es', { items: [post], translations: { [post.url]: { originalTitle: post.title, originalSummary: post.summary, title: post.title, summary: post.summary, spanishSummary: 'Una conversación sobre el apagón.' } }, feeds: [] });
  expect(es).toContain('Discusión de la comunidad · Publicación original'); // untranslated community label stays Spanish on the Spanish page
  expect(es).not.toContain('Discusión de la comunidad · Traducido');        // the saved Spanish summary is not a "translated" card
  expect(es).toContain('lang=""><a href="/click');                          // community originals keep the neutral content lang
 });
 it('marks hall-of-fame summaries with the edition language when translated and the original’s own otherwise', async () => {
  const renderer = (await import('../src/render')).default;
  const item = items[0];
  const hall = [{ url: item.url, clicks: 5, item, translation: { target: 'es' as const, originalTitle: item.title, originalSummary: item.summary, title: esTitle, summary: esSummary }, capturedAt: seen }];
  const es = await (await renderer.fetch(new Request('https://example.com/hall?lang=es'), { items: [item], translations: {}, feeds: [], hall } as never)).text();
  expect(es).toContain(esTitle);
  expect(es).toContain(`<p lang="es">`); // the translated summary is Spanish content on the Spanish page
  const en = await (await renderer.fetch(new Request('https://example.com/hall?lang=en'), { items: [], translations: {}, feeds: [], hall: [{ url: spanishItem.url, clicks: 5, item: spanishItem, translation: englishTranslation, capturedAt: seen }] } as never)).text();
  expect(en).toContain(`<p lang="en">`); // the classic ES→EN direction keeps lang="en"
 });
});

describe('news.pr reverse-direction cache cannot leak into English paths', () => {
 const item = items[0];
 const entry = (targetItem: Item, title: string, summary: string): Translation =>
  ({ target: 'es', originalTitle: targetItem.title, originalSummary: targetItem.summary, title, summary });
 const esHeadline = 'Tres paradas de longaniza marcaron la historia de Orocovis';
 const esSummary = 'El recorrido empieza en la casa original de 1934, según la tradición del pueblo.';
 const spanish = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>news.pr</title><item><title>La isla que viene: ${esHeadline}</title><link>https://news.pr/story/es-edge</link><guid>news-pr:es-edge:v1</guid><pubDate>Thu, 19 Nov 2026 12:00:00 GMT</pubDate><category>Culture &amp; Events</category><description>${esSummary}</description></item></channel></rss>`, newspr, seen)[0];
 it('treats a reverse (target:es) entry as never being an English translation', () => {
  // An English news.pr item with its valid Spanish translation cached: the English edition,
  // the English alert mail and the ES→EN queue must all see the original, never the Spanish.
  const cache = { [item.url]: entry(item, 'Titular traducido del artículo', 'Resumen traducido con la información completa del suceso publicado hoy.') };
  expect(validTranslation(item, cache[item.url])).toBe(false);
  expect(translated(item, 'en', cache)).toEqual({ ...item, translated: false });
  expect(needsTranslation(item, cache)).toBe(false); // English item: nothing pending for the English edition
 });
 it('routes a Spanish news.pr payload to the Spanish→English queue only (no double queue)', () => {
  expect(spanish.originalLanguage).toBe('es');            // a Spanish payload from the English source
  expect(needsSpanishTranslation(spanish, {})).toBe(false); // the reverse queue never claims it
  expect(needsTranslation(spanish, {})).toBe(true);         // the shared ES→EN queue owns it
  // Even if a reverse entry is already stored on such a row (e.g. left by a retry race),
  // the English queue stays pending and the English edition shows no Spanish as English:
  const stale = { [spanish.url]: entry(spanish, esHeadline, esSummary) };
  expect(needsTranslation(spanish, stale)).toBe(true);
  expect(translated(spanish, 'en', stale)).toEqual({ ...spanish, translated: false });
 });
});

describe('news.pr same-event clustering', () => {
 const base = (source: string, title: string, time = seen - 3600000): Item =>
  ({ url: `https://example.com/${source}/${Math.abs([...title].reduce((a, c) => a + c.charCodeAt(0), 0))}/`, source, title, summary: 'Summary', image: '', time, observed: false, section: 'otras', reason: 'test' });
 it('folds a matching story with the original publisher as lead and news.pr as también', () => {
  const title = 'Power outage hits San Juan neighborhood overnight';
  const original = base('noticel', title), rewrite = base('newspr', title, seen - 1800000);
  expect(sameEvent(original, rewrite)).toBe(true);
  const [cluster] = clusterStories([rewrite, original]);
  expect(cluster.item.source).toBe('noticel');
  expect(cluster.also.map(i => i.source)).toEqual(['newspr']);
 });
 it('still lets a news.pr-only cluster lead with news.pr', () => {
  const [cluster] = clusterStories([base('newspr', 'Unique story only this outlet covered tonight')]);
  expect(cluster.item.source).toBe('newspr');
  expect(cluster.also).toHaveLength(0);
 });
 it('reports news.pr in the registry-driven /fuentes health page', async () => {
  const renderer = (await import('../src/render')).default;
  const state = { url: 'https://news.pr/rss.xml', source: 'newspr', etag: null, modified: null, last_checked: 1795131000000, last_ok: 1795131000000, status: 200, error: null, failures: 0, next_check: 1795131000000, item_count: 30 };
  const page = await renderer.fetch(new Request('https://example.com/fuentes'), { items, translations: {}, feeds: [state] }).text();
  expect(page).toContain('news.pr');
  expect(page).toContain('Inglés');          // factual language label from the shared registry
  expect(page).toContain('Último éxito');    // its own last-success status, like every feed
  const failing = await renderer.fetch(new Request('https://example.com/fuentes'), { items: [], translations: {}, feeds: [{ ...state, error: 'HTTP 500', last_ok: null }] }).text();
  expect(failing).toContain('Actualizando…'); // public error state stays safe (no database message)
  expect(failing).not.toContain('HTTP 500');
 });
 it('does not weaken the shared threshold for unrelated headlines', () => {
  const a = base('newspr', 'School budget hearing scheduled for Monday evening');
  const b = base('noticel', 'Cruise ship arrives at the port of San Juan');
  expect(sameEvent(a, b)).toBe(false);
  expect(clusterStories([a, b])).toHaveLength(2);
 });
});

describe('news.pr reverse translation queue (D1)', () => {
 function database(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_live.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0010_image_enrich.sql', 'utf8'));
  function prepare(sql: string): any {
   let args: any[] = [];
   return { bind(...values: any[]) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; } };
  }
  return { prepare, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
 }
 afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
 it('ingests the feed, translates into Spanish with a per-run cap, and never queues news.pr for English', async () => {
  const DB = database();
  const aiCalls: { system: string }[] = [];
  const env = { DB, AI: { run: async (_model: string, payload: any) => {
   const input = JSON.parse(payload.messages[1].content) as { id: number }[];
   aiCalls.push({ system: payload.messages[0].content });
   return { response: JSON.stringify({ articles: input.map(i => ({ id: i.id, title: `Titular traducido del artículo ${i.id}`, summary: `Resumen traducido con la información completa del suceso número ${i.id} publicado hoy.` })) }) };
  } } } as unknown as Env;
  const now = Date.parse('2026-11-19T23:30:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const feed = readFileSync('test/fixtures/newspr.xml', 'utf8');
  vi.stubGlobal('fetch', vi.fn(async (input: URL) => String(input).includes('news.pr')
   ? new Response(feed, { headers: { 'content-type': 'application/rss+xml' } })
   : new Response('Unavailable', { status: 503 }))); // other sources stay isolated failures
  await refresh(env);
  const count = async () => (await DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE source='newspr'").first<any>()).n;
  const stored = async () => (await DB.prepare("SELECT payload,translation FROM articles WHERE source='newspr'").all<{ payload: string; translation: string | null }>()).results;
  expect(await count()).toBe(items.length);
  const first = (await stored()).filter(r => r.translation);
  expect(first.length).toBe(8); // REVERSE_PER_RUN bounds the queue; the rest waits for later runs
  expect(aiCalls.length).toBe(2);  // two bounded batches of 4; the Spanish→English queue found nothing to do
  expect(aiCalls.every(c => c.system.includes('fluent Spanish') && !c.system.includes('fluent English'))).toBe(true);
  const entry = JSON.parse(first[0].translation!) as Translation;
  expect(entry.target).toBe('es');
  expect(entry.originalTitle).toBe((JSON.parse(first[0].payload) as Item).title);
  const cache: Record<string, Translation> = { [(JSON.parse(first[0].payload) as Item).url]: entry };
  const shown = translated(JSON.parse(first[0].payload) as Item, 'es', cache);
  expect(shown.translated).toBe(true);
  expect(shown.title).toContain('Titular traducido');
  expect(await DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE source!='newspr'").first<any>()).toMatchObject({ n: 0 });
  // The queue drains 8 per run: 30 items take 4 runs; every call is the Spanish
  // prompt, and once every item has a valid cache a further run claims nothing.
  await refresh(env); await refresh(env); await refresh(env);
  expect((await stored()).filter(r => r.translation).length).toBe(items.length);
  expect(aiCalls.length).toBe(8);
  const before = aiCalls.length;
  await refresh(env);
  expect(aiCalls.length).toBe(before); // valid caches are reused; page views and idle runs never call AI
  const calls = vi.mocked(fetch).mock.calls.length;
  await refresh(env);
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls); // feeds wait for their 15-minute slot
 });
});
