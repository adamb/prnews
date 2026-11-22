import {afterEach, expect, it, vi} from 'vitest';
import {quarantined, publisherFetch, quarantineHtml} from '../src/quarantine';
import {clickRoute} from '../src/trending';
import {feeds} from '../src/ingest';
import {fetchImage} from '../src/archive';
import {rssRoute} from '../src/syndication';
afterEach(() => vi.unstubAllGlobals());
it('matches domain boundaries, mixed case and DNS trailing dots', () => {
 for (const domain of ['periodicovision.com','elpostantillano.com']) {
  for (const prefix of ['', 'www.', 'a.b.']) expect(quarantined(`https://${prefix}${domain.toUpperCase()}./story`)).toBe(true);
  expect(quarantined(`https://fake${domain}/`)).toBe(false);
  expect(quarantined(`https://${domain}.example.org/`)).toBe(false);
 }
 expect(feeds.vision).toEqual([]);
});
it('blocks known story and archive destinations before counting', async () => {
 for (const key of ['id=18', 'url='+encodeURIComponent('https://periodicovision.com/old')]) {
  const batch=vi.fn();
  const DB={prepare:()=>({bind:()=>({first:async()=>({url:'https://www.periodicovision.com/old'})})}),batch} as any;
  const response=await clickRoute(new Request('https://news.dev.pr/click?'+key),{DB});
  expect(response?.status).toBe(403);expect(response?.headers.has('location')).toBe(false);expect(batch).not.toHaveBeenCalled();
 }
});
it('strips direct, tracked, source and image links with localized review text', () => {
 const url='https://www.elpostantillano.com/';
 for (const lang of ['es','en']) {
  const html=quarantineHtml(`<a href="${url}">Source</a><a href="/click?url=${encodeURIComponent(url)}">Story</a><img src="${url}image.jpg">`,lang);
  expect(html).not.toContain('href=');expect(html).not.toContain('src=');expect(html).toContain(lang==='es'?'bajo revisión':'under review');
 }
});
it('refuses blocked initial fetches and redirect hops for feeds and images', async () => {
 const fetch=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://sub.periodicovision.com/image'}}));vi.stubGlobal('fetch',fetch);
 await expect(publisherFetch('https://elpostantillano.com')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 await expect(publisherFetch('https://example.org/feed')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
 fetch.mockClear();await expect(fetchImage('https://example.org/image')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('omits quarantined RSS articles', async () => {
 const DB={prepare:()=>({bind:()=>({all:async()=>({results:[{payload:JSON.stringify({url:'https://periodicovision.com/story',source:'vision',title:'Blocked',summary:'',time:Date.now()})}]})})})} as any;
 const response=await rssRoute(new Request('https://news.dev.pr/feed'),{DB});
 expect(await response!.text()).not.toContain('<item>');
});
