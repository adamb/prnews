# Clicks, Hall of Fame, and Web Analytics integration (November 2026)

Scope: durable lifetime click aggregates (migration `0008_click_totals.sql`), the `/hall`
page, `/stats` cumulative sections, and a cached server-side read of Cloudflare Web
Analytics. Privacy posture unchanged: no IPs, cookies, or per-user identifiers anywhere.

## Old vs new click history semantics

| Layer | Before | After |
|---|---|---|
| Rolling buckets (`article_click_buckets`) | per-second buckets, cleanup deletes older than 48 h | unchanged |
| Most read (homepage) | rolling 24 h, active 14-day articles only, top 5 | unchanged |
| Lifetime per-article | none | `article_click_totals`, upserted in the same D1 batch as the bucket |
| Lifetime global | none | single `site_click_totals` row incl. `started_at` |
| Aged articles | `/click?id=` 404'd after 14-day rotation | redirects via `story_ids`/`archive_revisions` fallback and keeps counting |

Backfill honesty: migration 0008 ran when buckets held at most ~48 h of real clicks. It
seeded totals from exactly those retained buckets; clicks older than that had already been
pruned by design and are **not** reconstructed or invented. Every rendered counter labels
"counting since <date>" (the migration's `started_at`) and notes the pre-deploy gap. The
idempotent SQL cannot double-count even if re-applied by hand.

Atomicity: one `/click` GET performs bucket + per-article + global upserts in a single D1
batch (transactional, serialized increments). HEAD redirects without counting. Counting
failures never block a known-destination redirect.

## Hall of Fame (`/hall`)

Archive revisions (permanent title/source/summary/image) joined with lifetime totals:
articles published more than 14 days ago (their `articles` row is gone) with recorded
clicks, top 10, most clicked first. Each entry shows the stable archive title, source,
≤300-char summary, a direct link to the original article, and the metric "N clicks ·
published more than 14 days ago" with the counting-start label. Empty until a real
article both ages out and was clicked — no unpopular articles are promoted, no counts are
fabricated, and an honest empty state explains the rule.

## Cloudflare Web Analytics read (verified live 2026-11-15)

- Official endpoint: GraphQL `https://api.cloudflare.com/client/v4/graphql`, dataset
  `viewer.accounts.rumPageloadEventsAdaptiveGroups`, filter `{siteTag, datetime_geq,
  datetime_leq}`, `count` = browser pageloads, `sum.visits` = visit sessions.
- `siteTag` is **not** the beacon token: the beacon `data-cf-beacon` token
  (in `src/analytics.json` as `token`) differs from the GraphQL `siteTag` (`f88a31…`,
  also in `src/analytics.json`). Filtering by the beacon token returns silently-empty
  results (HTTP 200, no error) — verified with a control query.
- The account's existing D1 API token reads this dataset (installed as the
  `CF_ANALYTICS_TOKEN` worker secret; write-only in the Cloudflare secret store, sent only
  to api.cloudflare.com, never rendered or logged).
- Query quota: a single query may span at most 13w2d. Our refresh asks for 8 days of
  date-only groups (≤8 rows; the adaptive-groups limit cannot truncate this query).
- RUM semantics: counts only JavaScript-executing browsers; non-JS bots/previews never
  appear. `visits` are sessions, **not** identified unique visitors — no visitor IDs, IPs,
  or cookies are stored or invented. Worker request volume is a different, unrelated
  metric and is never used as a pageview/visitor proxy.

Worker integration: the 15-minute scheduler probes a single D1 `MAX(fetched_at)` and only
refetches past a 6-hour TTL (≤4 GraphQL reads/day). Page renders read only the durable
`web_analytics_daily` archive, so measured days survive beyond the API window and no
Cloudflare API call happens per page view. Missing token/errors render an explicit
"unavailable" state with the dashboard link instead of a fabricated zero.
