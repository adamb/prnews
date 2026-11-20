-- Additive satire-feedback ledger. No article, account, address, or generation data changes.
-- Readers: src/lighter-feedback.ts (the /stats aggregate). Writers: POST /api/lighter-vote only.
-- One row per browser token hash per exact cached generation. The cache key already
-- identifies the exact take (prompt version + URL + headline + excerpt + language),
-- so when a headline or excerpt changes, the new take starts with no inherited ratings.
-- The token is a random client UUID; only its SHA-256 hex is stored server-side.
-- Clearing the browser's storage makes that browser look new: votes are per browser,
-- never unique people. No email, IP, cookie, account, or fingerprint is stored.
CREATE TABLE IF NOT EXISTS lighter_votes (
  token_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (token_hash, cache_key)
);
CREATE INDEX IF NOT EXISTS lighter_votes_key ON lighter_votes(cache_key);

-- Global vote-write counter per minute: a basic abuse guard for the counts only.
-- The generation path keeps the limits it has today; this adds nothing back there.
-- No address is stored; excess requests are refused before any write.
CREATE TABLE IF NOT EXISTS lighter_vote_rate (
  bucket INTEGER PRIMARY KEY,
  hits INTEGER NOT NULL
);

-- Two short leases so overlapping vote writes stay bounded.
CREATE TABLE IF NOT EXISTS lighter_vote_inflight (
  id INTEGER PRIMARY KEY CHECK (id >= 1 AND id <= 2),
  until_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO lighter_vote_inflight(id, until_ms) VALUES (1, 0), (2, 0);
