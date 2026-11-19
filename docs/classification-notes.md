# Classification integration

`classify(url, categories, text)` keeps its signature and returns `{section, reason}`.
Pass original title plus original summary, not translations. Preserve source categories
when available. Explicit publisher section paths precede exact normalized categories;
bilingual keyword rules follow. Violence/traffic injury overrides incidental hospital
and road mentions within keyword classification; Microsoft/software outages take
business/technology precedence. Strong publisher routing remains authoritative.
Malformed URLs still allow text classification. Generic `agua`, `genera`, `muere`
and `muerte` no longer act as topic signals by themselves.

`sections` and `Section` retain all 13 legacy slugs and labels for route compatibility.
`navigationSections` supplies 10 display groups. **Apply `primarySection` to both
article sections and the requested section when selecting section-page articles,
and to article placement on the home page.** Merely hiding navigation links will
not consolidate content. Keep legacy routes working, either grouped in place or
redirected to the primary page while retaining language/query parameters.

| Primary slug | Includes | English label root should set |
| --- | --- | --- |
| comunidad | comunidad | Community |
| politica | politica | Government & Politics |
| negocios | negocios | Economy, Business & Technology |
| policiales | policiales | Safety & Justice |
| energia | energia, clima | Environment & Infrastructure |
| salud | salud, educacion | Health, Education & Society |
| deportes | deportes | Sports |
| entretenimiento | entretenimiento | Entertainment & Culture |
| mundo | mundo | United States & World |
| otras | otras, opinion | Other & Opinion |

The last group openly includes opinion and unresolved articles. Opinion is still
classified separately and should retain its article badge; consolidation does not
count as classifier improvement. Unknown strings pass through `primarySection`.
Reddit stays in Community; classify topic cross-listings separately if desired.
Root must apply the same primary mapping to Reddit cross-listings. Preserve known
manual-import sections rather than reclassifying them.

## Measured before/after

Measured November 14, 2026 against the unmodified saved sources and payload.
Baseline is the original classifier from this task, not stored section labels.
Saved-feed run uses `sources[*].files`, `parseFeed` with original categories,
titles and summaries, timestamp `2026-11-14T04:30:00Z`, deduplicated by canonical
URL (last occurrence wins). Both versions retain 25 Reddit items in Community.
Snapshot run uses the 355 `src/data.json` items, original title + summary + URL,
empty categories because the payload does not retain them. Counts below precede
primary-section consolidation.

| Section | Feeds before | Feeds after | Snapshot before | Snapshot after |
| --- | ---: | ---: | ---: | ---: |
| comunidad | 25 | 25 | 25 | 25 |
| politica | 41 | 47 | 38 | 49 |
| negocios | 23 | 36 | 23 | 36 |
| policiales | 38 | 59 | 38 | 60 |
| energia | 14 | 23 | 15 | 25 |
| salud | 1 | 10 | 1 | 10 |
| educacion | 3 | 2 | 3 | 3 |
| clima | 5 | 6 | 5 | 6 |
| deportes | 25 | 26 | 23 | 26 |
| entretenimiento | 50 | 59 | 50 | 59 |
| mundo | 36 | 40 | 29 | 35 |
| opinion | 18 | 18 | 17 | 17 |
| otras | 76 | 4 | 88 | 4 |

True fallback reduction: **72/76 (94.7%) in saved feeds**, **84/88 (95.5%) in
snapshot reclassification**. The reported 137 does not reproduce with these
355-item inputs; no fixtures or payloads were changed to manufacture that result.
After grouping opinion, the displayed Other & Opinion contains 22 saved-feed
articles or 21 snapshot articles; it is not a four-article display group.

Faithful example mappings:

- “Hieren de bala a un hombre en Guánica” → policiales, including hospital summaries.
- “Motociclista muere arrollado en Canóvanas” → policiales, not road infrastructure.
- “Falla de Outlook y Microsoft 365…” and “CESCO y AutoExpreso continúan operando pese a situación con Microsoft” → negocios.
- “Santurce defeats Carolina to stay alive in BSNF quarterfinals” → deportes.
- “Nasdaq, S&P 500 futures fall…” → negocios.
- “Vivir con dermatitis atópica…” → salud.
- “Island trombonist-conductor to gift Pan-American panoply of sound” → entretenimiento.
- “House speaker proposes sweeping overhaul of Agriculture Dept.” → politica.
- “Pope Leo XIV goes home…” → mundo.

Four honest fallbacks remain: the Coast Guard migrant repatriation report, two
Starship visibility reports, and Legal Notices. Their topic taxonomy needs an
editorial decision; no catch-all politics rule was added for them. These rules
are heuristics, not a semantic model: publisher paths/categories can be imperfect,
and multi-topic stories may still need manual editorial assignment.

## Sports court, shooting, and defend

Checked against production D1 on 2026-11-19 (`changed_db: false`). San Juan Daily Star
“Pollitas defend home court; Manatí holds off Caguas to go up 2-0”
(`https://www.sanjuandailystar.com/post/pollitas-defend-home-court-manat%C3%AD-holds-off-caguas-to-go-up-2-0/`)
is stored as `deportes` / `category`. The feed category `Sports` wins at ingest.
The public URL is `/post/…`, not `/sports/`. Render does not keep categories.
`currentItem` calls `classify(url, [], title + " " + summary)` for every article
except Reddit and `manual-import`.

Before this change, that path matched only `court` inside “home court”, so the
title alone was `policiales`. The stored summary also matches `bsnf`. Those two
scores tie, and the first section with the high score wins, which was `policiales`.

A game recap now returns `deportes` when the text has a bounded sports signal
(home court, defend home court, defiende(n)/defendió/defendieron su cancha, a
points-and-rebounds line, or a shooting-guard / three-point shooting phrase)
and no legal-case or violence signal. Bare `shooting` stays violence. Bare
`cancha` does not, because an assault can happen on a residential court. Bare
`bsnf` stays a normal keyword, so a tie with politics is unchanged. A charge,
arrest, tribunal, or “in court” still beats a box score, including when the
person plays basketball. Publisher paths and feed categories stay ahead of this
rule. `Sports` on a crime headline is still `deportes` at ingest and is
reclassified from the text at render.

Integration review: accents are folded before matching, so the Spanish forms
are `defiende`, `defienden`, `defendio`, and `defendieron`. The first pattern,
`defiend(?:e|en|eron|o|io)`, did not match `defendieron` or `defendió`. A
sentence that also had a points-and-rebounds line could still look correct.
A `Business` category still wins over the recap text. No database rewrite and
`scripts/repair-live.ts` was not run.

Section pages, the front page, lighter stats, and any source comparison use
that same `currentItem` result, then `primarySection`. `payload.section` is the
ingest result and is not a second predicate. This story’s stored row already
matches the corrected section, so no database rewrite is required. `scripts/repair-live.ts`
rewrites every drifted payload and was not run.

## Validation

Added 20 regression cases in `test/classification.test.ts`: bilingual topics,
shooting/hospital and hit-and-run/road precedence, software versus power outages,
false positive boundaries, publisher metadata precedence, legacy compatibility,
and idempotent primary grouping. `npx tsc --noEmit` passed; `npx vitest run` passed
12 files / 84 tests. `npx wrangler deploy --dry-run --outdir /tmp/prnews-classification-build`
passed. Commands deliberately bypass seed scripts to avoid writing files owned by
root. No deploy, commits, or fixture changes.
