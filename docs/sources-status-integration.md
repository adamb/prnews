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

## Radio Isla 1320 and WALO 1240 (verified 2026-11-19)

Public reads only, with `User-Agent: news.dev.pr/1.0 (+https://news.dev.pr/about)`. No article HTML was fetched. Saved bytes are `test/fixtures/radioisla.xml` and `test/fixtures/walo.xml`; provenance is in the matching `.headers` files. Both feeds are registered through `additionalSources` / `additionalFeedURLs`. They stay on the shared parser, the 300-character excerpt cap, Spanish-by-article detection, the bounded image queue, and the bounded translation queue. This change does not deploy.

| Publisher | Registered feed | Capture |
|---|---|---|
| Radio Isla 1320 | `https://radioisla.tv/feed/` | 200 `application/rss+xml`, **25 items**, newest `Wed, 18 Nov 2026 20:30:11 +0000`, links on `radioisla.tv`. `robots.txt` disallows `/?s=`, `/page/*/?s=` and `/search/` only. |
| WALO 1240 · Humacao | `https://waloradio.com/feed/` | 200 `application/rss+xml`, **10 items**, all dated 18 Nov 2026 (newest `19:59:36 +0000`). Eastern coverage includes Humacao, Yabucoa, Naguabo, Las Piedras and a Caguas police item. `robots.txt` is `User-Agent: *` / `Disallow:` (allow all). |

Radio Isla items have no `enclosure`. The picture is the first `<img>` in `description` (every item has one). Every link carries `utm_*` query parameters, including a duplicated set; `canonical` strips `utm_*` and `fbclid`. `content:encoded` runs to about 5,500 characters of plain text. The parser still summarizes `description`. All 25 plain descriptions exceed 300 characters, and `summary()` keeps the 300-character cap. The channel element says `en-US`; the headlines are Spanish, so the source is not English. Per-article detection marks 24 of 25 items `es`. The Senado / New Fortress Energy headline stays undetected because "New" is an English function word; it keeps the Spanish source default and is not labeled English.

WALO's main feed is the one registered. `https://waloradio.com/category/noticias/feed/` also returned 10 items, but 7 of them are different and the main feed's police item ("Arrestan a seis personas durante operativos antidrogas en tres residenciales de Caguas", category `Policiacas`) is absent there. The category document is smaller (55,321 bytes vs 61,387) even though the gateway repeated the same etag string. Descriptions have no `<img>` and there are no enclosures, so the shared parser stores an empty image. Four items have an `<img>` only inside `content:encoded`, which the parser does not read when `description` is present. Those missing images stay on the existing bounded `og:image` queue. Plain descriptions are 321–418 characters and encoded bodies run past 6,000, so the stored excerpt remains the capped description. The same `en-US` channel language is ignored in favor of the Spanish text.

Not registered, and not re-probed in this change: TeleOnce (403 challenge), NotiUno (`/search` disallowed by robots), WKAQ (duplicates WAPA), Mega TV (not a Puerto Rico newsroom), CPI (explicitly excluded). None of those names were added to `unavailableSources`, because that list is shown on `/fuentes` as "no verified feed," which does not describe all five.

## News is my Business (rechecked 2026-11-19, not registered)

Public reads only, with `User-Agent: news.dev.pr/1.0 (+https://news.dev.pr/about)`. No second user agent, and the Cloudflare challenge script was not run. Evidence is `test/fixtures/nimb-probe-2026-11-19.txt`. The HTML and sitemap fixtures are the shapes that were rejected; the live sitemap bodies were not retrieved.

`https://newsismybusiness.com/robots.txt` returned **200** `text/plain` at 16:31:43 GMT. For `User-agent: *` it sets `Content-Signal: search=yes,ai-train=no,use=reference` and `Allow: /`, then disallows `/wp-admin/` except `admin-ajax.php`. The lines at the bottom are sitemaps, not article feeds:

- `Sitemap: https://newsismybusiness.com/sitemap.xml` — **403** `text/html`, 1522 bytes, `cf-ray: a5d09b58bb74b398-MIA`. Title `Error 403 Forbidden`, script `/cdn-cgi/challenge-platform/scripts/jsd/main.js`. Not XML.
- `Sitemap: https://newsismybusiness.com/sitemap.rss` — **403** `text/html`, 1522 bytes, `cf-ray: a5d09b5a0b54cc25-MIA`. Same challenge page. Not RSS.

The homepage (`/`) at 16:32:34 GMT was also **403** HTML (`cf-ray: a5d09c94e8dd4ba4-MIA`) and contained no `rel=alternate` feed link. `https://newsismybusiness.com/feed/` at 16:32:50 GMT was **403** HTML (`cf-ray: a5d09cfb1c87a581-MIA`), the same challenge page.

`feeds.nimb` stays `[]`. The source id, homepage, English default, and manual-import title repair are unchanged. A 200 HTML challenge or a sitemap document (`sitemapindex`, `urlset`, or an RSS channel titled `XML Sitemap`) is rejected before `parseFeed` and follows the existing failure backoff. NIMB stays out of the article-page image queue.

Read-only production D1 on 2026-11-19 (`changed_db: false`, `rows_written: 0`): `articles` has **43** `nimb` rows, all `reason=manual-import`, `published_at` from 2026-11-05T20:48:00Z through 2026-11-13T09:06:00Z, `first_seen` 2026-11-14T20:47:36.687Z. `archive_revisions` has **67** rows and **49** distinct `nimb` URLs. `feed_state` still holds the retired URL `https://newsismybusiness.com/feed/` with `status=403`, `error=HTTP 403`, `failures=3`, `last_ok=null`, `item_count=0`, `last_checked=2026-11-14T22:15:08.614Z`, `next_check=2026-11-15T00:15:08.614Z` (2 hours, `retryDelay(3)`). The current source list does not request that URL. This change does not deploy and does not write D1.
