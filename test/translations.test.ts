import { isEnglishSource } from '../src/sources';
import { expect, it } from 'vitest';
import data from '../src/data.json';
import translations from '../src/translations.en.json';
import { translated, localUrl, validTranslation } from '../src/i18n';
import type { Item } from '../src/parse';
import worker from '../src/render';
const items = data.items as Item[];
// Sources added after the bundled English snapshot. They enter the bounded live queue; this file does not call Workers AI.
const laterSources = ['elvocero','wapa','wipr','claridad','radioisla','walo'];
const needsBundledTranslation = (item: Item) => !isEnglishSource(item.source) && item.source !== 'reddit_puertorico' && !laterSources.includes(item.source);
it('provides a current English translation for each pretranslated original snapshot article', () => {
 for (const item of items.filter(needsBundledTranslation)) {
  const english = translated(item, 'en');
  expect(translations[item.url as keyof typeof translations],item.url).toBeTruthy();
  expect(english.translated,item.url).toBe(validTranslation(item,translations[item.url as keyof typeof translations]));
  expect(english.title).toBeTruthy();
  expect(english.summary.length).toBeLessThanOrEqual(300);
  if (item.summary) expect(english.summary).toBeTruthy();
  expect(english.url).toBe(item.url);
 }
});
it('preserves original content and does not use stale translations', () => {
 const item = items.find(needsBundledTranslation)!;
 expect(translated(item, 'es').title).toBe(item.title);
 expect(translated({...item, summary:'Changed summary'}, 'en').translated).toBe(false);
 const english = items.find(i => isEnglishSource(i.source))!;
 expect(translated(english, 'en')).toEqual({...english,translated:false});
});
it('renders translated headlines, original links, and language annotations', async () => {
 const item = items.find(i => i.source === 'noticel')!;
 const html = await worker.fetch(new Request('https://example.com/?lang=en'),{items:[item],translations:{},feeds:[]}).text();
 const title = translated(item, 'en').title.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 expect(html).toContain(title);
 expect(html).toContain('Translated · Original in Spanish');
 expect(html).toContain('hreflang="es" target="_blank"');
 expect(Object.keys(translations).length).toBe(items.filter(needsBundledTranslation).length);
});
it('language URLs preserve pagination and replace the existing language', () => {
 expect(localUrl('/s/mundo?page=2&lang=es','en')).toBe('/s/mundo?page=2&lang=en');
});
it('never shows pending Spanish articles in the English edition',async()=>{
 const item={...items.find(i=>i.source==='noticel')!,title:'Nueva noticia pendiente',url:'https://example.com/new/'};
 const live={items:[item],translations:{},feeds:[]};
 const en=await worker.fetch(new Request('https://example.com/?lang=en'),live).text();
 expect(en).not.toContain(item.title);
 expect(en).not.toContain('posts are awaiting English translation'); // counts live in /api/live and /stats, not on public pages
 expect(en).not.toContain('class="notice"');
 const es=await worker.fetch(new Request('https://example.com/?lang=es'),live).text();
 expect(es).toContain(item.title);
});

it('rejects partial translation with unchanged Spanish headline',()=>{
 const item=items.find(i=>i.source==='noticel')!;
 const cache={[item.url]:{originalTitle:item.title,originalSummary:item.summary,title:item.title,summary:'An English excerpt.'}};
 expect(translated(item,'en',cache).translated).toBe(false);
});
