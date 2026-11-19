import { sections } from './sections';

const origin = 'https://news.dev.pr';
const paths = ['/', ...sections.map(([slug]) => `/s/${slug}`), '/fuentes', '/about', '/archive', '/comparar'];
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
${paths.flatMap(path => {
 const spanish = origin + path;
 const english = spanish + '?lang=en';
 return [spanish, english].map(loc => `  <url>
    <loc>${xmlEscape(loc)}</loc>
    <xhtml:link rel="alternate" hreflang="es" href="${xmlEscape(spanish)}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${xmlEscape(english)}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(spanish)}"/>
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
