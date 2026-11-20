import { XMLParser } from 'fast-xml-parser';
import * as he from 'he';
import { classify, type Section } from './sections';
import type { Source } from './sources';
export interface Item { originalLanguage?: 'en'|'es'; url: string; source: string; title: string; summary: string; image: string; time: number; observed: boolean; section: Section; reason: string; /** Feed <category> labels, kept so re-classification reproduces the ingest-time section. */ categories?: string[]; }
export const plain = (s: string) => he.decode(s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export function summary(s: string): string {
 const clean = plain(s).replace(/The post .*?(?:appeared first on|first appeared on).*$/i, '').replace(/\[…\]|\[\.\.\.\]/g, '').trim();
 if (clean.length <= 300) return clean;
 return clean.slice(0, 299).replace(/\s+\S*$/, '').trimEnd() + '…';
}
export function redditExcerpt(raw: string, html = false): string {
 const decoded = he.decode(he.decode(raw));
 const body = html ? /<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/i.exec(decoded)?.[1] ?? '' : decoded;
 const clean = summary(body.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
 return !clean || ['[removed]', '[deleted]'].includes(clean) ? 'Publicación compartida en r/PuertoRico.' : clean;
}
export function safeUrl(value: string, base?: string): string {
 try { const u = new URL(he.decode(value), base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}
/** Metro's Arc default social card, verified 2026-11-19: this exact file is the green
 * METRO wordmark (1200×630 JPEG, 12384 bytes), not a photograph of the story.
 * A real Metro photo lives under /api/image/ and must not match. */
export function publisherPlaceholder(value: string): boolean {
 const safe = safeUrl(value);
 if (!safe) return false;
 try {
  const u = new URL(safe);
  return u.protocol === 'https:' && u.hostname === 'www.metro.pr' && u.pathname === '/og-default.jpg';
 } catch { return false; }
}
export function canonical(value: string, base: string): string {
 const safe = safeUrl(value, base); if (!safe) return '';
 const u = new URL(safe); u.hash = '';
 for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key) || key === 'fbclid') u.searchParams.delete(key);
 if (!/\.[a-z0-9]{1,8}$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/+$/, '') + '/'; return u.href;
}
/** Demonstrably-Spanish detection: transparent lexical signals, never a blanket
 * source assumption. It only ever says 'es' — items without strong signals keep their
 * source default, and no 'en' verdict is invented. Signals are Spanish-exclusive
 * function words, Spanish word morphology, and Spanish diacritics on lowercase words.
 * Capitalized tokens beyond the sentence-initial word are ignored so Spanish place and
 * person names in an English article ("Manatí", "Rosalía", "Luis Muñoz Marín") never
 * count, and acronym shouting ("POR CYBERNEWS") never counts either. */
const SPANISH_STOPS = new Set(['de','del','la','el','los','las','al','lo','un','una','unos','unas','en','con','para','sin','sobre','entre','desde','hasta','tras','como','pero','que','porque','aunque','cuando','donde','ni','sus','su','si','mismo','misma','mientras','ya','hace','han','ante','durante','mediante','hacia','entonces','ahora','luego','sino','cada','todo','toda','todos','todas','otro','otra','otros','otras','este','esta','esto','estos','estas','ese','esa','eso','esos','esas','fue','fueron','tiene','tienen','debe','deben','puede','pueden','dijo','dijeron','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','ante']);
/** Function words that only occur in English prose; any hit vetoes the two
 * summary-based rules, keeping precision far above recall. Boundaries are
 * accent-aware (plain \b treats Spanish accented letters as non-word characters,
 * which would find a bogus English "as" inside "días" and veto real Spanish). */
const ACCENT = 'A-Za-zÁÉÍÓÚÑáéíóúñüÜ';
const ENGLISH_STOPS = new RegExp(`(?<![${ACCENT}])(the|and|of|in|to|for|with|at|on|from|as|is|are|was|were|be|been|being|am|has|have|had|will|would|can|could|should|may|might|must|after|before|over|under|between|against|during|while|until|since|about|into|out|off|up|down|their|its|his|her|our|your|this|that|these|those|there|here|what|when|how|why|which|who|whom|whose|said|says|new|report|reports|first|last|more|most|than|very|not)(?![${ACCENT}])`, 'i');
const TOKEN = /[A-Za-zÁÉÍÓÚÑáéíóúñüÜ][A-Za-zÁÉÍÓÚÑáéíóúñüÜ'-]*/g;
const SPANISH_SUFFIX = /(?:ción|ciones|dad|amiento|ando|iendo|ados|idas|adas)$/;
/** Counts Spanish signals in text: function-word list, Spanish morphology, accented words. */
function spanishSignals(text: string): number {
 const words = text.match(TOKEN) ?? [];
 let count = 0;
 words.forEach((raw, index) => {
  const lower = raw.toLowerCase();
  if (index > 0 && raw[0] !== lower[0]) return;      // capitalized beyond sentence-initial: name, place, all-caps byline
  if (raw.length > 1 && raw === raw.toUpperCase()) return;  // acronym shouting ("POR CYBERNEWS")
  if (raw.length < 2) return;
  if (SPANISH_STOPS.has(lower) || (SPANISH_SUFFIX.test(lower) && raw.length >= (/(?:ando|iendo)$/.test(lower) ? 8 : 6))) count++;
  else if (/[áéíóúñü]/.test(lower)) count++;
 });
 return count;
}
const englishSignals = (text: string) => (text.match(ENGLISH_STOPS) ?? []).length;
/** 'es' iff the title itself is clearly Spanish (no English function words, 2+ Spanish
 * signals), or the title leans Spanish while title+summary are Spanish-dominant, or a
 * neutral title is carried by a clearly Spanish summary. Conservative by design: an
 * English article must never be queued as Spanish, so anything else stays undefined. */
export function detectSpanish(title: string, summaryText: string = ''): 'es' | undefined {
 const t = spanishSignals(title), both = spanishSignals(title + ' ' + summaryText);
 const englishTitle = englishSignals(title), englishSummary = englishSignals(summaryText);
 if (englishTitle === 0 && t >= 2) return 'es';
 if (englishTitle === 0 && t >= 1 && both >= 4 && englishSummary <= 1) return 'es';
 if (englishTitle === 0 && t === 0 && englishSummary === 0 && both >= 4) return 'es';
 return undefined;
}
/**
 * Edition of one generated sentence, using the same function-word, morphology,
 * and name rules as detectSpanish. Capitalized proper nouns and acronyms are
 * not signals, so "PRITS", "WIPR", "Manatí", or "Suzanne Roig" do not decide
 * the edition. Undefined means the sentence is not clearly one language.
 */
export function sentenceEdition(text: string): 'es' | 'en' | undefined {
 const es = spanishSignals(text), en = englishSignals(text);
 if (en >= 1 && en > es) return 'en';
 if (es >= 2 && es > en) return 'es';
 if (es >= 1 && en === 0 && /[áéíóúñü]/.test(text)) return 'es';
 return undefined;
}
const list = (x: any): any[] => x == null ? [] : Array.isArray(x) ? x : [x];
const str = (x: any): string => typeof x === 'string' ? x : typeof x === 'number' ? String(x) : x?.['#text'] ?? '';
export function parseFeed(xml: string, source: Source, seen: number): Item[] {
 // Convert named HTML entities without introducing XML markup or breaking CDATA.
 const sanitized = xml.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (entity) => {
  const decoded = he.decode(entity); return decoded === entity ? entity : [...decoded].map(c => `&#${c.codePointAt(0)};`).join('');
 });
 const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(sanitized);
 if (!doc.rss?.channel && !doc.feed) throw new Error(`Invalid feed: ${source.id}`);
 const rows = list(doc.rss?.channel?.item ?? doc.feed?.entry);
 const dates = rows.map(r => Date.parse(str(r.pubDate ?? r.published ?? r.updated)));
 return rows.flatMap((r, index) => {
  const link = typeof r.link === 'string' ? r.link : list(r.link).find(l => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'];
  const url = canonical(str(link), source.homepage), title = plain(str(r.title));
  if (!link || !url || !title) return [];
  let dek = summary(str(source.id === 'telemundo' ? r.excerpt : r.description ?? r.summary ?? r['content:encoded']));
  if (source.id === 'reddit_puertorico') dek = redditExcerpt(str(r.content), true);
  const media = [...list(r['media:content']), ...list(r['media:thumbnail']), ...list(r.enclosure).filter(e => /^image\//.test(e['@_type'] ?? ''))];
  const rawImage = safeUrl(str(media.find(m => m['@_url'])?.['@_url'] ?? /<img[^>]+src=["']([^"']+)/i.exec(str(r.description ?? r['content:encoded']))?.[1] ?? ''));
  const image = publisherPlaceholder(rawImage) ? '' : rawImage;
  const date = dates[index];
  const observed = source.id === 'telemundo' || !Number.isFinite(date) || date > seen || dates.filter(d => d === date).length > 5;
  // Per-article language for demonstrably Spanish text (community posts keep their own bilingual flow).
  const originalLanguage = source.id === 'reddit_puertorico' ? undefined : detectSpanish(title, dek);
  // Feed categories are kept on the item so the render-time re-classification
  // (src/current-item.ts) sees the same inputs the ingest-time call saw; without
  // them a feed-category section (reason 'category') would be recomputed from
  // URL and keywords alone and could silently override the publisher's label.
  const categories = list(r.category).map(str).filter(Boolean);
  return [{ url, source: source.id, title, summary: dek, image, time: observed ? seen : date, observed, ...(source.id === 'reddit_puertorico' ? {section: 'comunidad' as const, reason: 'community'} : classify(url, categories, title + ' ' + dek, source.id)), ...(originalLanguage ? {originalLanguage} : {}), ...(categories.length ? {categories} : {}) }];
 });
}
