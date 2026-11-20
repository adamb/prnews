# Requested Puerto Rico outlets — verification, 2026-11-20

The user asked for fifteen outlets on 2026-11-20. Eleven verified and were
registered on the shared source pipeline (`src/additional-sources.ts`); four did
not clear verification and are recorded in `unavailableSources` with the
evidence. CPI (Centro de Periodismo Investigativo, periodismoinvestigativo.com)
was retracted by the user before any check and was never probed, reviewed or
registered; it stays excluded.

Method: one crawler identity, `news.dev.pr/1.0 (+https://news.dev.pr/about)`,
the same User-Agent the live scheduler sends. Requests were bounded — homepage,
`robots.txt`, candidate feed paths, and one saved capture per feed. No blocks
were bypassed, no subscriber feeds or sitemaps were used as article sources,
and no article HTML was fetched beyond the feed documents. The first pass and
its saved captures are Grok's work (2026-11-20, interrupted task); the El
Oriental and WKAQ feed addresses were re-verified live the same day during the
handoff, and the blocked-outlet robots rules were re-read before documenting
them.

## Registered (11)

| Outlet (official identity) | Feed | Capture |
| --- | --- | --- |
| Semanario Visión — "El Regional Noroeste" (periodicovision.com) | `https://periodicovision.com/feed/` | 2026-11-20, 10 items |
| La Calle Digital — "Noticias del Área Oeste" (lacallerevista.com) | `https://lacallerevista.com/feed` | 2026-11-20, 10 items |
| Periódico El Sol — "el periódico regional más importante del sur" (periodicoelsolpr.com) | `https://periodicoelsolpr.com/feed/` | 2026-11-20, 10 items |
| Es Noticia PR — "Informa con compromiso y credibilidad" (esnoticiapr.com) | `https://esnoticiapr.com/feed/` | 2026-11-20, 10 items |
| El Oriental — "#tuvozturegiontuperiodico" (periodicoeloriental.com) | `https://periodicoeloriental.com/?feed=rss2` | 2026-11-20, 10 items |
| La Esquina — "El Periódico y la Voz del Sureste" (laesquina.com) | `https://laesquina.com/feed/` | 2026-11-20, 10 items |
| 9 millones — "Independent News Network in Puerto Rico" (9millones.com) | `https://www.9millones.com/story/rss.xml` | 2026-11-20, 100 items |
| ¡Ey! Boricua — "Informando a los puertorriqueños" (eyboricua.com) | `https://eyboricua.com/feed/` | 2026-11-20, 10 items |
| Pasquines — bilingual US-territories policy outlet (pasquines.us) | `https://pasquines.us/feed/` | 2026-11-20, 10 items |
| WKAQ 580 — "WKAQ580 (WAPA Media)" (wkaq580.com) | `https://www.wkaq580.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc` | 2026-11-20, 50 items |
| Periódico Presencia (presenciapr.com) | `https://presenciapr.com/feed/` | 2026-11-20, 10 items |

All are on the shared pipeline: 15-minute checks, canonical-URL D1 upsert,
14-day article window, ≤300-character excerpts, image recovery and R2 archive.
Fixtures are saved under `test/fixtures/` with `.headers` provenance notes, and
`/comparar` shows the November 20 registration date so earlier blank days stay
dashes.

Per-outlet notes:

- **Semanario Visión** is the outlet's own name; the user's shorthand was
  "Periódico Visión". The feed ships no images; the bounded og:image recovery
  and the monogram fallback apply.
- **El Oriental**: the site serves its homepage HTML for `/feed/`, `/rss` and
  `/rss.xml`, and its `robots.txt` URL also returns the homepage (no rules, so
  default-allow). The WordPress query form `?feed=rss2` is the one address that
  returns the real RSS; it was re-fetched live and matched the saved fixture.
  Permalinks are query-string form (`?p=…`) and are kept exactly as published.
- **La Esquina**: identity confirmed on the publisher's own homepage title —
  "LaEsquina.com – El Periódico y la Voz del Sureste de Puerto Rico". Feed
  permalinks are `laesquina.com/blog/yyyy/mm/dd/…`. No sitemap or slug-derived
  articles were used.
- **9 millones** is a Webflow site with no WordPress feed; `/story/rss.xml` is
  Webflow's public collection RSS (not a sitemap). At capture the newest item
  was 17 days old, so every item sat outside the 14-day upsert window; the feed
  still parses, and the next published story is captured on the next scan. 94 of
  100 items ship only the "| 9 millones" suffix as their title; they are stored
  exactly that way — nothing is invented to fill them.
- **Pasquines** publishes Spanish and English on one feed, so it follows the
  San Juan Daily Star mechanism (`isEnglishSource` in `src/sources.ts`): items
  without a per-article language signal keep an English default, and
  demonstrably Spanish items (`originalLanguage='es'`) enter the shared
  Spanish→English translation queue. The 2026-11-20 capture was
  English-dominant; this keeps English originals readable in the English
  edition instead of hiding them as eternally pending. The homepage sits
  behind a Cloudflare challenge for this crawler, but the feed itself answers
  200 and robots.txt allows it.
- **WKAQ 580** was requested again by the user even though it duplicates WAPA
  coverage (both are WAPA Media). It is registered, and the duplication is
  reported, not hidden: comparing the saved captures, 5 of WKAQ's 50 titles
  exactly matched WAPA's 50 ("Gobernadora anuncia pago de bono de Navidad…",
  "Remueven a maestro que presuntamente perreó…", "Los Taínos de la UAGM,
  primeros finalistas…", "Itinerario de la Pro por WAPA Deportes", "Dayanara
  Torres…"), 6 by 48-character prefix. All WKAQ links point to
  `www.wkaq580.com`, so both outlets keep their own canonical URLs and
  lifetime clicks; the homepage "same event, shown once" fold may collapse the
  near-identical pairs on the front page. robots.txt disallows only
  `/tncms/*` paths; the keywordless `/search/` RSS is allowed, and the
  `#topstory` variant returned zero items.

## Requested but not registered (4), with evidence

- **La Isla Oeste** (laislaoeste.com): homepage returned HTTP 403 to the site's
  crawler (a plain block, not a challenge — no bypass attempted) and `/feed/`,
  `/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/index.xml` all returned 404. No
  public feed exists.
- **Sin Comillas** (sincomillas.com): `robots.txt` disallows `/feed` for
  `User-agent: *` (and asks for a 60-second crawl delay); `/rss` 301-redirects
  to that same disallowed `/feed/`. A feed body reached through that redirect
  was inspected once for diagnosis and never committed or ingested. No allowed
  feed path exists.
- **TeleOnce** (teleonce.com): `/feed/` returns HTTP 200 with a valid RSS
  document containing zero items (rechecked the same day). Registering it
  would record a "no usable articles" failure every 15 minutes, so it stays out
  until the feed ships items.
- **NotiUno 630** (notiuno.com): `/feed/`, `/rss`, `/rss.xml`, `/atom.xml` and
  `/index.xml` all return 404, and the only article feed is the TownNews
  search RSS under `/search/`, which robots.txt disallows for `User-agent: *`.
  Disallowed paths are never fetched, so no feed is registered.

## Excluded by the user, never reviewed

- **CPI — Centro de Periodismo Investigativo** (periodismoinvestigativo.com):
  the user retracted it before any probe. It was not fetched, reviewed, or
  registered, and should not be suggested for this site's source work.
