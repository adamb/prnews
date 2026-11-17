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

## November 17 verified usable output, 13:30–13:32 UTC / 09:30–09:32 AST

Source release `0f2fadc4d7dd13ef5507010e1cc6dd9fab7e594e`; Worker `cd9b9bfa-5720-463b-9fa2-629928d30e79`. Preserves alert-language release `30beef092bd255059f924a78e353a2da30c08e3f` and notes `a896b83`. Exclusive release slot coordinated after the alerts deployment. Reviewed diff, clean source checkout, remote main SHA verified before OAuth deployment. npm ci, 273 tests, typecheck and build passed. No migration.

At 13:21 UTC production still held two null-text rows from 13:15 and zero successes. The historical failure reason was not recorded. At 13:30 UTC a one-shot diagnostic adapter invoked the existing generator against production D1 and the same Workers AI model using OAuth. It acquired the existing durable 15-minute slot; two calls only, each configured with max_tokens 180. Earlier rows remained in one-hour backoff. Actual completion usage was 29 and 18 tokens. The normal 13:30 cron subsequently finished with outcome `ok`; the shared claim prevented extra lighter calls. No refresh/email endpoint or outbound click GET was invoked.

Both real responses contained an object in `response`, with a `text` field. This is concretely incompatible with the original string-only JSON.parse implementation and compatible with the previously deployed hardened decoder. It supports that parser defect but cannot prove the unrecorded historical responses had the same shape. Sanitized public text/shape is now regression-tested. Failure logs now distinguish model, decode and save errors without recording raw exception/response data.

Final read-only D1 evidence: four cache rows, two generated texts, two failed/no-text rows, four cumulative attempts. Two slots consumed (13:15 and 13:30). Latest 60 candidate eligibility was 45 before the cron and 44 afterward. No limit increase, forced unsafe output or fabricated cache text.

After deployment, https://news.dev.pr/ and https://news.dev.pr/?lang=en each returned HTTP 200 with one native `details.lighter` control, localized open/return labels and AI disclosure for “Maestros realizan hoy manifestaciones en escuelas: ‘Hay unos reclamos puntuales’”. Spanish saved text: “Maestros en Puerto Rico realizan manifestaciones para exigir mejoras salariales y pago de deudas.” English: “Teachers in Puerto Rico are protesting for salary improvements and debt payment.” Both are supported by the supplied public excerpt, pass existing validation, and preserve the original. These direct home URLs are untracked; verification did not follow `/click`. Homepage visibility changes as news ordering changes; this is dated HTML/control evidence, not a permanent placement guarantee or a browser interaction test.
