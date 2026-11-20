# One-time Reddit image repair pulled through Roux (2026-11-19/20)

Operational note — no code behavior changed; this documents a one-time bounded
repair and the script that performs it.

## Why

The deployed bounded Arctic image repair (`src/reddit-repair.ts`) stays quiet
while the feed scan is in 429 backoff, and Arctic Shift kept answering the
Worker's requests with HTTP 429 (9 consecutive failures recorded at
2026-11-19 23:45Z, next check 2026-11-20 03:45Z). An ordinary HTTPS request for
the same documented newest-100 endpoint answered HTTP 200 from Roux (Adam's dev
machine), i.e. the block depends on egress, not on the request. With the user's
explicit authorization, one bounded pull was made from Roux to repair already
stored Reddit rows — not to bypass, rotate, or schedule anything.

## What ran

- `curl -H 'User-Agent: news.dev.pr/1.0 (+https://news.dev.pr/about)'`
  `'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=PuertoRico&sort=desc&limit=100'`
  — exactly one request, HTTP 200, ~455 KB. The response was saved locally and
  is the only input the script accepts.
- `npx tsx scripts/repair-reddit-images-roux.ts <saved-response.json> --apply`

The script never fetches; it only consumes the saved response. Dry run is the
default, writes are guarded, idempotent, and bounded to 200 rows: it pairs
existing `reddit_puertorico` rows by canonical post ID, parses each post with
the deployed `parseArcticPost`/`safeUrl` validators, and changes only
`payload.$.image` — and only when the stored image is empty or a demonstrably
obsolete 140px `preview.redd.it` thumbnail and the Arctic record yields a fresh
valid photo. Rows matched against records without any photo are only marked in
the bounded `arctic_image_repair` ledger (the same terminal the scheduled
repair records), so no photo is ever invented for text posts, deleted posts, or
invalid assets. Rows outside the single pull window remain for the scheduled
repair once backoff lifts.

## Result recorded

- Before: 155 Reddit rows in the 14-day window, 105 with no image, 7 with a
  tiny 140px thumbnail, 50 with an image.
- Plans: 23 set, 0 thumbnail upgrades, 22 photo-less terminal marks, 110 rows
  outside the pull window.
- Applied: 23 payload repairs (0 concurrent guard misses, 22 terminal ledger
  marks). After: 82 no image, 73 with an image. Titles, summaries, saved
  translations, published times, sources, and retention untouched by
  construction (the guarded UPDATE pins exact stored title and summary).
- The existing D1 triggers added 23 `archive_revisions` rows and queued the 23
  new image URLs for the permanent R2 copy (still pending at the time of this
  note; ordinary scheduled copy batches, no manual handling).
- Representative byte checks before use: the repaired poster for the
  speeding-ticket video post `1xzopfo` and two `i.redd.it` photos returned real
  image bytes with matching magic numbers and image content types.
- Observation only: the successful pull came from a different egress (Roux)
  than the Worker's while the Worker stayed in 429 backoff. This was a one-time
  manual pull; it is not evidence a scheduled cron run recovered, it does not
  reset the feed's error state or backoff, and no cron, timer, credentials, or
  source code changed for it.

## Public verification

`/s/comunidad` in both editions, ordinary requests after the HTML cache could
have expired: 14 real image references each, including the repaired
speeding-ticket post's photo; the Royal Decree of Graces text post (in the pull
but verified to ship no photo) still renders its compact imageless card.
