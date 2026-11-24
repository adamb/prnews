-- Owner-only Source Suggestions admin dashboard (strictly additive to 0019).
-- Adds an admin note to each suggestion, single-use magic-link sign-in tokens for exactly
-- one operator mailbox, scoped admin sessions, and a paced outbox for the sign-in mail that
-- follows the alerts/suggestions conventions (hashed tokens, ambiguous sends never auto-retried).
ALTER TABLE source_suggestions ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';

-- Sign-in tokens: SHA-256 hashes only, single-use, expiring. Raw tokens are never stored.
CREATE TABLE IF NOT EXISTS admin_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_tokens_created ON admin_tokens(created_at);

-- Admin sessions: hashed secret, a per-session CSRF token, seven-day expiry.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires ON admin_sessions(expires_at);

-- The admin sign-in mail flows through here. ImprovMX's Send API has no idempotency keys,
-- so ambiguous outcomes become 'uncertain' and are never auto-resent.
CREATE TABLE IF NOT EXISTS admin_outbox (
  id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS admin_outbox_ready ON admin_outbox(state, lease_until);
