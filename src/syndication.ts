import {quarantined} from './quarantine';
import { sources } from './sources';
import type { Item } from './parse';
import type { Translation } from './i18n';
import { alternateLinks, BILINGUAL_PATHS, englishStoryAvailable, pagePair, PUBLIC_ORIGIN, storyPair } from './seo';

/**
 * Syndication: RSS 2.0, a sitemap of *own* story permalinks, and the
 * /story?id= lookup helper the root route layer can render pages from.
 * Tables come from migrations/0003_search_clicks.sql.
 */
export interface SyndicationEnv { DB: D1Database }

export const SITE_ORIGIN = PUBLIC_ORIGIN;
export const RSS_PAGES = ['feed', 'rss.xml', 'feed.xml'];
export const RSS_LIMIT = 50;
export const SITEMAP_PATH = 'sitemap.xml';
export const SITEMAP_LIMIT = 500;
export const STORY_PATH = 'story';
export const EXCERPT_MAX = 300;

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sourceName = (id: string) => sources.find(s => s.id === id)?.name ?? id;
const sourceHomepage = (id: string) => sources.find(s => s.id === id)?.homepage ?? '';

/** Clamps plain text to EXCERPT_MAX characters; never emits article full text. */
export const excerpt = (s: string, max: number = EXCERPT_MAX) => s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd() + '…';

const httpUrl = (item: Item): string => {
  try { const u = new URL(item.url); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
};

const xmlHeaders = (type: string) => ({ 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'public, max-age=300' });
const methodOr = (request: Request): Response | undefined =>
  request.method !== 'GET' && request.method !== 'HEAD' ? new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }) : undefined;

/**
 * Handles GET/HEAD for /rss.xml (+ /feed.xml alias). Item <link>/<guid> are the
 * *original* foreign article URLs; titles, sources and descriptions are always
 * XML-escaped, descriptions are <=300-char excerpts only.
 */
export async function rssRoute(request: Request, env: SyndicationEnv, now: number = Date.now()): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!RSS_PAGES.includes(url.pathname.slice(1))) return undefined;
  const guarded = methodOr(request);
  if (guarded) return guarded;
  const rows = await env.DB.prepare('SELECT payload FROM articles WHERE published_at>=? ORDER BY published_at DESC LIMIT ?').bind(now-14*86400000,RSS_LIMIT).all<{ payload: string }>();
  const items = rows.results.map(r => JSON.parse(r.payload) as Item).filter(i => httpUrl(i));
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>news.dev.pr</title><link>${SITE_ORIGIN}/</link><description>Noticias de Puerto Rico · Puerto Rico news from many sources in one place</description><language>es-PR</language><lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate><ttl>15</ttl>${items.filter(item => !quarantined(item.url) && !quarantined(sourceHomepage(item.source))).map(item => `<item><title>${xmlEscape(item.title)}</title><link>${xmlEscape(httpUrl(item))}</link><guid isPermaLink="true">${xmlEscape(httpUrl(item))}</guid><pubDate>${new Date(item.time).toUTCString()}</pubDate><source url="${xmlEscape(sourceHomepage(item.source))}">${xmlEscape(sourceName(item.source))}</source><description>${xmlEscape(excerpt(item.summary))}</description></item>`).join('')}</channel></rss>`;
  return respondXml(request, body, xmlHeaders('application/rss+xml'));
}

/**
 * Handles GET/HEAD for /sitemap.xml. Static pages are listed in both editions.
 * Story <loc> values are news.dev.pr summary permalinks. The English story URL
 * is a second entry, and an alternate, only when that edition returns 200.
 * Foreign article URLs are never listed.
 */
export async function sitemapRoute(request: Request, env: SyndicationEnv, now: number = Date.now()): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== `/${SITEMAP_PATH}`) return undefined;
  const guarded = methodOr(request);
  if (guarded) return guarded;
  const rows = await env.DB.prepare('SELECT s.id, a.published_at, a.payload, a.translation FROM story_ids s JOIN articles a ON a.url=s.url WHERE a.published_at>=? ORDER BY a.published_at DESC LIMIT ?').bind(now-14*86400000,SITEMAP_LIMIT).all<{ id: number; published_at: number; payload: string; translation: string | null }>();
  const staticEntries = BILINGUAL_PATHS.flatMap(path => {
    const pair = pagePair(path);
    const links = alternateLinks(pair.es, pair.en, xmlEscape, 'xml');
    return [pair.es, pair.en].map(loc => `<url><loc>${xmlEscape(loc)}</loc>${links}</url>`);
  }).join('');
  const storyEntries = rows.results.map(row => {
    const pair = storyPair(row.id);
    let item: Item | null = null;
    let translation: Translation | null = null;
    try { item = JSON.parse(row.payload) as Item; } catch { item = null; }
    if (row.translation) { try { translation = JSON.parse(row.translation) as Translation; } catch { translation = null; } }
    const en = item && englishStoryAvailable(item, translation) ? pair.en : null;
    const links = alternateLinks(pair.es, en, xmlEscape, 'xml');
    const lastmod = `<lastmod>${new Date(row.published_at).toISOString().slice(0, 10)}</lastmod>`;
    const spanish = `<url><loc>${xmlEscape(pair.es)}</loc>${lastmod}${links}</url>`;
    return en ? spanish + `<url><loc>${xmlEscape(en)}</loc>${lastmod}${links}</url>` : spanish;
  }).join('');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${staticEntries}${storyEntries}</urlset>`;
  return respondXml(request, body, xmlHeaders('application/xml'));
}

/** Combined helper the root fetch handler can call first: rss → sitemap → undefined. */
export const syndicationRoute = (request: Request, env: SyndicationEnv, now: number = Date.now()) =>
  rssRoute(request, env, now).then(r => r ?? sitemapRoute(request, env, now));

function respondXml(request: Request, body: string, headers: Record<string, string>): Response {
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

/** Builds a stable on-site permalink for a story_ids id. */
export const storyPermalink = (origin: string, id: number | string): string =>
  `${origin.replace(/\/+$/, '')}/${STORY_PATH}?id=${encodeURIComponent(String(id))}`;

export interface StoryResult { item: Item; translation: Translation | null; publishedAt: number; from: 'articles' | 'archive' }

/**
 * Resolves /story?id=<n> to renderable content. Prefer articles (current
 * 14-day window); otherwise fall back to the latest archived revision so the
 * permalink keeps working after the article rotates out. Unknown or invalid
 * ids return null. The stored `translation` may be stale — renderers should
 * verify it against the item, e.g. with translated() from src/i18n.ts.
 */
export async function storyLookup(env: SyndicationEnv, id: string | number): Promise<StoryResult | null> {
  const key = String(id);
  if (!/^[1-9]\d{0,8}$/.test(key)) return null;
  try {
    const row = await env.DB.prepare('SELECT a.payload, a.translation, a.published_at FROM story_ids s JOIN articles a ON a.url=s.url WHERE s.id=?').bind(Number(key)).first<{ payload: string; translation: string | null; published_at: number }>();
    if (row) {
      const item = JSON.parse(row.payload) as Item;
      return { item, translation: row.translation ? JSON.parse(row.translation) as Translation : null, publishedAt: row.published_at, from: 'articles' };
    }
    const archive = await env.DB.prepare('SELECT payload, translation, captured_at FROM archive_revisions WHERE url=(SELECT url FROM story_ids WHERE id=?) ORDER BY id DESC LIMIT 1').bind(Number(key)).first<{ payload: string; translation: string | null; captured_at: number }>();
    if (archive) {
      const item = JSON.parse(archive.payload) as Item;
      return { item, translation: archive.translation ? JSON.parse(archive.translation) as Translation : null, publishedAt: archive.captured_at, from: 'archive' };
    }
    return null;
  } catch { return null; }
}
