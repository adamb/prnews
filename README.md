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

## Remaining work

Homepage duplicate placement is prevented by canonical article URL. Bounded article-page image metadata lookups are implemented; regional filters are not. Articles without usable images use a small local newspaper illustration. El Vocero is enabled using its RSS search feed, checked every 30 minutes to respect its advertised interval; it uses the same translation and permanent-archive pipeline. See [SPEC.md](SPEC.md) for the broader roadmap.

## Reddit community

`r/PuertoRico` is polled through its newest-posts Atom feed at most hourly, with rate-limit/error backoff. All posts appear in the Reddit section (`/s/comunidad`), and title-based Spanish/English topic matching also includes relevant posts in Politics, Sports, and other sections; they are labeled community discussions and link directly to Reddit. Each post displays its title and a one-line summary. A short excerpt from the post is used to produce saved Spanish and English summaries; comments and usernames are excluded. For image/link-only posts, the summary uses only the title without inventing unseen details. Summaries appear in compact homepage cards as well as topic and Reddit pages. English titles remain unchanged by the translation prompt; Spanish titles and summaries enter the saved translation queue.

Reddit announced the end of RSS support on November 13, 2026. The feed was still responding during implementation on November 14, but continued availability is uncertain. `/fuentes` reports failures, and the Community page includes a direct subreddit link. If Reddit RSS fails, the scanner requests the newest 100 r/PuertoRico posts from Arctic Shift. Archive posts retain their Reddit URLs and publication dates, reuse the same stored articles, and are restricted to the existing 14-day window. Removed/deleted records are skipped. Feed health identifies each provider. No login or scraping fallback is used.

## Permanent archive

`/archive` keeps every observed headline/excerpt/image-URL revision indefinitely, with source links, original publication times, capture timestamps in AST, and a capture-date filter. An Archive link is in the footer. Existing articles were backfilled when migration `0002_archive.sql` ran; this cannot reconstruct revisions from before we started observing them.

D1 triggers record inserts and content changes, but not unchanged scans or classification-only changes. Translations are attached to matching historical text. The archive tables have no cascading relationship to rolling articles, so the main feed's 14-day cleanup does not remove history. The archive date filter is based on capture date, in Puerto Rico time.

Image originals are queued by URL and copied into the private `prnews-archive` R2 bucket, served through `/archive/images/<sha256>`. Identical bytes share one object. Saved images are never expired or re-downloaded. Each scan copies up to 40 queued images with two concurrent downloads; failures back off, stopping after six attempts. Only JPEG, PNG, WebP, GIF, and AVIF files up to 16 MiB are accepted. Unavailable/unsupported images retain their original URL and error status rather than being represented as saved. No full articles or videos are copied.

Feeds that ship no image are recovered once, at ingestion only: the scheduler fetches up to 12 publisher article pages per 15-minute run, reads only the publisher's own `og:image`/`twitter:image` metadata, and stores that URL on the payload exactly like a feed-provided image (which also queues the permanent R2 copy). Lookups are URL-keyed and idempotent, https-only, 512 KiB of HTML, 12 s timeout, 4 attempts with exponential backoff — a publisher with no og:image converges to the honest newspaper-illustration fallback; recovered images survive rescans until the feed itself provides one. There is no AI step, no per-page fetch at render time, and no article body is copied.

An authenticated POST to `/internal/archive` processes an additional image batch without scanning feeds or calling AI. It uses the same `REFRESH_TOKEN` as manual refresh and returns copy progress. Credentials never appear in browser requests. R2 retention has no expiration rule; stored bytes and operations will accumulate over time.

## Integrated features and operational notes (November 2026)

- Search: `/search?q=...`, D1 FTS5 over original and cached translated titles/excerpts, bounded to the last 14 days, 30 results/page, safe highlighting and LIKE fallback. Filter by source with `source` (`lang=en` searches English-readable rows). The header Español/English toggle is the single language control; the retired `english=1` checkbox no longer renders anywhere and legacy `?english=1` links are canonicalized server-side with a 301 redirect to `lang=en` (keeping `q`, `source`, `page`).
- Digest: `/signup` and footer form; double opt-in; hashed expiring confirmation tokens; unsubscribe; bilingual HTML/text **El resumen de la isla**, with about five source-diverse stories. Cron `30 10 * * *` is 6:30 AM AST. The 15-minute cron continues bounded batches against the same day's immutable snapshot; every send uses a stable Resend `Idempotency-Key` (`digest/<day>/<subscriber>`) so ambiguous outcomes (timeouts, 5xx) retry safely inside a 23-hour window, 429/`Retry-After` responses back off without consuming an attempt, and definite 4xx rejections are terminal. Sending is **Resend-only** (`RESEND_API_KEY` + RFC 8058 one-click `List-Unsubscribe` headers) because ImprovMX's shared transactional account prohibits newsletters. The previously documented ImprovMX send path was removed; the installed `IMPROVMX_API_KEY` secret is unused by the digest and its presence alone never enables sending. **The digest is disabled** (`DIGEST_ENABLED="false"` and no `RESEND_API_KEY` is installed): legacy digest subscription requests return 503; the footer and `/signup` now offer keyword alerts instead. Enabling later requires a Resend-verified `DIGEST_FROM` domain (e.g. `digest@news.dev.pr`, needing Resend domain verification with its DKIM/DMARC records) plus `wrangler secret put RESEND_API_KEY` and `DIGEST_ENABLED="true"`. `DIGEST_TOKEN_SECRET` is installed and durable; never commit secrets. No real email delivery was tested without a user-supplied recipient.
- Most read: `/click` redirects only to DB-known destinations (live `articles` rows, stable `story_ids` permalinks, or permanent `archive_revisions` copies) and increments article/second rolling buckets. No visitor identities, IPs, or cookies are stored by this feature. Homepage ranks the past 24 hours and never repeats a headline already shown in another homepage block.
- Lifetime click ledger (migration `0008_click_totals.sql`): every counted click atomically upserts `article_click_totals` (per article), `site_click_totals` (one global row with the counting start date), and the 48-hour rolling bucket in one D1 batch. Totals survive both the bucket cleanup and 14-day article rotation. The 0008 backfill seeded totals only from buckets retention still kept (the final ~48 h); clicks older than that had been pruned by design and are never reconstructed or invented. All pages that render counters label the counting start ("conteo acumulado desde …") and say older clicks were not kept.
- `/stats` shows the lifetime outbound clicks and the most-clicked articles (full history, capped list), plus Cloudflare Web Analytics pageviews and visit sessions. Clicks, pageviews, and visits are three different metrics and never converted into one another: clicks are outbound `/click` GET-redirects, while pageviews/visits come from the browser beacon. No unique-visitor counts are shown or invented. If the analytics read is unavailable, the page says so and links the dashboard instead of showing a zero. The same page has a separate lighter-take ledger (button requests, cache hits, model attempts, stored generations, and failures, with Spanish and English rows when those rows exist). Those figures are request counts from each row's start time, not unique people, and they are never added to outbound clicks or Most read. A missing ledger or a failed read says unavailable instead of showing zeros. Requests from before counting started are not estimated. The page also shows the current lighter cache (valid takes for the current headline and excerpt, plus the scheduled generator's eligible, retry, and exhausted states). Opening `/stats` does not call AI.
- Hall of fame (`/hall`, footer link): archived articles — published more than 14 days ago — ranked by lifetime recorded clicks, bounded to the top 10, each with stable archive title/source/≤300-char summary and the original article link, with the exact metric labeled. It is honestly empty until an article both ages out of the 14-day window and has recorded clicks; nothing unpopular is promoted and no counts are fabricated.
- Site analytics read: the scheduler fetches Cloudflare Web Analytics through the official GraphQL Analytics API (`rumPageloadEventsAdaptiveGroups`, account-level read with the installed `CF_ANALYTICS_TOKEN` secret, never per page view). `src/analytics.json` holds the beacon host/token, the GraphQL `siteTag` (different value from the beacon token), and the account id. An 8-day date-only query (which cannot hit the group row limit) upserts daily pageviews/visits into `web_analytics_daily`, so measured days stay durable beyond the API's own querying window. Refresh attempts are bounded to one per 6-hour TTL; the page render only reads D1. RUM counts only JavaScript-executing browsers (no non-JS bots, no Worker request volume) and `visits` are sessions, not identified unique visitors.
- `/feed` (also `/rss.xml`, `/feed.xml`) emits latest 50 original article links. Sitemap includes local pages and stable `/story?id=...` summary permalinks; those pages link to full originals, never reproduce them.
- `CONTACT_EMAIL` is configurable, default `prnews@code.pr` (site contact and alert Reply-To; the address is a code.pr address of the owner). This does not provision a mailbox.
- Context uses a cached verbatim excerpt sentence chosen by the existing AI model; unsupported output falls back to a word-trimmed excerpt of at most 140 characters. Page views never invoke AI.
- Ten grouped sections retain compatibility with old section URLs. The navigation wraps and secondary sections are in an accessible native More menu. Missing/failed thumbnails use a local SVG newspaper illustration.
- Feed fixes: duplicate archived-image URLs use explicit `ON CONFLICT DO NOTHING` under article upserts; News is my Business automated fetching is paused because the publisher returns 403 (manual imports stay); Reddit is hourly with exponential backoff and `Retry-After` support. Source errors show a generic updating state and last successful timestamp, not database messages.
- The homepage and default archive **view** cover 14 days. Historical database records and saved R2 images remain retained indefinitely, honoring the prior storage requirement; this change does not delete history. The page banner reports source-check times and no longer promises a 15-minute page reload.
- `scripts/repair-live.ts` reapplies classification, repairs only URL-derived NIMB punctuation, and queues incomplete translations. The News is my Business issue was in the manual slug import, not the shared feed sanitizer. Other publishers' titles are untouched.

- Live status: cached NWS Puerto Rico alerts, latest USGS Puerto Rico-region earthquake, and the official LUMA load-shedding layer (explicitly not all outages). Failed sources hide immediately; cache expiry hides stale chips. WAPA, WIPR and Claridad RSS feeds are enabled. El Post Antillano is excluded because its domain serves unrelated parked content.

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

### Optional lighter take

Homepage/section cards may expose a native keyboard-accessible “A lighter take” disclosure (Spanish: “Una mirada más ligera”). Originals and publisher links remain visible. Missing or rejected output has no button. Only existing titles/excerpts are sent to the same Llama 3.3 70B FP8 Fast model, never full articles. Scheduled generation reserves a durable 15-minute slot before making at most **two calls**, each capped at 180 output tokens (maximum 192 calls / 34,560 output tokens per day). Input titles are capped at 500 characters; excerpts use the existing 300-character policy. No page-view AI. This is a token/call ceiling, not a dollar-cost guarantee.

Migration 0011 only adds two tables. Cache identity includes URL, original title/excerpt, edition and prompt version. Failed attempts back off 1/2/4 hours and stop after three; successful results are reused. Slot reservations survive failures to prevent duplicate concurrent spending. Recognized sensitive topics are withheld entirely, retaining the sober original. Prompt and lexical checks are best-effort: they cannot prove factual grounding, language accuracy or absence of inappropriate humor. AI labeling and source links remain essential. Cache/slot rows currently persist; periodic operational cleanup may be needed. Coverage of the scheduled generator is deliberately sparse, newest 60 candidates first. Homepage and section cards expose a stored take. `/stats` reads that cache and, when present, the separate `lighter_stats` ledger written by the on-demand button path. The stats page does not restate a fixed calls-per-window budget; the generator still enforces its own cap.
