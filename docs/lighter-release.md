# Lighter take release — November 17, 2026

Deployed source: `a31b006b25078ff11e56b7dff4c4cc8a84eca05c`.
Worker version: `04956006-a627-428b-89d9-fdd914dbf4fd`.
Integrated main `c686841398105507b29812c0be5b073c84b8929d`, preserving Stats/Hall click redirects. Feature and main remote SHAs verified before deployment. Clean committed checkout deployed with Wrangler OAuth. Applied only additive `0011_lighter.sql` (two CREATE TABLE IF NOT EXISTS statements), no seeds or initial migrations.

Validation: npm ci; 269 tests passing in 25 files; TypeScript check; Wrangler dry-run build. Public browser-user-agent fetches of Spanish/English home, About, Stats and Hall returned 200; About includes new disclosure. Plain urllib user agent received 403. No outbound /click GETs, private accounts or email delivery tested. Generated production takes await cron; no extra AI calls were triggered for verification.

Maximum two 180-output-token calls per 15-minute slot using existing Llama 3.3 70B FP8 Fast; durable slot claim, cached results, bounded retry. Homepage/section coverage only, intentionally sparse. Sensitive matches are withheld rather than rewritten. Lexical/prompt controls cannot guarantee factuality, language correctness or semantic safety. Originals remain visible. Cache and slot records currently persist.
