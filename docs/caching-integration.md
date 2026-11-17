# Caching integration (freshness fix, 2026-11-15)

## Demonstrated root cause (live evidence, not assumed)

Repeated production fetches on 2026-11-15 ~01:48–01:56 GMT showed a Cloudflare layer
rewriting the HTML cache TTL of Worker responses on the **Cache-API hit path**:

* first visit (origin fill): `cache-control: public, max-age=60`
* identical second visit: `cf-cache-status: HIT`, `cache-control: public, max-age=14400`, `age: N`

The zone default `browser_cache_ttl=14400` (dev.pr zone, Cloudflare default) is what the
served header reflects. One such hit response is enough for a browser to hold a rendered
page for **4 hours** without revalidating. This explains the reported stale banner
("Last successful check: 7:30 PM AST … 31 posts awaiting English translation") persisting
after the 31→1 queue fix: the user's browser had stored a 4h-stamped hit from ~7:33 PM AST.
Entries themselves expire at the worker level after 60 s, so no worker-side entry was ever
more than a minute old — the durable staleness was purely the browser stamp.

## Constraints found

* The deployment API token cannot read or edit zone Rulesets (Cache Rules) — read attempts
  return `Authentication error`. `browser_cache_ttl` is zone-wide (other subdomains of
  dev.pr share it) and was **not** modified to avoid unrelated behavior changes.
* No Cache-Purge token exists; nothing relies on active purge.

## Shipped fix (app-level, all layers kept bounded)

1. `serveBounded()` in `src/index.ts`: Cache-API hits are re-served with
   `Cache-Control: public, max-age=60` (and stripped `content-length`), so no response this
   worker emits — origin or hit — ever invites 4-hour browser caching. Verified live: HITs
   now serve `max-age=60`.
2. Namespace bumped to `prnews-html-v18`; variant keys unchanged
   (`lang`/`source`/`english`/`q`/`page`).
3. `CDN-Cache-Control: public, max-age=60` set alongside, pinning edge TTL if a zone Cache
   Rule ever overrides it.
4. `/api/live?lang=en|es`: `no-store` JSON with the unified `needsTranslation` count,
   missing/invalid breakdown, feed `lastOk`, and the rendered notice/detail sentences for
   both languages (single wording source: `noticeText`/`detailText`/`machineNote` in
   `src/render.ts`).
5. Inline freshness script on pages with the live notice: re-fetches `/api/live` with
   `{cache:'reload'}` (bypasses any browser cache age), then swaps the notice text, stats
   queue number (`data-live="queue"`) and breakdown (`data-live="detail"`, removed at zero).
   Even if any intermediary served stale HTML, the visible numbers re-sync on every load.
6. 503 fallbacks now carry `Cache-Control: no-store`.

Worst-case visible staleness after the fix: 60 s at the HTML layer, corrected client-side
on load; banner and queue count always agree within one render (regression-tested).

## What remains externally blocked

Reducing `browser_cache_ttl` zone-wide or adding a hostname-scoped Cache Rule
(`http_request_cache_settings`) requires a token with Zone Settings/Cache Rules edit
permission. The app-level header caps make that independent, but if an edge-cache rewrite
reappears, check for a new Cache Rule first.
