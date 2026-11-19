# prnews

Spanish-first Puerto Rico news, with an English edition, served by one TypeScript Cloudflare Worker.

Public site: https://news.dev.pr

Crawler endpoints: `/robots.txt` permits public pages and disallows `/internal/`; `/sitemap.xml` lists the homepage, sections, sources, and about pages in Spanish and English with language alternates. Both use the canonical public domain and work independently of D1.

## Architecture and documentation

Cloudflare Workers serves news.dev.pr. D1 stores articles, cached translations, alerts and counters; R2 stores archived images; Workers AI translates excerpts and headlines. Cron refreshes feeds every 15 minutes (individual sources may have longer intervals). See [wrangler.toml](wrangler.toml) for bindings and schedules.

This README is the starting point for setup, validation and operation. Focused notes already document [alerts](docs/alerts-integration.md), [search and RSS](docs/search-integration.md), [clicks and analytics](docs/clicks-analytics-integration.md), [caching](docs/caching-integration.md), [classification](docs/classification-notes.md), [source discovery and status](docs/sources-status-integration.md), and the [disabled daily digest](docs/digest-integration.md). Some integration notes retain historical implementation details; current code and newer dated notes take precedence.

## Git collaboration and releases

The private code backup is [adamb/prnews](https://github.com/adamb/prnews). Before the November 17, 2026 checkpoint, coders shared a working directory and the application was deployed without regular commits. The checkpoint preserves the combined application; it does not reconstruct a fictional per-feature history.

From this checkpoint onward:

1. Give independent coders separate feature branches and tool-managed worktrees, based on current main. Name dependencies explicitly instead of overlapping edits in one checkout.
2. Make focused commits with a reviewed diff and verified model attribution (`AI-Tool`, `AI-Model`, `Validation` trailers). Use a reviewed PR or coordinated integration into main; rerun checks after integration.
3. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. Build is a dry run; generated fixtures/build output remain ignored.
4. Push the tested commit to the private remote. Release only that committed revision, with no uncommitted source/config changes. Review/apply any new migrations, then run `npx wrangler deploy` using Wrangler OAuth (`npx wrangler login`, `npx wrangler whoami`) or a securely supplied API token.
5. Record the source commit SHA and resulting Worker version in release notes. Do not run concurrent deployments.

**Pushing to GitHub does not deploy the site.** Deployment remains a manual Wrangler operation. The Git backup includes source, fixtures, migrations and configuration; production D1 data, R2 images and Worker secrets require separate backup/credential procedures. See [AGENTS.md](AGENTS.md) for the rules every coding agent must follow.

### Model attribution

Adam used Grok bot to set up t3.codes on Roux, then used Codex for orchestration and coding and asked the orchestrator to select other models. Completed task reports identify GLM-5.3-Flash Cloud through OpenCode/Ollama Cloud as contributing search, trending/RSS, and live-status/source-discovery modules. Codex contributed orchestration, integration, coding, testing and repairs. Workers AI's runtime translation model is separate from these development tools.

Git originally held only the spec/fixture commit, so it cannot establish historical task counts, token usage, cost, or contribution percentages by model. This baseline is a consolidated snapshot with incomplete historical attribution. Future commit trailers provide a traceable contribution record, not token/cost telemetry or a measure of how much code a model wrote.

## Automatic updates

The live ingestion implementation uses a Cloudflare Cron Trigger (`*/15 * * * *`) and D1. Every 15 minutes it checks the configured news and community sources (including both NotiCel pages), saves articles by canonical URL, and processes up to 96 pending English translations. New and changed articles are translated once and stored in D1. Until translation succeeds, articles remain available in Spanish and are withheld from the English edition. A count indicates translations still pending. Existing snapshot translations can be imported without repeating AI calls.

Feeds have independent timeouts, conditional requests, and exponential backoff capped at four hours. A database lease prevents overlapping runs. Observation timestamps remain stable across scans. Articles older than 14 days are removed. `/fuentes` shows the latest status and last successful check for each feed. HTML is cached for 60 seconds.

Production is deployed with D1 and a 15-minute Cron Trigger. Cloudflare Web Analytics uses manual JS snippet installation on news.dev.pr. Its public beacon token is in src/analytics.json; the module script is included once before </body>. Local development and the workers.dev hostname do not emit the beacon.

## Local development

Requires Node.js 22.13+ and npm.

```sh
npm ci
npm run db:local
npm run seed:db
npm run dev
```

Open the URL printed by Wrangler. Local configuration has no AI binding and requires no Cloudflare token. Importing the fixtures preserves the saved English translations. To run a real feed scan locally (outbound network requests, local database only):

```sh
curl -X POST http://localhost:8787/cdn-cgi/local/scheduled
```

Use the actual port printed by Wrangler. Local cron is invoked manually; production cron runs automatically.

## Production setup

The database already exists in production. The commands below are for a **new installation only**; do not replay database creation or fixture seeding on the live site. Use Wrangler OAuth or `CLOUDFLARE_API_TOKEN` supplied securely (Workers deployment and D1 Edit permissions):

```sh
npx wrangler d1 create prnews
# Put the returned database_id in wrangler.toml, replacing the all-zero placeholder.
npx wrangler d1 migrations apply prnews --remote
npm run seed
npx tsx scripts/seed-db.ts
npx wrangler d1 execute prnews --remote --file .wrangler/seed.sql
npx wrangler deploy
```

The `[ai]` binding runs translations through Workers AI; credentials are not embedded in the Worker. Cron changes can take up to 15 minutes to propagate. For an optional manual initial refresh, set a strong random `REFRESH_TOKEN` using `wrangler secret put REFRESH_TOKEN`, then POST `/internal/refresh` with a matching Bearer authorization header. The endpoint returns 404 without valid authorization. It is never called by page views.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

`build` is a dry run, not a deployment. Tests cover real feed fixtures, normalization, classification, English coverage, routing, SQLite-backed ingestion, conditional requests, source failure isolation, stable first-seen dates, translation invalidation, and overlap prevention.

## English edition

Use Español / English or `/?lang=en`. The chosen language is preserved through navigation and pagination. Publisher links always point to the original article. Machine translations are labeled. Original English articles remain unchanged.

Snapshot translations remain in `src/translations.en.json`. To regenerate missing or changed snapshot translations, set `CLOUDFLARE_API_TOKEN` with Workers AI Read and `CLOUDFLARE_ACCOUNT_ID`, then run `npm run translate`. Production translations are handled by the scheduled Worker and stored in D1.

### Translation queue definition

One definition (`needsTranslation` in `src/i18n.ts`) is shared by the pending notice, `/stats`, the queue history, and the scheduler: an article is awaiting translation iff the English edition cannot render it in English right now. That covers both articles with no stored translation and articles whose cached translation fails validation (for example an unchanged Spanish headline), and it checks the bundled snapshot translations second so nothing is double-counted or double-translated. Retry stays bounded: up to 96 articles per 15-minute refresh and at least one hour between attempts for the same article; `/stats` records the same number every 15 minutes, and older history samples used a narrower definition and are kept as recorded rather than recalculated.

Language is decided per article, not per source. Bilingual publishers like the San Juan Daily Star ship both languages, so `parseFeed` records a transparent per-article `originalLanguage:'es'` whenever title/summary carry demonstrably Spanish signals (Spanish-exclusive function words, Spanish morphology, Spanish diacritics; capitalized proper nouns and acronym bylines never count). Items with a per-article signal are labeled and queued accordingly; items without one keep their source's default (sjds/nimb English, everything else Spanish). Detection is conservative and never invents an English verdict.

## Front end (editorial redesign)

The public pages are server-rendered strings in `src/render.ts` with one inlined stylesheet, `src/styles.ts`; there is no client framework. Composition is pure and unit-tested in `src/frontpage.ts`; nothing here touches ingestion, translation, D1 or the click ledger.

- **Front page:** "Última hora" ticker (newest newsroom stories, pausable, still under `prefers-reduced-motion`), a hero (the best-covered recent story that has a picture) with up to three side stories, a "Lo más leído" rail ranked 1-5 from the existing rolling-24h click data, then one section module per navigation section. Every section shows the same 1 large + 2 medium + 3 brief preview whatever its size, so "Otras y Opinión" has no extra weight; its header count matches the section page.
- **Same event, shown once:** on the front page only, near-identical headlines from different newsrooms within 12 hours (at least four shared content words and 60% overlap) fold into one story with a "También en" link to the other newsroom's original. Headlines are never rewritten and the section pages list every story. Thresholds live in `src/frontpage.ts`.
- **Images:** every thumbnail sits in a fixed aspect-ratio box with the source's monogram (`src/brand.ts`) underneath, so a missing or broken image leaves a tidy colored block and never shifts layout. A thumbnail used by four or more different stories is treated as a publisher stock graphic and replaced by the monogram (presentation only; stored data is unchanged). An imageless lead or hero, including the first card on a section page, is a compact text row with that small source mark. A real photo on that card keeps its 16/9 or 3/2 box.
- **Time:** stories under a week old show "hace 12 min" / "12 min ago" (the absolute AST time is the tooltip). A 600-byte inline script refreshes them every minute; `src/reltime.ts` keeps the server and browser rules identical and a test enforces it.
- **Type and theme:** headlines use Fraunces, one variable woff2 (latin subset, weight axis 600-800, ~32 KB) served by the Worker itself from `/fonts/fraunces-var.woff2` with immutable caching (`src/font.ts`; SIL Open Font License 1.1); UI text uses the system sans stack. Colors are tokens resolved with `light-dark()` from `color-scheme`, which follows the system theme unless the header toggle stored a choice; dark is the fallback palette. Section accents take only a hue from `src/brand.ts`; lightness is set per theme so accents, muted text and the monogram blocks all clear 4.5:1 on their backgrounds (checked with a WCAG contrast sweep; the one unused yellow hue near 60 would miss 4.5:1 in the light theme, so keep new section hues away from it).
- **Navigation on phones:** the bar collapses to "Portada" plus one sections button that opens a full-width sheet; search collapses to an icon that expands over the header.

## Remaining work

Homepage duplicate placement is prevented by canonical article URL. Bounded article-page image metadata lookups are implemented; regional filters are not. Articles without usable images show their source's monogram block (see Front end). El Vocero is enabled using its RSS search feed, checked every 30 minutes to respect its advertised interval; it uses the same translation and permanent-archive pipeline. See [SPEC.md](SPEC.md) for the broader roadmap.

## Reddit community

`r/PuertoRico` is polled through its newest-posts Atom feed at most hourly, with rate-limit/error backoff. All posts appear in the Reddit section (`/s/comunidad`), and title-based Spanish/English topic matching also includes relevant posts in Politics, Sports, and other sections; they are labeled community discussions and link directly to Reddit. Each post displays its title and a one-line summary. A short excerpt from the post is used to produce saved Spanish and English summaries; comments and usernames are excluded. For image/link-only posts, the summary uses only the title without inventing unseen details. Summaries appear in compact homepage cards as well as topic and Reddit pages. English titles remain unchanged by the translation prompt; Spanish titles and summaries enter the saved translation queue.

Reddit announced the end of RSS support on November 13, 2026. The feed was still responding during implementation on November 14, but continued availability is uncertain. `/fuentes` reports failures, and the Community page includes a direct subreddit link. If Reddit RSS fails, the scanner requests the newest 100 r/PuertoRico posts from Arctic Shift. A preview URL already in that JSON is stored when its host is `i.redd.it`, `preview.redd.it`, or `external-preview.redd.it`, the same hosts the old `media:thumbnail` used. A text post whose thumbnail is `self` or `default` stays imageless. No second request is made, and Reddit stays out of the publisher-page image queue. Archive posts retain their Reddit URLs and publication dates, reuse the same stored articles, and are restricted to the existing 14-day window. Removed/deleted records are skipped. Feed health identifies each provider. No login or scraping fallback is used.

## Permanent archive

`/archive` keeps every observed headline/excerpt/image-URL revision indefinitely, with source links, original publication times, capture timestamps in AST, and a capture-date filter. An Archive link is in the footer. Existing articles were backfilled when migration `0002_archive.sql` ran; this cannot reconstruct revisions from before we started observing them.

D1 triggers record inserts and content changes, but not unchanged scans or classification-only changes. Translations are attached to matching historical text. The archive tables have no cascading relationship to rolling articles, so the main feed's 14-day cleanup does not remove history. The archive date filter is based on capture date, in Puerto Rico time.

Image originals are queued by URL and copied into the private `prnews-archive` R2 bucket, served through `/archive/images/<sha256>`. Identical bytes share one object. Saved images are never expired or re-downloaded. Each scan copies up to 40 queued images with two concurrent downloads; failures back off, stopping after six attempts. Only JPEG, PNG, WebP, GIF, and AVIF files up to 16 MiB are accepted. Unavailable/unsupported images retain their original URL and error status rather than being represented as saved. No full articles or videos are copied.

Feeds that ship no image are recovered once, at ingestion only: the scheduler fetches up to 12 publisher article pages per 15-minute run, newest article per source first, reads only the publisher's own `og:image`/`twitter:image` metadata, and stores that URL on the payload exactly like a feed-provided image (which also queues the permanent R2 copy). A feed image already on the article is left alone, and an R2 copy is not fetched again. Lookups are URL-keyed and idempotent, https-only, 512 KiB of HTML, 12 s timeout. A page with no og:image uses 4 attempts with exponential backoff and then stays on the newspaper illustration. A 429 or 503 keeps that same 4-attempt cap but waits for the next 15-minute run, or for `Retry-After` when that falls between 15 and 60 minutes, because the image may still be on the page. Recovered images survive rescans until the feed itself provides one. There is no AI step, no per-page fetch at render time, and no article body is copied.

An authenticated POST to `/internal/archive` processes an additional image batch without scanning feeds or calling AI. It uses the same `REFRESH_TOKEN` as manual refresh and returns copy progress. Credentials never appear in browser requests. R2 retention has no expiration rule; stored bytes and operations will accumulate over time.

## Integrated features and operational notes (November 2026)

- Search: `/search?q=...`, D1 FTS5 over original and cached translated titles/excerpts, bounded to the last 14 days, 30 results/page, safe highlighting and LIKE fallback. Filter by source with `source` (`lang=en` searches English-readable rows). The header Español/English toggle is the single language control; the retired `english=1` checkbox no longer renders anywhere and legacy `?english=1` links are canonicalized server-side with a 301 redirect to `lang=en` (keeping `q`, `source`, `page`).
- Digest: `/signup` and footer form; double opt-in; hashed expiring confirmation tokens; unsubscribe; bilingual HTML/text **El resumen de la isla**, with about five source-diverse stories. Cron `30 10 * * *` is 6:30 AM AST. The 15-minute cron continues bounded batches against the same day's immutable snapshot; every send uses a stable Resend `Idempotency-Key` (`digest/<day>/<subscriber>`) so ambiguous outcomes (timeouts, 5xx) retry safely inside a 23-hour window, 429/`Retry-After` responses back off without consuming an attempt, and definite 4xx rejections are terminal. Sending is **Resend-only** (`RESEND_API_KEY` + RFC 8058 one-click `List-Unsubscribe` headers) because ImprovMX's shared transactional account prohibits newsletters. The previously documented ImprovMX send path was removed; the installed `IMPROVMX_API_KEY` secret is unused by the digest and its presence alone never enables sending. **The digest is disabled** (`DIGEST_ENABLED="false"` and no `RESEND_API_KEY` is installed): legacy digest subscription requests return 503; the footer and `/signup` now offer keyword alerts instead. Enabling later requires a Resend-verified `DIGEST_FROM` domain (e.g. `digest@news.dev.pr`, needing Resend domain verification with its DKIM/DMARC records) plus `wrangler secret put RESEND_API_KEY` and `DIGEST_ENABLED="true"`. `DIGEST_TOKEN_SECRET` is installed and durable; never commit secrets. No real email delivery was tested without a user-supplied recipient.
- Most read: `/click` redirects only to DB-known destinations (live `articles` rows, stable `story_ids` permalinks, or permanent `archive_revisions` copies) and increments article/second rolling buckets. No visitor identities, IPs, or cookies are stored by this feature. Homepage ranks the past 24 hours and never repeats a headline already shown in another homepage block.
- Lifetime click ledger (migration `0008_click_totals.sql`): every counted click atomically upserts `article_click_totals` (per article), `site_click_totals` (one global row with the counting start date), and the 48-hour rolling bucket in one D1 batch. Totals survive both the bucket cleanup and 14-day article rotation. The 0008 backfill seeded totals only from buckets retention still kept (the final ~48 h); clicks older than that had been pruned by design and are never reconstructed or invented. All pages that render counters label the counting start ("conteo acumulado desde …") and say older clicks were not kept.
- `/stats` shows the lifetime outbound clicks and the most-clicked articles (full history, capped list), plus Cloudflare Web Analytics pageviews and visit sessions. Clicks, pageviews, and visits are three different metrics and never converted into one another: clicks are outbound `/click` GET-redirects, while pageviews/visits come from the browser beacon. No unique-visitor counts are shown or invented. If the analytics read is unavailable, the page says so and links the dashboard instead of showing a zero. The same page has a separate lighter-take ledger (button requests, cache hits, model attempts, stored generations, and failures, with Spanish and English rows when those rows exist). Those figures are request counts from each row's start time, not unique people, and they are never added to outbound clicks or Most read. A missing ledger or a failed read says unavailable instead of showing zeros. Requests from before counting started are not estimated. The page also shows the current lighter cache (valid takes for the current headline and excerpt, plus eligible, retry, and exhausted rows under the same rule as generation). Opening `/stats` does not call AI.
- `/comparar` (linked from `/stats` and the footer) compares outlets by what the feeds actually delivered in the active 14-day window: a topic matrix, one daily chart per outlet, image-URL coverage, and raw `/click` redirects for articles still in that window. Counts are captured canonical URLs, not publisher output. Days are AST. Today and the opening day of the window are marked partial. A paused or never-checked feed shows a dash instead of a zero. Reddit is a separate community block. Topics use the same display classifier as the section pages, which can differ from the section stored at capture. The page does not rank quality, bias, or audience, and it does not read the archive revisions. Opening it does not call AI or an external API.
- Hall of fame (`/hall`, footer link): archived articles — published more than 14 days ago — ranked by lifetime recorded clicks, bounded to the top 10, each with stable archive title/source/≤300-char summary and the original article link, with the exact metric labeled. It is honestly empty until an article both ages out of the 14-day window and has recorded clicks; nothing unpopular is promoted and no counts are fabricated.
- Site analytics read: the scheduler fetches Cloudflare Web Analytics through the official GraphQL Analytics API (`rumPageloadEventsAdaptiveGroups`, account-level read with the installed `CF_ANALYTICS_TOKEN` secret, never per page view). `src/analytics.json` holds the beacon host/token, the GraphQL `siteTag` (different value from the beacon token), and the account id. An 8-day date-only query (which cannot hit the group row limit) upserts daily pageviews/visits into `web_analytics_daily`, so measured days stay durable beyond the API's own querying window. Refresh attempts are bounded to one per 6-hour TTL; the page render only reads D1. RUM counts only JavaScript-executing browsers (no non-JS bots, no Worker request volume) and `visits` are sessions, not identified unique visitors.
- `/feed` (also `/rss.xml`, `/feed.xml`) emits latest 50 original article links. Sitemap includes local pages and stable `/story?id=...` summary permalinks; those pages link to full originals, never reproduce them.
- `CONTACT_EMAIL` is configurable, default `prnews@code.pr` (site contact and alert Reply-To; the address is a code.pr address of the owner). This does not provision a mailbox.
- Context uses a cached verbatim excerpt sentence chosen by the existing AI model; unsupported output falls back to a word-trimmed excerpt of at most 140 characters. Page views never invoke AI.
- Ten grouped sections retain compatibility with old section URLs. The navigation wraps and secondary sections are in an accessible native More menu. Missing/failed thumbnails use a local SVG newspaper illustration.
- Feed fixes: duplicate archived-image URLs use explicit `ON CONFLICT DO NOTHING` under article upserts; News is my Business automated fetching is paused because the publisher returns 403 (manual imports stay); Reddit is hourly with exponential backoff and `Retry-After` support. Source errors show a generic updating state and last successful timestamp, not database messages.
- The homepage and default archive **view** cover 14 days. Historical database records and saved R2 images remain retained indefinitely, honoring the prior storage requirement; this change does not delete history. The page banner reports source-check times and no longer promises a 15-minute page reload.
- `scripts/repair-live.ts` reapplies classification, repairs only URL-derived NIMB punctuation, and queues incomplete translations. The News is my Business issue was in the manual slug import, not the shared feed sanitizer. Other publishers' titles are untouched.

- Live status: cached NWS Puerto Rico alerts, latest USGS Puerto Rico-region earthquake, and the official LUMA load-shedding layer (explicitly not all outages). Failed sources hide immediately; cache expiry hides stale chips. WAPA, WIPR, Claridad, Radio Isla 1320 (`https://radioisla.tv/feed/`) and WALO 1240 in Humacao (`https://waloradio.com/feed/`, not its narrower Noticias category) RSS feeds are enabled. El Post Antillano is excluded because its domain serves unrelated parked content.

### Dated source size

The About page's November 17, 2026 count measures physical lines (including comments and blank lines) in tracked, maintained `src/**/*.ts` application files. Tests, fixtures, generated JSON, dependencies and lockfiles are excluded. Reproduce at the release revision with:

```sh
python3 - <<'PY'
import pathlib, subprocess
files = [p for p in subprocess.check_output(['git', 'ls-files', 'src/'], text=True).splitlines() if p.endswith('.ts')]
print(sum(len(pathlib.Path(p).read_bytes().splitlines()) for p in files))
PY
```

Repository attribution records contain no complete development-token ledger. Source lines and Git history cannot recover token usage. Runtime Workers AI translation usage is separate; neither is estimated on About.

### On-demand satire

Eligible homepage and section cards show a keyboard button in the selected edition (Spanish: “Pedir una sátira” / “Ver la sátira guardada”; English: “Ask for a satire” / “Show the saved satire”). The original headline stays on the page. The satire text is not in the HTML. A click sends `POST /api/lighter` with `Content-Type: application/json`, `X-PRNews-Action: lighter`, and an `Origin` header equal to the site origin. A missing or different Origin is rejected. GET, HEAD, prefetch, and ordinary page views do not call the model and do not count. The 15-minute cron does not generate satire.

The body may only name a URL already stored in `articles`, `lang` of `es` or `en`, and a UUID v4 `action` for that button press. The server loads the stored headline and excerpt (the same `currentItem` view the card uses). It does not fetch the article URL and does not follow instructions inside the headline. Prompt version is `lighter-2` (`src/lighter.ts` `VERSION`). A new version does not rewrite old rows. Cache identity is version, URL, title, excerpt, and language.

One explicit `action` counts once in `lighter_stats`, including when the text was already cached. Polls and automatic retries reuse that id and do not count again. A later “Try again” is a new id. `interactions` are button requests, not people. `cache_hits` are requests served from cache. `attempts` are model calls. `generations` are attempts that stored a valid text. `failures` are attempts that did not. Scopes `all`, `es`, and `en` are written separately; `all` is not derived by adding the editions. `started_at` is when migration `0012_lighter_stats.sql` began counting. Older button clicks are not invented. `lighter-1` cache rows are not copied in as generations. No IP, cookie, account, or error text is stored. These numbers are not `/click` and not Most read.

Cost ceiling, chosen because unlimited spend was not authorized: **24 model calls per UTC day**, **180 output tokens** each (at most 4,320 output tokens a day), **2 calls in flight**, **3 attempts** per headline/excerpt/language, then a stop. The first failed attempt waits 1 hour and the second waits 2 hours. The third attempt does not offer another try. The HTTP call gives up after 12 seconds; the UI can poll the same action while a call is in flight. A separate global cap allows 60 new button presses per minute and stores no address. Over the daily cap the original stays, and the model is not called. The same Llama 3.3 70B FP8 Fast model is used. Sensitive death, violence, crime, disaster, and emergency matches get no button and no model call. The label is AI satire / commentary, not reporting. Checks on quotes, numbers, markup, and reassurance are best-effort and can miss a bad joke or reject a fair one.

The button does not offer an immediate retry when another press cannot run. A failed attempt that still has tries left returns `cooldown` and `retry_after` (seconds). The note says to wait, and “Try again” appears only when that wait has elapsed. The third failure, and any later press, returns `exhausted`. A stored line that is not clearly the requested edition is withheld: a clearly wrong language is cleared on the next explicit request, and an ambiguous or otherwise invalid line stays stored and returns `exhausted`. `budget` disables the button for the rest of the UTC day. `busy` and `rate` can be tried again shortly. These responses do not include the model error, the attempt count, or the cache key. A model object whose sentence is nested under `text` is still checked with the same edition and safety rules.

### Explain the context (November 19, 2026)

Eligible cards can show a second control beside satire, in the language of the page: “Explicar el contexto” / “Explain the context”. It is a closed `<details>` element, not an always-open block. The original headline and excerpt stay as the source wrote them. The note is not satire, does not replace the article, and does not claim to summarize it.

This first version is a reviewed glossary in `src/explainer.ts`, not a model call. Matching looks only at the headline and excerpt already on the card (original and the edition the reader is seeing). It does not fetch the article, read a paywalled body, or pretend the full story is known. Nothing is stored. There is no new route, migration, or counter. Opening the note does not call Workers AI, and a page view does not either. `/stats` is unchanged: lighter-take counts stay in their own ledger, outbound clicks stay in the click ledger, and recurring topic comparisons stay with the source-comparison report. Explainer opens are not counted, so there is no new per-person record and no speculative analytics table.

An entry appears only for a pattern in that file. Short or ambiguous words do not fire alone. “promesa” in the sense of a promise does not match; the acronym PROMESA has to be capitalized, or the card has to use a full Board name. “oversight committee” and “comité de supervisión” are not treated as the Financial Oversight and Management Board. “Junta de Planificación”, a board of directors, and a school board are not that Board either. Bare “AAA”, “Ley 60”, “ELA”, “PD”, and “hacienda” do not match. Party entries say when a position comes from a party page, and they do not assign a person to a party. Each entry links the public source it relies on. The copy says it is background checked on November 19, 2026, not reporting.

To change an entry, edit `src/explainer.ts`, open the cited URL, and update `VERIFIED_ON` when the check is real. Do not paste a current officeholder, a vote total, or a tax rate from memory. Prefer an official statute, the institution’s own page, or a State Elections Commission document. Label a party’s own page as the party’s statement. If a source no longer says what the entry says, narrow the entry or remove it.

The card change is one call in `card()` in `src/render.ts`, inserted before the satire control. The `.explainer` rules in `src/styles.ts` sit next to satire and do not replace `.lighter` or `.compare`. The HTML cache name stays `prnews-html-v28`; a cached page can lag up to its 60-second TTL. At most three entries render on one card.
