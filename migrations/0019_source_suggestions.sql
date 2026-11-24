-- Source suggestions (sites and influencers): a public submission form with double opt-in.
-- Follows the alerts (0009) conventions exactly: hashed single-use tokens, a paced outbox
-- whose ambiguous sends are never auto-retried, and a shared pacing row (alert_pace).
CREATE TABLE source_suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('site','influencer')),
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'es' CHECK(language IN ('es','en')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','reviewed','rejected')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX source_suggestions_status ON source_suggestions(status, created_at);
-- Double opt-in tokens: SHA-256 hashes only, single-use, expiring. Raw tokens are never stored.
CREATE TABLE source_suggestion_tokens (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES source_suggestions(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX source_suggestion_tokens_suggestion ON source_suggestion_tokens(suggestion_id);
-- Every mail (confirmations + owner notices) flows through here. ImprovMX's Send API has no
-- idempotency keys, so ambiguous outcomes become 'uncertain' and are never auto-resent.
CREATE TABLE source_suggestion_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('confirm','owner')),
  suggestion_id TEXT NOT NULL REFERENCES source_suggestions(id),
  email TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','uncertain','unresolved','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempt_at INTEGER,
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX source_suggestion_outbox_ready ON source_suggestion_outbox(state, lease_until);
