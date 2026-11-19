import { canonical, plain, redditExcerpt, safeUrl, type Item } from './parse';
import { classify, fold, type Section } from './sections';

export const redditSource = 'reddit_puertorico';
export const arcticFeed = 'https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=PuertoRico&sort=desc&limit=100';

// Classify original titles in either language; unmatched discussions stay only in Reddit.
const englishKeywords: Partial<Record<Section, string[]>> = {
 politica: ['governor', 'mayor', 'senate', 'legislature', 'election', 'elections', 'politics', 'political', 'politica', 'elecciones'],
 policiales: ['police', 'murder', 'arrest', 'shooting', 'court', 'crime'],
 energia: ['power outage', 'electricity', 'water outage', 'airport'],
 negocios: ['economy', 'business', 'investment', 'taxes', 'tourism'],
 'bienes-raices': ['real estate', 'mortgage', 'housing', 'zoning'],
 salud: ['health', 'hospital', 'doctor', 'healthcare'],
 educacion: ['school', 'university', 'college', 'education', 'interamericana'],
 clima: ['hurricane', 'storm', 'drought', 'flood', 'weather'],
 deportes: ['baseball', 'basketball', 'volleyball', 'sports'],
 entretenimiento: ['concert', 'movie', 'music', 'festival'],
};
export function redditTopic(title: string): Section | undefined {
 const result = classify('https://www.reddit.com/', [], title);
 if(result.section !== 'otras') return result.section;
 const text=fold(title);
 let best: Section | undefined, score=0;
 for(const [section, words] of Object.entries(englishKeywords)) {
  const matches=words.filter(word=>new RegExp(`\\b${word}\\b`).test(text)).length;
  if(matches>score){score=matches;best=section as Section;}
 }
 return best;
}
/** Hosts the old Atom `media:thumbnail` already carried. A text post sends thumbnail
 * "self" or "default" and has no preview; it stays imageless. Nothing here is fetched. */
const redditImageHosts = new Set(['i.redd.it', 'preview.redd.it', 'external-preview.redd.it']);
export function redditImage(post: { url?: unknown; thumbnail?: unknown; preview?: { images?: Array<{ source?: { url?: unknown } }> } }): string {
 const preview = post.preview?.images?.[0]?.source?.url;
 for (const raw of [preview, post.thumbnail, post.url]) {
  if (typeof raw !== 'string') continue;
  const safe = safeUrl(raw);
  if (!safe) continue;
  let host = '', path = '';
  try { const u = new URL(safe); host = u.hostname.toLowerCase(); path = u.pathname; if (u.protocol !== 'https:') continue; } catch { continue; }
  if (!redditImageHosts.has(host) || /\.(svg|gifv|mp4)$/i.test(path)) continue;
  return safe;
 }
 return '';
}
export function inSection(item: Item, section: string): boolean {
 if(item.source!==redditSource) return item.section===section;
 return section==='comunidad' || redditTopic(item.title)===section;
}
export function parseArctic(text: string, now: number): Item[] {
 const payload=JSON.parse(text);
 if(!Array.isArray(payload.data)) throw new Error('Invalid Arctic Shift response');
 return payload.data.flatMap((post: any): Item[]=>{
  if(typeof post.subreddit!=='string'||post.subreddit.toLowerCase()!=='puertorico'||typeof post.id!=='string'||!/^[a-z0-9]+$/.test(post.id)) return [];
  if(post.removed_by_category || post.selftext==='[removed]' || post.selftext==='[deleted]' || ['[removed]','[deleted]'].includes(post.title)) return [];
  if(typeof post.title!=='string'||typeof post.created_utc!=='number') return [];
  const title=plain(post.title), time=post.created_utc*1000;
  if(!title||!Number.isFinite(time)||time>now||time<now-14*86400000) return [];
  if(typeof post.permalink!=='string'||!new RegExp(`^/r/puertorico/comments/${post.id}/`,'i').test(post.permalink)) return [];
  const url=canonical(post.permalink,'https://www.reddit.com');
  return [{url,source:redditSource,title,summary:redditExcerpt(typeof post.selftext==='string'?post.selftext:''),image:redditImage(post),time,observed:false,section:'comunidad',reason:'community'}];
 });
}
