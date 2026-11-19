import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { additionalSources, additionalFeedURLs, unavailableSources, additionalMappingIsConsistent } from '../src/additional-sources';
import { feeds } from '../src/ingest';
import { sourceMark } from '../src/brand';
import { parseFeed, plain, safeUrl, summary } from '../src/parse';
// Fixtures captured over real HTTP (see docs/sources-status-integration.md).
// Item counts are fixed to those saves: WAPA/WIPR/Claridad on 2026-11-14,
// Radio Isla and WALO on 2026-11-19.
const seen = Date.parse('2026-11-14T22:30:00Z');
const feed = (id: string, at = seen) => parseFeed(readFileSync(`test/fixtures/${id}.xml`, 'utf8'), additionalSources.find(s => s.id === id)!, at);
const EXPECTED_ITEMS: Record<string, number> = { wapa: 50, wipr: 10, claridad: 5, radioisla: 25, walo: 10 };
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
  expect(additionalSources.map(s => s.id).sort()).toEqual(['claridad', 'radioisla', 'walo', 'wapa', 'wipr']);
  expect(additionalMappingIsConsistent()).toBe(true);
  expect(Object.keys(additionalFeedURLs)).toEqual(['wapa', 'wipr', 'claridad', 'radioisla', 'walo']);
  expect(feeds.radioisla).toEqual(['https://radioisla.tv/feed/']);
  expect(feeds.walo).toEqual(['https://waloradio.com/feed/']);
  expect(Object.values(feeds).flat().join('\n')).not.toContain('waloradio.com/category/noticias');
  expect(additionalSources.map(s => s.id)).not.toContain(unavailableSources[0].homepage); // El Post Antillano stays out
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
 it('documents the unavailable publisher with evidence, not a guess', () => {
  expect(unavailableSources.map(s => s.name)).toContain('El Post Antillano');
  for (const s of unavailableSources) {
   expect(s.reason).toMatch(/HTTP|\//); // states the observed failure, not silence
   expect(Object.keys(additionalFeedURLs)).not.toContain(s.homepage);
  }
 });
});
