import { describe, expect, it } from 'vitest';
import { type Item } from '../src/parse';
import { isTinyThumb, MAX_WRITES, planRepair, redditId } from '../scripts/repair-reddit-images-roux';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const item = (id: string, image: string): Item => ({
 url: `https://www.reddit.com/r/puertorico/comments/${id}/post/`, source: 'reddit_puertorico',
 title: `Post ${id}`, summary: 'Publicación compartida en r/PuertoRico.', image,
 time: NOW - 60_000, observed: false, section: 'comunidad', reason: 'community',
});
const row = (id: string, image: string) => ({url: item(id, image).url.replace('/r/puertorico/', '/r/PuertoRico/'), payload: JSON.stringify({title: `Post ${id}`, summary: 'Publicación compartida en r/PuertoRico.', image})});
const tiny = 'https://preview.redd.it/abc.jpeg?width=140&height=140&crop=1:1,smart&auto=webp&s=1f283d4b38869b';
const poster = 'https://cf.preview.redd.it/xyz.jpeg?width=1080&format=pjpg&auto=webp&s=abc';

describe('redditId', () => {
 it('extracts the canonical post ID case-insensitively', () => {
  expect(redditId('https://www.reddit.com/r/PuertoRico/comments/1xzopfo/nos_dieron_un_ticket/')).toBe('1xzopfo');
  expect(redditId('https://www.reddit.com/r/puertorico/comments/1XZOPFO/a/')).toBe('1xzopfo');
  expect(redditId('https://news.dev.pr/s/comunidad')).toBe('');
 });
});

describe('isTinyThumb', () => {
 it('recognizes the obsolete 140px RSS thumbnail hosts only', () => {
  expect(isTinyThumb(tiny)).toBe(true);
  expect(isTinyThumb('https://external-preview.redd.it/z.png?width=140&format=pjpg&s=abc')).toBe(true);
  expect(isTinyThumb('https://i.redd.it/photo.jpg')).toBe(false);
  expect(isTinyThumb('https://preview.redd.it/big.jpeg?width=1080&format=pjpg&s=abc')).toBe(false);
  expect(isTinyThumb('http://preview.redd.it/a.jpg?width=140')).toBe(false);
  expect(isTinyThumb('')).toBe(false);
 });
});

describe('planRepair', () => {
 it('plans an image-only set for an empty stored image', () => {
  const plan = planRepair([row('1xzopfo', '')], [item('1xzopfo', poster)]);
  expect(plan).toHaveLength(1);
  expect(plan[0].action).toBe('set');
  expect(plan[0].newImage).toBe(poster);
  expect(plan[0].oldImage).toBe('');
 });

 it('plans an upgrade only from a demonstrably tiny thumb to a valid photo', () => {
  const plan = planRepair([row('1xxcdib', tiny)], [item('1xxcdib', 'https://i.redd.it/real.jpg')]);
  expect(plan[0].action).toBe('upgrade-thumb');
 });

 it('keeps a good image even when the pull yields another', () => {
  const kept = planRepair([row('1aa2bb3', 'https://i.redd.it/photo.jpg')], [item('1aa2bb3', 'https://i.redd.it/other.jpg')]);
  expect(kept[0].action).toBe('keep-good');
  expect(kept[0].newImage).toBe('https://i.redd.it/other.jpg');
  expect(kept[0].oldImage).toBe('https://i.redd.it/photo.jpg');
 });

 it('keeps a tiny thumb when the record offers no fresh image', () => {
  const plan = planRepair([row('1bb2cc3', tiny)], [item('1bb2cc3', '')]);
  expect(plan[0].action).toBe('keep-good');
 });

 it('terminates text posts honestly without inventing an image', () => {
  const plan = planRepair([row('1cc2dd3', '')], [item('1cc2dd3', '')]);
  expect(plan[0].action).toBe('no-photo');
 });

 it('marks rows outside the pull window for the scheduled repair', () => {
  const plan = planRepair([row('1dd2ee3', '')], [item('1ee2ff3', poster)]);
  expect(plan[0].action).toBe('outside-pull');
 });

 it('never modifies title or summary and pairs identical previews (no-op)', () => {
  const plan = planRepair([row('1ff2gg3', 'https://preview.redd.it/same.jpeg?width=140&height=105&auto=webp&s=x')], [item('1ff2gg3', 'https://preview.redd.it/same.jpeg?width=140&height=105&auto=webp&s=x')]);
  expect(plan[0].action).toBe('keep-good');
  expect(plan[0].title).toBe('Post 1ff2gg3');
  expect(plan[0].summary).toBe('Publicación compartida en r/PuertoRico.');
 });

 it('caps the bounded write window', () => {
  expect(MAX_WRITES).toBeLessThanOrEqual(200);
 });
});
