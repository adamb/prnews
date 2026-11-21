import { isEnglishItem } from './sources';
import { repairNimbTitle } from './current-item';
import translations from './translations.en.json';
import { detectSpanish } from './parse';
import type { Item } from './parse';
export type Language = 'es' | 'en';
/** `target` marks the reverse-direction cache: undefined means the default
 * English translation of a Spanish original; 'es' means a Spanish translation
 * of an English original (every English-origin source: sjds, nimb, newspr,
 * Pasquines, and any row with a per-article English signal). The two directions
 * share this row shape but never share a cache entry: a row is either
 * Spanish→English or, for an English-origin item, English→Spanish. */
export type Translation = { originalTitle: string; originalSummary: string; title: string; summary: string; spanishSummary?: string; target?: 'es' };
/** currentItem() (src/current-item.ts) may display a corrected NIMB manual-import
 * slug title while the stored payload — the exact text the queue translated and
 * stored as originalTitle — keeps the raw slug. The two agree through the same
 * deterministic fix, and nothing else loosens the original match: the comparison
 * is exact-equal or exactly repairNimbTitle(raw)===displayed, never fuzzy. */
const originalMatches = (item: Item, originalTitle: string): boolean => {
 const manual = item.source === 'nimb' && item.reason === 'manual-import' && 'titleOrigin' in item && (item as unknown as { titleOrigin?: string }).titleOrigin === 'url-slug';
 return originalTitle === item.title || (manual && repairNimbTitle(originalTitle) === item.title);
};
/** An original with no excerpt must stay excerpt-less in translation: a cached
 * entry claiming a summary the original never shipped would render invented text,
 * so it is invalid (title-only is the honest completed form). */
const summaryHonest = (item: Item, entry: Translation): boolean =>
 item.summary ? !!entry.summary?.trim() : !(entry.summary && entry.summary.trim());
export function validTranslation(item:Item, entry?:Translation): boolean {
 if(!entry||entry.target)return false; // a reverse-direction (target:'es') row is a Spanish translation, never an English one
 if(!originalMatches(item,entry.originalTitle)||entry.originalSummary!==item.summary||!entry.title?.trim()||!summaryHonest(item,entry))return false;
 // An unchanged headline from a Spanish newsroom is not a completed translation.
 if(!isEnglishItem(item)&&entry.title.trim()===item.title.trim()&& (item.source!=='reddit_puertorico'||/\b(el|la|los|las|del|una|para|por|que|con|en|como|cual|est[aá])\b/i.test(item.title)))return false;
 if(item.source!=='reddit_puertorico'&&item.summary&&entry.summary.trim()===item.summary.trim()&&/\b(el|la|los|las|del|una|un|para|por|que|con|en)\b/i.test(item.summary))return false;
 return true;
}
/** The reverse-direction validation: the entry must be marked 'es', attached to the
 * unchanged English original (including currentItem's deterministic NIMB slug-title
 * correction), actually different from it, and demonstrably Spanish (the same
 * conservative detector the ingestion language signals use). An English copy-through
 * is never a completed Spanish translation, and neither is an invented excerpt where
 * the original ships none. */
export function validSpanishTranslation(item:Item, entry?:Translation): boolean {
 if(!entry||entry.target!=='es'||!originalMatches(item,entry.originalTitle)||entry.originalSummary!==item.summary||!entry.title?.trim()||!summaryHonest(item,entry))return false;
 if(entry.title.trim()===item.title.trim())return false;
 return detectSpanish(entry.title, entry.summary) === 'es';
}
const saved = translations as Record<string, Translation>;
export function translated(item: Item, lang: Language, cache: Record<string, Translation> = saved): Item & { translated: boolean } {
 const entry = cache[item.url] ?? saved[item.url];
 if (lang === 'es' && item.source === 'reddit_puertorico' && entry?.spanishSummary && entry.originalTitle === item.title && entry.originalSummary === item.summary) return {...item, summary:entry.spanishSummary, translated:false};
 // The Spanish edition of any English-origin item renders the cached English→Spanish
 // translation when one is valid; without it the English original stays, exactly as
 // for Spanish items in the English edition. The English edition always keeps the
 // original (isEnglishItem).
 if (lang === 'es' && isEnglishItem(item) && validSpanishTranslation(item, entry)) return { ...item, title: entry.title, summary: entry.summary, translated: true };
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
/** The reverse queue: an item awaits translation iff the Spanish edition cannot render
 * it in Spanish right now — the mirror of needsTranslation for the English→Spanish
 * direction. It claims every English-origin item (source default or per-article
 * signal, decided by the shared isEnglishItem rule), so the Spanish edition can show
 * its cached translation; a demonstrably Spanish payload (originalLanguage='es' or a
 * Spanish-source default) is never inverted and stays in the shared Spanish→English
 * queue (needsTranslation), so the two directions stay mutually exclusive per row. */
export function needsSpanishTranslation(item: Item, translations: Record<string, Translation> = {}): boolean {
 if (!isEnglishItem(item)) return false;
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
