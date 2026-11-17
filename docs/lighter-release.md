# Lighter take release — November 17, 2026

Deployed source: `a31b006b25078ff11e56b7dff4c4cc8a84eca05c`.
Worker version: `04956006-a627-428b-89d9-fdd914dbf4fd`.
Integrated main `c686841398105507b29812c0be5b073c84b8929d`, preserving Stats/Hall click redirects. Feature and main remote SHAs verified before deployment. Clean committed checkout deployed with Wrangler OAuth. Applied only additive `0011_lighter.sql` (two CREATE TABLE IF NOT EXISTS statements), no seeds or initial migrations.

Validation: npm ci; 269 tests passing in 25 files; TypeScript check; Wrangler dry-run build. Public browser-user-agent fetches of Spanish/English home, About, Stats and Hall returned 200; About includes new disclosure. Plain urllib user agent received 403. No outbound /click GETs, private accounts or email delivery tested. Generated production takes await cron; no extra AI calls were triggered for verification.

Maximum two 180-output-token calls per 15-minute slot using existing Llama 3.3 70B FP8 Fast; durable slot claim, cached results, bounded retry. Homepage/section coverage only, intentionally sparse. Sensitive matches are withheld rather than rewritten. Lexical/prompt controls cannot guarantee factuality, language correctness or semantic safety. Originals remain visible. Cache and slot records currently persist.

## November 17 diagnosis, 13:18 UTC / 09:18 AST

Read-only production D1 inspection found one slot (`lighter/1994357`, 13:15 UTC), two attempts (Spanish/English for one article), and zero generated texts. Retry timestamps are around 14:15 UTC. Thus cron reached generation; this was not merely an unstarted warmup. Historical reasons cannot be recovered: original code swallowed errors and did not persist rejection reasons. No manual AI requests were made or limits bypassed. Latest-60 candidate inspection admitted 49 items before the safety correction; the filter did not reject everything. Both public home editions returned 200 and zero lighter controls. Previous release verification did not establish usable production output.

Follow-up hardens recognized Spanish death/accident terms, accepts fenced/structured JSON with unchanged downstream validation, and logs only categorical failures (no raw error, prompt, or response). This is defensive parser compatibility, not proof of the historical failure cause. No schema migration or spend increase. Validation: npm ci; 270 tests; typecheck; build. No visible production example can yet be claimed.

Follow-up deployed source `ae19900a899204784bc61333d049096151b6278e`, verified on private remote main before deploy; Worker `5423eb4d-974a-4239-927a-9666384d27c1`. Clean checkout, coordinated fast-forward main integration, no migrations. Post-deploy Spanish/English home and `/s/otras` returned 200 with zero lighter controls. Usable production output remains unverified; next scheduled opportunity 13:30 UTC / 09:30 AST. No claim of feature completion or exact historical model failure is justified by these records.
