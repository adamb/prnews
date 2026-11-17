CREATE TABLE IF NOT EXISTS articles (
 url TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL,
 first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER NOT NULL,
 translation TEXT, translation_attempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS articles_published ON articles(published_at DESC);
CREATE TABLE IF NOT EXISTS feed_state (
 url TEXT PRIMARY KEY, source TEXT NOT NULL, etag TEXT, modified TEXT,
 last_checked INTEGER, last_ok INTEGER, status INTEGER, error TEXT,
 failures INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, lease_until INTEGER NOT NULL, owner TEXT NOT NULL);
