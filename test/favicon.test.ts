import { expect, it } from 'vitest';
import worker from '../src/index';
import { alertsRoute } from '../src/alerts-http';
import { faviconLinks } from '../src/favicon';

// No D1 binding: the icon routes and rendered pages must work from bundled state alone.
const noDb = {} as any;

const fetchIcon = (path: string, method = 'GET') => worker.fetch(new Request('https://news.dev.pr' + path, { method }), noDb);

it('serves the site icons with fixed MIME types, caching and non-empty original artwork', async () => {
  const svg = await fetchIcon('/favicon.svg');
  expect(svg.status).toBe(200);
  expect(svg.headers.get('Content-Type')).toBe('image/svg+xml');
  expect(svg.headers.get('Cache-Control')).toBe('public, max-age=86400');
  const svgBody = await svg.text();
  expect(svgBody.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svgBody.length).toBeGreaterThan(200);
  // Vector-only artwork: no external fetches, no embedded rasters.
  expect(svgBody).not.toMatch(/href|url\(|<image/);

  const ico = await fetchIcon('/favicon.ico');
  expect(ico.status).toBe(200);
  expect(ico.headers.get('Content-Type')).toBe('image/x-icon');
  const icoBytes = new Uint8Array(await ico.arrayBuffer());
  expect(icoBytes.length).toBeGreaterThan(1000);
  // ICO header with three frames; dimension bytes for each 32-bit BMP frame (16/32/48).
  expect([...icoBytes.slice(0, 4)]).toEqual([0, 0, 1, 0]);
  expect(icoBytes[4]).toBe(3);
  expect(icoBytes[6]).toBe(16);expect(icoBytes[7]).toBe(16);
  expect(icoBytes[22]).toBe(32);expect(icoBytes[23]).toBe(32);
  expect(icoBytes[38]).toBe(48);expect(icoBytes[39]).toBe(48);

  const touch = await fetchIcon('/apple-touch-icon.png');
  expect(touch.status).toBe(200);
  expect(touch.headers.get('Content-Type')).toBe('image/png');
  const png = new Uint8Array(await touch.arrayBuffer());
  expect(png.length).toBeGreaterThan(1000);
  expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

it('answers HEAD exactly like GET on every icon route, minus the body', async () => {
  for (const path of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) {
    const head = await fetchIcon(path, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Type')).toBeTruthy();
    expect(head.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(await head.text()).toBe('');
  }
  const bodyless = await fetchIcon('/favicon.ico', 'HEAD');
  expect(bodyless.headers.get('Content-Type')).toBe('image/x-icon');
});

it('rejects non-GET/HEAD icon requests with 405 and an Allow header', async () => {
  for (const method of ['POST', 'PUT']) {
    const r = await fetchIcon('/favicon.ico', method);
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET, HEAD');
  }
});

it('every rendered page head links the icon set; icons are same-origin only', async () => {
  const html = await worker.fetch(new Request('https://news.dev.pr/?lang=en'), noDb).then(r => r.text());
  expect(html).toContain(faviconLinks);
  expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">');
  expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  const es = await worker.fetch(new Request('https://news.dev.pr/about'), noDb).then(r => r.text());
  expect(es).toContain(faviconLinks);
});

it('the alerts shell carries the icon links without changing its privacy posture', async () => {
  const methodPage = await alertsRoute(new Request('https://news.dev.pr/alerts/signup'), noDb);
  expect(methodPage?.status).toBe(405);
  const shell = await methodPage!.text();
  expect(shell).toContain(faviconLinks);
  expect(shell).toContain('href="/favicon.svg"');
  const headers = methodPage!.headers;
  expect(headers.get('Cache-Control')).toBe('no-store');
  expect(headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'");
});
