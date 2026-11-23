import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { additionalSources, additionalFeedURLs, unavailableSources, additionalMappingIsConsistent } from '../src/additional-sources';
import { sources, isEnglishSource } from '../src/sources';
import { feeds } from '../src/ingest';
import { sourceMark } from '../src/brand';
import { parseFeed, plain, safeUrl, summary } from '../src/parse';
// Fixtures captured over real HTTP (see docs/sources-status-integration.md and
// docs/pr-outlet-feeds.md). Item counts are fixed to those saves: WAPA/WIPR/Claridad
// on 2026-11-14, Radio Isla and WALO on 2026-11-19, news.pr on 2026-11-19, and the
// eleven 2026-11-20 outlets (Semanario Visión through Periódico Presencia).
const seen = Date.parse('2026-11-14T22:30:00Z');
const feed = (id: string, at = seen) => parseFeed(readFileSync(`test/fixtures/${id}.xml`, 'utf8'), additionalSources.find(s => s.id === id)!, at);
const EXPECTED_ITEMS: Record<string, number> = { wapa: 50, wipr: 10, claridad: 5, radioisla: 25, walo: 10, newspr: 30, vision: 10, lacalle: 10, elsol: 10, esnoticia: 10, eloriental: 10, laesquina: 10, millones: 100, eyboricua: 10, pasquines: 10, wkaq: 50, presencia: 10 };
const cdata = (block: string, tag: string) => new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(block)?.[1] ?? '';
/** A sentence from the end of content:encoded must not survive into the stored excerpt. */
const encodedTailAbsent = (encoded: string, excerpt: string) => {
 const tail = plain(encoded).slice(-80).trim();
 return tail.length > 40 && !excerpt.includes(tail);
};
const rawItems = (id: string) => readFileSync(`test/fixtures/${id}.xml`, 'utf8').split('<item>').slice(1).map(part => {
 const block = part.split('</item>')[0];
 return { block, description: cdata(block, 'description'), encoded: cdata(block, 'content:encoded') };
});

describe('additional sources: verified publisher feeds', () => {
 it('covers exactly the verified ids and never registers the unavailable ones', () => {
  expect(additionalSources.map(s => s.id).sort()).toEqual(['claridad', 'eloriental', 'elsol', 'esnoticia', 'eyboricua', 'lacalle', 'laesquina', 'millones', 'newspr', 'pasquines', 'presencia', 'radioisla', 'vision', 'walo', 'wapa', 'wipr', 'wkaq']);
  expect(additionalMappingIsConsistent()).toBe(true);
  expect(sources.map(s => s.id)).toHaveLength(33); // 10 base + 17 additional after the 2026-11-20 outlets
  expect(Object.keys(additionalFeedURLs)).toEqual(['wapa', 'wipr', 'claridad', 'radioisla', 'walo', 'newspr', 'vision', 'lacalle', 'elsol', 'esnoticia', 'eloriental', 'laesquina', 'millones', 'eyboricua', 'pasquines', 'wkaq', 'presencia']);
  expect(feeds.radioisla).toEqual(['https://radioisla.tv/feed/']);
  expect(feeds.walo).toEqual(['https://waloradio.com/feed/']);
  expect(feeds.newspr).toEqual(['https://news.pr/rss.xml']); // public RSS, never the gated /feed page
  expect(feeds.wkaq).toEqual(['https://www.wkaq580.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc']); // robots allows /search/; only /tncms/search/ is disallowed
  expect(feeds.eloriental).toEqual(['https://periodicoeloriental.com/?feed=rss2']); // the only address that returns the real RSS
  expect(Object.values(feeds).flat().join('\n')).not.toContain('waloradio.com/category/noticias');
  expect(Object.values(feeds).flat().join('\n')).not.toContain('news.pr/feed');
  expect(additionalSources.map(s => s.id)).not.toContain(unavailableSources[0].homepage); // El Post Antillano stays out
  // None of the requested-but-blocked outlets is registered, and neither is the user-excluded CPI.
  const blocked = Object.values(feeds).flat().join('\n');
  for (const host of ['laislaoeste.com', 'sincomillas.com', 'teleonce.com', 'notiuno.com', 'periodismoinvestigativo.com', 'cpi.']) expect(blocked).not.toContain(host);
 });
 it('parses each saved feed with its exact verified item count', () => {
  for (const source of additionalSources) {
   const items = feed(source.id);
   expect(items.length).toBe(EXPECTED_ITEMS[source.id]);
   for (const item of items) {
    expect(item.source).toBe(source.id);
    expect(item.title).toBeTruthy();
    expect(item.url).toMatch(/^https:\/\//);
    expect(item.url).toContain(new URL(source.homepage).hostname);
    expect(item.summary.length).toBeLessThanOrEqual(300);
    expect(item.time).toBeLessThanOrEqual(seen);
   }
  }
 });
 it('keeps summaries readable: no markup, boilerplate or undecoded entities', () => {
  for (const source of additionalSources) {
   for (const item of feed(source.id)) {
    expect(item.summary).not.toMatch(/<\/?\w|&[a-z]+;|&#\d+;/i);
    expect(item.summary).not.toContain('The post');
   }
  }
  expect(feed('wapa').some(i => i.section === 'clima')).toBe(true); // classification reaches the new urls
 });
 it('keeps Radio Isla on the description excerpt, first image and stripped tracking', () => {
  const at = Date.parse('2026-11-19T12:00:00Z');
  const items = feed('radioisla', at);
  const raw = rawItems('radioisla');
  expect(items).toHaveLength(25);
  expect(readFileSync('test/fixtures/radioisla.xml', 'utf8')).not.toContain('<enclosure');
  expect(sourceMark('radioisla', 'Radio Isla 1320')).toEqual({ code: 'RI', hue: 292 });
  let capped = 0;
  items.forEach((item, index) => {
   const description = raw[index].description;
   const encoded = plain(raw[index].encoded);
   const image = /<img[^>]+src=["']([^"']+)/i.exec(description)?.[1] ?? '';
   expect(item.originalLanguage).not.toBe('en');
   expect(item.url).toMatch(/^https:\/\/radioisla\.tv\/[^?]+\/$/);
   expect(item.url).not.toMatch(/utm_|fbclid/);
   expect(item.summary).toBe(summary(description));
   expect(item.summary.length).toBeLessThanOrEqual(300);
   expect(encoded.length).toBeGreaterThan(item.summary.length);
   expect(item.summary).not.toBe(encoded);
   expect(item.image).toBe(safeUrl(image));
   expect(item.image).toMatch(/^https:\/\/radioisla\.tv\//);
   if (plain(description).length > 300) {
    capped++;
    expect(item.summary.endsWith('…')).toBe(true);
   }
   expect(item.time).toBeLessThanOrEqual(at);
   expect(item.observed).toBe(false);
  });
  expect(capped).toBe(25);
  expect(items.filter(i => i.originalLanguage === 'es')).toHaveLength(24);
  // "New Fortress Energy" puts an English function word in an otherwise Spanish headline.
  // Detection stays undefined, so the Spanish source default still applies.
  expect(items.find(i => i.title.includes('New Fortress Energy'))?.originalLanguage).toBeUndefined();
  expect(items[0].time).toBe(Date.parse('Wed, 18 Nov 2026 20:30:11 +0000'));
  expect(encodedTailAbsent(raw[0].encoded, items[0].summary)).toBe(true);
 });
 it('keeps WALO on the main feed, capped excerpts and the existing empty-image path', () => {
  const at = Date.parse('2026-11-19T12:00:00Z');
  const items = feed('walo', at);
  const raw = rawItems('walo');
  const xml = readFileSync('test/fixtures/walo.xml', 'utf8');
  expect(items).toHaveLength(10);
  expect(xml).not.toContain('<enclosure');
  expect(xml).toContain('<img');
  expect(sourceMark('walo', 'WALO 1240 · Humacao')).toEqual({ code: 'WALO', hue: 122 });
  const titles = items.map(i => i.title).join('\n');
  expect(titles).toMatch(/Humacao/);
  expect(titles).toMatch(/Yabucoa/);
  expect(titles).toMatch(/Naguabo/);
  const police = items.find(i => i.title.includes('operativos antidrogas'));
  expect(police?.section).toBe('policiales');
  expect(police?.reason).toBe('category');
  items.forEach((item, index) => {
   const description = raw[index].description;
   const encoded = plain(raw[index].encoded);
   expect(item.originalLanguage).toBe('es');
   expect(item.url).toMatch(/^https:\/\/waloradio\.com\/\d{4}\/\d{2}\/\d{2}\/[^?]+\/$/);
   expect(item.url).not.toMatch(/utm_|fbclid/);
   expect(item.summary).toBe(summary(description));
   expect(item.summary.length).toBeLessThanOrEqual(300);
   expect(plain(description).length).toBeGreaterThan(300);
   expect(item.summary.endsWith('…')).toBe(true);
   expect(encoded.length).toBeGreaterThan(1000);
   expect(item.summary).not.toBe(encoded);
   expect(item.image).toBe(''); // description has no img; content:encoded images stay out of the parser
   expect(item.observed).toBe(false);
   expect(item.time).toBeLessThanOrEqual(at);
  });
  expect(items[0].time).toBe(Date.parse('Wed, 18 Nov 2026 19:59:36 +0000'));
 });

 it('keeps WKAQ 580 on its own search RSS, separate from WAPA', () => {
  const at = Date.parse('2026-11-20T23:30:00Z');
  const items = feed('wkaq', at);
  expect(items).toHaveLength(50);
  expect(readFileSync('test/fixtures/wkaq.xml', 'utf8')).toContain('<enclosure');
  expect(items.every(i => i.url.startsWith('https://www.wkaq580.com/'))).toBe(true); // every link is the publisher's own; no wapa.tv canonical collision
  expect(items.every(i => i.originalLanguage === 'es')).toBe(true);
  expect(items.filter(i => i.image)).toHaveLength(27);
  expect(items[0].title).toBe('Ferries del Caribe presenta su evento de Black Friday');
  expect(items[0].time).toBe(Date.parse('Fri, 20 Nov 2026 16:58:00 -0400'));
  expect(items[0].image).toMatch(/^https:\/\/bloximages\.chicago2\.vip\.townnews\.com\/wkaq580\.com\//);
  expect(items[0].observed).toBe(false);
  // Registered at the user's explicit request; the known WAPA overlap is reported in docs/pr-outlet-feeds.md.
 });

 it('treats Pasquines as a bilingual English-default publisher, like the San Juan Daily Star', () => {
  const at = Date.parse('2026-11-20T23:30:00Z');
  const items = feed('pasquines', at);
  expect(items).toHaveLength(10);
  expect(isEnglishSource('pasquines')).toBe(true); // unsignaled items stay English-readable originals, never eternally pending
  // The 2026-11-20 capture was English-dominant: no item carries a Spanish signal.
  expect(items.every(i => i.originalLanguage === undefined)).toBe(true);
  expect(items.every(i => i.image.startsWith('https://pasquines.us/wp-content/uploads/'))).toBe(true);
  expect(items[0].title).toBe('American Samoa deep-sea mining lease sale goes ahead days after court voids species approval');
  expect(items[0].url).toBe('https://pasquines.us/2026/11/20/american-samoa-deep-sea-mining-lease-sale-court-ruling/');
  expect(items[0].time).toBe(Date.parse('Fri, 20 Nov 2026 20:16:22 +0000'));
 });

 it('keeps 9 millones archive titles honest and its Webflow images', () => {
  const at = Date.parse('2026-11-20T23:30:00Z');
  const items = feed('millones', at);
  expect(items).toHaveLength(100);
  // 94 items ship only the site suffix as their title; nothing is invented to fill them.
  expect(items.filter(i => i.title === '| 9 millones')).toHaveLength(94);
  expect(items.every(i => i.image)).toBe(true);
  expect(items[0].title).toBe('Ismael Cruz Córdova revela cómo logró interpretar a Pedro Albizu | 9 millones');
  expect(items[0].url).toBe('https://www.9millones.com/story/ismael-cruz-cordova-cine-albizu/');
  expect(items[0].image).toMatch(/^https:\/\/cdn\.prod\.website-files\.com\//);
  expect(items[0].time).toBe(Date.parse('Tue, 03 Nov 2026 00:00:00 GMT'));
  // At capture the newest story was already 17 days old, so every item sits outside the
  // 14-day upsert window; the feed still parses, and future stories will be captured.
  expect(items.every(i => i.time < at - 14 * 86400000)).toBe(true);
 });

 it('pins the 2026-11-20 regional outlets to their own verified feeds', () => {
  const at = Date.parse('2026-11-20T23:30:00Z');
  const byTitle = (id: string, needle: string) => feed(id, at).find(i => i.title.includes(needle))!;
  expect(feed('vision', at)[0].time).toBe(Date.parse('Fri, 20 Nov 2026 18:12:31 +0000'));
  expect(byTitle('vision', '78 municipios').url).toMatch(/^https:\/\/periodicovision\.com\//);
  expect(feed('lacalle', at)[0].title).toContain('fiesta navideña');
  expect(byTitle('elsol', 'ODSEC').url).toMatch(/^https:\/\/periodicoelsolpr\.com\//);
  expect(byTitle('esnoticia', 'Presión económica').url).toMatch(/^https:\/\/esnoticiapr\.com\//);
  // The publisher's own canonical form is a query-string permalink; it is preserved as-is.
  expect(feed('eloriental', at)[0].url).toBe('https://periodicoeloriental.com/?p=1042');
  expect(feed('eloriental', at)[0].time).toBe(Date.parse('Wed, 18 Nov 2026 07:15:00 +0000'));
  expect(feed('laesquina', at)[0].title).toContain('Radicación de cargos por Violencia de Género en Guayama');
  expect(feed('laesquina', at)[0].time).toBe(Date.parse('Thu, 19 Nov 2026 14:11:23 +0000'));
  expect(byTitle('eyboricua', 'tradición navideña').url).toMatch(/^https:\/\/eyboricua\.com\//);
  expect(feed('presencia', at)[0].title).toContain('Municipio de Carolina');
  expect(feed('presencia', at)[0].time).toBe(Date.parse('Fri, 20 Nov 2026 20:52:48 +0000'));
 });

 it('documents the unavailable publisher with evidence, not a guess', () => {
  expect(unavailableSources.map(s => s.name)).toEqual(['El Post Antillano', 'La Isla Oeste', 'Sin Comillas', 'TeleOnce', 'NotiUno 630']);
  for (const s of unavailableSources) {
   expect(s.reason).toMatch(/HTTP|\//); // states the observed failure, not silence
   expect(Object.keys(additionalFeedURLs)).not.toContain(s.homepage);
  }
 });
});
