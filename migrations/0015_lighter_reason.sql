-- Sanitized per-cell failure category for the on-demand satire cache.
-- Additive only: existing rows keep last_reason NULL, and every SELECT in the
-- Worker names its columns, so the deployed code can read the table before or
-- after this migration. The column stores only the category names written by
-- src/lighter.ts (abstained, rejected:quotes|numbers|shape|institution|language,
-- timeout, model_error, decode_error, save_error, provider_throttled) and is
-- cleared on success. Never model output, provider error text, URLs, or any
-- article data. Applied with the reviewed plan: migrate first, then deploy.
ALTER TABLE lighter_cache ADD COLUMN last_reason TEXT;
