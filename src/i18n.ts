import { isEnglishSource, isEnglishItem, newsprSource } from './sources';
import translations from './translations.en.json';
import { detectSpanish } from './parse';
import type { Item } from './parse';
export type Language = 'es' | 'en';
/** `target` marks the reverse-direction cache: undefined means the default
 * English translation of a Spanish original; 'es' means a Spanish translation
 * of an English original (news.pr only). The two directions share this row shape
 * but never share a cache entry: a row is either Spanish→English or, when it is
 * a news.pr item, English→Spanish. */
export type Translation = { originalTitle: string; originalSummary: string; title: string; summary: string; spanishSummary?: string; target?: 'es' };
export function validTranslation(item:Item, entry?:Translation): boolean {
 if(!entry||entry.target)return false; // a reverse-direction (target:'es') row is a Spanish translation, never an English one
 if(entry.originalTitle!==item.title||entry.originalSummary!==item.summary||!entry.title?.trim()||(item.summary&&!entry.summary?.trim()))return false;
 // An unchanged headline from a Spanish newsroom is not a completed translation.
 if(!isEnglishItem(item)&&entry.title.trim()===item.title.trim()&& (item.source!=='reddit_puertorico'||/\b(el|la|los|las|del|una|para|por|que|con|en|como|cual|est[aá])\b/i.test(item.title)))return false;
 if(item.source!=='reddit_puertorico'&&item.summary&&entry.summary.trim()===item.summary.trim()&&/\b(el|la|los|las|del|una|un|para|por|que|con|en)\b/i.test(item.summary))return false;
 return true;
}
/** The reverse-direction validation: the entry must be marked 'es', attached to the
 * unchanged English original, actually different from it, and demonstrably Spanish
 * (the same conservative detector the ingestion language signals use). An English
 * copy-through is never a completed Spanish translation. */
export function validSpanishTranslation(item:Item, entry?:Translation): boolean {
 if(!entry||entry.target!=='es'||entry.originalTitle!==item.title||entry.originalSummary!==item.summary||!entry.title?.trim()||(item.summary&&!entry.summary?.trim()))return false;
 if(entry.title.trim()===item.title.trim())return false;
 return detectSpanish(entry.title, entry.summary) === 'es';
}
const saved = translations as Record<string, Translation>;
export function translated(item: Item, lang: Language, cache: Record<string, Translation> = saved): Item & { translated: boolean } {
 const entry = cache[item.url] ?? saved[item.url];
 if (lang === 'es' && item.source === 'reddit_puertorico' && entry?.spanishSummary && entry.originalTitle === item.title && entry.originalSummary === item.summary) return {...item, summary:entry.spanishSummary, translated:false};
 // The Spanish edition of news.pr renders the cached English→Spanish translation when
 // one is valid; without it the English original stays, exactly as for other English
 // sources. The English edition always keeps the original (isEnglishItem).
 if (lang === 'es' && item.source === newsprSource && validSpanishTranslation(item, entry)) return { ...item, title: entry.title, summary: entry.summary, translated: true };
 if (lang !== 'en' || isEnglishItem(item) || !validTranslation(item,entry)) return { ...item, translated: false };
 return { ...item, title: entry.title, summary: entry.summary, translated: true };
}
/** The single queue definition shared by the scheduler, /stats and the pending notice: an item is
 * awaiting translation iff the English edition cannot render it in English right now, checking the
 * live translation cache first and the bundled snapshot translations second (mirrors translated()). */
export function needsTranslation(item: Item, translations: Record<string, Translation> = {}): boolean {
 if (isEnglishItem(item)) return false;
 return !validTranslation(item, translations[item.url] ?? saved[item.url]);
}
/** The reverse queue (news.pr only): an item awaits translation iff the Spanish edition
 * cannot render it in Spanish right now — the mirror of needsTranslation for the
 * English→Spanish direction. Other English sources (sjds/nimb) are never inverted, and
 * neither is a news.pr item whose own payload is demonstrably Spanish: that item is a
 * Spanish original and belongs to the shared Spanish→English queue (needsTranslation),
 * so the two directions stay mutually exclusive per row. */
export function needsSpanishTranslation(item: Item, translations: Record<string, Translation> = {}): boolean {
 if (item.source !== newsprSource || item.originalLanguage === 'es') return false;
 return !validSpanishTranslation(item, translations[item.url] ?? saved[item.url]);
}
export function localUrl(path: string, lang: Language) {
 const url = new URL(path, 'https://local.invalid');
 url.searchParams.set('lang', lang);
 return url.pathname + url.search;
}
export const englishSections: Record<string, string> = {
  comunidad: 'Reddit', politica: 'Government & Politics', negocios: 'Business & Technology', policiales: 'Safety & Justice',
  'bienes-raices': 'Real Estate',
  energia: 'Environment & Infrastructure', salud: 'Health, Education & Society', educacion: 'Education', clima: 'Weather & Environment',
  deportes: 'Sports', entretenimiento: 'Entertainment & Culture', mundo: 'United States & World', opinion: 'Opinion', otras: 'Other & Opinion',
};
