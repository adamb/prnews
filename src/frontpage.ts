import { primarySection } from './sections';
import { newsprSource } from './sources';
import { redditSource } from './reddit';
import { publisherPlaceholder, safeUrl, type Item } from './parse';

/** Pure front-page composition: which stories lead, which fold into "también en", and how each
 * section's preview is laid out. It reads Items and returns Items — it never edits a headline,
 * excerpt or URL, and it never decides what the pipeline stores. */

/** One story on the front page plus the other newsrooms that covered the same event. */
export interface Cluster { item: Item; also: Item[] }

const STOP = new Set(('de del la el los las un una unos unas en con por para sin sobre entre desde hasta tras como pero que se su sus al lo y o a e u ni es son fue ha han '
 + 'the a an of in on at to for with by from and or as is are was were be been it its this that these those after before over into about says said new').split(' '));

/** Lower-cased, accent-folded content words of a headline (numbers kept: "27 millones" matters). */
export function headlineTokens(title: string): Set<string> {
 const folded = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
 const words = folded.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
 return new Set(words.map(w => w.length > 4 ? w.replace(/(?:es|s)$/, '') : w));
}

export const SAME_EVENT_WINDOW_MS = 12 * 3600000;
const MIN_SHARED = 4;

const overlaps = (x: Set<string>, y: Set<string>): boolean => {
 if (x.size < MIN_SHARED || y.size < MIN_SHARED) return false;
 const [small, large] = x.size <= y.size ? [x, y] : [y, x];
 let shared = 0, left = small.size;
 for (const word of small) {
  if (large.has(word)) shared++;
  // Cannot reach the minimum any more: stop early (most pairs are unrelated headlines).
  if (shared + --left < MIN_SHARED) return false;
 }
 if (shared < MIN_SHARED) return false;
 return shared / (x.size + y.size - shared) >= 0.6 || shared / small.size >= 0.85;
};
const pairable = (a: Item, b: Item) => a.source !== b.source && a.url !== b.url && a.source !== redditSource && b.source !== redditSource && Math.abs(a.time - b.time) <= SAME_EVENT_WINDOW_MS;

/** Near-identical coverage of one event: from different newsrooms, within hours, sharing most
 * content words. Deliberately conservative — hiding a distinct story is worse than showing a
 * near-duplicate, so loosely related headlines (same people, different angle) stay separate. */
export function sameEvent(a: Item, b: Item, titleA = a.title, titleB = b.title): boolean {
 return pairable(a, b) && overlaps(headlineTokens(titleA), headlineTokens(titleB));
}

const MAX_ALSO = 3;
const hasImage = (item: Item) => !!safeUrl(item.image);

/** Folds same-event stories. `titleOf` is the headline as the reader sees it (the translated one
 * on the English edition), so the comparison matches what is on the page. Items are expected
 * newest-first (the page query orders them so): each story is compared only with stories inside
 * the same-event window, which keeps ~2,000 stories cheap. Input order is kept; a cluster leads
 * with its first member that has a thumbnail, else its newest. The one exception is news.pr: it
 * rewrites the day's record, so when the unchanged conservative threshold folds its item with
 * the publisher's own story, the original publisher leads and news.pr is the "También en" link;
 * a cluster of only news.pr items still leads with news.pr. Thresholds are untouched. */
export function clusterStories(items: Item[], titleOf: (item: Item) => string = i => i.title): Cluster[] {
 const words = new Map<Item, Set<string>>();
 const tokens = (item: Item) => { let set = words.get(item); if (!set) { set = headlineTokens(titleOf(item)); words.set(item, set); } return set; };
 const groups: Item[][] = [];
 for (const item of items) {
  let home: Item[] | undefined;
  for (let g = groups.length - 1; g >= 0; g--) {
   const first = groups[g][0];
   if (first.time - item.time > SAME_EVENT_WINDOW_MS) break;
   if (groups[g].length <= MAX_ALSO && pairable(first, item) && overlaps(tokens(first), tokens(item))) { home = groups[g]; break; }
  }
  if (home) home.push(item); else groups.push([item]);
 }
 return groups.map(group => {
  const original = group.filter(member => member.source !== newsprSource);
  const pool = original.length ? original : group;
  const lead = pool.find(hasImage) ?? pool[0];
  return { item: lead, also: group.filter(member => member !== lead) };
 });
}

/** Stories that must not lead the page: community chatter and opinion columns. */
const editorial = (item: Item) => item.source !== redditSource && item.section !== 'opinion';

export interface Lead { hero?: Cluster; side: Cluster[]; rest: Cluster[] }

/** Top story + up to three secondary stories. The hero is the best-covered recent story that has
 * a picture (more newsrooms on one event is the strongest signal we have, then recency); the
 * secondaries are the newest remaining stories, preferring a different newsroom each. */
export function pickLead(clusters: Cluster[], skip: Set<string> = new Set()): Lead {
 const pool = clusters.filter(c => !skip.has(c.item.url) && editorial(c.item));
 const window = pool.slice(0, 24);
 const score = (cluster: Cluster, index: number) => (hasImage(cluster.item) ? 100 : 0) + cluster.also.length * 12 + (24 - index);
 let best = -1, bestScore = -Infinity;
 window.forEach((cluster, index) => { const s = score(cluster, index); if (s > bestScore) { bestScore = s; best = index; } });
 const hero = best >= 0 ? window[best] : undefined;
 const taken = new Set<string>(hero ? [hero.item.url] : []);
 const side: Cluster[] = [];
 const newsrooms = new Set<string>(hero ? [hero.item.source] : []);
 for (const pass of [0, 1]) {
  for (const cluster of pool) {
   if (side.length >= 3) break;
   if (taken.has(cluster.item.url) || (pass === 0 && newsrooms.has(cluster.item.source))) continue;
   side.push(cluster); taken.add(cluster.item.url); newsrooms.add(cluster.item.source);
  }
 }
 return { hero, side, rest: clusters.filter(c => !taken.has(c.item.url)) };
}

/** Every section shows the same number of stories, whatever the size of its bucket: a big
 * "Otras y Opinión" earns no extra room on the page. 1 lead + 2 medium + 3 brief. */
export const SECTION_PREVIEW = { lead: 1, mid: 2, brief: 3 } as const;
export const SECTION_PREVIEW_TOTAL = SECTION_PREVIEW.lead + SECTION_PREVIEW.mid + SECTION_PREVIEW.brief;

/** The stories of one section as the section page counts them (Reddit posts only in the Reddit
 * section's own count; topical Reddit posts also appear in their topic, as on /s/<slug>). */
export function inNavSection(item: Item, slug: string): boolean {
 return item.source === redditSource ? slug === 'comunidad' : primarySection(item.section) === slug;
}

export interface SectionPlan { lead?: Cluster; mid: Cluster[]; brief: Cluster[] }

/** Splits up to six unused stories into the lead / medium / brief tiers. The lead is the newest
 * story with a picture among the first four, so the big slot is not an empty gray block when a
 * photo is available; the rest keep their newest-first order. */
export function planSection(candidates: Cluster[]): SectionPlan {
 const picks = candidates.slice(0, SECTION_PREVIEW_TOTAL);
 const leadAt = Math.max(0, picks.slice(0, 4).findIndex(c => hasImage(c.item)));
 const lead = picks[leadAt];
 const rest = picks.filter((_, i) => i !== leadAt);
 return { lead, mid: rest.slice(0, SECTION_PREVIEW.mid), brief: rest.slice(SECTION_PREVIEW.mid, SECTION_PREVIEW.mid + SECTION_PREVIEW.brief) };
}

/** A thumbnail URL shared by this many different stories is a publisher's stock graphic (San Juan
 * Daily Star's "no image" card is on 13 unrelated stories), not a photograph of the story. */
export const STOCK_IMAGE_MIN_STORIES = 4;

/** Returns the items with stock thumbnails blanked so they take the source-monogram fallback
 * instead. Pure presentation: stored data is untouched, item order and identity are preserved
 * for every story that keeps its image. */
export function withoutStockImages(items: Item[]): Item[] {
 const users = new Map<string, Set<string>>();
 for (const item of items) if (item.image && !publisherPlaceholder(item.image)) { let set = users.get(item.image); if (!set) users.set(item.image, set = new Set()); set.add(item.url); }
 return items.map(item => {
  if (!item.image) return item;
  // One copy of a known publisher placeholder is still not a story photo. The
  // four-story rule stays for everything else, including a real photo reused twice.
  if (publisherPlaceholder(item.image) || (users.get(item.image)?.size ?? 0) >= STOCK_IMAGE_MIN_STORIES) return { ...item, image: '' };
  return item;
 });
}
