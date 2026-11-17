-- Homepage live-status strip cache (src/live-status.ts). One row per source;
-- nothing here is user data. Apply after 0001-0004 (0006 has no ordering conflicts).
CREATE TABLE live_status (
 source TEXT PRIMARY KEY CHECK(source IN ('weather','earthquake','outage')),
 -- Serialized StatusChip JSON from the last successful fetch; NULL until the
 -- source ever succeeded. Kept after later failures but hidden by staleness rules.
 payload TEXT,
 -- Last attempt's failure message (truncated). NULL when the last attempt succeeded.
 error TEXT,
 -- Epoch ms of the last fetch attempt, success or failure (rate-limits refreshes).
 last_checked INTEGER NOT NULL,
 -- Epoch ms of the last successful fetch; chip freshness/hiding is measured from here.
 last_good INTEGER,
 -- Duration of the last successful fetch in ms.
 fetch_ms INTEGER
);
