-- First confirmed alert account: one durable marker, and room for outbox kind 'owner'.
-- Copies every existing outbox row, then swaps the table so the CHECK can allow 'owner'.
-- Does not delete accounts, watchers, tokens, sessions, or mail history, and does not
-- enqueue notices for accounts that are already confirmed.
-- Idempotent: a second apply copies the live outbox again and keeps every row.
CREATE TABLE IF NOT EXISTS alert_signup_notices (
  account_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL UNIQUE,
  confirmed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_outbox_v2 (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('notify','confirm','signin','owner')),
 account_id TEXT NOT NULL REFERENCES alert_accounts(id),
 batch_hour INTEGER,
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

INSERT OR IGNORE INTO alert_outbox_v2(id,kind,account_id,batch_hour,email,payload,state,attempts,lease_until,attempt_at,provider_ref,created_at,sent_at)
SELECT id,kind,account_id,batch_hour,email,payload,state,attempts,lease_until,attempt_at,provider_ref,created_at,sent_at FROM alert_outbox;

DROP TABLE alert_outbox;
ALTER TABLE alert_outbox_v2 RENAME TO alert_outbox;

CREATE UNIQUE INDEX IF NOT EXISTS alert_outbox_batch ON alert_outbox(account_id, batch_hour) WHERE kind = 'notify' AND batch_hour IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_outbox_ready ON alert_outbox(state, lease_until);
CREATE INDEX IF NOT EXISTS alert_outbox_prune ON alert_outbox(created_at);
