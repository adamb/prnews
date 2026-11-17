/** Shared attribution; the year follows the site's Puerto Rico date convention. */
export function copyrightNotice(lang: 'es' | 'en', now = new Date()): string {
 const year = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Puerto_Rico', year: 'numeric' }).format(now);
 return `© ${year} Adam Beguelin · ${lang === 'en' ? 'Linked articles and images belong to their respective publishers.' : 'Los artículos e imágenes enlazados pertenecen a sus respectivos medios.'}`;
}
