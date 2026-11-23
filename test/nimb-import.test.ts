import {it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {sections} from '../src/sections';

const allowed = new Set<string>(sections.map(([id]) => id));
const asOf = Date.parse('2026-11-19T16:31:00Z');
const parse = (file: string) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => {
 const [dt, section, slug] = line.split('|');
 const [day, clock] = dt.split(' ');
 return {day, clock, section, slug, time: Date.parse(`2026-11-${day}T${clock}:00-04:00`)};
});

it('keeps the November 19 sitemap rows inside the manual NIMB import', () => {
 const fresh = parse('scripts/imports/nimb-2026-11-19.tsv');
 const prior = new Set(parse('scripts/imports/nimb-2026-11-14.tsv').map(row => row.slug));
 expect(fresh).toHaveLength(29);
 expect(new Set(fresh.map(row => row.slug)).size).toBe(29);
 for (const row of fresh) {
  expect(prior.has(row.slug)).toBe(false);
  expect(row.slug).not.toBe('');
  expect(allowed.has(row.section)).toBe(true);
  expect(row.time).toBeGreaterThanOrEqual(asOf - 14 * 86400000);
  expect(row.time).toBeLessThanOrEqual(asOf);
  expect(`https://newsismybusiness.com/${row.slug}/`).not.toBe('https://newsismybusiness.com/');
  if (row.slug.startsWith('analysis-')) expect(row.section).toBe('opinion');
  if (row.slug.includes('-bill-') || row.slug.includes('senate-passes-bill')) expect(row.section).toBe('politica');
  if (row.slug.includes('-sues-')) expect(row.section).toBe('policiales');
 }
});
