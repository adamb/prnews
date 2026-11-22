-- Restore latest known copies; never replace a current item. Existing insert
-- triggers index these copies and capture a redundant revision at its original time.
INSERT OR IGNORE INTO articles(url,source,payload,first_seen,updated_at,published_at,translation)
SELECT r.url,r.source,r.payload,r.first_seen,r.captured_at,json_extract(r.payload,'$.time'),r.translation
FROM archive_revisions r WHERE NOT EXISTS(SELECT 1 FROM articles c WHERE c.url=r.url) AND r.id=(SELECT MAX(a.id) FROM archive_revisions a WHERE a.url=r.url);
CREATE INDEX articles_source_date ON articles(source,published_at DESC,url);
CREATE INDEX articles_date_url ON articles(published_at DESC,url);
CREATE INDEX articles_first_seen ON articles(first_seen);

-- No bodies, addresses, capabilities, or provider error text.
CREATE TABLE alert_delivery_history (
 account_id TEXT NOT NULL, article_ref TEXT NOT NULL, phrases TEXT NOT NULL,
 queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 outbox_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 accepted_at INTEGER, PRIMARY KEY(account_id,article_ref)
);
CREATE INDEX alert_history_expiry ON alert_delivery_history(queued_at);
CREATE INDEX alert_history_outbox ON alert_delivery_history(outbox_id);
CREATE TRIGGER alert_history_queue AFTER INSERT ON alert_queue BEGIN
 INSERT OR IGNORE INTO alert_delivery_history(account_id,article_ref,phrases,queued_at,updated_at,state)
 VALUES(NEW.account_id,NEW.url,json_extract(NEW.payload,'$.phrases'),NEW.enqueued_at,NEW.enqueued_at,'queued');
END;
CREATE TRIGGER alert_history_phrases AFTER UPDATE OF payload ON alert_queue BEGIN
 UPDATE alert_delivery_history SET phrases=json_extract(NEW.payload,'$.phrases') WHERE account_id=NEW.account_id AND article_ref=NEW.url;
END;
CREATE TRIGGER alert_history_outbox_new AFTER UPDATE OF payload ON alert_outbox WHEN NEW.kind='notify' AND json_valid(NEW.payload) BEGIN
 UPDATE alert_delivery_history SET outbox_id=NEW.id,state='pending',updated_at=NEW.created_at
 WHERE account_id=NEW.account_id AND article_ref IN (SELECT json_extract(value,'$.url') FROM json_each(NEW.payload,'$.items'));
END;
CREATE TRIGGER alert_history_state AFTER UPDATE OF state,attempts ON alert_outbox WHEN NEW.kind='notify' BEGIN
 UPDATE alert_delivery_history SET state=CASE NEW.state WHEN 'sent' THEN 'provider_accepted' ELSE NEW.state END,
 attempts=NEW.attempts,accepted_at=NEW.sent_at,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE outbox_id=NEW.id;
END;
CREATE TRIGGER alert_history_outbox_expiry BEFORE DELETE ON alert_outbox BEGIN
 UPDATE alert_delivery_history SET state=CASE WHEN OLD.state IN ('sending','uncertain') THEN 'unresolved' ELSE 'expired' END,
 updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE outbox_id=OLD.id AND state IN ('pending','sending','uncertain');
END;
CREATE TRIGGER alert_history_queue_expiry BEFORE DELETE ON alert_queue BEGIN
 UPDATE alert_delivery_history SET state='expired',updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE account_id=OLD.account_id AND article_ref=OLD.url AND state='queued';
END;
CREATE TRIGGER alert_history_close AFTER UPDATE OF status ON alert_accounts WHEN NEW.status='closed' BEGIN
 DELETE FROM alert_delivery_history WHERE account_id=NEW.id;
END;
