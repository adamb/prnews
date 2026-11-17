import {expect,it} from 'vitest';
import {inSection,parseArctic,redditTopic} from '../src/reddit';
import renderer from '../src/render';
import {canonical, type Item} from '../src/parse';
const now=Date.parse('2026-11-14T18:00:00Z');
const post={id:'abc123',subreddit:'PuertoRico',permalink:'/r/PuertoRico/comments/abc123/governor_election/',title:'Governor announces election plans',created_utc:now/1000-60};
it('puts matching Reddit posts in both Reddit and a topic, but leaves ambiguous posts only in Reddit',()=>{
 const [item]=parseArctic(JSON.stringify({data:[post]}),now);
 expect(inSection(item,'comunidad')).toBe(true);expect(inSection(item,'politica')).toBe(true);expect(inSection(item,'deportes')).toBe(false);
 expect(redditTopic('Apagón de LUMA')).toBe('energia');expect(redditTopic('Basketball in San Juan')).toBe('deportes');
 const casual={...item,title:'Hola gente'};
 expect(inSection(casual,'comunidad')).toBe(true);expect(inSection(casual,'otras')).toBe(false);
});
it('normalizes archive links to the same Reddit URLs and rejects removed, wrong-subreddit, and stale entries',()=>{
 const [item]=parseArctic(JSON.stringify({data:[post]}),now);
 expect(item.url).toBe(canonical('https://www.reddit.com'+post.permalink,'https://www.reddit.com'));
 expect(item.summary).toBe('Publicación compartida en r/PuertoRico.');
 const rejected=[{...post,removed_by_category:'moderator'},{...post,selftext:'[deleted]'},{...post,subreddit:'other'},{...post,created_utc:now/1000-15*86400},{...post,permalink:'https://evil.example/post'}];
 expect(parseArctic(JSON.stringify({data:rejected}),now)).toEqual([]);
 expect(()=>parseArctic('{}',now)).toThrow('Invalid Arctic Shift response');
});
it('renders one discussion on its Reddit and topic pages with its community label',async()=>{
 const [item]=parseArctic(JSON.stringify({data:[post]}),now);
 const live={items:[item] as Item[],translations:{[item.url]:{originalTitle:item.title,originalSummary:item.summary,title:item.title,summary:'A community discussion about election plans.'}},feeds:[]};
 for(const path of ['/s/politica','/s/comunidad']) {
  const html=await renderer.fetch(new Request('https://news.dev.pr'+path+'?lang=en'),live).text();
  expect(html).toContain(post.title);expect(html).toContain('Community discussion · Translated');
 }
 const unrelated=await renderer.fetch(new Request('https://news.dev.pr/s/deportes'),live).text();
 expect(unrelated).not.toContain(post.title);
});
it('shows saved summaries on compact Reddit cards in both languages',async()=>{
 const [item]=parseArctic(JSON.stringify({data:[{...post,selftext:'A discussion of the upcoming election and its candidates.'}]}),now);
 const live={items:[item],translations:{[item.url]:{originalTitle:item.title,originalSummary:item.summary,title:'Governor announces election plans',summary:'A discussion of the governor’s election plans.',spanishSummary:'Una conversación sobre los planes electorales del gobernador.'}},feeds:[]};
 const en=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),live).text();
 const es=await renderer.fetch(new Request('https://news.dev.pr/?lang=es'),live).text();
 expect(en).toContain('class="reddit-summary"');expect(en).toContain('A discussion of the governor’s election plans.');
 expect(es).toContain('Una conversación sobre los planes electorales del gobernador.');
});
