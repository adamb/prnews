import { translated, type Translation } from './i18n';
import type { Item } from './parse';
import { sections } from './sections';
import { isEnglishItem } from './sources';

export const PUBLIC_ORIGIN = 'https://news.dev.pr';

/** Pages that exist in both editions. Spanish has no lang param; English is ?lang=en. */
export const BILINGUAL_PATHS = [
  '/',
  ...sections.map(([slug]) => `/s/${slug}`),
  '/fuentes',
  '/about',
  '/archive',
  '/signup',
  '/comparar',
] as const;

export const NOINDEX_FOLLOW = '<meta name="robots" content="noindex,follow">';

export function isBilingualPath(path: string): boolean {
  return (BILINGUAL_PATHS as readonly string[]).includes(path);
}

/**
 * True when /story?id=…&lang=en would return 200. Matches the page: an English
 * original, or a translation the English edition can render (live row, else the
 * bundled snapshot). An untranslated Spanish story stays off the English URL.
 */
export function englishStoryAvailable(item: Item, translation: Translation | null | undefined): boolean {
  const cache: Record<string, Translation> = {};
  if (translation) cache[item.url] = translation;
  return isEnglishItem(item) || translated(item, 'en', cache).translated;
}

/** Clean pair for a static path. page>1 is kept; page 1 and other params are not. */
export function pagePair(path: string, page?: number | null): { es: string; en: string } {
  const es = new URLSearchParams();
  const en = new URLSearchParams();
  en.set('lang', 'en');
  if (page != null && page > 1) {
    es.set('page', String(page));
    en.set('page', String(page));
  }
  const esQuery = es.toString();
  return {
    es: `${PUBLIC_ORIGIN}${path}${esQuery ? `?${esQuery}` : ''}`,
    en: `${PUBLIC_ORIGIN}${path}?${en.toString()}`,
  };
}

export function storyPair(id: number | string): { es: string; en: string } {
  const es = `${PUBLIC_ORIGIN}/story?id=${encodeURIComponent(String(id))}`;
  return { es, en: `${es}&lang=en` };
}

export function canonicalLink(href: string, esc: (value: string) => string): string {
  return `<link rel="canonical" href="${esc(href)}">`;
}

/** es, en (when that URL returns 200), and x-default (the Spanish URL). */
export function alternateLinks(es: string, en: string | null, esc: (value: string) => string, kind: 'html' | 'xml'): string {
  const tag = kind === 'html' ? 'link' : 'xhtml:link';
  const close = kind === 'html' ? '>' : '/>';
  const one = (lang: string, href: string) => `<${tag} rel="alternate" hreflang="${lang}" href="${esc(href)}"${close}`;
  return one('es', es) + (en ? one('en', en) : '') + one('x-default', es);
}
