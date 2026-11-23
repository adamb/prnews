import {expect,it} from 'vitest';
import {diasporaRelevant,diasporaSources,diasporaFeeds} from '../src/diaspora-sources';
import {isEnglishSource} from '../src/sources';
it('filters broad publishers using explicit bilingual Puerto Rican evidence',()=>{
 for(const id of ['laprensafl','thecity','documented','nbclatino']) {
  const url='https://www.nbcnews.com/news/latino/example';
  for(const title of ['Puerto Rico recovery','Puerto Rican families','Puertorriqueños en Orlando','La comunidad boricua','Nuyorican history']) expect(diasporaRelevant(id,title,'',url)).toBe(true);
  for(const title of ['Latino voters','Orlando theme parks','NYC immigration','PR campaign','San Juan school','Somos una familia','Puerto Riconnect']) expect(diasporaRelevant(id,title,'',url)).toBe(false);
  expect(diasporaRelevant(id,'New exhibition','Puerto Rican artists',url)).toBe(true);
 }
 expect(diasporaRelevant('thecity','SOMOS conference opens','','https://www.thecity.nyc/story')).toBe(true);
 expect(diasporaRelevant('thecity','Somos conference opens','','https://www.thecity.nyc/story')).toBe(false);
 for(const url of ['https://www.nbcnews.com/politics/puerto-rico','https://evil.test/news/latino/story','https://www.nbcnews.com/news/latino-other/story']) expect(diasporaRelevant('nbclatino','Puerto Rico','',url)).toBe(false);
});
it('registers publisher metadata and English defaults with Spanish La Prensa',()=>{
 expect(diasporaSources).toHaveLength(6);
 for(const s of diasporaSources){expect(diasporaFeeds[s.id]).toHaveLength(1);expect(isEnglishSource(s.id)).toBe(s.id!=='laprensafl');}
});
