-- Additive anonymous event ledger. No historic events are backfilled.
CREATE TABLE invitation_counting (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL);
INSERT INTO invitation_counting VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
CREATE TABLE invitation_events (
 day TEXT NOT NULL, variant INTEGER NOT NULL CHECK(variant BETWEEN 0 AND 4),
 lang TEXT NOT NULL CHECK(lang IN ('es','en')),
 event TEXT NOT NULL CHECK(event IN ('shown','clicked','dismissed')),
 total INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day,variant,lang,event)
);
