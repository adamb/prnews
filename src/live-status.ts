/**
 * Homepage live-status strip: NWS active alerts for Puerto Rico, USGS recent
 * earthquakes around the island, and LUMA Energy's public feeders-without-service
 * layer. Cached in D1 (migrations/0005_live_status.sql), refreshed at most every
 * 15 minutes by cron; every source is fetched in isolation with a timeout so one
 * failure never blocks the others.
 *
 * All three APIs are public and credential-free. Chip links point at public
 * human-facing pages (weather.gov/sju, USGS map, LUMA's dashboard), never at a
 * JSON response. A failed or stale source produces no chip at all — the strip
 * must never show a fabricated zero.
 */
export interface StatusChip {
 /** Stable key: 'weather' | 'earthquake' | 'outage' */
 id: string;
 /** Public, credential-free human page for the source. */
 link: string;
 es: string;
 en: string;
 /** Epoch ms when this chip's data was actually fetched (last_good). */
 ts: number;
}
export interface LiveStatus { chips: StatusChip[]; generatedAt: number | null; needsRefresh: boolean }
export interface StatusEnv { DB: D1Database }

/** Refresh the cache at most this often (cron runs every 15 min). */
export const STATUS_TTL_MS = 15 * 60 * 1000;
/** Chips whose last good fetch is older than this are hidden by readStatus. */
export const STATUS_STALE_MS = 30 * 60 * 1000;
const FETCH_MS = 10000;
const UA = 'news.dev.pr/1.0 (+https://news.dev.pr/about)';

/**
 * Verified public endpoints as of 2026-11-14 (see docs/sources-status-integration.md).
 * The USGS/LUMA queries embed no credentials and need no user input.
 */
export const statusURLs = {
 nws: 'https://api.weather.gov/alerts/active?area=PR',
 nwsOffice: 'https://www.weather.gov/sju/',
 usgsBase: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=17.6&maxlatitude=18.7&minlongitude=-68.0&maxlongitude=-65.2&orderby=time',
 usgsMap: 'https://earthquake.usgs.gov/earthquakes/map/',
 lumaQuery: 'https://services3.arcgis.com/0n3sEGhALDkUSwc5/arcgis/rest/services/Manual_Load_Shedding/FeatureServer/0/query?f=json&where=UPPER(STATUS)%3C%3E%27NO%27&returnGeometry=false&outStatistics=%5B%7B%22statisticType%22%3A%22count%22%2C%22onStatisticField%22%3A%22OBJECTID_1%22%7D%2C%7B%22statisticType%22%3A%22sum%22%2C%22onStatisticField%22%3A%22CLIENTS%22%7D%5D',
 lumaDashboard: 'https://aeepr.maps.arcgis.com/apps/dashboards/1995c773fceb468db8b7f7d34899df94',
};
const SOURCES = ['weather', 'earthquake', 'outage'] as const;
type SourceStatus = typeof SOURCES[number];

// ---------------------------------------------------------------------------
// Pure chip builders (verified against live responses on 2026-11-14).

/** NWS active-alert feed: GeoJSON features[] with properties.event/messageType. */
export function nwsChip(data: any, now: number, link = statusURLs.nwsOffice): StatusChip {
 if (!Array.isArray(data?.features)) throw new Error('NWS: unexpected shape');
 const alerts = data.features
  .map((f: any) => f?.properties)
  .filter((p: any) => p?.event && (!p.status || p.status === 'Actual') && p.messageType !== 'Cancel' && (!p.expires || Date.parse(p.expires)>now));
 const names = [...new Set(alerts.map((p: any) => String(p.event)))].slice(0, 2).join(' · ');
 const count = alerts.length;
 return {
  id: 'weather', link, ts: now,
  es: count ? `NWS: ${count} alerta${count === 1 ? '' : 's'} · ${names}` : 'NWS: sin alertas activas',
  en: count ? `NWS: ${count} alert${count === 1 ? '' : 's'} · ${names}` : 'NWS: no active alerts',
 };
}

/** USGS earthquake query: GeoJSON features[] bounded to the PR region and 7 days. */
export function usgsChip(data: any, now: number, days = 7, link = statusURLs.usgsMap): StatusChip {
 if (!Array.isArray(data?.features)) throw new Error('USGS: unexpected shape');
 const latest=data.features.map((f:any)=>f?.properties).filter((p:any)=>Number.isFinite(p?.mag)&&Number.isFinite(p?.time)&&p.time<=now&&p.time>=now-days*86400000).sort((a:any,b:any)=>b.time-a.time)[0];
 if(!latest)return {id:'earthquake',link,ts:now,es:`USGS: sin temblores publicados en ${days} días`,en:`USGS: no earthquakes published in ${days} days`};
 const when=new Intl.DateTimeFormat('en-US',{timeZone:'America/Puerto_Rico',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(latest.time)+' AST';
 const place=typeof latest.place==='string'?latest.place.slice(0,120):'Puerto Rico';
 return {id:'earthquake',link,ts:now,es:`Último temblor: M${latest.mag.toFixed(1)} · ${place} · ${when}`,en:`Latest earthquake: M${latest.mag.toFixed(1)} · ${place} · ${when}`};
}

/**
 * LUMA aggregate: statistics row { COUNT_OBJECTID_1, SUM_CLIENTS } over the
 * "Alimentadores sin Servicio" layer filtered to UPPER(STATUS)<>'NO'. Semantics
 * caveat: the active-status value is inferred ('NO' = not flagged); a nonzero
 * count is always reported verbatim, never interpreted further.
 */
export function lumaChip(data: any, now: number, link = statusURLs.lumaDashboard): StatusChip {
 const attrs = data?.features?.[0]?.attributes;
 if (!attrs || attrs.COUNT_OBJECTID_1==null || !Number.isInteger(Number(attrs.COUNT_OBJECTID_1)) || Number(attrs.COUNT_OBJECTID_1)<0) throw new Error('LUMA: unexpected shape');
 const feeders = Number(attrs.COUNT_OBJECTID_1);
 
 return {
  id: 'outage', link, ts: now,
  es: `LUMA: ${feeders} alimentadores marcados en relevos de carga (no incluye todas las averías)`,
  en: `LUMA: ${feeders} feeders flagged for load shedding (not all outages)`,
 };
}

// ---------------------------------------------------------------------------
// Fetchers. Each is defensive: anything unexpected throws and that source alone
// is recorded as failed (no chip).

type FetchJson = (url: string) => Promise<any>;
const defaultFetchJson: FetchJson = async (url) => {
 const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_MS) });
 if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
 return response.json();
};

const chipFor = (id: SourceStatus, data: any, now: number): StatusChip => {
 if (id === 'weather') return nwsChip(data, now);
 if (id === 'earthquake') return usgsChip(data, now); // starttime is embedded in the URL
 return lumaChip(data, now);
};

// ---------------------------------------------------------------------------
// D1 persistence.

interface StatusRow { source: string; payload: string | null; error: string | null; last_checked: number; last_good: number | null }
const clean = (message: string) => message.replace(/\s+/g, ' ').slice(0, 120) || 'failed';
const ROWS = 'SELECT source,payload,error,last_checked,last_good FROM live_status';

/** Serialises one source: success writes payload+last_good, failure only error+last_checked. */
async function record(env: StatusEnv, id: SourceStatus, now: number, outcome: { chip?: StatusChip; error?: string; ms?: number }) {
 if (outcome.chip) {
  await env.DB.prepare(`INSERT INTO live_status(source,payload,error,last_checked,last_good,fetch_ms) VALUES(?,?,?,?,?,?)
   ON CONFLICT(source) DO UPDATE SET payload=excluded.payload,error=NULL,last_checked=excluded.last_checked,last_good=excluded.last_good,fetch_ms=excluded.fetch_ms`)
   .bind(id, JSON.stringify(outcome.chip), null, now, now, outcome.ms ?? null).run();
 } else {
  // Preserve historical last-good metadata, but readStatus hides failed chips immediately.
  await env.DB.prepare(`INSERT INTO live_status(source,payload,error,last_checked,last_good,fetch_ms) VALUES(?,NULL,?,?,NULL,NULL)
   ON CONFLICT(source) DO UPDATE SET error=excluded.error,last_checked=excluded.last_checked`)
   .bind(id, clean(outcome.error ?? 'failed'), now).run();
 }
}

// ---------------------------------------------------------------------------
// Public API.

/** Read-only: chips visible right now (stale/never-good ones omitted), plus refresh hint. */
export async function readStatus(env: StatusEnv, now: number = Date.now()): Promise<LiveStatus> {
 const rows = await env.DB.prepare(ROWS).all<StatusRow>();
 return assemble(rows.results, now);
}

const ORDER = SOURCES as readonly string[];
function assemble(rows: StatusRow[], now: number): LiveStatus {
 const chips = rows.flatMap((row) => {
  if (row.error || !row.payload || row.last_good == null || now - row.last_good > STATUS_STALE_MS || row.last_good > now) return [];
  try { return [JSON.parse(row.payload) as StatusChip]; } catch { return []; }
 });
 // Deterministic strip order: weather, earthquake, outage.
 const ordered = ORDER.map((id) => chips.find((c) => c.id === id)).filter((c): c is StatusChip => !!c);
 const checked = Math.max(0, ...rows.map((r) => r.last_checked || 0));
 // generatedAt is the newest VISIBLE chip: a fully hidden strip has nothing to timestamp.
 return { chips: ordered, generatedAt: ordered.length ? Math.max(0, ...ordered.map((c) => c.ts)) : null, needsRefresh: rows.length<SOURCES.length || now - checked >= STATUS_TTL_MS };
}

/**
 * Refreshes the strip cache when older than STATUS_TTL_MS (unless forced).
 * Sources are independent: each has its own try/catch and 10s timeout, so a
 * failure records the error and leaves the others intact. DB failures throw.
 */
export async function refreshStatus(env: StatusEnv, force = false, now: number = Date.now(), fetchJson: FetchJson = defaultFetchJson): Promise<LiveStatus> {
 const existing = await env.DB.prepare(ROWS).all<StatusRow>();
 const checked = Math.max(0, ...existing.results.map((r) => r.last_checked || 0));
 if (!force && now - checked < STATUS_TTL_MS) return assemble(existing.results, now);

 const urls: Record<SourceStatus, string> = {
  weather: statusURLs.nws,
  earthquake: `${statusURLs.usgsBase}&starttime=${new Date(now - 7 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
  outage: statusURLs.lumaQuery,
 };
 await Promise.all(SOURCES.map(async (id) => {
  const started = Date.now();
  try {
   const chip = chipFor(id, await fetchJson(urls[id]), now);
   await record(env, id, now, { chip, ms: Date.now() - started });
  } catch (error) {
   await record(env, id, now, { error: clean(String(error)) });
  }
 }));
 const rows = await env.DB.prepare(ROWS).all<StatusRow>();
 return assemble(rows.results, now);
}

/** Last confirmed-good time per source id (0 when never fetched OK) — for admin tooling. */
export async function lastGoodMap(env: StatusEnv): Promise<Record<string, number>> {
 const rows = await env.DB.prepare('SELECT source,last_good FROM live_status').all<StatusRow>();
 return Object.fromEntries(rows.results.map((r) => [r.source, r.last_good ?? 0]));
}
