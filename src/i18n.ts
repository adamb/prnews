import { isEnglishSource, isEnglishItem } from './sources';
import translations from './translations.en.json';
import type { Item } from './parse';
export type Language = 'es' | 'en';
export type Translation = { originalTitle: string; originalSummary: string; title: string; summary: string; spanishSummary?: string };
export function validTranslation(item:Item, entry?:Translation): boolean {
 if(!entry||entry.originalTitle!==item.title||entry.originalSummary!==item.summary||!entry.title?.trim()||(item.summary&&!entry.summary?.trim()))return false;
 // An unchanged headline from a Spanish newsroom is not a completed translation.
 if(!isEnglishItem(item)&&entry.title.trim()===item.title.trim()&& (item.source!=='reddit_puertorico'||/\b(el|la|los|las|del|una|para|por|que|con|en|como|cual|est[aá])\b/i.test(item.title)))return false;
 if(item.source!=='reddit_puertorico'&&item.summary&&entry.summary.trim()===item.summary.trim()&&/\b(el|la|los|las|del|una|un|para|por|que|con|en)\b/i.test(item.summary))return false;
 return true;
}
const saved = translations as Record<string, Translation>;
export function translated(item: Item, lang: Language, cache: Record<string, Translation> = saved): Item & { translated: boolean } {
 const entry = cache[item.url] ?? saved[item.url];
 if (lang === 'es' && item.source === 'reddit_puertorico' && entry?.spanishSummary && entry.originalTitle === item.title && entry.originalSummary === item.summary) return {...item, summary:entry.spanishSummary, translated:false};
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
export function localUrl(path: string, lang: Language) {
 const url = new URL(path, 'https://local.invalid');
 url.searchParams.set('lang', lang);
 return url.pathname + url.search;
}
export const englishSections: Record<string, string> = {
 comunidad: 'Reddit', politica: 'Government & Politics', negocios: 'Business & Technology', policiales: 'Safety & Justice',
 energia: 'Environment & Infrastructure', salud: 'Health, Education & Society', educacion: 'Education', clima: 'Weather & Environment',
 deportes: 'Sports', entretenimiento: 'Entertainment & Culture', mundo: 'United States & World', opinion: 'Opinion', otras: 'Other & Opinion',
};
