# Search, clicks and syndication integration (not wired into existing files)

New files only: `src/search.ts`, `src/trending.ts`, `src/syndication.ts`, `migrations/0003_search_clicks.sql` and their tests. No existing source files were edited; `0004`/`0006` remain untouched. The migration must be applied by the root checkout **after 0001/0002** (`wrangler d1 migrations apply`). It creates `articles_fts` (FTS5), `story_ids` and `article_click_buckets`, plus triggers that keep the FTS index and story ids in sync with `articles` and backfills both from the current population.

## 1. Search (`src/search.ts`)

```ts
searchArticles(env: {DB}, params: SearchParams, now = Date.now()): Promise<SearchResult>
parseSearchTerms(q): string[]   // tokens: letters/numbers only, max 8 × 48 chars
ftsQuery(terms): string         // each token double-quoted for MATCH
highlight(text, terms): string  // XSS-safe: HTML-escapes first, then <mark> wraps
```

`SearchParams = { q?, source?, english?, page? }`; `SearchResult = { items: Item[]; translations: Record<string,Translation>; page; hasNext; engine: 'fts'|'like'|'filter'; terms }`.

* Index: `articles_fts` matches the **original** title/summary **and** the cached translation — but only while `translation.originalTitle/originalSummary` equal the payload (stale translations are simply not searchable, same validity the renderer already applies). The ingest triggers (`articles_fts_add/del/upd`) maintain it from `payload`/`translation` writes; the 14-day purge in `refresh()` keeps it bounded.
* Query semantics: every term must match (implicit AND), exact tokens, case-folded; FTS5-syntax characters are stripped and every token is quoted, so arbitrary input can never inject MATCH grammar or SQL. Empty/decoration-only queries degrade to `engine:'filter'` (filters + newest only). Unknown `source` ids are ignored (renderer's convention); `english: true` keeps only English sources (`sjds`, `nimb`) or rows with a valid translation.
* Bounded: newest-first, `published_at >= now-14d` always, 30/page via `LIMIT 31` (`hasNext`), page clamped to 1..50. `q` truncated to 200 chars — mirror that in cache keys (root's `/search` header already sends `maxlength="200"`).
* Fallback: if the FTS statement throws (index dropped, FTS unavailable), the same filters re-run as escaped `LIKE` constraints over original + valid-translated text (max 8 tokens × 4 binds). Writes keep working only while the triggers exist; if someone drops `articles_fts`, also drop the triggers.

**Suggested root wiring.** Early in `fetch()`, after the other routes:

```ts
if (url.pathname === '/search' || url.pathname === '/click' || url.pathname === '/story') { … }
```

For `/search` (GET/HEAD): `const r = await searchArticles(env, { q: url.searchParams.get('q') ?? '', source: url.searchParams.get('source') ?? '', english: url.searchParams.get('english') === '1', page: Number(url.searchParams.get('page')) || 1 }, now)` and pass `{ items: r.items, translations: r.translations, feeds: … }` into the existing renderer so cards, filters and language switching work unchanged. In `?lang=en` editions pass `english: url.searchParams.get('english') === '1' || lang === 'en'`, otherwise the renderer would silently drop Spanish-only rows and shorten the page. Root owns rendering; add a `role="search"` result heading, a `No results` empty state, and highlight by rendering `title`/`summary` through `highlight(item.title, r.terms)` (values are escaped by the helper; do not double-escape). Cache keys: reuse the existing cache-key loop (`q` is already included) and keep `page` in the key; 60s max-age is fine.

## 2. Clicks (`src/trending.ts`)

```ts
clickRoute(request, env, now?): Promise<Response|undefined>  // undefined on other paths
recordClick(env, url, now?) / topClicked(env, now?, limit? = 5) / cleanupClicks(env, now?)
lookupDestination(env, key, now?): Promise<string>           // '' when unknown
```

* Route `GET/HEAD /click?url=<article url>` or `/click?id=<story id>` (exact key match; both params can coexist — `id` wins). The destination comes only from the DB (`articles.payload`, validated `http(s)` by `safeUrl`); unknown values yield a plain 404 with `Cache-Control: no-store`, so `//evil.com`, `javascript:…`, prefixes or any foreign URL can never become a redirect target (no open redirect).
* 302 redirect, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. **GET counts once, HEAD never counts.** Non-GET/HEAD → 405. Counting and the 1-in-50 opportunistic `cleanupClicks()` run inside `try{}catch{}`: a counter failure must still redirect a known destination.
* Privacy: `article_click_buckets(url, bucket, clicks)` stores hourly buckets of counts per article only — no IP, cookies, user agents or request identifiers, nothing else is read or logged.
* Aggregates: `topClicked` returns a rolling-24h top 5 as `{ item, clicks }[]` (ties broken by url, zero-count rows skipped). `cleanupClicks` deletes buckets older than 48h. Root's cron (`refresh` or the scheduled handler) may call both directly; the route already self-heals via the 1/50 cleanup. Suggested UI: chips/trend list linking through `/click?url=<item.url>` so the counts stay measurable.
* `id` lookups resolve `story_ids → articles` (see below).

## 3. Syndication (`src/syndication.ts`)

```ts
syndicationRoute(request, env, now?): Promise<Response|undefined>  // rss → sitemap → undefined
rssRoute(request, env, now?) / sitemapRoute(request, env, now?)
storyPermalink(origin, id) / storyLookup(env, id): Promise<StoryResult|null>
excerpt(text, max? = 300)
```

* **RSS 2.0** at `GET/HEAD /rss.xml` (alias `/feed.xml`, per SPEC): latest 50 articles, newest first. `<link>`/`<guid>` are the **original foreign article URLs** (RSS items must point at the publisher); `<title>` is the original title, `<source url="…">` the publisher name/homepage, `<pubDate>` RFC-822, `<description>` a ≤300-char excerpt. All text is XML-escaped (`&<>"'`); invalid URLs are dropped, full article text is never included. GET → `application/rss+xml`, HEAD → headers only. Other methods → 405 (`Allow: GET, HEAD`).
* **Sitemap** at `GET/HEAD /sitemap.xml`: latest 500 `<url><loc>` entries are **always** `https://news.dev.pr/story?id=<n>` summary permalinks — never foreign URLs — plus `<lastmod>` (UTC date of `published_at`). `story_ids.id` is `AUTOINCREMENT`, so ids are never recycled after rotation.
* **Story pages.** `storyPermalink(origin, id)` builds the permalink; `storyLookup(env, id)` prefers the current `articles` row and falls back to the latest `archive_revisions` revision, returning `{ item, translation|null, publishedAt, from: 'articles'|'archive' }`. Suggested root wiring: `id` must match `^[1-9]\d{0,8}$` (the helper enforces it), render the item with the normal card/summary logic, verify a cached translation with `translated()` before use, link the headline through `/click?url=<item.url>` for measurement, and respond 404 for `storyLookup() === null`. Permalinks stay stable across rotation; the archived fallback keeps them working after the 14-day window.
* The root route order can be: `clickRoute` → `syndicationRoute` → `/search` page → existing routes; both helpers return `undefined` on other paths, `storyLookup` is data-only.

## Tests and verification

`npx vitest run test/search.test.ts test/trending.test.ts test/syndication.test.ts`, then full `npx tsc --noEmit` and `npx wrangler deploy --dry-run --outdir <tmp>`. Tests run real migration SQL (0001+0002+0003) with Node 22's built-in SQLite — actual FTS5 index, triggers and bucket math — covering: maintained index (insert/update/delete, stale-translation exclusion), original+translated matching, source/English filters, 14-day bound, pagination, FTS-injection safety, LIKE fallback, highlight escaping; known-destination-only redirects, HEAD-no-count, counting-failure-still-redirects, open-redirect rejection, rolling-24h aggregation and cleanup; RSS escaping/excerpts/publisher links, sitemap-only-own-permalinks, story lookup incl. archive fallback.

## Limitations

* FTS5 is required by the migration (D1 supports it); token folding is unicode61 case folding — `apagón` matches `APAGÓN`, but `apagon` ≠ `apagón` (accent folding is not part of the default tokenizer; LIKE fallback is ASCII-only case-insensitive).
* Search matches whole tokens, not substrings; prefixes need `*` which the sanitizer deliberately strips.
* Click counts under-count (no JS fallback counted, HEAD excluded by design, redirects blocked client-side never register). Story ids in `story_ids` persist after rotation by design; sitemap entries drop out of the join once articles rotate.
* RSS exposes original titles (translations are not duplicated into the feed); sitemap pins `https://news.dev.pr` regardless of the serving host, keeping cache keys and canonical URLs stable.
