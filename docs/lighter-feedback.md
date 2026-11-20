# Satire feedback (👍/👎) — 2026-11-20

Anonymous reader votes on a displayed satire take. Read `README.md` and `AGENTS.md`
first. This note documents the feedback feature; the satire generator itself is
documented in the README's "On-demand satire" section and is unchanged by this feature.
Voting is **feedback, not AI**: no vote ever calls the model, spends the satire budget,
or touches the generation ledger, and this feature adds nothing back to the generation
limits the operator removed.

## What the reader sees

Below a **successfully displayed** satire line — after "Mostrar sátira" paints it, or
on a shared `/story?id=N&satire=1` page that opens with the line — two controls appear:
👍 and 👎 (`src/lighter-feedback.ts` `lighterFeedbackClientScript`). They never appear
for a failed, exhausted, hidden, or missing take: they are added inside the
`.lighter-note` only while the line is on the page, and every hide/fail/wait/done path
rewrites that note, which removes them with it. The server never ships vote-control
markup; the client builds it with DOM APIs and `textContent` only (no `innerHTML`).
The copy is fully bilingual (Spanish and English editions).

- Both editions: aria-labels are localized ("Me gusta esta sátira" /
  "I like this satire", "No me gusta esta sátira" / "I dislike this satire"), the
  pressed state is `aria-pressed`, buttons are real `<button type="button">` (keyboard
  operable), and a status line announces success ("¡Gracias por tu voto!" /
  "Thanks for your vote!"), retraction ("Tu voto se retiró." / "Your vote was removed."),
  failure, or a stale take in the note's existing polite live region.
- Pressing the other control changes the vote; pressing the pressed control retracts
  it. Both buttons are disabled while a submission is in flight.
- The button tooltip discloses the mechanism honestly: an anonymous per-browser vote.

## Identity, dedup, and change/retract

- Each browser generates one random UUID (`crypto.randomUUID`), kept in
  `localStorage` as `prnews-lighter-vote-token`. It is purpose-scoped to this feature.
- The server stores only `SHA-256("prnews-lighter-vote:" + token)` (domain-separated,
  so the hash cannot be reused as any other feature's id). The raw token is never
  stored, logged, or echoed in any response.
- `lighter_votes` primary key `(token_hash, cache_key, take_hash)` gives **one current
  vote per browser per exact displayed generation**: repeat submissions update the same
  row (idempotent, no double counts), a change moves it, a retract (`vote:'none'`)
  deletes it, and totals are derived `COUNT`s over rows — they can never go negative.
- The browser's own current vote is also kept in `localStorage`
  (`prnews-lighter-votes`, keyed by language, URL, and a digest of the displayed text)
  — but that is UI state only. It does not pretend to be server dedup: the server
  row is the record. Clearing browser storage makes that browser count as a new voter;
  the copy on `/stats` says so. Votes are per browser, **not unique people**.
- No email, IP address, cookie, account, user agent, or device fingerprint is read or
  stored by this feature, and no identity analytics is used. With browser storage
  blocked, or without `crypto.subtle` to hash the displayed text, voting fails
  honestly with the error copy and no request is sent.

## Exact-generation binding (the text, not just the key)

A vote names the article URL, the language, and `take`: the SHA-256 of the **exact
displayed text** (`SHA-256("prnews-lighter-take:" + trimmed text)`, computed in the
browser over the line it is showing). The server (`POST /api/lighter-vote`,
`src/lighter-feedback.ts`) re-resolves the take the page can show right now: it loads
the stored article (`currentItem` view), computes the same `lighter-2` cache key the
generator uses (prompt version + URL + headline + excerpt + language), and requires a
stored text that still passes `valid()`. It then compares the client's hash with the
hash of the currently stored text. Three outcomes, none of them a write:

- No cache row, a hidden line (including a clearly wrong-edition line), or a changed
  headline/excerpt → `409 {"status":"gone"}`.
- The browser shows a different text than the one stored now → `409 {"status":"stale"}`.
  This is the regenerated-take case: the cache key alone cannot distinguish it, because
  a clearly wrong-edition line is cleared on the next explicit request and the same key
  can then store a new, different text. A stale client is told to reopen the satire
  instead of silently rating the replacement.
- Otherwise the vote is stored with that exact `take_hash`, so it can never be
  reassigned to a different text under the same key.

A future take never inherits a predecessor's ratings: a new headline or excerpt is a
new key, and a regenerated text under the same key is a new `take_hash`.

**Honest history.** When a take is replaced, the old text's votes stay in the ledger,
still bound to the old text. The `/stats` up/down totals count every stored vote
(each row is one browser's current vote on one exact generation), while the
rated-take count and the most/least up-voted examples count only votes whose
`take_hash` matches the currently stored text. Nothing is deleted, reassigned,
or invented. A browser that voted on a replaced text cannot retract that row after
the fact (a stale retract is rejected like any stale request); the row simply remains
as history.

## Server rules

- POST only; GET and HEAD answer `405` and never write. Page views write nothing.
- Same-origin closed like `/api/lighter`: `Origin` must equal the site origin (missing
  Origin fails closed), `X-PRNews-Action: lighter-vote`, `Sec-Fetch-Site` same-origin
  when present, JSON content type. Body capped at 1000 bytes; `url`, `lang` (`es|en`),
  `vote` (`up|down|none`), `token` (UUID v4), and `take` (64-hex SHA-256) are all
  validated as enums/shapes before any database work.
- **No AI anywhere in this feature.** Votes never call the model and never touch
  `lighter_stats`, `lighter_budget`, or the satire cache. The daily 1,000-call ceiling,
  the removed global 60/min and 2-in-flight generation limits, and all existing satire
  guards are untouched.
- The single count-abuse guard, vote writes only: a global per-UTC-minute bucket
  (`lighter_vote_rate`, 60/min across everyone, no address stored — excess is refused
  before any write). A vote is one small D1 write, so this generous bucket bounds flood
  writes without refusing real readers; there is deliberately **no in-flight lease or
  concurrency cap** — unlike a model call, a vote write is cheap, and a global
  in-flight cap of two would refuse honest concurrent voters for no cost benefit.
  Stale and `gone` requests are rejected before the bucket, so they never consume it.
- All SQL is bound parameters. The only strings ever rendered from this data on
  `/stats` are the take's own title/text and integer counts, HTML-escaped.

## `/stats` aggregate

The "Votos sobre las sátiras / Votes on satire takes" section on `/stats` is separate
from outbound clicks and from the satire generation ledger. It shows:

- Total up votes, total down votes, and the number of takes with at least one vote
  bound to the current text — counted from the deploy of this feature forward; no
  earlier votes are invented. A failed read says unavailable, never zero.
- "Most up-voted" and "Most down-voted" examples, **only for takes with at least
  `FEEDBACK_MIN_SAMPLE` (3) votes bound to the current text and a net score of that
  sign**, so one vote can never present a take as best or worst and a down-voted take
  never appears under most-up-voted. The copy labels the list subjective and not a
  definitive ranking. A take the current validity guard hides keeps its counted votes
  but is not displayed as an example.
- No identifiers: no token, hash, address, or per-person data is ever public.

## Migration

`migrations/0016_lighter_votes.sql` is purely additive: `lighter_votes` (with the
`take_hash` binding column and the `(token_hash, cache_key, take_hash)` primary key)
and `lighter_vote_rate`. No article, account, address, or generation data changes; no
seed or import replay; every statement is `IF NOT EXISTS` and replay-safe. It was
reviewed and edited **before its first application** (it was still pending on
production when the exact-text binding was added). Apply it with
`npx wrangler d1 migrations apply prnews --remote` before the deploy that ships this
feature; the route fails closed (503/`gone`/`stale`/unavailable) against a database
without it.

## Tests

`test/lighter-feedback.test.ts` covers vote create/replay/change/retract, invalid
requests (method, origin, action, size, enums, token and take-hash shapes, unknown
URL), non-current generations, the exact-text binding (a regenerated take under the
same key inherits no ratings, stale up/down/retract are rejected, historical totals
stay counted), the per-minute guard, aggregate reads with the minimum-sample rule and
current-text binding, missing-table unavailability, migration replay, the `/stats`
section (including that no identifier appears), the shared `satire=1` page, and the
client script's build/vote/change/retract behavior plus blocked-storage, missing-
`crypto.subtle`, and stale-response handling in both editions.
