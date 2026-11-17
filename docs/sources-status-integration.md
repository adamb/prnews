# Live status strip + additional publisher feeds integration (not wired into existing files)

New files only: `src/live-status.ts`, `src/additional-sources.ts`, `migrations/0005_live_status.sql`, `test/live-status.test.ts`, `test/additional-sources.test.ts`, RSS fixtures (`test/fixtures/wapa.xml`, `wipr.xml`, `claridad.xml` + `.headers` provenance notes). No existing file was modified; `0006` is untouched. Slot `0005` in `migrations/` is free (files 0001–0004 and 0006 exist). Apply `0005` with `wrangler d1 migrations apply prnews` after `0001`–`0004`; it only creates the `live_status` cache table.

Everything below that looks like a fact was verified with real HTTP requests on **2026-11-14 ≈ 17:45–18:30 UTC** (curl/tsx from this checkout). Status codes and counts are from those captures.

## 1. Live status strip (`src/live-status.ts`)

```ts
export interface StatusChip { id: string /* 'weather'|'earthquake'|'outage' */; link: string; es: string; en: string; ts: number }
export interface LiveStatus { chips: StatusChip[]; generatedAt: number | null; needsRefresh: boolean }
export interface StatusEnv { DB: D1Database }

refreshStatus(env, force = false, now = Date.now(), fetchJson?: FetchJson): Promise<LiveStatus>  // cron / on-demand
readStatus(env, now = Date.now()): Promise<LiveStatus>                                            // render path, read-only
lastGoodMap(env): Promise<Record<string, number>>                                                 // admin/diagnostics
export const STATUS_TTL_MS = 15min, STATUS_STALE_MS = 30min, statusURLs // all endpoints + public chip links
```

* **Cache:** `live_status` table, one row per source (`weather`, `earthquake`, `outage`) holding the serialized `StatusChip`, `error`, `last_checked`, `last_good`, `fetch_ms`. `refreshStatus` is a no-op network-wise while `now - max(last_checked) < STATUS_TTL_MS` (unless `force`); cron should call it every cycle.
* **Isolation:** each source gets its own `try/catch` and `AbortSignal.timeout(10s)`; a failure only writes `error` + `last_checked` and never touches `payload`/`last_good` (DB failures throw so cron logs them; per-source failures never throw).
* **Hiding rule (no fake zeros):** a chip is returned by `readStatus` only while `now - last_good <= STATUS_STALE_MS` and its source has ever succeeded. Stale/failed/never-good sources are simply absent from `chips` — the frontend renders only what's there, so a down source never shows a fabricated count. `generatedAt` is the newest visible chip's `ts` (null when the strip is empty) so no timestamp is claimed for hidden data. `needsRefresh` tells the root whether the cache predates `STATUS_TTL_MS`.
* **Bilingual chips:** `es`/`en` carry ready-to-render text, e.g. `NWS: sin alertas activas` / `NWS: no active alerts`, `USGS: 18 temblores en 7 días máx M3.0 / max M3.0`, `LUMA: sin desvíos de carga publicados` / `LUMA: no load-shed feeders published`. `link` is always the public human page (never the JSON API): `weather.gov/sju/`, `earthquake.usgs.gov/earthquakes/map/`, LUMA's dashboard below.
* `refreshStatus`'s `fetchJson` parameter exists for tests; production default is `fetch` with UA `news.dev.pr/1.0 (+https://news.dev.pr/about)`.
* Pure builders are exported and unit-tested: `nwsChip(data, now)`, `usgsChip(data, now, days=7)`, `lumaChip(data, now)` — each throws on unexpected shapes, which the caller records as that source's failure.

**Suggested root wiring:** in `scheduled` (the `*/15` cron branch) add `await refreshStatus(env).catch(() => {});`; on the homepage path call `const status = await readStatus(env).catch(() => ({ chips: [], generatedAt: null, needsRefresh: false }))` and pass it to the renderer through a new options field (root owns rendering; render `chip.es`/`chip.en` as text with `chip.link` and a relative "actualizado hace X / updated X ago" from `chip.ts`).

### Verified public APIs (all credential-free)

| Source | Exact URL used | Captured state (2026-11-14) |
|---|---|---|
| NWS active alerts | `https://api.weather.gov/alerts/active?area=PR` | 200 `application/geo+json`, **0 features** at capture. Schema verified via `?area=FL` (8 alerts): `features[].properties.{event, headline, areaDesc, severity, effective, expires, messageType, status, senderName, …}`. Builder skips `messageType:'Cancel'` and `status` Exercise/System. |
| USGS earthquakes | `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=17.6&maxlatitude=18.7&minlongitude=-68.0&maxlongitude=-65.2&orderby=time&starttime=<now−7d ISO>` | 200; bbox + 7-day window returned **24** and later **18** features (`properties.mag/place/time/url`); 105 over the default 30 days. |
| LUMA feeders | `https://services3.arcgis.com/0n3sEGhALDkUSwc5/arcgis/rest/services/Manual_Load_Shedding/FeatureServer/0/query?f=json&where=UPPER(STATUS)%3C%3E%27NO%27&returnGeometry=false&outStatistics=[{count OBJECTID_1},{sum CLIENTS}]` (URL-encoded in `statusURLs.lumaQuery`) | 200; layer "Alimentadores sin Servicio" (org [aeepr.maps.arcgis.com](https://aeepr.maps.arcgis.com/sharing/rest/portals/self?f=json) resolves to **"LUMA Energy LLC"**), **792** polygon features, all `STATUS='NO'`; stats query returned `{"COUNT_OBJECTID_1":0,"SUM_CLIENTS":null}`. Public dashboard linked on the chip: `https://aeepr.maps.arcgis.com/apps/dashboards/1995c773fceb468db8b7f7d34899df94` (referenced from LUMA's own MiLUMA bundle). One request yields both numbers. |
| Chip links | `https://www.weather.gov/sju/` · `https://earthquake.usgs.gov/earthquakes/map/` · dashboard above | All 200. |

### LUMA outage research report (previous worker's "MiLUMA candidate" resolved)

* **MiLUMA REST outage API: not publicly usable.** The MiLUMA SPA bundle (`https://miluma.lumapr.com/assets/index-Cft0n0UU.js`) declares service roots including `OUTAGE_API_URI: "https://api.miluma.lumapr.com/miluma-outage-api"`, but it is for logged-in account flows: anonymous `GET {…}/{, /outages, /outages/status, /outages/report}` all return **404 `{"statusCode":404,"message":"Resource not found"}`** (NestJS) behind an Incapsula WAF; the `/outages/...` strings in the bundle are React Router paths, not API endpoints. No outage-count API is reachable without credentials — so none was used and none was guessed.
* **Public LUMA data that *is* verified:** the official MiLUMA bundle links to LUMA's ArcGIS Dashboard "Manual Load Shedding" (`/apps/dashboards/1995c773fceb468db8b7f7d34899df94`, sharing-API metadata 200), which reads the public FeatureServer above. `where=UPPER(STATUS)<>'NO'` counts feeders the layer flags as without service / load-shed.
* **Honest caveat:** the active-value semantics are inferred — the layer name, its `predicted`/`pred_time`/`MW` fields, and today's capture (792 rows, every one `STATUS='NO'`, zero flagged) say `'NO' = not flagged`. No active day was observed, so the exact non-`'NO'` value is unconfirmed. Consequently the chip reports the count *verbatim* ("N flaggados sin servicio / N flagged without service"), and a zero is rendered as the neutral "no published load-shed feeders" rather than a guarantee that no outage exists. If LUMA later publishes a richer public API, treat that as a replacement, not an addition.

## 2. Additional publisher feeds (`src/additional-sources.ts`)

Verified by real HTTP fetch and through the existing `parseFeed` on captured fixtures (saved bytes in `test/fixtures/*.xml`, provenance in `.headers`).

| Publisher | feed URL (exact capture) | result |
|---|---|---|
| WAPA | `https://wapa.tv/search/?f=rss&t=article&l=50&s=start_time&sd=desc` | 200 `application/rss+xml`, **50 items** (BLOX CMS, same family as the already-working elvocero feed; links `wapa.tv/noticias/...`, 17 with images). The homepage's `#topstory`-keyword variant of this URL returned **0 items** — use the keyword-less URL. |
| WIPR | `https://wipr.pr/feed/` | 200, **10 items** (WordPress; `wipr.pr/...` links, current daily dates). |
| Claridad | `https://claridadpuertorico.com/feed/` | 200, **5 items** (homepage `<title>` = "Home - Claridad", canonical `claridadpuertorico/`; weekly paper, low item count is normal). |

**El Post Antillano — unavailable, documented not guessed:** `elpostantillano.com` is lapsed/parked — its homepage and `/feed/` now serve unrelated Japanese spam (feed channel title is Japanese); `postantillano.com` fails at connect, `elpostantillano.net` returns HTTP 406. No feed is registered for it; the finding is exported via `unavailableSources` (name/homepage/reason).

**Exports for root (merge — do not touch `src/sources.ts`/`src/ingest.ts` from this module):**

```ts
additionalSources: Source[]          // wapa, wipr, claridad (same {id,name,homepage,files} shape, fixture names in files)
additionalFeedURLs: Record<string,string[]>
unavailableSources: UnavailableSource[]
additionalMappingIsConsistent(): boolean   // asserts ids ⇔ feed-url keys stay 1:1
```

Wire-in for root: append `additionalSources` to `sources` and spread `additionalFeedURLs` into ingest's `feeds` record; refresh/purge/classification then behave as for existing sources. Both Spanish-language, no `isEnglishSource` changes needed.

## 3. Tests & verification status

* `npx vitest run` → **15 files / 97 tests passing** (11 new: 7 in `test/live-status.test.ts`, 4 in `test/additional-sources.test.ts`).
* Live-status tests cover happy (3 chips persisted + cache-served), down (isolated failure, error row, no fabricated chip), recovery (fail refresh keeps last-good payload/last_good), staleness (chips hidden past `STATUS_STALE_MS`, `generatedAt: null`), TTL gating (no refetch inside 15 min), and the pure builders' edge cases; D1 interaction uses the same `node:sqlite` shim pattern as `test/digest.test.ts`.
* End-to-end smoke (outside vitest, real network through `migrations/0005_live_status.sql`'s own schema): `refreshStatus` returned the three chips above with `fetch_ms` 329–409 ms and correct rows.
* `npm run typecheck` and `npm run build` (wrangler dry-run) pass with the new files included.

## 4. Limitations

* NWS alerts fluctuate; a real event will fill the strip's weather chip with counted, deduped event names (max 2) — wording stays short by construction.
* USGS counts are bbox-defined (17.6–18.7°N, −68.0–−65.2°W), 7-day window; magnitude shown is `max(mag)` rounded to 0.1.
* `STATUS_TTL_MS` (15 min) bounds writes to ≤ 96 fetches/day/source; `fetch_ms`/`error` are diagnostics only and never leave the table.
* LUMA numbers are as publish-accurate as LUMA's own dashboard; semantics caveat in §1 applies, and no per-account or outage-map API was reachable without credentials.
* Fixture item counts are fixed at capture time (2026-11-14) by design; re-capture fixtures if feed templates change (e.g. WIPA BLOX updates).

## Root integration corrections
The deployed strip reports the latest valid earthquake (event time in AST), not a seven-day count. Failed source chips hide immediately even if last-good metadata remains. LUMA is explicitly a limited load-shedding layer, not a complete outage count. WAPA/WIPR/Claridad are registered in the main source map; El Post Antillano remains an unavailable-source note. Cache read/refresh is wired into homepage/ingestion.
