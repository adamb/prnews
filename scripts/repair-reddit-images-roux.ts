// One bounded, image-only repair for EXISTING r/PuertoRico rows, driven by a saved
// Arctic Shift newest-100 search response that was pulled ONCE from Roux's own egress
// (Cloudflare's egress was answering HTTP 429 while Roux's ordinary request was 200).
//
// This is deliberately not a proxy, rotation, or scheduled system, and the script never
// fetches Arctic Shift itself: it only consumes the saved response file, so a second
// pull happens solely by re-running the documented curl by hand. Dry run is the
// default and writes nothing; production writes require --apply and are guarded,
// idempotent, bounded, and image-only:
//
// - matches existing canonical rows by Reddit post ID only (source reddit_puertorico);
// - sets/repairs the payload image ONLY when the stored image is empty, or is a
//   demonstrably obsolete 140px `preview.redd.it` thumbnail and the Arctic record
//   (parsed by the deployed `parseArcticPost`/`safeUrl` validators) yields a fresh
//   valid real photo;
// - never overwrites a good image, never changes title, summary, translation,
//   published time, source or retention, and never invents a photo for text posts
//   or removed/sensitive records (those are only honestly marked in the bounded
//   `arctic_image_repair` ledger so the scheduled repair never re-requests them);
// - the existing D1 triggers carry the new URL into `archive_revisions` and the
//   R2 copy queue exactly like a feed-provided image.
//
// Usage:
//   npx tsx scripts/repair-reddit-images-roux.ts <saved-arctic-response.json> [--apply]
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseArctic, redditSource} from '../src/reddit';
import type {Item} from '../src/parse';

/** Hard cap on rows this run may write, on top of the single 100-post pull window. */
export const MAX_WRITES = 200;
/** Same terminal ledger level as the deployed repair (src/reddit-repair.ts). */
export const MAX_ATTEMPTS = 3;
/** A demonstrably obsolete tiny thumb from the old Reddit RSS media thumbnail. */
const TINY_THUMB_HOSTS = new Set(['preview.redd.it', 'external-preview.redd.it']);

export function isTinyThumb(image: string): boolean {
 try {
  const u = new URL(image);
  return u.protocol === 'https:' && TINY_THUMB_HOSTS.has(u.hostname.toLowerCase()) && u.searchParams.get('width') === '140';
 } catch { return false; }
}

/** Extracts the canonical Reddit post ID from a stored /r/<sub>/comments/<id>/ URL. */
export function redditId(url: string): string {
 const match = /\/comments\/([a-z0-9]{4,})(?:\/|$)/i.exec(url);
 return match ? match[1].toLowerCase() : '';
}

export type RepairAction = 'set' | 'upgrade-thumb' | 'keep-good' | 'no-photo' | 'outside-pull';
export interface RepairPlanRow {
 url: string; id: string; title: string; summary: string; action: RepairAction; oldImage: string; newImage: string;
}

/** Pure planner: pairs stored rows with images parsed from the saved pull. */
export function planRepair(rows: Array<{url: string; payload: string}>, items: Item[]): RepairPlanRow[] {
 const byId = new Map<string, Item>();
 for (const item of items) {
  const id = redditId(item.url);
  if (id && !byId.has(id)) byId.set(id, item);
 }
 return rows.map(row => {
  const id = redditId(row.url);
  const payload = JSON.parse(row.payload) as {title?: unknown; summary?: unknown; image?: unknown};
  const title = typeof payload.title === 'string' ? payload.title : '';
  const summary = typeof payload.summary === 'string' ? payload.summary : '';
  const oldImage = typeof payload.image === 'string' ? payload.image : '';
  const fresh = id ? byId.get(id) : undefined;
  const newImage = fresh?.image ?? '';
  let action: RepairAction;
  if (!fresh) action = 'outside-pull';
  else if (oldImage && !isTinyThumb(oldImage)) action = 'keep-good';
  else if (newImage && newImage !== oldImage) action = oldImage ? 'upgrade-thumb' : 'set';
  else action = oldImage ? 'keep-good' : 'no-photo';
  return {url: row.url, id, title, summary, action, oldImage, newImage};
 });
}

// Parameter-guarded D1 access through the wrangler CLI, following the existing
// scripts/enrich-live.ts shim: values are escaped and typed before substitution, and
// the ? placeholders are replaced left-to-right on the template only.
const literal = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? String(v) : v == null ? 'NULL' : `'` + String(v).replaceAll(`'`, `''`) + `'`;
const DB = {prepare(sql: string) {
 let args: unknown[] = [];
 const run = async () => {
  let i = 0;
  const command = sql.replace(/\?/g, () => literal(args[i++]));
  const result = JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'prnews', '--remote', '--command', command, '--json'], {encoding: 'utf8'}).replace(/^[\s\S]*?(?=\[\s*\{)/, ''))[0];
  return result;
 };
 return {bind(...values: unknown[]) {args = values; return this;}, run, all: run, async first() {return (await run()).results[0] ?? null;}};
}};
type Row = {url: string; payload: string};

const file = process.argv[2], apply = process.argv.includes('--apply');
const run = async(): Promise<void> => {
 if (!file || !file.endsWith('.json') || process.argv.slice(2).some((a: string) => a !== '--apply' && a !== file)) {
  console.error(`Usage: npx tsx scripts/repair-reddit-images-roux.ts <saved-arctic-response.json> [--apply]`);
  process.exit(2);
 }
 if (!apply) process.stderr.write('Dry run (default): no production writes. Pass --apply to write.\n');

 const now = Date.now();
 const items = parseArctic(readFileSync(file, 'utf8'), now); // Deployed parser + safeUrl validation, verbatim.
 const windowSql = `published_at>=${now - 14 * 86400000}`;
 const counts = async() => (await DB.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(json_extract(payload,'$.image'),'')='' THEN 1 ELSE 0 END) AS no_image, SUM(CASE WHEN json_extract(payload,'$.image') LIKE '%preview.redd.it%' AND json_extract(payload,'$.image') LIKE '%width=140%' THEN 1 ELSE 0 END) AS tiny_thumb, SUM(CASE WHEN COALESCE(json_extract(payload,'$.image'),'')!='' THEN 1 ELSE 0 END) AS with_image FROM articles WHERE source=? AND ${windowSql}`).bind(redditSource).first()) as Record<string, number>;

 const {results: rows} = await DB.prepare(`SELECT url,payload FROM articles WHERE source=? AND ${windowSql}`).bind(redditSource).all() as {results: Row[]};
 const plan = planRepair(rows, items);
 const candidates = plan.filter(p => (p.action === 'set' || p.action === 'upgrade-thumb') && p.newImage).slice(0, MAX_WRITES);
 const noPhoto = plan.filter(p => p.action === 'no-photo').slice(0, MAX_WRITES);

 const before = await counts();
 let payloadRepaired = 0, concurrent = 0, terminalMarked = 0;
 if (apply) {
  for (const row of candidates) {
   // Each UPDATE is guarded by the exact stored image, title, and summary, so a
   // concurrent change simply doesn't match and is reported, not overwritten.
   const empty = !row.oldImage;
   const merged = await DB.prepare(`UPDATE articles SET payload=json_set(payload,'$.image',?),updated_at=? WHERE url=? AND source=? AND ${empty ? `COALESCE(json_extract(payload,'$.image'),'')=''` : `json_extract(payload,'$.image')=?`} AND json_extract(payload,'$.title')=? AND json_extract(payload,'$.summary')=?`)
    .bind(row.newImage, now, row.url, redditSource, ...(empty ? [] : [row.oldImage]), row.title, row.summary).run();
   if (!merged.meta.changes) { concurrent++; continue; }
   payloadRepaired++;
   await DB.prepare(`INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,1,0,NULL) ON CONFLICT(url) DO NOTHING`).bind(row.url).run();
  }
  for (const row of noPhoto) {
   // Honest bookkeeping only: the fresh record shows a text/placeholder post, the same
   // terminal the scheduled repair records after its own lookup. No payload changes.
   await DB.prepare(`INSERT INTO arctic_image_repair(url,attempts,next_attempt,error) VALUES(?,?,0,?) ON CONFLICT(url) DO UPDATE SET attempts=excluded.attempts,next_attempt=0,error=excluded.error WHERE arctic_image_repair.attempts<?`)
    .bind(row.url, MAX_ATTEMPTS, 'No photo in the newest-100 Roux pull', MAX_ATTEMPTS).run();
   terminalMarked++;
  }
 }
 const after = apply ? await counts() : before;

 const sample = (action: RepairAction, count: number) => plan.filter(p => p.action === action).slice(0, count)
  .map(p => ({id: p.id, title: p.title.slice(0, 80), old: p.oldImage || null, new_: p.newImage || null}));
 console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  savedResponse: file,
  pull: {validPostsParsed: items.length},
  plan: {
   set: plan.filter(p => p.action === 'set').length,
   upgradeThumb: plan.filter(p => p.action === 'upgrade-thumb').length,
   keepGood: plan.filter(p => p.action === 'keep-good').length,
   noPhoto: plan.filter(p => p.action === 'no-photo').length,
   outsidePull: plan.filter(p => p.action === 'outside-pull').length,
  },
  writes: {payloadRepaired, concurrentGuardSkips: concurrent, terminalMarked},
  before,
  after,
  updatedAt: new Date(now).toISOString(),
  examples: {set: sample('set', 6), upgradeThumb: sample('upgrade-thumb', 6), noPhoto: sample('no-photo', 6)},
 }, null, 2));
};

// Only the CLI entry performs I/O; an import of this module (e.g. from a test) gets
// the pure planner functions and touches nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
