-- Additive optional cache; no article or account data is changed.
CREATE TABLE IF NOT EXISTS lighter_cache(key TEXT PRIMARY KEY,text TEXT,attempts INTEGER NOT NULL,next_try INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lighter_slots(id TEXT PRIMARY KEY);
