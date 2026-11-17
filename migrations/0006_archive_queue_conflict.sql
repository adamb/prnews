-- Explicit UPSERT retains duplicate-image handling during an outer article UPSERT.
DROP TRIGGER archive_queue_image;
CREATE TRIGGER archive_queue_image AFTER INSERT ON archive_revisions
WHEN NEW.image_url != ''
BEGIN
 INSERT INTO archive_images(url) VALUES(NEW.image_url) ON CONFLICT(url) DO NOTHING;
END;
