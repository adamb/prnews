/**
 * Additional Puerto Rico news feeds. WAPA, WIPR and Claridad were verified on
 * 2026-11-14; Radio Isla 1320 and WALO 1240 on 2026-11-19; news.pr on
 * 2026-11-19 (see docs/sources-status-integration.md and docs/newspr-source.md).
 * Semanario Visión, La Calle Digital, Periódico El Sol, Es Noticia PR, El
 * Oriental, La Esquina, 9 millones, ¡Ey! Boricua, Pasquines, WKAQ 580 and
 * Periódico Presencia were verified on 2026-11-20 (see docs/pr-outlet-feeds.md;
 * every requested outlet that did not clear verification is recorded in
 * `unavailableSources` below, with the evidence).
 * `sources` and `ingest` already append
 * `additionalSources` and merge `additionalFeedURLs`, so a new entry here is
 * the registry change. Parsing, the 300-character excerpt cap, image recovery
 * and translation stay on the shared pipeline.
 *
 * Only feeds that answered 200 with parseable items and their publisher's own
 * homepage are listed. Unreachable or hijacked domains are recorded in
 * `unavailableSources` with the evidence — never as feed entries.
 */
import type { Source } from './sources';

/** Publisher's live RSS; `files` name the saved fixtures used by tests. */
export const additionalSources: Source[] = [
 { id: 'wapa', name: 'WAPA', homepage: 'https://wapa.tv', files: ['wapa.xml'] },
 { id: 'wipr', name: 'WIPR', homepage: 'https://wipr.pr', files: ['wipr.xml'] },
 { id: 'claridad', name: 'Claridad', homepage: 'https://claridadpuertorico.com', files: ['claridad.xml'] },
 { id: 'radioisla', name: 'Radio Isla 1320', homepage: 'https://radioisla.tv', files: ['radioisla.xml'] },
 { id: 'walo', name: 'WALO 1240 · Humacao', homepage: 'https://waloradio.com', files: ['walo.xml'] },
 { id: 'newspr', name: 'news.pr', homepage: 'https://news.pr', files: ['newspr.xml'] },
 { id: 'vision', name: 'Semanario Visión', homepage: 'https://periodicovision.com', files: ['vision.xml'] },
 { id: 'lacalle', name: 'La Calle Digital', homepage: 'https://lacallerevista.com', files: ['lacalle.xml'] },
 { id: 'elsol', name: 'Periódico El Sol', homepage: 'https://periodicoelsolpr.com', files: ['elsol.xml'] },
 { id: 'esnoticia', name: 'Es Noticia PR', homepage: 'https://esnoticiapr.com', files: ['esnoticia.xml'] },
 { id: 'eloriental', name: 'El Oriental', homepage: 'https://periodicoeloriental.com', files: ['eloriental.xml'] },
 { id: 'laesquina', name: 'La Esquina', homepage: 'https://laesquina.com', files: ['laesquina.xml'] },
 { id: 'millones', name: '9 millones', homepage: 'https://www.9millones.com', files: ['millones.xml'] },
 { id: 'eyboricua', name: '¡Ey! Boricua', homepage: 'https://eyboricua.com', files: ['eyboricua.xml'] },
 { id: 'pasquines', name: 'Pasquines', homepage: 'https://pasquines.us', files: ['pasquines.xml'] },
 { id: 'wkaq', name: 'WKAQ 580', homepage: 'https://www.wkaq580.com', files: ['wkaq.xml'] },
 { id: 'presencia', name: 'Periódico Presencia', homepage: 'https://presenciapr.com', files: ['presencia.xml'] },
];

/** feedURL map entries for src/ingest's `feeds` record (merge, don't replace). */
export const additionalFeedURLs: Record<string, string[]> = {
 wapa: ['https://wapa.tv/search/?f=rss&t=article&l=50&s=start_time&sd=desc'],
 wipr: ['https://wipr.pr/feed/'],
 claridad: ['https://claridadpuertorico.com/feed/'],
 radioisla: ['https://radioisla.tv/feed/'],
 // Main feed, not /category/noticias/feed/: the category feed drops police items.
 walo: ['https://waloradio.com/feed/'],
 // The public RSS, never the subscriber-gated /feed page. See docs/newspr-source.md.
 newspr: ['https://news.pr/rss.xml'],
 // Verified 2026-11-20 (docs/pr-outlet-feeds.md). The paths below are the
 // publisher's own feeds, allowed by each site's robots.txt.
 vision: ['https://periodicovision.com/feed/'],
 lacalle: ['https://lacallerevista.com/feed'],
 elsol: ['https://periodicoelsolpr.com/feed/'],
 esnoticia: ['https://esnoticiapr.com/feed/'],
 // The site serves its homepage for /feed/-style paths; the WordPress query
 // form is the one address that returns the real RSS (rechecked 2026-11-20).
 eloriental: ['https://periodicoeloriental.com/?feed=rss2'],
 laesquina: ['https://laesquina.com/feed/'],
 // Webflow's public collection RSS for the /story/ collection (not a sitemap).
 millones: ['https://www.9millones.com/story/rss.xml'],
 eyboricua: ['https://eyboricua.com/feed/'],
 // Bilingual publisher; see the isEnglishSource note in src/sources.ts.
 pasquines: ['https://pasquines.us/feed/'],
 // Keywordless TownNews search RSS, same pattern as WAPA/El Vocero; robots.txt
 // disallows only /tncms/search/, and the #topstory variant returns zero items.
 wkaq: ['https://www.wkaq580.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc'],
 presencia: ['https://presenciapr.com/feed/'],
};

export interface UnavailableSource { name: string; homepage: string; reason: string }

/** Verified-unusable publishers; kept visible so root never has to guess. */
export const unavailableSources: UnavailableSource[] = [
 {
  name: 'El Post Antillano',
  homepage: 'https://www.elpostantillano.com',
  reason: 'Domain lapsed/parked: homepage and /feed/ now serve unrelated Japanese spam content; postantillano.com is unreachable and elpostantillano.net returns HTTP 406. No trustworthy feed exists as of 2026-11-14.',
 },
 {
  name: 'La Isla Oeste',
  homepage: 'https://laislaoeste.com',
  reason: 'Verified unusable on 2026-11-20: the homepage returned HTTP 403 to this site\u2019s crawler (news.dev.pr/1.0) and /feed/, /feed, /rss, /rss.xml, /atom.xml and /index.xml all returned 404. A plain block, not a challenge; no bypass was attempted and no public feed exists.',
 },
 {
  name: 'Sin Comillas',
  homepage: 'https://sincomillas.com',
  reason: 'Verified unusable on 2026-11-20: robots.txt disallows /feed for User-agent: * (it also asks for a 60-second crawl delay), and /rss 301-redirects to that same disallowed /feed/. The disallowed feed was never ingested; no allowed feed path exists.',
 },
 {
  name: 'TeleOnce',
  homepage: 'https://teleonce.com',
  reason: 'Verified unusable on 2026-11-20: /feed/ returns HTTP 200 with a valid RSS document that contains zero items (rechecked the same day). Registering it would record a "no usable articles" failure every 15 minutes, so it stays out until the feed ships items.',
 },
 {
  name: 'NotiUno 630',
  homepage: 'https://www.notiuno.com',
  reason: 'Verified unusable on 2026-11-20: /feed/, /rss, /rss.xml, /atom.xml and /index.xml all return 404, and the only article feed is the TownNews search RSS under /search/, which robots.txt disallows for User-agent: *. Disallowed paths are never fetched, so no feed is registered.',
 },
];

/** Every additional source id has exactly one feed entry and vice versa. */
export const additionalMappingIsConsistent = (urls: Record<string, string[]> = additionalFeedURLs): boolean =>
 additionalSources.every((s) => Array.isArray(urls[s.id]) && urls[s.id].length > 0) &&
 Object.keys(urls).length === additionalSources.length;
