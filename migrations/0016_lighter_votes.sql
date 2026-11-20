-- Additive satire-feedback ledger. No article, account, address, or generation data changes.
-- Readers: src/lighter-feedback.ts (the /stats aggregate). Writers: POST /api/lighter-vote only.
-- One row per browser token hash per exact displayed generation. The cache key
-- (prompt version + URL + headline + excerpt + language) alone does NOT distinguish a
-- regenerated text under the same key: a clearly-wrong-edition line is cleared on the
-- next explicit request and the same key can store a new, different text. The take_hash
-- column (SHA-256 of the exact displayed text) closes that gap, so a vote can never
-- silently rate a replacement: when a take is regenerated, the old text's votes stay
-- bound to the old text, the new text starts with no ratings, and a client still
-- showing the old text is rejected as stale before any write.
-- The token is a random client UUID; only its SHA-256 hex is stored server-side.
-- Clearing the browser's storage makes that browser look new: votes are per browser,
-- never unique people. No email, IP, cookie, account, or fingerprint is stored.
CREATE TABLE IF NOT EXISTS lighter_votes (
  token_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  take_hash TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  voted_at INTEGER NOT NULL,
  PRIMARY KEY (token_hash, cache_key, take_hash)
);
CREATE INDEX IF NOT EXISTS lighter_votes_key ON lighter_votes(cache_key);

-- Global vote-write counter per UTC minute: the only new count-abuse guard.
-- A vote is one small D1 write, so a generous global per-minute bucket bounds
-- flood writes without refusing real concurrent readers; no address is stored,
-- and excess requests are refused before any write. There is deliberately no
-- in-flight lease: unlike a model call, a vote write is cheap, and a global
-- concurrency cap would refuse honest voters for no cost benefit.
-- The generation path keeps the limits it has today; this adds nothing there.
CREATE TABLE IF NOT EXISTS lighter_vote_rate (
  bucket INTEGER PRIMARY KEY,
  hits INTEGER NOT NULL
);
