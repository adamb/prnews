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
/** Hosts already present on the Arctic post. A text post sends thumbnail "self" or
 * "default" and has no preview; it stays imageless. Nothing here is fetched.
 * cf.preview.redd.it is the full-size preview CDN; preview.redd.it is often only the 140px thumb. */
const redditImageHosts = new Set(['i.redd.it', 'preview.redd.it', 'cf.preview.redd.it', 'external-preview.redd.it']);
type RedditMedia = { status?: unknown; e?: unknown; s?: { u?: unknown } };
function redditImageUrl(raw: unknown): string {
 if (typeof raw !== 'string') return '';
 const safe = safeUrl(raw);
 if (!safe) return '';
 try {
  const u = new URL(safe);
  if (u.protocol !== 'https:' || !redditImageHosts.has(u.hostname.toLowerCase()) || /\.(svg|gifv|mp4)$/i.test(u.pathname)) return '';
  return safe;
 } catch { return ''; }
}
function galleryOriginal(post: { media_metadata?: Record<string, RedditMedia> | null; gallery_data?: { items?: Array<{ media_id?: unknown }> } | null }): string {
 const meta = post.media_metadata;
 if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
 const order = Array.isArray(post.gallery_data?.items)
  ? post.gallery_data.items.flatMap(item => typeof item?.media_id === 'string' ? [item.media_id] : [])
  : Object.keys(meta);
 for (const id of order) {
  const entry = meta[id];
  if (!entry || entry.status === 'failed' || entry.status === 'invalid' || entry.status === 'deleted' || entry.e === 'RedditVideo') continue;
  const url = redditImageUrl(entry.s?.u);
  if (url) return url;
 }
 return '';
}
export function redditImage(post: { url?: unknown; thumbnail?: unknown; preview?: { images?: Array<{ source?: { url?: unknown } }> }; media_metadata?: Record<string, RedditMedia> | null; gallery_data?: { items?: Array<{ media_id?: unknown }> } | null }): string {
 const direct = redditImageUrl(post.url);
 if (direct && new URL(direct).hostname === 'i.redd.it') return direct;
 const preview = redditImageUrl(post.preview?.images?.[0]?.source?.url);
 if (preview) return preview;
 const gallery = galleryOriginal(post);
 if (gallery) return gallery;
 if (direct) return direct;
 return redditImageUrl(post.thumbnail);
}
export function inSection(item: Item, section: string): boolean {
 if(item.source!==redditSource) return item.section===section;
 return section==='comunidad' || redditTopic(item.title)===section;
}
/** Validates one archived post and builds the stored item with the same rules the
 * feed scan applies, so the bounded image repair reuses identical logic. Returns
 * undefined for removed, foreign-subreddit, out-of-window, or malformed posts. */
export function parseArcticPost(post: any, now: number): Item | undefined {
 if(typeof post.subreddit!=='string'||post.subreddit.toLowerCase()!=='puertorico'||typeof post.id!=='string'||!/^[a-z0-9]+$/.test(post.id)) return undefined;
 if(post.removed_by_category || post.selftext==='[removed]' || post.selftext==='[deleted]' || ['[removed]','[deleted]'].includes(post.title)) return undefined;
 if(typeof post.title!=='string'||typeof post.created_utc!=='number') return undefined;
 const title=plain(post.title), time=post.created_utc*1000;
 if(!title||!Number.isFinite(time)||time>now||time<now-14*86400000) return undefined;
 if(typeof post.permalink!=='string'||!new RegExp(`^/r/puertorico/comments/${post.id}/`,'i').test(post.permalink)) return undefined;
 const url=canonical(post.permalink,'https://www.reddit.com');
 return {url,source:redditSource,title,summary:redditExcerpt(typeof post.selftext==='string'?post.selftext:''),image:redditImage(post),time,observed:false,section:'comunidad',reason:'community'};
}
export function parseArctic(text: string, now: number): Item[] {
 const payload=JSON.parse(text);
 if(!Array.isArray(payload.data)) throw new Error('Invalid Arctic Shift response');
 return payload.data.flatMap((post: any): Item[]=>{
  const item=parseArcticPost(post,now);
  return item?[item]:[];
 });
}
