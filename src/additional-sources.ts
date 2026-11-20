/**
 * Additional Puerto Rico news feeds. WAPA, WIPR and Claridad were verified on
 * 2026-11-14; Radio Isla 1320 and WALO 1240 on 2026-11-19; news.pr on
 * 2026-11-19 (see docs/sources-status-integration.md and docs/newspr-source.md).
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
};

export interface UnavailableSource { name: string; homepage: string; reason: string }

/** Verified-unusable publishers; kept visible so root never has to guess. */
export const unavailableSources: UnavailableSource[] = [
 {
  name: 'El Post Antillano',
  homepage: 'https://www.elpostantillano.com',
  reason: 'Domain lapsed/parked: homepage and /feed/ now serve unrelated Japanese spam content; postantillano.com is unreachable and elpostantillano.net returns HTTP 406. No trustworthy feed exists as of 2026-11-14.',
 },
];

/** Every additional source id has exactly one feed entry and vice versa. */
export const additionalMappingIsConsistent = (urls: Record<string, string[]> = additionalFeedURLs): boolean =>
 additionalSources.every((s) => Array.isArray(urls[s.id]) && urls[s.id].length > 0) &&
 Object.keys(urls).length === additionalSources.length;
