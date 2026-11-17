import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { additionalSources, additionalFeedURLs, unavailableSources, additionalMappingIsConsistent } from '../src/additional-sources';
import { parseFeed } from '../src/parse';
// Fixtures captured over real HTTP on 2026-11-14 by the discovering run (see
// docs/sources-status-integration.md); item counts are therefore fixed to those saves.
const seen = Date.parse('2026-11-14T22:30:00Z');
const feed = (id: string) => parseFeed(readFileSync(`test/fixtures/${id}.xml`, 'utf8'), additionalSources.find(s => s.id === id)!, seen);
const EXPECTED_ITEMS: Record<string, number> = { wapa: 50, wipr: 10, claridad: 5 };

describe('additional sources: verified publisher feeds', () => {
 it('covers exactly the verified ids and never registers the unavailable ones', () => {
  expect(additionalSources.map(s => s.id).sort()).toEqual(['claridad', 'wapa', 'wipr']);
  expect(additionalMappingIsConsistent()).toBe(true);
  expect(Object.keys(additionalFeedURLs)).toEqual(['wapa', 'wipr', 'claridad']);
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
 it('documents the unavailable publisher with evidence, not a guess', () => {
  expect(unavailableSources.map(s => s.name)).toContain('El Post Antillano');
  for (const s of unavailableSources) {
   expect(s.reason).toMatch(/HTTP|\//); // states the observed failure, not silence
   expect(Object.keys(additionalFeedURLs)).not.toContain(s.homepage);
  }
 });
});
