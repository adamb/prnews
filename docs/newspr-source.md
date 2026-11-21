# news.pr source and the English→Spanish translation direction

Verified and implemented on **2026-11-19** from the isolated `sources/news-pr` branch, then integrated with the review fixes (PR #24) and the follow-up scoping review. Every fact below was checked with real HTTP requests or unit tests from an isolated checkout; the bounded live translation samples were made with exactly 2 Workers AI batch calls (see *Verification status* and [newspr-translation-samples.md](newspr-translation-samples.md)).

## Source

| | |
|---|---|
| Publisher | news.pr — English-language Puerto Rico newspaper ("Puerto Rico, reported daily") |
| Feed | `https://news.pr/rss.xml` (public RSS 2.0; HTTP 200, `application/rss+xml`, ~16 KB, 30 items at capture) |
| Never used | `https://news.pr/feed` — the subscriber-gated reader page (HTML), not a feed |
| Cadence | Default 15-minute poll (the shared cron), 14-day retention, normal canonical-URL upsert; `~22 items/day` measured across the capture window (oldest 2026-11-18 14:08Z, newest 2026-11-19 22:32Z) — consistent with the ~20–30/day expectation |
| Item shape | `title`, `link` = `https://news.pr/story/<id>`, `pubDate`, `dc:creator` byline, `<category>` label, short `description` (≤300 chars). GUIDs look like `news-pr:<story-id>:v1` |
| Identity | Upsert is by **canonical story URL**, never by GUID: a `:v2` revision of the same story rewrites the existing row (payload changes clear the cached translation), it cannot create a duplicate row. This is the existing pipeline behavior, unchanged |
| AI-written | The publisher's own pages do not state "AI-written" in extractable metadata, so the site does not label it beyond the facts: `/fuentes` shows news.pr as an English RSS source with its own last-success status |

The publisher also serves its own Spanish edition at `/rss.xml?lang=es` (same GUIDs, `?lang=es` links). It is **not** ingested: those links would be separate canonical URLs and duplicate every story. The English feed is the single ingested original, as the task specified.

## Files (the registry change is intentionally small)

- `src/additional-sources.ts` — the registry entry and feed URL (`sources`/`ingest` already merge it).
- `src/sources.ts` — `isEnglishSource` includes `newspr` (English by default), plus the shared `newsprSource` constant.
- `src/sections.ts` — source-scoped exact-category map, inside the shared `classify()` (4th, optional `source` argument; the normalization only applies to `newspr`).
- `src/parse.ts` — `classify` receives the source, and news.pr's feed `<category>` labels are stored on the item (`categories`). **Scoped to news.pr only:** every other source's stored payload keeps its exact current shape, and ingest-time classification still receives the feed's raw categories exactly as before this source existed.
- `src/current-item.ts` — render-time re-classification passes the stored categories + source **for news.pr only**, so a feed-category section is reproduced instead of being overridden by a weaker keyword match. Every other source keeps the existing behavior exactly (re-classification from URL and keywords only); a test pins all ~430 non-newspr fixture items to that behavior, including Radio Isla's flu report, which the news.pr-scoped fix keeps rendering under its keyword section.
- `src/i18n.ts` — `Translation.target:'es'`, `validSpanishTranslation`, `needsSpanishTranslation`, and the Spanish-edition branch of `translated()`. A reverse (`target:'es'`) entry is never accepted as an English translation, and a Spanish-detected news.pr payload belongs to the Spanish→English queue only, so the two directions are mutually exclusive per row.
- `src/ingest.ts` — `translatePendingReverse` (bounded EN→ES queue) and the `newspr` exclusion in the ES→EN selection.
- `src/stats.ts` — the `/stats` queue history keeps its exact English-edition definition (`newspr` excluded there too).
- `src/frontpage.ts` — same-event clusters lead with the original publisher when news.pr's rewrite folds in; news.pr becomes the "También en" link. The shared thresholds (4 shared content words, 60%/85% overlap, 12-hour window) are untouched.
- `test/fixtures/newspr.xml` (+ `.headers` provenance) and `test/newspr.test.ts` (18 tests, including the review-fix regressions and the other-source scope guard), plus the two mechanical count updates in `test/additional-sources.test.ts` and `test/ingest.test.ts`.

## Category map (exact feed labels → existing sections; no new sections)

`Energy & Grid → energia` · `Economy & Business → negocios` · `Justice & Public Safety → policiales` · `Sports → deportes` · `Culture & Events → entretenimiento` · `Education & Health → salud` · `Federal & Fiscal → politica`

Labels seen on the feed but deliberately **not** exact-mapped — `briefs`, `Environment & Climate`, `Infrastructure & Transport`, `Tourism & Travel`, `la isla que viene`, `general`, `More` — fall through to the shared keyword classifier, which picks the nearest existing bucket by content (`climate`/`tourism`/`infrastructure` keywords already exist there), with `otras` as the honest unmapped fallback. Case variants (`energy & grid` vs `Energy & Grid`) are folded by the existing `fold()`.

## English→Spanish translation direction (news.pr at introduction, 2026-11-19; generalized to every English-origin source on 2026-11-21)

The existing pipeline translates Spanish originals into English (96 per 15-minute run, ≥1 hour between retries, `translation_attempt` as the claim, `max_tokens` 4000, batches of 4). The reverse direction mirrors it in reverse: news.pr introduced it (2026-11-19), and since 2026-11-21 every English-origin item uses it:

- **Selection** is the shared `needsSpanishTranslation()` — the same cache-then-queue rule the renderer's `translated()` uses, so no page view or idle scan ever calls AI.
- **Storage** reuses the `articles.translation` column with a distinct direction marker (`target:'es'`); `originalTitle`/`originalSummary` keep the English original, so the archive trigger attaches it to the right revisions and the existing revision CASE in the upsert invalidates it when the publisher revises a story.
- **Validation** (`validSpanishTranslation`) rejects entries that are not marked `'es'`, do not match the current payload, copy the English headline through unchanged, or are not demonstrably Spanish (the same conservative `detectSpanish` signals the ingestion language detection uses).
- **Bounding:** batches of 4, a hard cap of **8 items per 15-minute run** (a full 30-item feed day drains in ~1 hour of runs) and ≥1 hour between retries of the same item. The Spanish→English queue and its 96-per-run cap are unchanged, so the existing budget is not doubled.
- **Cost is not a guaranteed daily spend.** The queue only calls the model while items are pending. At the measured ~25 items/day, healthy operation is roughly 7 batch calls a day — an added cost that tracks the source's own volume, not a fixed allowance. Rejected results (failed validation, nothing stored) keep their item pending, and the per-item 1-hour retry backoff with the 8-per-run cap then multiplies calls: a small set of stuck items (≤8) is retried together about once an hour (~2 calls/hour, ~48 model calls/day), and a persistently rejected full day's feed (~25–30 items, every item eligible again each hour) can reach ~8 calls/hour (~190 calls/day) until the items stop being pending. No separate daily call ceiling exists for this queue and none was added; the numbers here are measured mechanics, not a promoted budget.
- **No inversion elsewhere (as introduced):** sjds/nimb stayed as-is at introduction (English editions showed their originals; the Spanish edition showed them untranslated). See the 2026-11-21 generalization below for how that scope widened. news.pr items never enter the English queue (`isEnglishSource`), and `needsTranslation` is false for them, so no redundant English translation is generated.

**2026-11-21 generalization.** The same mechanism now serves *every* English-origin item, decided by the shared `isEnglishItem` rule — source default (`sjds`/`nimb`/`newspr`/`pasquines`) or a per-article English signal — not by the source name alone. A demonstrably Spanish payload from any of those feeds is never inverted and stays in the shared Spanish→English queue, so the two directions remain mutually exclusive per row. Mechanics are unchanged from the list above (8 items per 15-minute run, batches of 4, 1-hour retry backoff): the selection SQL in `translatePendingReverse` now mirrors `isEnglishItem`, the run cap is shared across the English sources with round-robin fairness so one backlog or a stuck retry cannot starve another source, and an original with an empty excerpt (NIMB manual imports) is stored title-only — the reverse prompt forbids inventing summary text and the validator rejects a cached summary the original never shipped. The renderer's `translated()`, the ticker, cards, story pages, `'es'` keyword alerts and the digest all read the same cache, and the English edition is untouched (English-origin rows were never `needsTranslation`-pending and a `target:'es'` row can never serve as an English translation). The validation also accepts `currentItem`'s deterministic NIMB manual-import slug-title correction as the same original so a stored translation still renders on corrected titles.
- No D1 migration is needed: the direction marker lives in the translation JSON, and both directions are mutually exclusive per row (English-origin items are the only ones that produce `target:'es'` rows).

## Deliberately unchanged limitations

- The same-event fold is intentionally conservative; AI rewrites with different wording will often not fold (that is reported as *not* detected, never forced).
- A cached Spanish translation of a news.pr story is searchable like any cached translation (the FTS columns named `title_en`/`summary_en` are direction-agnostic by design of the existing 0003 triggers); no search behavior was changed for this source.
- news.pr items ship no feed images; the existing bounded og:image recovery (4 attempts, then monogram) applies unchanged.
- The `translation_attempt` backoff and 8-per-run cap mean a first pull of a full 30-item feed needs ~4 runs to translate every item; until then the Spanish edition shows the English originals (the same honest pending behavior as the English edition).
- `/fuentes` shows the source registry-driven: name, language (`Inglés`), `RSS`, per-feed last success, and safe "Actualizando…" errors. No UI files were touched for this source.

## Verification status (truthful)

- Live feed verified with real HTTP on 2026-11-19 (see the fixture and its `.headers`).
- All 436 tests pass (36 files), including the news.pr tests that cover category mapping, news.pr-scoped render re-classification plus the other-source scope guard (~430 fixtures pinned to the exact pre-news.pr behavior), reverse-direction validation/selection, cluster priority, and a D1-backed queue test (bounded drain, reuse, prompt direction) using the mocked Workers AI shape.
- **Live translation samples were made** (bounded: exactly 2 batch calls, 8 feed items, the production model/prompt/shape via `scripts/newspr-verify.ts`): 8/8 passed the worker's own `validSpanishTranslation()`. The reviewed originals and translations, with manual review notes, are in [newspr-translation-samples.md](newspr-translation-samples.md). Nothing was stored and no production D1 writes were made for the samples.
- Production deploy and post-deploy verification are recorded in [releases.md](releases.md) (the release slot was owned by the alert owner-notification release until it shipped).
