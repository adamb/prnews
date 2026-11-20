# Satire feedback (👍/👎) — 2026-11-20

Anonymous reader votes on a displayed satire take. Read `README.md` and `AGENTS.md`
first. This note documents the feedback feature; the satire generator itself is
documented in the README's "On-demand satire" section and is unchanged by this feature.

## What the reader sees

Below a **successfully displayed** satire line — after "Mostrar sátira" paints it, or
on a shared `/story?id=N&satire=1` page that opens with the line — two controls appear:
👍 and 👎 (`src/lighter-feedback.ts` `lighterFeedbackClientScript`). They never appear
for a failed, exhausted, hidden, or missing take: they are added inside the
`.lighter-note` only while the line is on the page, and every hide/fail/wait/done path
rewrites that note, which removes them with it. The server never ships vote-control
markup; the client builds it with DOM APIs and `textContent` only (no `innerHTML`).

- Both editions: aria-labels are localized ("Me gusta esta sátira" /
  "I like this satire", "No me gusta esta sátira" / "I dislike this satire"), the
  pressed state is `aria-pressed`, buttons are real `<button type="button">` (keyboard
  operable), and a status line announces success ("¡Gracias por tu voto!" /
  "Thanks for your vote!"), retraction ("Tu voto se retiró." / "Your vote was removed.")
  or failure in the note's existing polite live region.
- Pressing the other control changes the vote; pressing the pressed control retracts
  it. Both buttons are disabled while a submission is in flight.
- The button tooltip discloses the mechanism honestly: an anonymous per-browser vote.

## Identity, dedup, and change/retract

- Each browser generates one random UUID (`crypto.randomUUID`), kept in
  `localStorage` as `prnews-lighter-vote-token`. It is purpose-scoped to this feature.
- The server stores only `SHA-256("prnews-lighter-vote:" + token)` (domain-separated,
  so the hash cannot be reused as any other feature's id). The raw token is never
  stored, logged, or echoed in any response.
- `lighter_votes` primary key `(token_hash, cache_key)` gives **one current vote per
  browser per exact take**: repeat submissions update the same row (idempotent, no
  double counts), a change moves it, a retract (`vote:'none'`) deletes it, and totals
  are derived `COUNT`s over rows — they can never go negative.
- The browser's own current vote is also kept in `localStorage`
  (`prnews-lighter-votes`, keyed by language, URL, and a digest of the displayed text)
  — but that is UI state only. It does not pretend to be server dedup: the server
  row is the record. Clearing browser storage makes that browser count as a new voter;
  the copy on `/stats` says so. Votes are per browser, **not unique people**.
- No email, IP address, cookie, account, user agent, or device fingerprint is read or
  stored by this feature, and no identity analytics is used. With browser storage
  blocked, voting fails honestly with the error copy and no request is sent.

## Exact-generation binding

A vote names only the article URL and language. The server (`POST /api/lighter-vote`,
`src/lighter-feedback.ts`) re-resolves the take the page can show right now: it loads
the stored article (`currentItem` view), computes the same `lighter-2` cache key the
generator uses (prompt version + URL + headline + excerpt + language), and requires a
stored text that still passes `valid()`. Anything else — no cache row, a hidden line
(including a clearly wrong-edition line), or a changed headline/excerpt — answers
`409 {"status":"gone"}` and writes nothing. So a future take never inherits a
predecessor's ratings: a new headline or excerpt is a new key with no votes.

## Server rules

- POST only; GET and HEAD answer `405` and never write. Page views write nothing.
- Same-origin closed like `/api/lighter`: `Origin` must equal the site origin (missing
  Origin fails closed), `X-PRNews-Action: lighter-vote`, `Sec-Fetch-Site` same-origin
  when present, JSON content type. Body capped at 1000 bytes; `url`, `lang` (`es|en`),
  `vote` (`up|down|none`), and `token` (UUID v4) are all validated as enums/shapes
  before any database work.
- **No AI anywhere in this feature.** Votes never call the model and never touch
  `lighter_stats`, `lighter_budget`, or the satire cache. The daily 1,000-call ceiling,
  the removed global 60/min and 2-in-flight generation limits, and all existing satire
  guards are untouched.
- Basic count-abuse guard, vote writes only: a global per-UTC-minute bucket
  (`lighter_vote_rate`, 60/min across everyone, no address stored — excess is refused
  before any write) and two short in-flight leases (`lighter_vote_inflight`, ~10 s,
  stale leases reclaimable). These are new tables for votes only; nothing is
  reinstated on the generation path.
- All SQL is bound parameters. The only strings ever rendered from this data on
  `/stats` are the take's own title/text and integer counts, HTML-escaped.

## `/stats` aggregate

The "Votos sobre las sátiras / Votes on satire takes" section on `/stats` is separate
from outbound clicks and from the satire generation ledger. It shows:

- Total up votes, total down votes, and the number of takes with at least one vote —
  counted from the deploy of this feature forward; no earlier votes are invented. A
  failed read says unavailable, never zero.
- "Most up-voted" and "Most down-voted" examples, **only for takes with at least
  `FEEDBACK_MIN_SAMPLE` (3) votes and a net score of that sign**, so one vote can never
  present a take as best or worst and a down-voted take never appears under
  most-up-voted. The copy labels the list subjective and not a definitive ranking. A
  take the current validity guard hides keeps its counted votes but is not displayed
  as an example.
- No identifiers: no token, hash, address, or per-person data is ever public.

## Migration

`migrations/0016_lighter_votes.sql` is purely additive: `lighter_votes`,
`lighter_vote_rate`, `lighter_vote_inflight`. No article, account, address, or
generation data changes; no seed or import replay; every statement is
`IF NOT EXISTS`/`INSERT OR IGNORE` and replay-safe. Apply it with
`npx wrangler d1 migrations apply prnews --remote` before the deploy that ships this
feature; the route fails closed (503/`gone`/unavailable) against a database without it.

## Tests

`test/lighter-feedback.test.ts` covers vote create/replay/change/retract, invalid
requests (method, origin, action, size, enums, token shape, unknown URL), non-current
generations, the rate and in-flight guards, aggregate reads with the minimum-sample
rule, missing-table unavailability, migration replay, the `/stats` section (including
that no identifier appears), the shared `satire=1` page, and the client script's
build/vote/change/retract behavior plus blocked-storage failure in both editions.
