import { isEnglishSource, sources } from './sources';
import type { Item } from './parse';
import type { Translation } from './i18n';

/**
 * D1-backed full-text search over the maintained `articles_fts` FTS5 index
 * (original + valid cached translated title/summary — see
 * migrations/0003_search_clicks.sql), with an automatic LIKE fallback.
 *
 * Contract: newest-first, 30 per page, optional 14-day bound, optional source and
 * English-readable filters. All values are bound; user text is never spliced
 * into SQL. `highlight()` is XSS-safe.
 */
export interface SearchEnv { DB: D1Database }

export const SEARCH_PAGE_SIZE = 30;
export const SEARCH_MAX_PAGES = 50;
export const SEARCH_MAX_QUERY = 200;
export const SEARCH_MAX_TERMS = 8;
export const SEARCH_WINDOW_MS = 14 * 86400000;

/** 'fts' = FTS5 MATCH, 'like' = escaped LIKE fallback, 'filter' = no query terms. */
export type SearchEngine = 'fts' | 'like' | 'filter';

export interface SearchParams {
  /** Free text; FTS5-syntax characters are stripped and each token is quoted. */
  q?: string;
  range?: 'recent' | 'all';
  /** Source id; unknown ids are ignored (same convention as the rendered filters). */
  source?: string;
  /** Only English-readable rows: English sources (sjds/nimb) or a valid translation. */
  english?: boolean;
  /** 1-based page. Out-of-range or invalid values clamp into 1..SEARCH_MAX_PAGES. */
  page?: number;
}

export interface SearchResult {
  items: Item[];
  /** Per-URL cached translations, ready to hand to the renderer's LiveData. */
  translations: Record<string, Translation>;
  page: number;
  hasNext: boolean;
  engine: SearchEngine;
  /** Tokens the query was reduced to; pass to highlight(). */
  terms: string[];
}

const englishSources = sources.filter(s => isEnglishSource(s.id)).map(s => s.id);
const VALID_TRANSLATION =
  "translation IS NOT NULL AND json_extract(translation,'$.originalTitle')=json_extract(payload,'$.title') AND json_extract(translation,'$.originalSummary')=json_extract(payload,'$.summary')";

/** Reduces free text to safe FTS5 tokens: letters/numbers only, bounded count/length. */
export function parseSearchTerms(q: string): string[] {
  return q
    .slice(0, SEARCH_MAX_QUERY)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map(t => t.slice(0, 48))
    .filter(Boolean)
    .slice(0, SEARCH_MAX_TERMS); // each token is quoted later, so FTS5 syntax can never inject
}

/** Builds the MATCH string; every term is double-quoted so it is a literal. */
export const ftsQuery = (terms: string[]) => terms.map(t => `"${t}"`).join(' ');

const likeEscape = (t: string) => t.replace(/[\\%_]/g, c => `\\${c}`);

interface Compiled { sql: string; binds: (string | number)[] }

/** Builds one bounded SELECT whose shape depends only on server-side flags. */
function compileFilters(params: SearchParams, now: number): Compiled {
  const source = sources.some(s => s.id === params.source) ? params.source! : '';
  const sql: string[] = ['SELECT payload, translation FROM articles', 'WHERE 1=1'];
  const binds: (string | number)[] = [];
  if (params.range === 'recent') { sql.push('AND published_at>=?'); binds.push(now - SEARCH_WINDOW_MS); }
  if (source) { sql.push('AND source=?'); binds.push(source); }
  if (params.english) {
    sql.push(`AND (source IN (${englishSources.map(() => '?').join(',')}) OR json_extract(payload,'$.originalLanguage')='en' OR ${VALID_TRANSLATION})`);
    binds.push(...englishSources);
  }
  return { sql: sql.join(' '), binds };
}

const PAGE_SUFFIX = ' ORDER BY published_at DESC, url ASC LIMIT ? OFFSET ?';

async function runSearch(env: SearchEnv, params: SearchParams, now: number, engine: SearchEngine, extraSql: string, extraBinds: (string | number)[], terms: string[]): Promise<SearchResult> {
  const page = Number.isInteger(params.page) && params.page! >= 1 ? Math.min(params.page!, SEARCH_MAX_PAGES) : 1;
  const { sql, binds } = compileFilters(params, now);
  const result = await env.DB.prepare(sql + (extraSql ? ` AND (${extraSql})` : '') + PAGE_SUFFIX)
    .bind(...binds, ...extraBinds, SEARCH_PAGE_SIZE + 1, (page - 1) * SEARCH_PAGE_SIZE)
    .all<{ payload: string; translation: string | null }>();
  const rows = result.results.slice(0, SEARCH_PAGE_SIZE);
  const translations: Record<string, Translation> = {};
  const items = rows.map(row => {
    const item = JSON.parse(row.payload) as Item;
    if (row.translation) try { translations[item.url] = JSON.parse(row.translation) as Translation; } catch { /* row still renders untranslated */ }
    return item;
  });
  return { items, translations, page, hasNext: page < SEARCH_MAX_PAGES && result.results.length > rows.length, engine, terms };
}

/**
 * Runs a search. Tries the maintained FTS5 index first; if the FTS query fails
 * for any reason the same filters run as escaped LIKE constraints (bounded to
 * SEARCH_MAX_TERMS tokens, each matching original and valid translated text).
 * With no usable tokens the search degrades to a filtered/newest-only listing.
 */
export async function searchArticles(env: SearchEnv, params: SearchParams, now: number = Date.now()): Promise<SearchResult> {
  const terms = parseSearchTerms(params.q ?? '');
  if (terms.length) {
    try {
      return await runSearch(env, params, now, 'fts', 'url IN (SELECT url FROM articles_fts WHERE articles_fts MATCH ?)', [ftsQuery(terms)], terms);
    } catch { /* fall through: FTS unavailable or dropped — reads must keep working */ }
    const likes: string[] = [];
    const likeBinds: (string | number)[] = [];
    for (const token of terms) {
      const pattern = `%${likeEscape(token)}%`;
      likes.push(`(json_extract(payload,'$.title') LIKE ? ESCAPE '\\' OR json_extract(payload,'$.summary') LIKE ? ESCAPE '\\' OR (${VALID_TRANSLATION} AND (json_extract(translation,'$.title') LIKE ? ESCAPE '\\' OR json_extract(translation,'$.summary') LIKE ? ESCAPE '\\')))`), likeBinds.push(pattern, pattern, pattern, pattern);
    }
    return runSearch(env, params, now, 'like', likes.join(' AND '), likeBinds, terms);
  }
  return runSearch(env, params, now, 'filter', '', [], terms);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * XSS-safe highlighter: HTML-escapes the text first, then wraps the already
 * escaped terms in <mark>. Terms shorter than 2 characters are ignored.
 */
export function highlight(text: string, terms: string[]): string {
  const escaped = escapeHtml(text);
  const usable = terms.filter(t => t.length >= 2 && t.length <= 48).map(t => escapeRegExp(escapeHtml(t))).filter(Boolean);
  if (!usable.length) return escaped;
  try {
    return escaped.replace(new RegExp(`(${usable.join('|')})`, 'gi'), '<mark>$1</mark>');
  } catch { return escaped; }
}
