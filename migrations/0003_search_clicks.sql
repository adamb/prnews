-- 0003_search_clicks.sql — search (FTS5), stable story permalinks, click aggregates.
-- Owned by the search/trending/syndication feature. Touches only new objects:
-- readers: src/search.ts (FTS + LIKE fallback), src/trending.ts (clicks + top),
-- src/syndication.ts (story permalinks, sitemap). Run after 0001/0002 in order.

-- ---------------------------------------------------------------------------
-- 1. Maintained FTS5 index: original title/summary + *valid cached* translation.
--    rowid mirrors articles.rowid while url stays stored (UNINDEXED) so deletes
--    are exact even if rowids ever shift; the 14-day retention on articles
--    keeps this table small via the delete trigger.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title,       -- original (Spanish or English source)
  summary,     -- original excerpt, <=300 chars
  title_en,    -- translated title, only when translation matches the payload
  summary_en,  -- translated excerpt, only when translation matches the payload
  url UNINDEXED
);

-- A translation is "valid" only while it matches the stored original payload
-- (same guard the renderer uses in src/i18n.ts).
CREATE TRIGGER IF NOT EXISTS articles_fts_add AFTER INSERT ON articles
BEGIN
  INSERT INTO articles_fts(rowid,url,title,summary,title_en,summary_en) VALUES(
    NEW.rowid, NEW.url,
    json_extract(NEW.payload,'$.title'), json_extract(NEW.payload,'$.summary'),
    CASE WHEN NEW.translation IS NOT NULL
          AND json_extract(NEW.translation,'$.originalTitle') = json_extract(NEW.payload,'$.title')
          AND json_extract(NEW.translation,'$.originalSummary') = json_extract(NEW.payload,'$.summary')
         THEN json_extract(NEW.translation,'$.title') END,
    CASE WHEN NEW.translation IS NOT NULL
          AND json_extract(NEW.translation,'$.originalTitle') = json_extract(NEW.payload,'$.title')
          AND json_extract(NEW.translation,'$.originalSummary') = json_extract(NEW.payload,'$.summary')
         THEN json_extract(NEW.translation,'$.summary') END
  );
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_del AFTER DELETE ON articles
BEGIN
  DELETE FROM articles_fts WHERE url = OLD.url;
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_upd AFTER UPDATE OF payload, translation ON articles
BEGIN
  DELETE FROM articles_fts WHERE url = OLD.url;
  INSERT INTO articles_fts(rowid,url,title,summary,title_en,summary_en) VALUES(
    NEW.rowid, NEW.url,
    json_extract(NEW.payload,'$.title'), json_extract(NEW.payload,'$.summary'),
    CASE WHEN NEW.translation IS NOT NULL
          AND json_extract(NEW.translation,'$.originalTitle') = json_extract(NEW.payload,'$.title')
          AND json_extract(NEW.translation,'$.originalSummary') = json_extract(NEW.payload,'$.summary')
         THEN json_extract(NEW.translation,'$.title') END,
    CASE WHEN NEW.translation IS NOT NULL
          AND json_extract(NEW.translation,'$.originalTitle') = json_extract(NEW.payload,'$.title')
          AND json_extract(NEW.translation,'$.originalSummary') = json_extract(NEW.payload,'$.summary')
         THEN json_extract(NEW.translation,'$.summary') END
  );
END;

-- Capture the article population that already exists.
INSERT INTO articles_fts(rowid,url,title,summary,title_en,summary_en)
SELECT a.rowid, a.url,
       json_extract(a.payload,'$.title'), json_extract(a.payload,'$.summary'),
       CASE WHEN a.translation IS NOT NULL
             AND json_extract(a.translation,'$.originalTitle') = json_extract(a.payload,'$.title')
             AND json_extract(a.translation,'$.originalSummary') = json_extract(a.payload,'$.summary')
            THEN json_extract(a.translation,'$.title') END,
       CASE WHEN a.translation IS NOT NULL
             AND json_extract(a.translation,'$.originalTitle') = json_extract(a.payload,'$.title')
             AND json_extract(a.translation,'$.originalSummary') = json_extract(a.payload,'$.summary')
            THEN json_extract(a.translation,'$.summary') END
FROM articles a;

-- ---------------------------------------------------------------------------
-- 2. Stable story permalinks: /story?id=<n> for syndication + click `id` lookups.
--    id = SQLite AUTOINCREMENT (never reused); rows persist after the article
--    rotates out of the 14-day `articles` window so ids stay stable; lookups
--    fall back to archive_revisions (see storyLookup in src/syndication.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS story_ids_add AFTER INSERT ON articles
BEGIN
  INSERT INTO story_ids(url) VALUES(NEW.url) ON CONFLICT(url) DO NOTHING;
END;

INSERT INTO story_ids(url) SELECT url FROM articles WHERE true ON CONFLICT(url) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Click aggregates per article, bucketed by hour. No IP, cookies, or any
--    other per-user data — only (article url, hour bucket, click count).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS article_click_buckets (
  url TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (url, bucket)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS article_click_buckets_bucket ON article_click_buckets(bucket);
