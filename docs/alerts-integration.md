# Keyword alerts integration (checkpoint, November 2026)

The disabled newsletter was replaced by keyword alerts per the accepted flow: **email + one
phrase signup → confirmation email activates the alert and opens My alerts (magic link
session; no passwords at any point)**. ImprovMX's Send API is the only outbound mail path for
alerts — its official API and blog list "Alerts" and "Magic Links" as supported transactional
use cases, while newsletters/promotions remain explicitly prohibited (the daily digest stays
Resend-only and disabled; `DIGEST_ENABLED=false` and no re-enable happened).

## Deployment state

* `migrations/0009_alerts.sql` — additive schema, **applied to the remote D1 database** (via the
  D1 token; next unique name after the other worker's 0008). Tables: `alert_accounts` (with the
  hash-only `out_hash` unsubscribe capability), `alert_watchers` (phrase, normalized tokens,
  status, baseline/scan_cursor watermarks), `alert_tokens` (hashed single-use confirm/signin/
  manage), `alert_sessions` (hashed cookie secrets + per-session CSRF), `alert_notified` (the
  per-address dedup ledger), `alert_queue` (pending matches), `alert_outbox` (all mail kinds,
  uncertainty + refs; unique per (account, batch hour) for notifications), `alert_limits`,
  `alert_pace`.
* Worker vars: `CONTACT_EMAIL="prnews@code.pr"` (site contact everywhere, incl. footer/about),
  `ALERTS_FROM="prnews"`, `ALERTS_DOMAIN="code.pr"` (sending identity confirmed with the user,
  catch-all on code.pr forwards it; nothing about forwarding/DNS was changed). The secret
  `IMPROVMX_API_KEY` was already installed in the Worker; `DIGEST_TOKEN_SECRET` is reused only
  as a namespaced HMAC key for the account-unsubscribe capability. `ALERTS_MINUTE_CAP`,
  `ALERTS_MIN_INTERVAL_MS`, `ALERTS_DAILY_SEND_CAP` are optional ops overrides; code clamps
  them so they can only slow things down.
* **ImprovMX capabilities verified against the live account (v4 API)**: plan `Premium - Yearly`,
  `daily_send_limit 400` (shared with SMTP), `email_log_retention_days 7`, code.pr
  `send_ready=true`, not banned. Note: `digest` and `alerts` are NOT currently aliases on
  code.pr (the catch-all is what delivers prnews@code.pr inbound).
* **Turnstile IS provisioned (2026-11-14, per the cloudflare Turnstile "existing widget"
  flow).** The user created the widget for news.dev.pr (widget metadata checked through the
  Turnstile API against the deploy token: sitekey `0x4AAAAAAGBgOxdiwxaNdKZs`, mode managed,
  domains news.dev.pr + localhost/127.0.0.1). The secret was delivered out-of-band and never
  appears in chat, logs, or this repo: validated against siteverify (dummy token →
  `invalid-input-response` only) and installed as the `TURNSTILE_SECRET_KEY` Worker secret
  via stdin. `TURNSTILE_SITE_KEY` and `TURNSTILE_HOSTNAMES="news.dev.pr"` are public vars in
  wrangler.toml (no localhost in the production hostname allowlist; no test keys). Public
  signup and magic sign-in are therefore live, and every siteverify response must carry
  `success`, the per-surface `action` (`signup` / `signin` from the widget's `data-action`)
  and an allowlisted `hostname`; anything else is fail-closed as unverified.

## How the agreed guarantees are implemented

* **Signup**: POST /alerts/signup — honeypot (`company`/`website` fields) → global daily cap
  (50) → **Turnstile siteverify (server-side, challenges.cloudflare.com/turnstile/v0/siteverify)**
  → generic identical answer for every normal-shaped input; an unverified token never touches
  the database. A new account starts `unconfirmed` with a pending watcher; re-signup of a
  pending address replaces it (bounded 3 confirmation mails/day/address via outbox count);
  re-signup of an active address answers with a fresh single-use sign-in mail instead
  (nothing is re-activated); a closed address can re-enroll.
* **Confirmation** (24h token, SHA-256-hashed at rest, single use): marks the account active,
  stamps every watcher with **baseline = activation time** — candidates require
  `first_seen > baseline AND published_at > baseline`, so pre-activation stories never match —
  then rotates into an HttpOnly/SameSite=Lax/Secure-on-https session cookie and 303s to
  `/alerts` (My alerts). The response is a generic page for invalid/expired/replayed links.
* **Matching** (no AI): phrases normalize to ≤8 lowercase word tokens (letters/numbers, ≥2
  chars — same shape as site search). A story matches when every token appears as a whole word
  across the original title/summary **and the validated translated text** (validTranslation).
  Each sweep loads ≤600 candidates of the last 12 h past each watcher's scan cursor, tokenizes
  each candidate once, and only `active` watchers of `active` accounts are considered.
  Translation arriving after collection is caught by the 12 h re-scan lookback; the per-address
  ledger `alert_notified(account,url)` guarantees an article is mailed at most once per person,
  across all their phrases, forever (within the 21-day pruning horizon).
* **Batching/pacing**: matches queue per address; a flush builds **at most one notification per
  hour per address** (stamped whether or not the send succeeds, so a degraded provider never
  loops), ≤10 items per email. Everything (notify + confirm + sign-in) flows through a single
  outbox with a global pace row (default ≥8 s between sends, ≤8/minute, ≤20 sends per sweep,
  ≤200/day against the provider's shared 10/min and 400/day account limits).
* **ImprovMX has no idempotency keys.** Ambiguous outcomes (timeout/5xx/network) become
  `uncertain` and are **never resent automatically**; a probe (`GET /v4/domains/:domain/logs/search`
  with the opaque subject reference ` [#id]`, exact recipient + transport=api, then a plain
  exact-recipient window count as fallback) resolves them: `present` → sent; `absent` → the
  ONLY state that permits exactly one more send (bounded 5 attempts/24 h, then `unresolved`).
  Crash rows stuck in `sending` become uncertain by expired lease, as in the digest.
  429 honors `Retry-After`/`X-RateLimit-Reset`, consumes no attempt, and stops the batch.
  Definite 4xx is terminal `failed`. Confirmation/sign-in sends are not auto-retried; the
  per-address caps let the user request anew, and a re-request of a recently-uncertain mail
  just waits for resolution (no duplicates).
* **Manage** (`/alerts`, session-gated, no CAPTCHA there; CAPTCHA only on public abuse
  endpoints): add / edit / pause / resume / delete individual alerts, pause-all, and
  unsubscribe-all (or the mailed `/alerts/out?token=…` capability which closes the account,
  deletes watchers, queued matches, sessions and cancels unsent outbox rows). Editing a phrase
  restarts its watermark so the new wording never judges old stories; pausing keeps the phrase.
  All mutations require the per-session CSRF token (constant-time compare) and same-origin
  POSTs. Sessions: hashed cookie secrets, max 5 per account, 30-day expiry, immediate revocation
  on unsubscribe-all.
* **Magic links**: fresh sign-in (`/alerts/in`, 15 min) and the manage link inside every
  notification (`/alerts/m`, 14 d) are single-use, hashed at rest, and only work for active
  accounts; redemption rotates into a scoped session and 303s to a clean URL. Manage/unsub
  links are also inside notification emails as promised.
* **Headers/privacy**: all /alerts* pages and token pages: `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, strict CSP (forms pages
  additionally allow challenges.cloudflare.com script/frame), and no analytics beacon. Tokens
  never appear in URLs after redemption or in referrers. No tokens/emails/credentials in logs;
  module code logs nothing about sends.
* **Provider identity**: `from` = `prnews` (local part on `code.pr` per the official parameter),
  `reply_to` = prnews@code.pr. The v4 Send API takes the bare local part and does not document
  display-name support or custom headers (no List-Unsubscribe header), so clear labels are
  carried in subjects/body and unsubscribe is a visible link only; reported honestly.

## Routes

* POST `/alerts/signup` (public, CAPTCHA); GET → 405. · POST `/alerts/signin` (public, CAPTCHA);
  GET → redirect `/alerts`.
* GET `/alerts/confirm?token=…` → single-use activation + session cookie. · GET `/alerts/in`
  (sign-in magic) · GET `/alerts/m` (manage magic) · GET/POST `/alerts/out` (unsubscribe-all).
* GET `/alerts` → My alerts (or passwordless sign-in page). POST `/alerts/watcher`,
  `/alerts/pauseall`, `/alerts/unsubscribeall` (session + CSRF + same-origin).
* Cron: the existing 15-minute scheduled handler runs `runAlertSweep` after ingestion
  (prune → match → flush → resolve-uncertain → dispatch); failure is caught and bounded.

## Verification performed

* `npm run typecheck`, `npx wrangler deploy --dry-run` — clean.
* `npx vitest run` — 166 tests green (162 + 4 new Turnstile claim-validation tests), including
  23 new alerts tests covering: captcha fail-closed
  gating (incl. no-DB on invalid tokens), honeypot, generic anti-enumeration responses,
  unconfigured-disabled endpoints, per-address/global caps, pending re-signup replacement,
  hash-only token storage, single-use replay (confirm/sign-in/manage), 15-minute expiry,
  cross-user isolation with CSRF rejection, same-origin enforcement, no-cookie 401,
  pause/delete/pause-all/unsubscribe-all/closure, watermark exclusion of old stories,
  translation-arriving-later pickup, one-article-once-per-person dedup across alerts,
  hourly batching with uniqueness, notification email links, uncertain→probe(present|absent)
  no-duplication semantics, Retry-After without attempt consumption + batch stop, terminal 4xx,
  unresolved-after-budget + pruning, exact provider request shape (v4 URL, basic auth, local
  `from`, reply_to prnews@code.pr, subject reference) and no Resend path.
* Local D1 (wrangler.local.toml) has the same vars minus secrets; local dev shows the truthful
  paused public forms.

## Deployment (performed 2026-11-14, updated 2026-11-15 after the first real user flow)

* **Immediate visitor mail (2026-11-15):** confirmation and sign-in mails now attempt one
  paced, claim-guarded send right where they are created — the visitor gets the email within
  seconds, not on the next cron. The visitor is never blocked: when the shared budget
  (daily cap, ≥8 s interval, ≤8/min) is momentarily busy the attempt is skipped and the row
  waits for the sweep. Hourly notification batching is unchanged; all outcomes (sent/
  throttled/uncertain/rejected) share the dispatcher's row state machine, so ambiguous
  attempts still resolve through provider-log probes and nothing is duplicated.
* **Dispatcher fix:** dispatch only mailed rows whose account was `active`, which deadlocked
  double opt-in (a `confirm` mail cannot wait for the activation it delivers). Confirm/signin
  rows now mail regardless of account status; notifications stay gated on `active`.
* **Origin gate (v3):** canonical origin = scheme+host+port; Sec-Fetch-Site (browser-only
  header) vouches for `Origin: null` posts, scheme-rewritten same-host posts and
  site-alias siblings with matching Referer; no-evidence requests keep the legacy posture
  and still meet the captcha gate; raw Origin/Referer values are never logged.
* **Honest failures:** a missing/expired/failed challenge (including network-error verifies
  and claim mismatches) returns a bilingual 400 retry page — form re-rendered with the
  retained, escaped input and a fresh widget — instead of a fake "if eligible" success;
  nothing is written and no shared counter is consumed. A verified token overrides the
  honeypot (real autofill is not a bot) and honeypot decoys are renamed `x_presencia`
  (legacy names still trip). Widget surfaces ship a small guard script (CSP-hashed) that
  refuses to submit without a live token and reports state in an aria-live region.
* **Live verification (2026-11-15):** dead-token POST → 400 retry page, `accounts`/`outbox`
  0 in remote D1; widget + guard render on /signup and /alerts with per-surface actions.
1. `wrangler d1 migrations apply prnews --remote` — 0009 applied ✅ (tables verified via API).
2. `wrangler deploy` — live at news.dev.pr (version 13fbde04…, both crons intact) ✅.
3. Public verification ✅: `/alerts` HEAD 200 with no-store/noindex/no-referrer; `/signup` shows
   the keyword-alerts page with the truthful paused notice; POST `/alerts/signup` → 503
   "temporarily unavailable" (generic; never echoes input; nothing unprotected); GET
   `/alerts/signin` → 303 `/alerts`; unknown /alerts paths → 404; POST `/digest/subscribe`
   still 503 (newsletter stays off); `/about` shows prnews@code.pr; homepage unaffected.
4. Turnstile (done 2026-11-14): the widget exists (user-created); `TURNSTILE_SECRET_KEY` was
   installed as a Worker secret (stdin only) and the public `TURNSTILE_SITE_KEY` var plus
   `TURNSTILE_HOSTNAMES="news.dev.pr"` were added; `wrangler deploy` lit the public forms up
   (`turnstileRenderConfigured`). Version 98c6f64d….
5. No real email was sent anywhere (no test recipients were provided); first real verification
   is the user's own sign-up through the live site with the rendered widget.

### Confirmation recovery investigation (2026-11-15)
Live D1 showed two separate confirmation outbox rows, one attempt each and distinct
provider IDs. The earlier row waited approximately six minutes for a sweep; the newer
row was accepted about 1.4 seconds after creation. User confirmed receiving both.
Only the newer confirmation token remained valid under the old replacement behavior.
No diagnostic resend or token rotation was performed.

Auth requests now await the same scoped dispatcher and paced send used by recovery.
Busy pacing no longer silently skips to the next cron. Pacing reservation compares the
previous timestamp atomically; only pending rows may be claimed for a fresh attempt.
Repeated unconfirmed submissions retain an unexpired unused confirmation token and
reuse any pending row instead of minting redundant mail. Provider throttling and daily
caps can still delay sending; provider acceptance does not guarantee inbox placement.


## Email-only confirmation recovery and language (2026-11-16)

The My alerts email-only form previously sent only to active accounts. An unconfirmed
account with an expired confirmation therefore received the generic response but no mail.
It now uses the same confirmation helper as signup when a pending watcher exists, preserves
all saved phrases and remains unconfirmed until the confirmation link is redeemed. An
unexpired confirmation is reused (including its pending outbox row); sent or uncertain
mail is never duplicated by a repeated request. Both entry points share confirmation caps.
Unknown/closed addresses are not enrolled or reactivated by sign-in.

The HTTP sign-in handler also no longer rejects an autofilled honeypot before verification:
like signup, a valid action/hostname-bound Turnstile response permits legitimate autofill.
Invalid email syntax gets a 400 without disclosing account state; successful challenges
retain the same public response across unknown, closed, unconfirmed and active accounts.

Alert pages now render one language: the selected English edition or Spanish by default.
Forms, retry/results, the Back link, emailed confirmation/sign-in/management links and
management redirects preserve that edition. Existing token URLs without a language retain
the Spanish default; no existing tokens or user records are migrated.

Verification uses real migration SQL with mocked Turnstile and mail-provider responses,
including the rendered homepage → My alerts → email-only submission → confirmation →
management journey. A deployment/public HTTP check does not prove real inbox delivery.

Released as `2f8942e7-1efe-421c-82ed-be79a1e737c1`: 253 tests, typecheck and
Wrangler dry-run passed. Public es/en homepage links, My alerts forms, signup actions,
confirmation failure pages, tokenless retry pages and generic sign-in outcomes were
checked after deployment. The generic outcome probe used an invalid synthetic address,
no challenge and the honeypot (no account lookup or send). No real email was sent and no
user account was activated; inbox delivery after a new legitimate request remains unverified.

## Notification edition policy (November 17, 2026)

The notification template was bilingual, but flushDue previously substituted English
translations regardless of account language. It now uses the site's validated edition
helpers and full live article metadata before applying the 300-character email limits.
Source labels use the existing publication names.

Language remains account-wide, matching the per-address hourly batch and dedup model.
Signup persists the page edition; authenticated creation of an additional alert selects
that page's edition for all future batches, explicitly disclosed on the add form.
Editing, pausing, signing in, and viewing another edition do not change this preference.
Existing accounts retain their stored preference; no historical choice is inferred.
Calls without a language preserve that preference. Already-created outbox messages retain
their immutable text and language; this release does not change previously delivered mail.

English batches defer stories without validated English text (including missing live
metadata), leaving them queued until translation arrives or the existing queue retention
expires. No email invokes AI or schedules bulk translation. Spanish follows the site's
original edition, including original English stories and the site's existing Reddit summary
policy; it does not promise Spanish translations of English originals. Publisher URLs
remain original URLs; management and unsubscribe links carry the batch language.
No database migration or production account mutation is required.

Release: source commit `30beef092bd255059f924a78e353a2da30c08e3f`, Worker
`ad483168-e464-4619-b912-92cc7b03478c`. Coordinated exclusive release slot;
fast-forwarded remote main from ed69e1e, verified its SHA before deploying the clean
committed checkout using Wrangler OAuth. Validation: npm ci, 272 tests across 25 files,
typecheck, build, and diff review. Regression tests cover both notification editions,
delayed English translation, publication labels, HTML/text language links, signup preference
and authenticated add-alert language changes. No live email, resend, account mutation,
migration, bulk translation, or changes to previously delivered mail.

## Operator notice on first confirmation

A signup counts when a confirmation token is redeemed and the account moves from
`unconfirmed` to `active`. An unconfirmed address, a replayed token, a sign-in, a watcher
edit, and an added watcher do not count. A closed account that confirms again is the same
account and does not count again. The public wording is "confirmed alert accounts":
one row is one email account, not one person.

That first transition inserts `alert_signup_notices(account_id)` and one `alert_outbox` row
with kind `owner`, id `owner-signup:<account id>`, and recipient `beguelin@gmail.com`.
The body has the confirmation time and the phrases activated by that confirmation. It does
not include the subscriber email, a manage link, or an unsubscribe token. HTML is escaped
and phrases are collapsed to one line. The row uses the existing pace, daily budget, and
uncertain-log reconciliation. ImprovMX still has no idempotency key; the notice row is what
stops a second event. A provider acceptance is best effort. If the process stops after the
notice row and before the outbox row, that account does not get a second chance: the token
is already used.

Dispatch sends kind `owner` even when the subscriber account is closed or not active.
Unsubscribe and a closed re-enrollment cancel that account's other unsent mail and leave
the operator row alone. The notice is not a keyword match and is not copied onto the
operator's watchers. Accounts already active when this ships do not get a notice. A failure
to record the notice does not undo the confirmation.

`/stats` shows the active count and the excluded closed count. Unconfirmed rows are omitted.
A failed read says the count is unavailable and does not show zero. The page has no address
list and no keyword list. There is no account-enumeration route. Public pages say "site
operator" and do not name the notice recipient.
Migration `0013_owner_signup_notice.sql` copies the outbox so kind `owner` is allowed and
adds the notice table. It does not delete accounts or rewrite mail history. Apply it before
the worker that inserts kind `owner`. Re-applying copies the current outbox and keeps every row.

## Reading-page invitation for keyword alerts (November 20, 2026)

`src/invitation.ts` renders a small, dismissible, never-modal invitation on the public
reading routes only (`/`, `/s/…`, `/story`, `/search`, `/archive`, status 200). Utility
pages, `/signup`, every `/alerts*` page and every non-200 response are excluded. The HTML
cache name moved to `prnews-html-v37` because page HTML changed.

Five bilingual variants ship together in the page, all server-hidden: your company, your
name, your favorite artist, your town (`tu pueblo`), and a favorite topic. Spanish is
Puerto Rican Spanish; each body states the truthful batched delivery ("máximo un correo
por hora" / "at most one email per hour") and never promises instant delivery. The shared
CTA is "Crear mis alertas" / "Create my alerts" and links to `/alerts` preserving the
viewed edition's `lang`; the close button carries a localized label. The card is a
fixed bottom card (full-width on phones, bottom-right on desktop), never covers reading
content, never takes focus, and Escape also closes it.

The client script does the only personalization, entirely in the browser:

- One invitation per America/Puerto_Rico calendar day (AST, UTC-4 all year — no DST, so a
  fixed offset is exact). Showing, closing or following the CTA suppresses every variant
  for the rest of that same AST day across all public pages. There is no midnight timer:
  the day is evaluated per visit (at display-decision time), so nothing re-opens while
  someone is reading.
- Deterministic round-robin: the shown variant index persists in the same local record
  and advances only on an actual display — never on plain page loads or on suppressed
  checks — so the next eligible visit on a later day offers the next variant (wrapping
  around). The record key is edition-independent, so switching Español/English never
  resets dismissal or rotation.
- A signed-in browser that already has active alerts is suppressed by
  `GET /api/alerts-active` (`src/alerts-http.ts`): the endpoint reads the existing session
  cookie and answers exactly `{"active":true|false}` — never an email, a phrase, or
  session material — always `Cache-Control: no-store` and `Referrer-Policy: no-referrer`,
  so it can never enter the shared HTML cache or the edge, and it sets no cookie. It is
  queried once per eligible display attempt, not per card. A signed-out visitor who
  created alerts elsewhere cannot be recognized; nothing claims otherwise.
- Storage is probed (localStorage, then sessionStorage); with both blocked the invitation
  never appears rather than nagging per page. A failed status check stays quiet and the
  invitation shows anyway. No new cookies, no visitor identity, no analytics; the Cloudflare
  beacon is unchanged.

Tests live in `test/invitation.test.ts`: bilingual variant copy and lang-preserving
links, route eligibility and exclusions, the AST day boundary, same-day suppression,
close/CTA dismissal, deterministic round-robin with wraparound, index preservation under
account-active suppression, edition-switch continuity, quiet storage failures, the
boolean endpoint's one-bit answers (no email/phrase, no-store, 405 on mutations), and
shared-HTML isolation (a session cookie changes nothing in the cached page).
