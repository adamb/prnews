import {expect,it} from 'vitest';
import worker from '../src/index';

/** The "English only" checkbox was retired: ?english=1 must canonicalize to ?lang=en before a
 * page renders, so no Spanish-UI/English-filter mix survives, and language switching through the
 * header starts from clean URLs. Tests run against the worker fetch (no DB needed: the
 * canonicalization precedes every storage read). */
const fetch=(url:string,init?:RequestInit)=>worker.fetch(new Request(`https://news.dev.pr${url}`,init),{} as never);

it('redirects the retired english=1 filter to the canonical English edition, preserving query, source and page',async()=>{
 for(const [from,to] of [
  ['/?english=1','/?lang=en'],
  ['/search?english=1&lang=es&q=luma&source=endi&page=2','/search?lang=en&q=luma&source=endi&page=2'],
  ['/s/politica?english=1&page=3','/s/politica?lang=en&page=3'],
  ['/archive?english=1&date=2026-11-14','/archive?lang=en&date=2026-11-14'],
 ]) {
  const r=await fetch(from,{redirect:'manual'});
  expect(r.status,from).toBe(301);
  expect(r.headers.get('Location'),from).toBe(to);
 }
 // HEAD mirrors the GET redirect status and location.
 const head=await fetch('/?english=1',{method:'HEAD',redirect:'manual'});
 expect(head.status).toBe(301);
 expect(head.headers.get('Location')).toBe('/?lang=en');
});

it('drops stray non-1 english flags without rewriting the language',async()=>{
 const r=await fetch('/about?english=0&lang=en',{redirect:'manual'});
 expect(r.status).toBe(302);
 expect(r.headers.get('Location')).toBe('/about?lang=en');
});

it('leaves requests without the legacy flag and non-page routes untouched',async()=>{
 const plain=await fetch('/');
 expect(plain.status).toBe(200);
 expect(plain.headers.get('Location')).toBeNull();
 const search=await fetch('/search?q=luma');
 expect(search.status).toBe(200);
 expect(await search.text()).not.toContain('name="english"');
 // GET/HEAD-only canonicalization: other methods are not silently rewritten.
 const post=await fetch('/?english=1',{method:'POST'});
 expect(post.status).toBe(405);
 // Non-page routes never redirect on the legacy param.
 const live=await fetch('/api/live?english=1');
 expect(live.status).toBe(404); // no DB in this env; importantly not a redirect
});

it('renders the Spanish homepage without the checkbox and keeps the header toggle as the only language control',async()=>{
 const spanish=await fetch('/').then(r=>r.text());
 expect(spanish).not.toContain('Solo en inglés');expect(spanish).not.toContain('name="english"');
 expect(spanish).toContain('aria-label="Idioma"');expect(spanish).toContain('>Español</a>');expect(spanish).toContain('>English</a>');
 const english=await fetch('/?lang=en').then(r=>r.text());
 expect(english).toContain('<html lang="en">');expect(english).not.toContain('name="english"');
 expect(english).not.toContain('?english');
});
