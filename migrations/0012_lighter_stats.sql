-- Durable lighter-button ledger. No IP, cookie, account, or user id.
-- Separate from article_click_totals / site_click_totals (outbound /click).
-- Readers: src/lighter-stats.ts. Writers: src/lighter.ts (POST /api/lighter only).
-- One row per scope. 'all' is written as its own total; it is not es+en.
-- started_at is migration apply time (unix ms), never backdated.
-- Rows start at zero. Pre-ledger button clicks did not exist and are not invented.
-- Older lighter-1 cache texts are a different prompt and have no event time, so
-- generations are not backfilled from lighter_cache.
CREATE TABLE IF NOT EXISTS lighter_stats (
  scope TEXT PRIMARY KEY CHECK (scope IN ('all', 'es', 'en')),
  started_at INTEGER NOT NULL,
  interactions INTEGER NOT NULL,
  cache_hits INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  generations INTEGER NOT NULL,
  failures INTEGER NOT NULL
);
INSERT INTO lighter_stats(scope, started_at, interactions, cache_hits, attempts, generations, failures)
  SELECT scope, CAST(strftime('%s','now') AS INTEGER) * 1000, 0, 0, 0, 0, 0
  FROM (SELECT 'all' AS scope UNION ALL SELECT 'es' UNION ALL SELECT 'en')
  WHERE NOT EXISTS (SELECT 1 FROM lighter_stats WHERE lighter_stats.scope = scope);

-- Opaque button-press ids (client UUID v4), not people. Dedupes polls and automatic retries.
-- Pruned by age in the writer. Totals above are not reduced when a row is pruned.
CREATE TABLE IF NOT EXISTS lighter_actions (
  action_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lighter_actions_created ON lighter_actions(created_at);

-- UTC-day model-call counter. The writer refuses another call at 24 (DAILY_MODEL_CALLS).
CREATE TABLE IF NOT EXISTS lighter_budget (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL
);

-- Two short leases so overlapping clicks cannot start an unbounded number of model calls.
CREATE TABLE IF NOT EXISTS lighter_inflight (
  id INTEGER PRIMARY KEY CHECK (id >= 1 AND id <= 2),
  until_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO lighter_inflight(id, until_ms) VALUES (1, 0), (2, 0);

-- Global new-action counter per minute. No address is stored. Excess requests are refused
-- before a model call and before an interaction increment.
CREATE TABLE IF NOT EXISTS lighter_rate (
  bucket INTEGER PRIMARY KEY,
  hits INTEGER NOT NULL
);
