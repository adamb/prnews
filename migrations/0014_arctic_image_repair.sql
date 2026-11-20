-- Bookkeeping so the bounded Arctic image repair never loops: one row per looked-up
-- post marks attempts and backoff; a row at the attempt cap is never re-queued, so
-- posts the archive says have no photo (text or Reddit placeholder) stay imageless.
CREATE TABLE arctic_image_repair (
 url TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0,
 error TEXT
);
