# Releases

## 2026-11-18 — WAPA image rate limits retry on the next run

- Deployed source: 3b4a4ae7d84a9699b5ce955d76c5eb0588e15757. This notes commit is later and was not deployed.
- Cloudflare Worker version: 8ad3cc6f-059b-4445-87df-8e6a6086e307 (version created 2026-11-18 21:48:46 UTC, deployment created 2026-11-18 21:48:46 UTC, 100%). Fast-forward of https://github.com/adamb/prnews/pull/6 onto main (`638543f..3b4a4ae`). Remote main matched 3b4a4ae before `npx wrangler deploy`. OAuth session used; no token printed. No migration. The 12-page / 15-minute cap, newest-per-source order, metadata-only lookup, feed-image precedence, and R2 copy rules were not changed.
- A page with no `og:image` still uses the hour-scale backoff and stops after 4 attempts. A `429` or `503` keeps that attempt cap but waits 15 minutes, or `Retry-After` when that falls between 15 and 60 minutes. Rows already parked longer than 60 minutes for those statuses are eligible on the next run.
- The reported card is WAPA, “Jennifer Barreto nos cuenta algunos retos que enfrentó en su juventud”, https://wapa.tv/programas/losetodo/jennifer-barreto-nos-cuenta-algunos-retos-que-enfrent-en-su-juventud/article_8f47299f-242f-4d6a-a701-c3c4d082758c.html, `pubDate` Wed, 18 Nov 2026 16:48 -0400. The live RSS item has title, description, and link, and no `enclosure`. The article HTML has `og:image` and `twitter:image` for `…/75f7b84f-2430-5454-9ab6-4969ab193cb4/6afe1078083c6.image.png`. Before the fix the payload image was empty and `image_enrich_queue` had attempts 1, error `Article page unavailable or not HTML (429, text/plain)`, `next_attempt` 2026-11-18 23:00:15 UTC.
- The 22:00 UTC cron, on the new worker, stored that `og:image` and removed the queue row. `archive_images` saved it at 2026-11-18 22:00:14 UTC as `images/ac53d31ce3e081f5e8b25030131c54bbdf742551edb91bfb7ed8404c0b4f5e76`, `image/png`, 596710 bytes. The same byte count and PNG signature came back from the publisher URL and from `GET /archive/images/ac53d31ce3e081f5e8b25030131c54bbdf742551edb91bfb7ed8404c0b4f5e76` (`content-type: image/png`, `content-length: 596710`). No `GET /click`.
- `GET /?lang=es` at 2026-11-18 22:04:03 UTC returned 200, `cache-control: public, max-age=60`, and that card’s `img src` was the publisher PNG. The `onerror` handler still names `/fallback.svg`. WAPA articles with an empty image: 0.
- The same 429 backlog also included three other WAPA URLs. Two already had `og:image` URLs before this deploy, after their earlier wait elapsed. The fianza story was still parked and received its own page `og:image` on the 22:00 run. One El Nuevo Día queue row remains, attempts 1, error `No usable og:image metadata from publisher`, for an article whose payload already has a feed image. That row is not selected while the image is present.
- Validation on 3b4a4ae, before deploy: `npm ci` reported 0 vulnerabilities. `npm test` was 31 files / 316 tests, then typecheck and a wrangler dry-run build (977.41 KiB / gzip 286.45 KiB).

## 2026-11-18 — Satire retry tells you when another press can run

- Deployed source: 25150ec81318127fb3b1a7a4626e4c8c308054bf. This notes commit is later and was not deployed.
- Cloudflare Worker version: a8e74fdf-32ff-4bc8-8507-46993474cb9b (version created 2026-11-18 12:25:27 UTC, deployment created 2026-11-18 12:25:27 UTC, 100%). Fast-forward of https://github.com/adamb/prnews/pull/5 onto main. Remote main matched 25150ec before `npx wrangler deploy`. OAuth session used; no token printed.
- HTML cache name is `prnews-html-v26`, so pages whose satire button still offered an immediate retry during a cooldown are not reused. On-demand cache version stays `lighter-2`. No migration. Daily cap, inflight leases, three attempts, 180 output tokens, and the 1-hour then 2-hour backoff were not changed. The cap was not reset and no cache row was purged.
- A failed attempt that still has tries left returns `cooldown` and `retry_after` seconds. The button stays disabled until that wait has elapsed, then says “Try again”. The third failure returns `exhausted` and does not offer another try. A stored line that is not clearly the requested edition is still withheld: a clearly wrong language is cleared on the next explicit request, and an ambiguous or otherwise invalid line stays stored and now returns `exhausted`. `budget` disables the button for the rest of the UTC day. `busy` and `rate` can still be tried again shortly. Responses do not include the model error, the attempt count, or the cache key. A nested sentence under `text` uses the same edition and safety checks.
- Validation on 25150ec, before deploy: `npm ci` reported 5 high findings already in the lockfile (vite, vitest, and their toolchain). The lockfile was not changed. `npm test` was 31 files / 313 tests, then typecheck and a wrangler dry-run build (975.64 KiB / gzip 286.07 KiB).
- The NotiCel article in the screenshot is https://noticel.com/noticias/20261118/junta-de-supervision-fiscal-exige-transparencia-al-gobierno/ (source noticel, published 2026-11-18 09:45:00 UTC, 5:45 AM AST, story id 2140). Before the live check its English `lighter-2` cell had no text, 1 attempt, and `next_try` 2026-11-18 12:57:32.563 UTC. There was no Spanish cell. Day 2026-11-18 had 19 of 24 model calls. The ledger had one English failure (all 36/0/34/33/1, en 33/0/31/30/1, es 3/0/3/3/0). Workers Logs are off, and the failure category is not stored, so the model’s first rejection is not recoverable. That cell is a cooldown, not a stored ambiguous line.
- Public curl after deploy, with no `GET /click`: `GET /story?id=2140&lang=en` returned 200 (`content-language: en`, no `cf-cache-status`). The page showed the English headline “Fiscal Supervision Board Demands Transparency from Government”, the button “Ask for a satire”, `data-lighter-lang="en"`, `data-cached="0"`, and that article URL. The inline script included “Try again later”, “Not available today”, and “Satire isn't available for this story.” and did not include `innerHTML`. `GET /?lang=en` returned 200 with `cache-control: public, max-age=60` and the same script strings; that headline was only in the most-read list. `GET /api/lighter` returned 405 `{"status":"method"}`.
- One production `POST /api/lighter` at 2026-11-18 12:26:45 UTC, English, a new action id, same-origin headers. It returned 200 `{"status":"cooldown","retry_after":1848}` with `cache-control: no-store`. 1848 seconds is the remaining wait until 12:57:32.563 UTC, rounded up. A read-only select afterward showed the same cell (no text, 1 attempt, the same `next_try`), budget still 19, failures still 1, and attempt counts still 31 English / 34 combined. Interactions rose by one (en 34, all 37), which is that press. Each select reported `changed_db: false` and `rows_written: 0`. The model was not called. The next press after 12:57:32 UTC can try once more and would spend one of the five remaining calls. This check did not make that call.

## 2026-11-17 — Satire language match and catalog removal

- Deployed source: 1d052f0753bb73fbdec24277776c21dabdfa42a1. This notes commit is later and was not deployed.
- Cloudflare Worker version: 360ad6aa-658f-422e-a06e-b8c5c415f7fb (created 2026-11-17 19:49:52 UTC). Fast-forward of https://github.com/adamb/prnews/pull/4 onto main. That revision includes the edition gate (276db40) and the reviewed ClasificadosOnline catalog removal (da36726, merged as d190b7d). Remote main matched 1d052f0 before `npx wrangler deploy`. OAuth session used; no token printed.
- HTML cache name is `prnews-html-v25`, so pages that still clamped the satire note or still included the catalog aside are not reused. On-demand cache version stays `lighter-2`. A stored sentence is served only when it matches the requested edition. A cell whose text is clearly the other edition is cleared on the next explicit request for that key, and that request may then generate. Ambiguous text is withheld and left in place. Good rows and lighter-1 rows were not deleted. The daily cap was not reset.
- ClasificadosOnline sale and rent links, the catalog aside, `propertyListings`, and the `.listings` CSS are gone. Bienes raíces news, navigation, and classification stay.
- Validation on 1d052f0, before deploy: `npm ci` reported 5 high findings already in the lockfile (vite, vitest, picomatch, tinyglobby, and fdir, all in the Vitest/Vite toolchain, not the Worker runtime). The lockfile was not changed and those packages were not updated. `npm test` was 30 files / 307 tests, then typecheck and a wrangler dry-run build.
- Public curl of `/s/bienes-raices` in Spanish and English at 19:52:44 UTC, then again at 19:54:12 UTC, after the 60-second `max-age`. Both editions returned 200 both times (`content-language` es and en). The second pair had new `cf-ray` values. Neither response included `cf-cache-status` or `Age`. Catalog strings were absent both times: clasificadosonline, RealEstate.asp, Rentals.asp, “Anuncios de propiedades”, “Property listings”, the sale and rent anchors, and `class="listings"`. Both pages still linked the section, still had the satire-note unclamp rule, and still showed the Río Grande mansion story. Spanish title “Bienes raíces”; English title “Real Estate”. No `<aside>`.
- Two production `POST /api/lighter` calls for the WIPR PRITS Academy article, English at 19:55:05 UTC and Spanish at 19:55:07 UTC. Each used a new action id. Same-origin headers only. No `GET /click` and no email. English returned “Bureaucrats are now learning to innovate, because that's exactly what they needed, more training.” Spanish returned “PRITS Academy busca convertir a los servidores públicos en expertos en tecnología para que puedan perder sus contraseñas de manera más eficiente.” The project `sentenceEdition` helper classified them as en and es. Both responses were `Cache-Control: no-store`. The previous Spanish sentence stored under the English key for that article is gone. The Spanish public-employee line, the English governor line, and the English symposium line were still stored. The unrequested Beckham English-key row was left as it was.
- Immediately after those two calls the read-only ledger was day 2026-11-17, calls 7 of 24 (it had been 5). Stats were all 7/0/7/7/0 and es 2/0/2/2/0 and en 5/0/5/5/0 (interactions, cache hits, attempts, generations, failures). `lighter_cache` was 18 rows, 15 with text. Both selects reported `changed_db: false` and `rows_written: 0`. A later read showed the counter still rising from other English requests (12 calls, 12 actions, English generations 10, Spanish still 2). The two PRITS rows were unchanged. Those later calls were not part of this check.

## 2026-11-17 — On-demand satire and lighter stats

- Deployed source: 5bbcff1c0245884698e0adbab3bbc8c0af0240a1. This notes commit is later and was not deployed.
- Cloudflare Worker version: 22419e8d-f0af-437c-95bc-10634cf3e2b6.
- Fast-forward of https://github.com/adamb/prnews/pull/3 onto main after the Bienes raíces release (source bd568c7ad13d78765981c3aaa848e0c92cc0904e, Worker faa154ee-17b0-41ac-8ecc-565744140eeb). Remote main matched 5bbcff1 before `npx wrangler deploy`. OAuth session used; no token printed. https://github.com/adamb/prnews/pull/1 is included in that history and was not deployed on its own.
- Bienes raíces classifier, catalog, styles, and navigation stayed: top tabs remain política, negocios, and policiales; Bienes raíces stays in the more menu. ClasificadosOnline sale and rent stay raw external hrefs on `/s/bienes-raices` only.
- HTML cache name is `prnews-html-v24`, so the previous `prnews-html-v21` pages (catalog, no satire button) are not reused. On-demand cache version is `lighter-2`.
- Validation on 5bbcff1: `npm ci` (zero vulnerabilities), 29 files / 300 tests, typecheck, and wrangler dry-run build.
- Remote D1 journal had stopped at 0010 while `lighter_cache` (12 rows) and `lighter_slots` (6 rows) already existed. `0011_lighter.sql` was applied idempotently and left those rows in place. `0012_lighter_stats.sql` then added `lighter_stats`, `lighter_actions`, `lighter_budget`, `lighter_inflight` (2 rows), and `lighter_rate`. The ledger started at zero at 2026-11-17 10:31 AM AST. No lighter-1 generation backfill. Migrations 0001 and the seed/import scripts were not replayed.
- Public HTTP checks (curl, not a browser): `/` and `/s/bienes-raices` in Spanish and English returned 200; the homepage had 47 satire buttons; sale and rent catalog hrefs were present. `GET /api/lighter` returned 405.
- One production `POST /api/lighter` (Spanish, Metro public-employee training story) returned 200 with the line "Ahora los empleados públicos podrán aprender a proteger sus archivos de café virtual en la nube." The same action id returned that same JSON and did not spend a second model call. The homepage HTML did not contain the line. After the 60-second page cache, one card was `data-cached="1"` and 46 were `data-cached="0"`.
- Before that POST, combined, Spanish, and English stats were all zero since 10:31 AM AST. The public `/stats` page stayed at zero for about 60 seconds because the worker cache had stored the earlier HTML. After that window, combined and Spanish showed 1 button request, 0 cache hits, 1 attempt, 1 stored generation, and 0 failures. English stayed at zero. The D1 ledger matched. The click section did not gain those counts. Daily model use for this check: 1 of 24. No production `GET /click` and no email.

## 2026-11-17 — Bienes raíces section

- Deployed source: bd568c7ad13d78765981c3aaa848e0c92cc0904e.
- Cloudflare Worker version: faa154ee-17b0-41ac-8ecc-565744140eeb.
- Fast-forward of `t3/real-estate-section` onto main at 6faf0a3918eae930c4cd6122020833be6aad2307 (favicon monogram kept). GitHub PR https://github.com/adamb/prnews/pull/2 merged. Remote main SHA matched the deployed commit before `npx wrangler deploy`. OAuth session used; no token printed.
- Validation on that revision: `npm ci` (zero vulnerabilities), 283 tests, typecheck, and build dry-run. No second tree existed after the fast-forward.
- Public curl of `/s/bienes-raices` in Spanish and English, `/sitemap.xml`, `/story?id=138`, `/`, and `/favicon.svg`. More menu links the section; top tabs stay política, negocios, and policiales. ClasificadosOnline sale and rent links are raw external hrefs on that section only. The Río Grande story renders there. Sitemap lists both languages and not the catalog.
- Read-only D1 check: story_id 138 is the $27 million Río Grande mansion. Stored payload section remains `negocios` (`changed_db: false`). Render-time classification places it in Bienes raíces. No migration and no database reclassification.
- Not in this deploy: satire/stats PR 1. Release slot finished.

## 2026-11-17 — About credits and translations

- Deployed source: d1c17e3bd55e4ce911e512ae3eae66f0df47dd67.
- Cloudflare Worker version: 1e87d40c-0cb8-413d-a266-c2da7a8cc68f.
- Preserved reviewed dependency ea643ba5679bc585dc89f02f6ebf72019822d9e8.
- Coordinated fast-forward integration into unchanged main; feature branch and remote main SHA verified before manual Wrangler deployment.
- Validation: npm ci (zero vulnerabilities), 259 tests passed, typecheck, build and diff check; tests/typecheck/build repeated on the integrated revision.
- Public Spanish and English About pages fetched successfully with curl; verified development-tool and runtime-model link targets, 300-character statement, cached reuse and bounded retry copy. Python urllib was denied HTTP 403; curl succeeded.
- Copy-only release; no migrations. Original publisher links and excerpt limits preserved.

## 2026-11-17 — Alerts navigation, copyright and About measurements

- Deployed source: ab4c8baed06f9d2851185375adae0913f81bfb03.
- Cloudflare Worker version: f3083fb6-4d4c-4985-a329-91054e25162b.
- Compact localized home navigation in the shared alerts shell; shared dynamic Puerto Rico-year copyright with publisher attribution in public and private footers.
- About reports 3,290 physical lines across 28 tracked application TypeScript files as of this date. README documents the reproducible scope/method. No complete development-token ledger exists in repository records; no estimates were inferred, and runtime translation usage remains distinct.
- Validation: npm ci (zero vulnerabilities), 262 tests, typecheck, build, reviewed diffs; tests/typecheck/build repeated after fast-forward integration. Remote main SHA verified before manual Wrangler deployment from clean committed source. No migrations.
- Public es/en alerts and home fetches verified navigation, locale and copyright; alerts retain no-store, no-referrer, CSP and no analytics/signup footer. About es/en measurements verified with a fresh release query key because an existing cached page initially retained older copy.
- Authenticated management/result/retry rendering verified with local fixtures and mocked mail only. No live sessions accessed or mail sent. Mobile sizing and keyboard focus implemented in CSS; no browser/390px visual inspection requested or performed.
- Earlier sequential deployments during additional user requests: c2a86f06f0966f4fb7cc84e57a8b70c0af55d565 / 5c2b704e-9499-4f66-b5e8-38c822dfb9ce; d0608abed1f53dfa987cc9daeeee8ce180d3aca2 / 43024b76-9404-4235-9537-eb5e0e3b0812.

## 2026-11-19 — Editorial front-end redesign

- Deployed source: a18ae08675f9612adbf1b54ded5c3ea02c2bb872 (branch redesign/ui, PR #7; not yet merged to main at deploy time).
- Cloudflare Worker version: 9289a2a3-9ae3-4d44-b883-62b068893b9c.
- Front end only: ticker, hero, per-section 1+2+3 modules, ranked most-read rail, relative timestamps, monogram image fallback, front-page same-event folding ("También en"), self-hosted Fraunces variable font at /fonts/fraunces-var.woff2. No migrations, no pipeline, translation, D1 or click-ledger changes.
- Validation: 350 tests, typecheck, wrangler dry-run build; clean tree, pushed SHA verified equal to local HEAD and main unchanged before manual `wrangler deploy`.
- Live checks: 200 for /, /?lang=en, /s/politica, /fuentes, /about, /archive, /feed, /api/live; font served as font/woff2 with immutable caching; English edition shows "Latest" and "Also in". Browser screenshot of production at 1440 px matched local review.
- Rollback: `npx wrangler rollback` to the previous version (see `wrangler deployments list`).

## 2026-11-19 — Compact monogram-only cards

- Deployed source: 1f18f40 (branch redesign/ui, PR #7). Cloudflare Worker version: 44f543c8-1387-4560-b3c1-879ede9f1b30. Previous: 9289a2a3-9ae3-4d44-b883-62b068893b9c.
- CSS/markup only: `noimg` class on cards without a usable thumbnail; small tile or short banner instead of a photo-sized block. No migrations or pipeline changes.
- Validation: 350 tests, tsc; clean pushed tree before manual `wrangler deploy`; live 200 on /, /?lang=en, /s/politica with `noimg` cards present.

## 2026-11-19 — My alerts in the phone sections sheet

- Deployed source: a4c54cb (branch redesign/ui, PR #7). Cloudflare Worker version: 1fb68051-8624-482e-a5d3-ad182506e34a. Previous: 44f543c8-1387-4560-b3c1-879ede9f1b30.
- One link added to the sections sheet (hidden at 900px and up where the header link shows). No migrations or pipeline changes.
- Validation: 351 tests, tsc; clean pushed tree before manual `wrangler deploy`; live 200 on / and /?lang=en with the link present.
