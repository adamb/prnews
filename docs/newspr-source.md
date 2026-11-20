# news.pr source and the English→Spanish translation direction

Verified and implemented on **2026-11-19** from the isolated `sources/news-pr` branch. Every fact below was checked with real HTTP requests or unit tests from this checkout; live AI translation calls were not made from this environment (see *Verification status*).

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
- `src/sections.ts` — source-scoped exact-category map, inside the shared `classify()` (4th, optional `source` argument).
- `src/parse.ts` — feed `<category>` labels are stored on the item (`categories`), and `classify` receives the source.
- `src/current-item.ts` — render-time re-classification passes the stored categories + source, so a feed-category section is no longer overridden by a weaker keyword match. This was the exact pre-existing conflict: `currentItem` re-classified from URL/keywords only, silently discarding publisher categories at render time.
- `src/i18n.ts` — `Translation.target:'es'`, `validSpanishTranslation`, `needsSpanishTranslation`, and the Spanish-edition branch of `translated()`.
- `src/ingest.ts` — `translatePendingReverse` (bounded EN→ES queue) and the `newspr` exclusion in the ES→EN selection.
- `src/stats.ts` — the `/stats` queue history keeps its exact English-edition definition (`newspr` excluded there too).
- `src/frontpage.ts` — same-event clusters lead with the original publisher when news.pr's rewrite folds in; news.pr becomes the "También en" link. The shared thresholds (4 shared content words, 60%/85% overlap, 12-hour window) are untouched.
- `test/fixtures/newspr.xml` (+ `.headers` provenance) and `test/newspr.test.ts` (13 tests), plus the two mechanical count updates in `test/additional-sources.test.ts` and `test/ingest.test.ts`.

## Category map (exact feed labels → existing sections; no new sections)

`Energy & Grid → energia` · `Economy & Business → negocios` · `Justice & Public Safety → policiales` · `Sports → deportes` · `Culture & Events → entretenimiento` · `Education & Health → salud` · `Federal & Fiscal → politica`

Labels seen on the feed but deliberately **not** exact-mapped — `briefs`, `Environment & Climate`, `Infrastructure & Transport`, `Tourism & Travel`, `la isla que viene`, `general`, `More` — fall through to the shared keyword classifier, which picks the nearest existing bucket by content (`climate`/`tourism`/`infrastructure` keywords already exist there), with `otras` as the honest unmapped fallback. Case variants (`energy & grid` vs `Energy & Grid`) are folded by the existing `fold()`.

## English→Spanish translation direction (news.pr only)

The existing pipeline translates Spanish originals into English (96 per 15-minute run, ≥1 hour between retries, `translation_attempt` as the claim, `max_tokens` 4000, batches of 4). news.pr mirrors it in reverse, and only for news.pr:

- **Selection** is the shared `needsSpanishTranslation()` — the same cache-then-queue rule the renderer's `translated()` uses, so no page view or idle scan ever calls AI.
- **Storage** reuses the `articles.translation` column with a distinct direction marker (`target:'es'`); `originalTitle`/`originalSummary` keep the English original, so the archive trigger attaches it to the right revisions and the existing revision CASE in the upsert invalidates it when the publisher revises a story.
- **Validation** (`validSpanishTranslation`) rejects entries that are not marked `'es'`, do not match the current payload, copy the English headline through unchanged, or are not demonstrably Spanish (the same conservative `detectSpanish` signals the ingestion language detection uses).
- **Bounding:** batches of 4, a hard cap of **8 items per 15-minute run** (a full 30-item feed day drains in ~1 hour of runs) and ≥1 hour between retries. The Spanish→English queue and its 96 cap are unchanged, so the existing budget is not doubled; the added spend is exactly the new source's own ~25 items/day.
- **No inversion elsewhere:** sjds/nimb stay as-is (English editions show their originals; the Spanish edition shows them untranslated, as today). news.pr items never enter the English queue (`isEnglishSource`), and `needsTranslation` is false for them, so no redundant English translation is generated.
- No D1 migration is needed: the direction marker lives in the translation JSON, and both directions are mutually exclusive per row (news.pr is the only source that produces `target:'es'` rows).

## Deliberately unchanged limitations

- The same-event fold is intentionally conservative; AI rewrites with different wording will often not fold (that is reported as *not* detected, never forced).
- A cached Spanish translation of a news.pr story is searchable like any cached translation (the FTS columns named `title_en`/`summary_en` are direction-agnostic by design of the existing 0003 triggers); no search behavior was changed for this source.
- news.pr items ship no feed images; the existing bounded og:image recovery (4 attempts, then monogram) applies unchanged.
- The `translation_attempt` backoff and 8-per-run cap mean a first pull of a full 30-item feed needs ~4 runs to translate every item; until then the Spanish edition shows the English originals (the same honest pending behavior as the English edition).
- `/fuentes` shows the source registry-driven: name, language (`Inglés`), `RSS`, per-feed last success, and safe "Actualizando…" errors. No UI files were touched for this source.

## Verification status (truthful)

- Live feed verified with real HTTP on 2026-11-19 (see the fixture and its `.headers`).
- All 424 tests pass, including 13 new tests that cover category mapping, render-time re-classification, reverse-direction validation/selection, cluster priority, and a D1-backed queue test (bounded drain, reuse, prompt direction) using the mocked Workers AI shape.
- **Not done from here:** a live Workers AI call for the 5–10 sample translations, production deploy, and production D1 writes (blocked until the parent grants the release slot). The queue test's model output is a mock, not live output; live sample translations must be checked after deploy, within the cap above.
