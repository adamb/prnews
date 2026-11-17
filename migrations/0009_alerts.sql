-- Keyword alerts: passwordless accounts, per-phrase watchers, hashed single-use tokens,
-- scoped sessions, a per-address dedup ledger, a pending queue and a paced outbox.
CREATE TABLE alert_accounts (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
 language TEXT NOT NULL DEFAULT 'es' CHECK(language IN ('es','en')),
 status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(status IN ('unconfirmed','active','closed')),
 last_notification INTEGER NOT NULL DEFAULT 0,
 request_day INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0,
 out_hash TEXT,
 created_at INTEGER NOT NULL
);
-- The account-unsubscribe capability mailed in every notification: precomputed HMAC, stored hash-only.
CREATE UNIQUE INDEX alert_accounts_out ON alert_accounts(out_hash) WHERE out_hash IS NOT NULL;
-- One phrase per watcher; multiple independent phrases per account. baseline is the
-- activation watermark: only articles collected (first_seen) and published after it match,
-- so an alert never reports old stories. scan_cursor bounds each sweep to a small window.
CREATE TABLE alert_watchers (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES alert_accounts(id),
 phrase TEXT NOT NULL, tokens TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused')),
 baseline INTEGER NOT NULL, scan_cursor INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX alert_watchers_scan ON alert_watchers(status, scan_cursor);
CREATE INDEX alert_watchers_account ON alert_watchers(account_id);
-- Magic links (confirm / signin / manage): SHA-256 hashes only, single-use, expiring.
CREATE TABLE alert_tokens (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES alert_accounts(id),
 purpose TEXT NOT NULL CHECK(purpose IN ('confirm','signin','manage')),
 token_hash TEXT NOT NULL UNIQUE,
 expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX alert_tokens_account ON alert_tokens(account_id, purpose, created_at);
CREATE TABLE alert_sessions (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES alert_accounts(id),
 token_hash TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX alert_sessions_account ON alert_sessions(account_id);
-- One article at most once per person, across every alert they own.
CREATE TABLE alert_notified (account_id TEXT NOT NULL, url TEXT NOT NULL, notified_at INTEGER NOT NULL, PRIMARY KEY(account_id, url));
CREATE INDEX alert_notified_prune ON alert_notified(notified_at);
-- Matches waiting for the next hourly batch for their address.
CREATE TABLE alert_queue (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES alert_accounts(id),
 url TEXT NOT NULL, payload TEXT NOT NULL, enqueued_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX alert_queue_unique ON alert_queue(account_id, url);
CREATE INDEX alert_queue_order ON alert_queue(enqueued_at);
-- Every mail (notifications + confirmations + sign-ins) flows through here: ImprovMX's
-- Send API has no idempotency keys, so ambiguous outcomes become 'uncertain' and are
-- resolved through the provider's email logs before anything is ever resent.
CREATE TABLE alert_outbox (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('notify','confirm','signin')),
 account_id TEXT NOT NULL REFERENCES alert_accounts(id),
 batch_hour INTEGER, email TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','uncertain','unresolved','sent','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
 attempt_at INTEGER, provider_ref TEXT,
 created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE UNIQUE INDEX alert_outbox_batch ON alert_outbox(account_id, batch_hour) WHERE kind = 'notify' AND batch_hour IS NOT NULL;
CREATE INDEX alert_outbox_ready ON alert_outbox(state, lease_until);
CREATE INDEX alert_outbox_prune ON alert_outbox(created_at);
-- Global counters: bucket like 'signup:<day>' is implied by the day column.
CREATE TABLE alert_limits (bucket TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(bucket, day));
-- Global send pacing row: the ImprovMX Send API shares one 10 requests/minute and a
-- monthly/daily quota with SMTP, so all sends gate on this single row.
CREATE TABLE alert_pace (id TEXT PRIMARY KEY CHECK(id = 'pace'), last_send INTEGER NOT NULL DEFAULT 0, minute INTEGER NOT NULL DEFAULT 0, minute_count INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO alert_pace(id) VALUES('pace');
