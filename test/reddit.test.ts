import {expect,it} from 'vitest';
import {inSection,parseArctic,redditImage,redditTopic} from '../src/reddit';
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
it('keeps a preview already in the Arctic payload and leaves a text post imageless', () => {
 const photo = 'https://i.redd.it/photo.png';
 const preview = 'https://preview.redd.it/photo.jpg?auto=webp&amp;s=abc';
 const poster = 'https://external-preview.redd.it/frame.png?format=pjpg&s=abc';
 const imagePost = {...post, id: 'img123', permalink: '/r/PuertoRico/comments/img123/photo/', url: photo, thumbnail: preview, preview: {images: [{source: {url: preview}}]}};
 const videoPost = {...post, id: 'vid123', permalink: '/r/PuertoRico/comments/vid123/clip/', url: 'https://v.redd.it/clip', thumbnail: 'self', preview: {images: [{source: {url: poster}}]}};
 const textPost = {...post, thumbnail: 'self', url: 'https://www.reddit.com/r/PuertoRico/comments/abc123/governor_election/'};
 expect(redditImage(imagePost)).toBe('https://preview.redd.it/photo.jpg?auto=webp&s=abc');
 expect(redditImage({url: photo})).toBe(photo);
 expect(redditImage({thumbnail: 'https://preview.redd.it/gallery.jpg?width=140&s=abc'})).toBe('https://preview.redd.it/gallery.jpg?width=140&s=abc');
 expect(parseArctic(JSON.stringify({data: [imagePost]}), now)[0].image).toBe('https://preview.redd.it/photo.jpg?auto=webp&s=abc');
 expect(parseArctic(JSON.stringify({data: [videoPost]}), now)[0].image).toBe(poster);
 expect(parseArctic(JSON.stringify({data: [textPost]}), now)[0].image).toBe('');
 expect(redditImage({thumbnail: 'default', url: 'https://evil.example/a.jpg'})).toBe('');
 expect(redditImage({thumbnail: 'https://www.redditstatic.com/icon.png'})).toBe('');
 expect(redditImage({url: 'http://preview.redd.it/photo.jpg'})).toBe('');
 expect(redditImage({preview: {images: [{source: {url: 'https://preview.redd.it/clip.mp4'}}]}})).toBe('');
});
it('shows a recovered Reddit image and a compact monogram on a text lead', async () => {
 const photo = {...post, id: 'img123', permalink: '/r/PuertoRico/comments/img123/photo/', title: 'Photo from the island', preview: {images: [{source: {url: 'https://preview.redd.it/island.jpg'}}]}};
 const text = {...post, id: 'txt123', permalink: '/r/PuertoRico/comments/txt123/question/', title: 'A question with no picture', thumbnail: 'self', selftext: ''};
 const [pictured, bare] = parseArctic(JSON.stringify({data: [photo, text]}), now);
 const html = await renderer.fetch(new Request('https://news.dev.pr/s/comunidad'), {items: [bare, pictured], translations: {}, feeds: []}).text();
 expect(html).toContain('class="card lead noimg"');
 expect(html).toContain('class="card tile"');
 expect(html).toContain('src="https://preview.redd.it/island.jpg"');
 const lead = html.slice(html.indexOf('class="card lead'), html.indexOf('</article>'));
 expect(lead).not.toContain('<img');
});
