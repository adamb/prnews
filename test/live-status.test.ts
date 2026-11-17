import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readStatus, refreshStatus, lastGoodMap, nwsChip, usgsChip, lumaChip, statusURLs, STATUS_TTL_MS, STATUS_STALE_MS, type StatusEnv } from '../src/live-status';

const NOW = Date.parse('2026-11-14T18:30:00Z');
function db(): StatusEnv { // mirrors test/digest.test.ts's D1 shim
 const engine = new DatabaseSync(':memory:');
 engine.exec("CREATE TABLE live_status (source TEXT PRIMARY KEY CHECK(source IN ('weather','earthquake','outage')), payload TEXT, error TEXT, last_checked INTEGER NOT NULL, last_good INTEGER, fetch_ms INTEGER)");
 const wrap = (sql: string) => {
 const call = (args: any[]) => ({
  first: async () => engine.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: engine.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: engine.prepare(sql).run(...args).changes } }),
 });
 return { ...call([]), bind: (...args: any[]) => call(args) }; // D1 allows .all() without .bind()
 };
 return { DB: { prepare: wrap } } as unknown as StatusEnv;
}

const nwsData = { features: [{ properties: { event: 'Flood Advisory', messageType: 'Alert', status: 'Actual' } }, { properties: { event: 'Flood Advisory', messageType: 'Update', status: 'Actual' } }] } as any;
const nwsEmpty = { features: [] } as any;
const usgsData = { features: [{ properties: { mag: 2.4, place: 'Ponce',time:NOW-1000 } }, { properties: { mag: 3.1, place: 'Guánica',time:NOW-2000 } }, { properties: { mag: null } }] } as any;
const lumaZero = { features: [{ attributes: { COUNT_OBJECTID_1: 0, SUM_CLIENTS: null } }] } as any;
const lumaActive = { features: [{ attributes: { COUNT_OBJECTID_1: 3, SUM_CLIENTS: 4200.7 } }] } as any;
// Verified-shape fetcher: weather→nwsData, earthquake→usgsData, outage→lumaZero.
const goodFetch = (url: string) => Promise.resolve(url.includes('weather.gov') ? nwsData : url.includes('earthquake.usgs.gov') ? usgsData : lumaZero);
const failAll = () => Promise.reject(new Error('HTTP 503'));

describe('live-status chips (pure builders)', () => {
 it('counts NWS alerts, dedupes events, drops cancelations', () => {
  const chip = nwsChip(nwsData, NOW);
  expect(chip.id).toBe('weather');
  expect(chip.es).toBe('NWS: 2 alertas · Flood Advisory');
  expect(chip.link).toBe(statusURLs.nwsOffice);
  expect(nwsChip({ features: [...nwsData.features, { properties: { event: 'Heat Advisory', messageType: 'Cancel', status: 'Actual' } }] }, NOW).en).toBe('NWS: 2 alerts · Flood Advisory');
  expect(nwsChip(nwsEmpty, NOW).es).toBe('NWS: sin alertas activas');
 });
 it('counts quakes, ignores null magnitudes, reports strongest', () => {
  expect(usgsChip(usgsData, NOW).es).toContain('Último temblor: M2.4 · Ponce');
  expect(usgsChip({ features: [] }, NOW).en).toBe('USGS: no earthquakes published in 7 days');
  expect(() => usgsChip(null, NOW)).toThrow('unexpected shape');
 });
 it('reads LUMA aggregates verbatim and never fabricates activity', () => {
  expect(lumaChip(lumaZero, NOW).es).toContain('LUMA: 0 alimentadores');
  expect(lumaChip(lumaActive, NOW).en).toBe('LUMA: 3 feeders flagged for load shedding (not all outages)');
  expect(() => lumaChip({ features: [] }, NOW)).toThrow('unexpected shape');
 });
});

describe('live-status cache', () => {
 it('happy path: refresh, persist, read three chips, then serve from cache', async () => {
  const env = db();
  const first = await refreshStatus(env, true, NOW, goodFetch);
  expect(first.needsRefresh).toBe(false);
  expect(first.chips.map(c => c.id)).toEqual(['weather', 'earthquake', 'outage']);
  expect(first.chips[2].es).toContain('LUMA: 0 alimentadores');
  expect(first.generatedAt).toBe(NOW);
  let calls = 0; const counting = async (url: string) => { calls += 1; return goodFetch(url); };
  await refreshStatus(env, false, NOW + 1000, counting);
  expect(calls).toBe(0); // fresh cache is served without any network
  const read = await readStatus(env, NOW + 1000);
  expect(read.chips.map(c => c.id)).toEqual(['weather', 'earthquake', 'outage']);
  expect(await lastGoodMap(env)).toEqual({ weather: NOW, earthquake: NOW, outage: NOW });
 });
 it('down source is isolated: error recorded, no fabricated chip, others survive', async () => {
  const env = db();
  const status = await refreshStatus(env, true, NOW, (url) => url.includes('arcgis') ? failAll() : goodFetch(url));
  expect(status.chips.map(c => c.id)).toEqual(['weather', 'earthquake']);
  const row = await env.DB.prepare("SELECT error,last_good,payload FROM live_status WHERE source='outage'").bind().first<any>();
  expect(row.error).toMatch(/HTTP 503/); expect(row.last_good).toBeNull(); expect(row.payload).toBeNull();
  expect((await readStatus(env, NOW)).chips.some(c => c.id === 'outage')).toBe(false);
 });
 it('recovery: a failed force refresh keeps last-good chips and only the successful source is rewritten', async () => {
  const env = db();
  await refreshStatus(env, true, NOW, goodFetch);
  const failed = await refreshStatus(env, true, NOW + 1000, failAll);
  expect(failed.chips).toEqual([]); // last good data still shown, not faked as fresh
  const rows = await env.DB.prepare('SELECT source,last_good,error FROM live_status ORDER BY source').bind().all<{ source: string; last_good: number; error: string | null }>();
  expect(rows.results.every(r => r.error && r.last_good === NOW)).toBe(true); // payload/last_good untouched by failures
  const recovered = await refreshStatus(env, true, NOW + 2000, goodFetch);
  expect(recovered.chips.length).toBe(3);
  expect(await env.DB.prepare("SELECT fetch_ms FROM live_status WHERE source='weather'").bind().first<any>()).not.toBeNull();
 });
 it('staleness hides chips without a fake zero, and the TTL gates refetches', async () => {
  const env = db();
  await refreshStatus(env, true, NOW, goodFetch);
  expect(await readStatus(env, NOW + STATUS_STALE_MS + 60000)).toEqual({ chips: [], generatedAt: null, needsRefresh: true });
  let calls = 0; const counting = async (url: string) => { calls += 1; return goodFetch(url); };
  await refreshStatus(env, false, NOW + STATUS_TTL_MS - 1, counting);
  expect(calls).toBe(0); // still fresh enough
  const hint = await refreshStatus(env, false, NOW + STATUS_TTL_MS, counting);
  expect(calls).toBe(3);
  expect(hint.needsRefresh).toBe(false);
 });
});
