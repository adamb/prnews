# news.dev.pr — Build Spec (v1, Nov 14 2026)

A fast, good-looking, Spanish-first page that lists today's Puerto Rico news from the island's outlets' RSS feeds. Similar stories from different outlets are grouped into one story, and everything is organized into sections. It links out to the outlets. It is not a republisher.

## 1. Goals / Non-goals
**Goals**
- One page showing what's happening in PR right now: headline, short summary, source, time, and image, grouped by section.
- Detect duplicates: one card per *story*, with an "También en: Metro · ENDI · Telemundo" chip row.
- Top stories ranked by how many outlets are covering them.
- Refresh about every 15 minutes, cost about $0 (Cloudflare free/paid-minimum tier), and need little upkeep.

**Non-goals (v1)**
- No full-article text, no scraping behind paywalls, no comments, no user accounts.
- No push notifications, no native app.
- No sources that need HTML scraping (the El Sol de PR and Noticias de Ponce sites).

## 2. Sources (measured Nov 14 2026, 00:25 AST, browser User-Agent)
Raw samples are in `/workspace/news-dev-pr/samples/`.

| id | Outlet | Feed URL | HTTP | Items | Volume | Summary (`description`) | Image | Categories | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `noticel` | NotiCel (**priority**) | `https://noticel.com/feed/` (+ `?paged=2`) | 200 | 10/page | ~50–70/day | HTML, ~530 chars, has WP boilerplate "The post … first appeared on NotiCel" | **none in feed**, so use `og:image` | yes: `Noticias`, `Última Hora`, `Policíacas`, `Gobierno`, `Deportes`, `Mundo` + tags | WordPress. Only 10 items per page, so poll every 15 min and also fetch `?paged=2`. Strip `utm_*` from links. Has ETag/Last-Modified. |
| `endi` | El Nuevo Día (GFR) | `https://www.elnuevodia.com/arc/outboundfeeds/rss/?outputType=xml&size=100` | 200 | 100 | ~90–110/day | plain text dek, ~125 chars, clean | `media:content` | none, so use URL path (`noticias/locales`, `negocios/turismo`, `opinion/…`, `deportes/beisbol`) | Arc. Category feeds `…/rss/category/{noticias,negocios,deportes,entretenimiento,opinion}/` work. `politica`, `economia`, and `salud` are empty (not ENDI sections). ETag/Last-Modified present. Opinion pieces are batch-stamped `03:10:00Z`. |
| `primerahora` | Primera Hora (GFR) | `https://www.primerahora.com/arc/outboundfeeds/rss/?outputType=xml&size=100` | 200 | 30 (default) | ~50/day | plain dek, ~130 chars | `media:content` | URL path (`noticias/policia-tribunales`, `noticias/gobierno-politica`, `entretenimiento/farandula`) | The old landing page `primerahora.com/rss` returns **500**, so use Arc. Category feed `…/category/noticias/` works. GFR shares stories with ENDI but **rewrites titles/slugs** (0 identical slugs in the sample), so this is handled by dedupe, not URL matching. |
| `metro` | Metro PR | `https://www.metro.pr/arc/outboundfeeds/rss/?outputType=xml` | 200 | 50 | ~70/day | plain dek, ~130 chars | `enclosure` | none, so use URL path (`noticias/`, `deportes/`, `entretenimiento/`, `sabrosia/`, `estilo-vida/`) | Also has `content:encoded` (full text, **don't display it**). No ETag. Use Last-Modified-less polling with a body hash. |
| `telemundo` | Telemundo PR | `https://www.telemundopr.com/?rss=y` | 200 | 50 | ~20–50/day | **`description` is broken** (the same article body on all 50 items). Use the `<excerpt>` element (~120 chars, good). | `media:content` | `category` is always `post`, so use URL path (`noticias/puerto-rico`, `noticias/eeuu`, `deportes-*`, `entretenimiento`, `tu-dinero`, `elecciones`) | **`pubDate` is broken**: the same timestamp on every item, in a non-RFC format (`Fri, Nov 13 2026 04:28:15 PM`). Use `first_seen_at` for time. Includes lots of US/national NBC content; tag it `EE.UU.`. |
| `laperla` | La Perla del Sur (Ponce) | `https://www.periodicolaperla.com/feed` | 200 | 10 | ~10–40/day | HTML, ~465 chars | none, so use `og:image` | yes: `Actualidad`, `Seguridad`, `Gente`, `Ponce` + junk tags `portada1..4` | **The XML has HTML entities (`&oacute;`) that strict parsers reject**, so unescape them before parsing or use a lenient parser. Region = Sur. |
| `sjds` | San Juan Daily Star (EN) | `https://www.sanjuandailystar.com/blog-feed.xml` | 200 | 20 | ~15–20/day | plain, truncated to 500 chars | `enclosure` | yes: `Local`, `Sports`, `Business`, `International`, `Mainland`, `En Español`, `Viewpoint` | **New finding: Wix has a feed** (the earlier note said no RSS). English. Feed is CDN-cached for 7 days (`max-age=604800`), so add a cache-buster query. |
| `elvocero` | El Vocero | `https://www.elvocero.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc` (+ `&c=gobierno` etc.) | **429** | – | – | – | – | BLOX sections: `gobierno`, `ley-y-orden`, `economia`, `deportes`, `escenario`, `opinion`, `detupueblo` | Every RSS/search endpoint returned 429 from my box (the homepage returns 200). **Phase 1: disabled.** Retry from the Worker's IP. If it's still rate-limited, poll at most once per hour, one request per run. |

Not available: Noticias de Ponce and El Sol de PR have no feed (skip). Aquí.PR is a newsletter (inspiration only).

**What this means:** every working source has a usable title, link, and ~120–530-character summary, so **no LLM is needed for v1 summaries**. Images come from the feed for ENDI, PH, Metro, Telemundo, and SJDS. NotiCel and La Perla need an `og:image` lookup. Only NotiCel, La Perla, and SJDS have real categories, so **URL path is the main section signal**.

## 3. Architecture (Cloudflare, one Worker)
- **One Cloudflare Worker** (TypeScript, Hono or plain `fetch` handler) with:
  - `scheduled` handler (cron `*/15 * * * *`) that runs the ingest.
  - `fetch` handler that server-renders HTML pages (no SPA framework; small CSS, with near-zero JS for the theme toggle and section tabs).
- **D1** (SQLite) for items, stories, and feed state. **KV is not needed.** Cache rendered HTML with the Cache API for 60 s.
- Optional later: **Workers AI** for an English toggle, embeddings, and summary fallback.
- Domain: `news.dev.pr` as a Worker custom domain (dev.pr DNS is already on Cloudflare).
- Repo layout: `src/ingest/*`, `src/classify.ts`, `src/dedupe.ts`, `src/render/*`, `src/sources.ts`, `migrations/*.sql`, `test/fixtures/` (copy of the samples above), `wrangler.toml`.
- Rationale: Adam already runs Pages and Workers. Cron, DB, and HTML all live in one deployable on the free tier. There's no server to babysit, and SSR keeps it fast and SEO-friendly.

## 4. Data model (D1)
```sql
sources(id TEXT PK, name, homepage, feed_url, lang, region, priority INT, enabled INT,
        etag, last_modified, last_hash, last_status INT, last_ok_at, last_error, consecutive_failures INT)
items(id INTEGER PK, source_id, guid, url_canonical UNIQUE, title, summary, image_url, author,
      published_at INT, first_seen_at INT, raw_categories TEXT /*json*/, url_section TEXT,
      section TEXT, region TEXT, lang, title_norm TEXT, shingles TEXT /*json minhash or token set*/,
      story_id INT, updated_at INT)
stories(id INTEGER PK, primary_item_id, section, first_seen_at, last_updated_at,
        source_count INT, item_count INT, score REAL)
CREATE INDEX items_recent ON items(first_seen_at); CREATE INDEX items_story ON items(story_id);
```
Keep 14 days of data, and purge older rows in the cron.

## 5. Ingest pipeline (per source, in parallel, each in its own try/catch)
1. **Fetch** with a real UA string (`news.dev.pr/1.0 (+https://news.dev.pr/about)` plus a browser fallback if a source 403s), `If-None-Match`/`If-Modified-Since`, and a 10 s timeout. A 304 means skip. A 429 or 5xx means back off (skip the next N runs, doubling each time up to 4 h).
2. **Pre-sanitize** the XML by converting HTML named entities to characters (La Perla). Parse with `fast-xml-parser` (lenient). Support RSS 2.0 and Atom.
3. **Normalize per item:**
   - **URL:** absolute, lowercase host, strip `utm_*`/`fbclid`/`#`, consistent trailing slash. This is the `url_canonical` and the exact-dup key.
   - **Title:** decode entities, collapse whitespace.
   - **Summary:** priority is `excerpt` (Telemundo) > `description` > the first 300 characters of `content:encoded`. Strip HTML, drop the WP "The post … appeared first on …" line and "[…]", then cut to ≤ 300 characters at a word boundary and add "…".
   - **Image:** `media:content[url]` > `media:thumbnail` > `enclosure[type^=image]` > first `<img>` in the HTML > **og:image lookup** (only for sources flagged `needsOgImage`; ≤ 20 page fetches per run; cache the result on the item and never refetch).
   - **Time:** `published_at` = parsed pubDate. If it fails to parse, is in the future, or is shared by > 5 items in one fetch, use `first_seen_at` (Telemundo).
   - **Category inputs:** `raw_categories` = `<category>` values, and `url_section` = the first 2 path segments.
4. **Upsert** on `url_canonical`. If the title or summary changed, update and re-run classify and dedupe for that item.
5. **Classify** (§7), then **dedupe** (§8), then recompute the story's score.
6. **Record feed health** (status, count, error, duration).

## 6. Summaries
- v1: show the feed dek as described in §5. That covers every working source today.
- Phase 3, if the summary is < 60 characters or missing: generate a 1–2-sentence Spanish summary from the title + summary + `content:encoded` when the feed provides it (Metro, NotiCel, La Perla). Never fetch article pages for this. Use Workers AI or an OpenAI-compatible endpoint (configurable `LLM_BASE_URL`/`LLM_MODEL`), and cache it per item.
- Phase 3: **EN toggle**. Translate the story headline + summary once per story, cache it, and add a `?lang=en` query param. Use SJDS's English text natively when it's the primary.

## 7. Sections and classification
Sections (fixed order in the nav, slug in parentheses):
Portada (top) · Gobierno y Política (`politica`) · Economía y Negocios (`negocios`) · Policiales y Tribunales (`policiales`) · Energía e Infraestructura (`energia`; LUMA/Genera/AEE/AAA/carreteras/aeropuerto are a constant PR story) · Salud (`salud`) · Educación (`educacion`) · Clima y Ambiente (`clima`) · Deportes (`deportes`) · Entretenimiento y Cultura (`entretenimiento`) · Estados Unidos y Mundo (`mundo`) · Opinión (`opinion`) · Otras (`otras`).
Regions as filter chips: Área Metro, Norte, Sur (Ponce), Este, Oeste (Mayagüez), Centro. These are set by `source.region` or by town names in the title/summary (a list of 78 municipios mapped to regions).

Classification order (first match wins; store `section` + `section_reason`):
1. **URL path map** per source. Examples: `opinion/*` → opinion; `noticias/policia-tribunales`, `noticias/tribunales` → policiales; `noticias/gobierno-politica`, `noticias/puerto-rico-voto`, `elecciones/*`, `corresponsalias/washington-dc` → politica; `negocios/*`, `tu-dinero/*`, `noticias/consumo` → negocios; `deportes*/*` → deportes; `entretenimiento/*`, `sabrosia/*`, `estilos-de-vida/*`, `estilo-vida/*` → entretenimiento; `noticias/estados-unidos`, `noticias/eeuu`, `noticias/mundo`, `noticias/texas` → mundo.
2. **Feed category map**: NotiCel `Policíacas` → policiales, `Gobierno`/`Legislatura` → politica, `Deportes` → deportes, `Mundo`/`Estados Unidos` → mundo. La Perla `Seguridad`/`Policia` → policiales. SJDS `Business` → negocios, `Sports` → deportes, `Mainland`/`International` → mundo, `Viewpoint` → opinion. Ignore generic categories (`Noticias`, `Última Hora`, `Actualidad`, `portada*`, `Local`).
3. **Keyword rules** (accent-folded, on title + summary, weighted, pick the highest score ≥ 2). Seed lists:
   - politica: gobernador(a), Fortaleza, Senado, Cámara, Legislatura, alcalde, PNP, PPD, MVC, PIP, comisionada residente, proyecto de ley, Junta de Supervisión Fiscal.
   - policiales: Policía, asesinato, arresto, tiroteo, NIE, fiscalía, tribunal, juez, acusado, ocupan.
   - energia: LUMA, Genera, AEE, apagón, Negociado de Energía, AAA, agua, carretera, aeropuerto, Aerostar.
   - negocios: Hacienda, IVU, empresa, economía, empleo, turismo, vivienda, inversión.
   - salud: hospital, Departamento de Salud, dengue, médico, Medicaid, Plan Vital.
   - educacion: Departamento de Educación, escuela, maestros, UPR.
   - clima: huracán, tormenta, lluvias, sequía, Meteorología, NWS, inundación, sargazo.
   - deportes: BSN, LBPRC, béisbol, baloncesto, Criollos, Cangrejeros, voleibol.
   - entretenimiento: concierto, Latin Grammy, reguetón, farándula, película, Bad Bunny.
   Keep the lists in `src/sections.ts` so Adam can edit them.
4. Otherwise `otras`. Phase 3: optional LLM classifier for `otras` only.
- **Story section** = the section of the primary item. If items disagree, take the majority, with ties going to the primary.

## 8. Duplicate detection (stories)
Tested on tonight's samples: token-set Jaccard on normalized titles caught the "palma en Piñones" story across all 6 outlets (0.86–1.0), Metro/NotiCel "AK-47 Canóvanas" at 0.89, and Telemundo/SJDS "Sequía 34.7%" at 0.86. A distinct-but-related FAA story pair scored 0.58, so the threshold matters.
1. **Exact**: the same `url_canonical` means the same item (this also handles PH main vs category feeds and NotiCel page 1 vs 2).
2. **Normalize the title**: lowercase, strip accents, map `por ciento` → `%`, drop Spanish stopwords and punctuation, then make a token set. Also add the first 25 summary tokens as a secondary set.
3. **Candidates**: items from **other sources** with `first_seen_at` within ±48 h. That's only a few hundred rows, so brute force is fine and MinHash isn't needed at this scale.
4. **Score** = 0.7·J(title) + 0.3·J(title+summary). A score **≥ 0.55** joins the best-matching story. 0.40–0.55 joins only if they also share ≥ 2 capitalized entities or numbers (e.g. `Piñones`, `34.7`, `AK-47`). Never merge two items from the same source unless it's an exact URL match.
5. **ENDI ↔ Primera Hora**: same rules (GFR rewrites the titles). When both are in a story, show one chip "ENDI / Primera Hora" and prefer the ENDI link.
6. **Primary item**: priority NotiCel (100) > ENDI (80) > Metro (70) > Primera Hora (60) > Telemundo (60) > La Perla (50) > SJDS (40, or primary when the user picks EN). Break ties with the earliest `published_at`. If a story has an item with an image and the primary has none, borrow that image (with the right credit and link on hover).
7. **Score** for ranking Portada = `source_count*3 + recency_decay(hours, half-life 6h) + (has_image?0.5:0)`.
8. Phase 3: swap in an embedding similarity (Workers AI `bge-m3`, multilingual) for the 0.40–0.55 gray zone and the EN↔ES matches.

## 9. UI / UX
- Spanish UI. Mobile-first, with a max width of 1100 px. System font stack plus an optional serif for headlines. `prefers-color-scheme` dark mode with a toggle stored in localStorage. Lighthouse ≥ 95. No ads, no trackers.
- **Header**: "news.dev.pr · Noticias de Puerto Rico", last-updated time ("actualizado hace 4 min"), and sticky **section tabs** that scroll horizontally on mobile.
- **Portada** (`/`):
  - "Lo más cubierto": the top 6 stories by score, as large cards (16:9 image, headline, 2-line summary, primary source + time-ago, and a chip row with the other sources, each linking to that outlet's article).
  - Below that, one block per section with its 5 newest stories as compact rows (headline, source · time-ago, 64 px thumbnail) and a "Ver más →" link to `/s/{slug}`.
- **Section page** (`/s/{slug}`): a chronological list of stories, paginated in batches of 30 with `?before=` cursors.
- **Card behavior**: the headline links to the primary article (`target=_blank rel=noopener`). Times show in America/Puerto_Rico, as relative times under 24 h and as "13 nov, 5:37 p.m." after that. Lazy-load images through Cloudflare Image Resizing, or use the plain URL with `loading=lazy`, width/height set, and a neutral placeholder.
- **Region chips** filter on the section pages. **Search** comes in Phase 3 (D1 FTS5 on title + summary).
- **Other pages**: `/fuentes` (source list + health), `/about` (attribution policy).
- Also serve `/feed.xml` (a combined RSS of stories) and `/api/stories.json`.

## 10. Attribution and legal
- Show only the headline, a ≤ 300-character dek from the outlet's own feed, a thumbnail, and the outlet name. Always link to the original. Never display `content:encoded`/full text. Respect paywalls (link only).
- Hotlink images from the outlet's CDN, or proxy them via resizing with the outlet credit. Remove a source immediately if it objects (a contact email goes on `/about`).
- Fetch only the feeds and `og:image` from article pages. Obey robots.txt (none of the feed paths are disallowed for `*`), and use the identifying UA with a contact URL.

## 11. Ops
- Per-feed isolation: one bad feed never breaks the run. Store `last_status`, `last_error`, and `consecutive_failures`, and auto-disable a feed after 24 h of failures (keep it visible on `/fuentes`).
- **`/fuentes` health page**: one row per source with the last OK time, HTTP status, items in the last 24 h, the last error, and a green/amber/red dot.
- Log a cron summary line per run (`wrangler tail`). Run time should be < 30 s. Use `ctx.waitUntil` for the og:image lookups.
- Tests: vitest with `test/fixtures/*.xml` (the real samples), covering parse, normalize (Telemundo dates/excerpt, La Perla entities, NotiCel boilerplate/utm), classification, and the dedupe pairs listed in §8.

## 12. Milestones and acceptance criteria
**Phase 1 — MVP list (no dedupe)**
- Worker + D1 + cron is deployed to a workers.dev URL. Sources enabled: noticel, endi, primerahora, metro, telemundo, laperla, sjds. El Vocero is present but `enabled=0`.
- Done when:
  - (a) The cron ingests all 7 sources with no parse errors. `/fuentes` shows each one green with an item count.
  - (b) `/` shows stories grouped by the §7 sections, and ≥ 85% of items land in a non-`otras` section.
  - (c) Every card has a headline, a clean summary (no HTML, no "appeared first on", ≤ 300 characters), source, and a correct PR-time relative time. Telemundo times aren't all identical.
  - (d) ≥ 90% of cards have images, including NotiCel through og:image.
  - (e) Dark mode, mobile layout, and Lighthouse ≥ 90.
  - (f) Fixture tests pass.

**Phase 2 — Stories and dedupe**
- Stories table, the §8 algorithm, the "También en" chips, the "Lo más cubierto" ranking, and the ENDI/Primera Hora merge.
- Done when:
  - The fixture pairs merge (palma ×6, AK-47, Sequía).
  - The two different FAA stories stay separate.
  - No story contains two items from one source.
  - Duplicate rate on Portada, spot-checked by hand, is < 5%.
- Also in this phase: custom domain `news.dev.pr`.

**Phase 3 — Polish**
- FTS5 search, region filters, `/feed.xml`, LLM summary fallback for summaries under 60 characters, EN toggle, embedding gray-zone dedupe, and the LLM classifier for `otras`.
- Retry El Vocero (section feeds, 1 per hour).

## 13. Prompt for the coding agent (Phase 1)
> You're building **news.dev.pr**, a Cloudflare Worker (TypeScript) + D1 news aggregator for Puerto Rico. Read `SPEC.md` in this repo and implement **Phase 1 only** (§12). Constraints:
> - A single Worker with a `scheduled` handler (cron `*/15 * * * *`) for ingest, and a `fetch` handler that server-renders HTML. No React/SPA. Use `fast-xml-parser` and `vitest`.
> - Put the sources exactly as in the §2 table into `src/sources.ts`, including the per-source quirks: Telemundo uses `<excerpt>` and ignores pubDate; La Perla needs HTML-entity pre-sanitizing; NotiCel needs WP boilerplate and `utm_*` stripping, `?paged=2`, and og:image; SJDS needs a cache-buster. El Vocero goes in with `enabled=0`.
> - D1 schema from §4 goes in `migrations/0001_init.sql`. Ingest follows §5 exactly, including ETag/If-Modified-Since and backoff. Classification follows §7 (URL path map → feed category map → keyword rules → `otras`), with the lists in `src/sections.ts`.
> - UI follows §9 (Portada grouped by section, `/s/{slug}`, `/fuentes`), is Spanish, mobile-first, has dark mode, uses PR timezone relative times, and is attribution-only (§10).
> - Copy the XML files from the provided `samples/` into `test/fixtures/` and write tests for parsing/normalizing each source and for classification.
> - Give me the `wrangler` commands to create the D1 database, apply migrations, run locally (`wrangler dev --test-scheduled`), and deploy. Don't touch DNS.
> Stop after Phase 1 is complete and tests pass, then show me the local URL and a summary of the acceptance checks.
