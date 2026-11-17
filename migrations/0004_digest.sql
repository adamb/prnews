CREATE TABLE digest_subscribers (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, language TEXT NOT NULL CHECK(language IN ('es','en')),
 status TEXT NOT NULL DEFAULT 'pending', confirm_hash TEXT, confirm_expires INTEGER,
 unsubscribe_hash TEXT NOT NULL, confirmed_at INTEGER, last_request INTEGER NOT NULL,
 request_day INTEGER NOT NULL, request_count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX digest_confirm ON digest_subscribers(confirm_hash);
CREATE UNIQUE INDEX digest_unsubscribe ON digest_subscribers(unsubscribe_hash);
CREATE TABLE digest_limits (day INTEGER PRIMARY KEY, requests INTEGER NOT NULL);
CREATE TABLE digest_days (day TEXT PRIMARY KEY, cutoff INTEGER NOT NULL, stories TEXT NOT NULL, sender TEXT NOT NULL);
CREATE TABLE digest_deliveries (
 day TEXT NOT NULL, subscriber TEXT NOT NULL, language TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0, first_attempt INTEGER, sent_at INTEGER,
 PRIMARY KEY(day,subscriber)
);
CREATE INDEX digest_pending ON digest_deliveries(day,state,lease_until);
CREATE TABLE article_importance (cache_key TEXT PRIMARY KEY, text TEXT NOT NULL, method TEXT NOT NULL);
