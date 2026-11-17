-- Bounded og:image enrichment: articles whose feed provides no image are queued once
-- (url-keyed), so the scheduler may fetch the publisher's public article page at
-- ingestion time only — never on page views, never per render — and read the publisher's
-- own og:image metadata. Failed lookups back off and stop after the attempt cap; the
-- newspaper-illustration fallback stays for articles the publisher offers no image for.
CREATE TABLE IF NOT EXISTS image_enrich_queue (
 url TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0,
 error TEXT
);
CREATE INDEX IF NOT EXISTS image_enrich_ready ON image_enrich_queue(next_attempt, attempts);
