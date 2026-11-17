CREATE TABLE archive_revisions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 url TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
 title TEXT NOT NULL, summary TEXT NOT NULL, image_url TEXT NOT NULL,
 translation TEXT, first_seen INTEGER NOT NULL, captured_at INTEGER NOT NULL
);
CREATE INDEX archive_captured ON archive_revisions(captured_at DESC, id DESC);
CREATE INDEX archive_article ON archive_revisions(url, id DESC);
CREATE TABLE archive_images (
 url TEXT PRIMARY KEY, object_key TEXT, content_type TEXT, bytes INTEGER,
 saved_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE TRIGGER archive_queue_image AFTER INSERT ON archive_revisions
WHEN NEW.image_url != ''
BEGIN
 INSERT OR IGNORE INTO archive_images(url) VALUES(NEW.image_url);
END;
CREATE TRIGGER archive_new_article AFTER INSERT ON articles
BEGIN
 INSERT INTO archive_revisions(url,source,payload,title,summary,image_url,translation,first_seen,captured_at)
 VALUES(NEW.url,NEW.source,NEW.payload,json_extract(NEW.payload,'$.title'),json_extract(NEW.payload,'$.summary'),json_extract(NEW.payload,'$.image'),NEW.translation,NEW.first_seen,NEW.updated_at);
END;
CREATE TRIGGER archive_changed_article AFTER UPDATE OF payload ON articles
WHEN json_extract(OLD.payload,'$.title') IS NOT json_extract(NEW.payload,'$.title')
 OR json_extract(OLD.payload,'$.summary') IS NOT json_extract(NEW.payload,'$.summary')
 OR json_extract(OLD.payload,'$.image') IS NOT json_extract(NEW.payload,'$.image')
BEGIN
 INSERT INTO archive_revisions(url,source,payload,title,summary,image_url,translation,first_seen,captured_at)
 VALUES(NEW.url,NEW.source,NEW.payload,json_extract(NEW.payload,'$.title'),json_extract(NEW.payload,'$.summary'),json_extract(NEW.payload,'$.image'),NEW.translation,NEW.first_seen,NEW.updated_at);
END;
CREATE TRIGGER archive_translation AFTER UPDATE OF translation ON articles
WHEN NEW.translation IS NOT NULL
BEGIN
 UPDATE archive_revisions SET translation=NEW.translation
 WHERE url=NEW.url AND title=json_extract(NEW.translation,'$.originalTitle') AND summary=json_extract(NEW.translation,'$.originalSummary');
END;
-- Capture what is already present; no foreign keys tie the archive to rolling retention.
INSERT INTO archive_revisions(url,source,payload,title,summary,image_url,translation,first_seen,captured_at)
SELECT url,source,payload,json_extract(payload,'$.title'),json_extract(payload,'$.summary'),json_extract(payload,'$.image'),translation,first_seen,updated_at FROM articles;
