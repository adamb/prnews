import type {Env} from './ingest';
import type {Item} from './parse';
import {CANDIDATE_LIMIT, articleEligible, cacheSkips, key, sensitive, valid} from './lighter';

/** Read contract for the on-demand worker's ledger. This module only reads.
 * Table lighter_stats, one row per scope ('all' | 'es' | 'en'), no person or address data:
 * scope, started_at (unix ms, never backdated), interactions, cache_hits, attempts, generations, failures.
 * A missing table, missing scope, or failed read is unavailable — not a zero. */
export const LEDGER_SCOPES = ['all', 'es', 'en'] as const;
export type LedgerScope = typeof LEDGER_SCOPES[number];
export type Edition = 'es' | 'en';
const TEXT_LOAD_CAP = 1000;
const CACHE_CHUNK = 40;
const EXAMPLE_CAP = 5;

export interface CacheRow { text: string | null; attempts: number; next_try: number }
export interface CountPair { es: number; en: number }
export interface ReadyExample { lang: Edition; title: string; text: string; url: string; storyId: number | null; source: string }
export interface QueueSnapshot { available: true; pending: CountPair; retry: CountPair; failed: CountPair; withheld: CountPair }
export interface ReadySnapshot { available: true; truncated: boolean; ready: CountPair; examples: ReadyExample[] }
export interface LedgerRow { startedAt: number; interactions: number; cacheHits: number; attempts: number; generations: number; failures: number }
export interface LedgerSnapshot { available: true; rows: Partial<Record<LedgerScope, LedgerRow>> }
export interface LighterView {
 ledger: LedgerSnapshot | { available: false };
 queue: QueueSnapshot | { available: false };
 ready: ReadySnapshot | { available: false };
}

const emptyPair = (): CountPair => ({ es: 0, en: 0 });
const whole = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export async function lighterCacheReadable(env: Env): Promise<boolean> {
 try { await env.DB.prepare('SELECT key FROM lighter_cache LIMIT 1').first(); return true; }
 catch { return false; }
}

/** Current-article takes only. A cached text whose key is an older title or excerpt is ignored. */
export function readySnapshot(items: Item[], lighter: Record<string, string> | undefined, cacheReadable: boolean): ReadySnapshot | { available: false } {
 if (!cacheReadable) return { available: false };
 const map = lighter ?? {};
 const ready = emptyPair();
 const examples: ReadyExample[] = [];
 const seen: Record<Edition, number> = { es: 0, en: 0 };
 for (const item of items) {
  for (const lang of ['es', 'en'] as const) {
   const text = map[key(item, lang)];
   if (!text || !valid(text, item) || sensitive(item.title + ' ' + item.summary)) continue;
   ready[lang]++;
   if (seen[lang] < EXAMPLE_CAP) {
    seen[lang]++;
    examples.push({ lang, title: item.title, text, url: item.url, storyId: null, source: item.source });
   }
  }
 }
 return { available: true, truncated: Object.keys(map).length >= TEXT_LOAD_CAP, ready, examples };
}

export async function attachStoryIds(env: Env, examples: ReadyExample[]): Promise<void> {
 if (!examples.length) return;
 try {
  const urls = [...new Set(examples.map(example => example.url))];
  const rows = await env.DB.prepare(`SELECT id, url FROM story_ids WHERE url IN (${urls.map(() => '?').join(',')})`).bind(...urls).all<{ id: number; url: string }>();
  const ids = new Map(rows.results.map(row => [row.url, row.id]));
  for (const example of examples) {
   const id = ids.get(example.url);
   example.storyId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  }
 } catch {
  for (const example of examples) example.storyId = null;
 }
}

async function loadCache(env: Env, keys: string[]): Promise<Map<string, CacheRow>> {
 const found = new Map<string, CacheRow>();
 for (let index = 0; index < keys.length; index += CACHE_CHUNK) {
  const chunk = keys.slice(index, index + CACHE_CHUNK);
  const rows = await env.DB.prepare(`SELECT key, text, attempts, next_try FROM lighter_cache WHERE key IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<CacheRow & { key: string }>();
  for (const row of rows.results) found.set(row.key, { text: row.text, attempts: row.attempts, next_try: row.next_try });
 }
 return found;
}

/** Eligible pending, retry, and exhausted rows for the same newest-60 scan generate() uses. */
export async function readLighterQueue(env: Env, now: number): Promise<QueueSnapshot | { available: false }> {
 try {
  // A missing cache table must not look like an empty queue.
  await env.DB.prepare('SELECT key FROM lighter_cache LIMIT 1').first();
  const rows = await env.DB.prepare('SELECT payload FROM articles ORDER BY published_at DESC LIMIT ' + CANDIDATE_LIMIT).all<{ payload: string }>();
  const items = rows.results.map(row => JSON.parse(row.payload) as Item).filter(articleEligible);
  const slots = items.flatMap(item => (['es', 'en'] as const).map(lang => ({ item, lang, cacheKey: key(item, lang) })));
  const cache = await loadCache(env, slots.map(slot => slot.cacheKey));
  const pending = emptyPair(), retry = emptyPair(), failed = emptyPair(), withheld = emptyPair();
  for (const slot of slots) {
   const old = cache.get(slot.cacheKey) ?? null;
   const text = old?.text ?? null;
   if (text && valid(text, slot.item)) continue;
   if (text) { withheld[slot.lang]++; continue; }
   if (cacheSkips(old, now)) { (old && old.attempts >= 3 ? failed : retry)[slot.lang]++; continue; }
   pending[slot.lang]++;
  }
  return { available: true, pending, retry, failed, withheld };
 } catch { return { available: false }; }
}

export async function readLighterLedger(env: Env): Promise<LedgerSnapshot | { available: false }> {
 try {
  const rows = await env.DB.prepare("SELECT scope, started_at, interactions, cache_hits, attempts, generations, failures FROM lighter_stats WHERE scope IN ('all','es','en')").all<{ scope: string; started_at: number; interactions: number; cache_hits: number; attempts: number; generations: number; failures: number }>();
  const parsed: LedgerSnapshot['rows'] = {};
  for (const row of rows.results) {
   if (row.scope !== 'all' && row.scope !== 'es' && row.scope !== 'en') continue;
   const startedAt = row.started_at, interactions = row.interactions, cacheHits = row.cache_hits, attempts = row.attempts, generations = row.generations, failures = row.failures;
   if (![startedAt, interactions, cacheHits, attempts, generations, failures].every(whole) || startedAt <= 0) continue;
   parsed[row.scope] = { startedAt, interactions, cacheHits, attempts, generations, failures };
  }
  return { available: true, rows: parsed };
 } catch { return { available: false }; }
}
