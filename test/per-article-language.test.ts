import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { parseFeed, detectSpanish } from '../src/parse';
import { sources } from '../src/sources';
import { needsTranslation, validTranslation, type Translation } from '../src/i18n';
import renderer from '../src/render';
import type { Item } from '../src/parse';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const sjds = sources.find(s => s.id === 'sjds')!;
const seen = Date.parse('2026-11-16T09:00:00Z');
/** Real San Juan Daily Star feed captured Nov 16, 2026: English and Spanish items mixed. */
const items = (file = 'sjds_mixed.xml') => parseFeed(readFileSync(`test/fixtures/${file}`, 'utf8'), sjds, seen);
const byTitle = (needle: string) => items().find(i => i.title.includes(needle));

it('labels demonstrably Spanish SJDS articles per article instead of blanket-English by source', () => {
 // The two regressions the publisher's mixed feed shipped on Nov 16, 2026 — both were
 // rendered "Original in English" despite Spanish headlines.
 for (const needle of ['Senado aprueba programa Conecta 60+', 'Reportan 27 vuelos cancelados'] as const) {
  const item = byTitle(needle);
  expect(item, `fixture should contain: ${needle}`).toBeTruthy();
  expect(item!.originalLanguage, needle).toBe('es');
 }
 // The real NotiCel feed captured the same morning: Spanish items keep 'es', and — the
 // screenshot's actual complaint — the feed there ships NO image for these stories.
 const noticel = sources.find(s => s.id === 'noticel')!;
 const noticelItems = parseFeed(readFileSync('test/fixtures/noticel_2026-11-16.xml', 'utf8'), noticel, seen);
 expect(noticelItems.find(i => i.title.includes('Senado aprueba programa Conecta 60+'))).toMatchObject({ originalLanguage: 'es', image: '' });
 expect(noticelItems.find(i => i.title.includes('Gobierno explora energía nuclear'))).toMatchObject({ originalLanguage: 'es', image: '' });
 for (const needle of ['Manatí pounds Caguas in BSNF semifinal opener', 'Rosalía and Milo J win big', 'Puerto Rico finishes 5th at U-23', 'SpaceX makes history', 'What to know about continued flight disruptions']) {
  const item = byTitle(needle);
  expect(item, `fixture should contain: ${needle}`).toBeTruthy();
  expect(item!.originalLanguage, needle).toBeUndefined();
 }
});

it('queues demonstrably Spanish articles for translation but never labels a Spanish article as English or queues English ones', () => {
 const spanish = { ...byTitle('Senado aprueba programa Conecta 60+')! };
 expect(needsTranslation(spanish, {})).toBe(true); // enters the existing bounded queue
 const english = byTitle('Manatí pounds Caguas in BSNF semifinal opener')!;
 expect(needsTranslation(english, {})).toBe(false); // keeps the English-source default
 // A lazy "translation" that copies the Spanish headline is rejected for sjds too.
 const copied: Translation = { originalTitle: spanish.title, originalSummary: spanish.summary, title: spanish.title, summary: 'Excerpt still in Spanish.' };
 expect(validTranslation(spanish, copied)).toBe(false);
 const real: Translation = { originalTitle: spanish.title, originalSummary: spanish.summary, title: 'Senate approves the Conecta 60+ program', summary: 'A measure passed by the Senate…' };
 expect(validTranslation(spanish, real)).toBe(true);
});

it('renders consistent per-article labels in the English edition (translated, withheld, or English original)', async () => {
 const base: Omit<Item, 'originalLanguage'> = {
  url: 'https://www.sanjuandailystar.com/post/senado-aprueba-programa-conecta-60', source: 'sjds',
  title: 'Senado aprueba programa Conecta 60+', summary: 'Una medida aprobada por el Senado.',
  image: 'https://static.wixstatic.com/media/a793f9_ebe3adefff6c4f3a824a40c00274b86e~mv2.jpg/v1/fit/w_1000,h_1000,al_c,q_80/file.png',
  time: seen + 60000, observed: false, section: 'politica', reason: 'test',
 };
 const spanish = { ...base, originalLanguage: 'es' as const };
 const english = { ...base, url: 'https://www.sanjuandailystar.com/post/manati-pounds-caguas', title: 'Manatí pounds Caguas in BSNF semifinal opener', summary: 'The opener went to Manatí.' };
 const translation = { [spanish.url]: { originalTitle: spanish.title, originalSummary: spanish.summary, title: 'Senate approves the Conecta 60+ program', summary: 'A measure passed by the Senate.' } };
 const live = { items: [spanish, english], translations: translation, feeds: [] };
 const englishEdition = await renderer.fetch(new Request('https://example.com/?lang=en'), live).text();
 expect(englishEdition).toContain('Senate approves the Conecta 60+ program');
 expect(englishEdition).toContain('Translated · Original in Spanish'); // per-article label, not the source default
 expect(englishEdition).toContain('Original in English'); // the genuinely English item keeps its label
 expect(englishEdition).not.toContain('Senado aprueba'); // untranslated Spanish rows stay withheld from English
 const spanishEdition = await renderer.fetch(new Request('https://example.com/'), live).text();
 expect(spanishEdition).toContain('Senado aprueba programa Conecta 60+'); // same item, Spanish edition, original text
 // English title + no stored translation: the Spanish page shows the English original unlabeled.
 expect(spanishEdition).toContain('Manatí pounds Caguas');
});

it('detection stays silent for English text with Spanish proper nouns and all-caps bylines', () => {
 // "Manatí", "Rosalía", "Luis Muñoz Marín" are capitalized places/people: never signals.
 expect(detectSpanish('Manatí pounds Caguas in BSNF semifinal opener', 'The opener went to Manatí, and Caguas rallied late.')).toBeUndefined();
 expect(detectSpanish('Rosalía and Milo J win big: 6 key moments from the Latin Grammys', 'The ceremony featured Rosalía and others.')).toBeUndefined();
 expect(detectSpanish('POR CYBERNEWS — Un total de casos', 'POR CYBERNEWS CAROLINA')).toBeUndefined(); // all-caps byline only, nothing else
 // A Spanish title with a single strong signal plus a Spanish body is detected.
 expect(detectSpanish('Cinco heridos', 'Cinco heridos dejó un accidente en la carretera de Ponce, según la Policía.')).toBe('es');
 expect(detectSpanish('Senate approves program', 'The Senate approved the program in San Juan.')).toBeUndefined();
});
