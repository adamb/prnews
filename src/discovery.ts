import { alternateLinks, BILINGUAL_PATHS, pagePair, PUBLIC_ORIGIN } from './seo';

const origin = PUBLIC_ORIGIN;
const xmlEscape = (value: string) => value.replace(/[&<>"']/g, c => ({
 '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[c]!));

/** Crawler metadata is independent of D1 and always uses the public domain. */
export function discovery(request: Request): Response | undefined {
 const path = new URL(request.url).pathname;
 if (path !== '/robots.txt' && path !== '/sitemap.xml') return;
 if (request.method !== 'GET' && request.method !== 'HEAD') {
  return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, HEAD'}});
 }
 const robots = `User-agent: *\nAllow: /\nDisallow: /internal/\n\nSitemap: ${origin}/sitemap.xml\n`;
 const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${BILINGUAL_PATHS.flatMap(path => {
 const pair = pagePair(path);
 const links = alternateLinks(pair.es, pair.en, xmlEscape, 'xml');
 return [pair.es, pair.en].map(loc => `  <url>
    <loc>${xmlEscape(loc)}</loc>
    ${links}
  </url>`);
}).join('\n')}
</urlset>\n`;
 return new Response(request.method === 'HEAD' ? null : path === '/robots.txt' ? robots : sitemap, {
  headers: {
   'Content-Type': path === '/robots.txt' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8',
   'Cache-Control': 'public, max-age=3600',
   'X-Content-Type-Options': 'nosniff',
  },
 });
}
