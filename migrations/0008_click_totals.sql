-- 0008_click_totals.sql — durable cumulative click aggregates + daily Web Analytics archive.
-- Owned by the stats/hall-of-fame feature. Strictly additive: creates only new tables and an
-- index; the rolling bucket/click/top behavior of 0003 and its cleanup are untouched.
-- Readers: src/trending.ts (cumulative + hall of fame), src/analytics.ts (Web Analytics cache).

-- ---------------------------------------------------------------------------
-- 1. Lifetime per-article click totals. One row appears only when a real /click
--    GET records a click (or the backfill below seeds one) — no per-visitor
--    data, no IPs, no cookies. Rows survive both article rotation and the
--    48-hour bucket cleanup. The rank index keeps every ordered read bounded
--    (top lists scan the index with LIMIT; no unbounded sorts/scans).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS article_click_totals (
  url TEXT PRIMARY KEY,
  clicks INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS article_click_totals_rank ON article_click_totals(clicks DESC, url ASC);

-- Single global counter (id=1), incremented in the same batch as the per-article row.
CREATE TABLE IF NOT EXISTS site_click_totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clicks INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 2. Backfill from ONLY the buckets retention still keeps. article_click_buckets
--    is pruned after 48h (CLICK_RETAIN_MS in src/trending.ts), so clicks older
--    than that were permanently deleted by cleanupClicks before this migration
--    existed. They are intentionally NOT reconstructed: totals start exactly at
--    the retained real clicks and nothing is fabricated. Each run of this
--    statement is idempotent — a re-run cannot double-count (existing rows
--    conflict as DO NOTHING), and D1 applies each migration once in any case.
--    started_at = apply time; honest labels ("counting since") are rendered
--    from it, with a note that pre-deploy clicks were not kept.
-- ---------------------------------------------------------------------------
INSERT INTO article_click_totals(url,clicks,updated_at)
  SELECT url,SUM(clicks),MAX(bucket) FROM article_click_buckets WHERE true GROUP BY url
  ON CONFLICT(url) DO NOTHING;
INSERT INTO site_click_totals(id,clicks,updated_at,started_at)
  SELECT 1,COALESCE(SUM(clicks),0),COALESCE(MAX(bucket),0),CAST(strftime('%s','now') AS INTEGER)*1000 FROM article_click_buckets WHERE true
  ON CONFLICT(id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Daily Cloudflare Web Analytics (RUM) archive: one row per UTC day with
--    browser pageviews and visit sessions as reported by the official GraphQL
--    API. Refreshed server-side on a bounded TTL by the scheduler (never per
--    page view) so slow days are not lost when the source rolls past its query
--    window. Aggregates only; no visitor identifiers are stored or invented.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_analytics_daily (
  date TEXT PRIMARY KEY,
  pageviews INTEGER NOT NULL,
  visits INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
