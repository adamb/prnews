import {quarantined} from './quarantine';
import {safeUrl} from './parse';
import type {Env} from './ingest';
const maxBytes=16*1024*1024;
const allowedTypes=new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
export function imageUrl(raw:string):string {
 const safe=safeUrl(raw);
 if(!safe || quarantined(safe)) throw new Error('Invalid image URL');
 const url=new URL(safe);
 if(url.protocol!=='https:'||url.username||url.password||!url.hostname.includes('.')||/^[\d.]+$/.test(url.hostname)||url.hostname.includes(':')||/\.(localhost|local|internal)$/.test(url.hostname)) throw new Error('Image URL must use a public HTTPS host');
 return url.href;
}
export async function fetchImage(raw:string):Promise<{bytes:Uint8Array<ArrayBuffer>;type:string}> {
 let url=imageUrl(raw);
 const signal=AbortSignal.timeout(15000);
 for(let redirects=0;redirects<=3;redirects++) {
  const response=await fetch(url,{redirect:'manual',signal,headers:{'User-Agent':'news.dev.pr/1.0 (+https://news.dev.pr/about)'}});
  if([301,302,303,307,308].includes(response.status)) {
   const location=response.headers.get('location');await response.body?.cancel();
   if(!location||redirects===3)throw new Error('Image redirect limit');
   url=imageUrl(new URL(location,url).href);continue;
  }
  const type=(response.headers.get('content-type')??'').split(';')[0].toLowerCase();
  if(!response.ok||!allowedTypes.has(type)||Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw new Error(`Image unavailable or unsupported (${response.status}, ${type})`);}
  if(!response.body)throw new Error('Empty image response');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>maxBytes){await reader.cancel();throw new Error('Image exceeds 16 MiB');}chunks.push(value);}
  if(!length)throw new Error('Empty image');
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  // MIME headers alone are not enough: reject HTML/error pages mislabeled as an image.
  const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.slice(start,end));
  const valid=type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
   type==='image/png'?bytes[0]===137&&ascii(1,4)==='PNG':
   type==='image/gif'?['GIF87a','GIF89a'].includes(ascii(0,6)):
   type==='image/webp'?ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP':
   ascii(4,8)==='ftyp'&&/avif|avis/.test(ascii(8,32));
  if(!valid)throw new Error('Invalid image contents');
  return {bytes,type};
 }
 throw new Error('Image redirect limit');
}
async function copyImages(env:Env,now:number) {
 if(!env.ARCHIVE)return;
 const rows=await env.DB.prepare('SELECT url,attempts FROM archive_images WHERE object_key IS NULL AND attempts<6 AND next_attempt<=? ORDER BY attempts,url LIMIT 40').bind(now).all<{url:string;attempts:number}>();
 let next=0;
 await Promise.all(Array.from({length:2},async()=>{
  while(next<rows.results.length){const row=rows.results[next++];
   try {
    const {bytes,type}=await fetchImage(row.url);
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    const key='images/'+hash;
    // Identical bytes share one object even when publishers use different URLs.
    if(!await env.ARCHIVE!.head(key)) await env.ARCHIVE!.put(key,bytes,{httpMetadata:{contentType:type,cacheControl:'public, max-age=31536000, immutable'}});
    await env.DB.prepare('UPDATE archive_images SET object_key=?,content_type=?,bytes=?,saved_at=?,error=NULL,attempts=attempts+1 WHERE url=?').bind(key,type,bytes.length,now,row.url).run();
   }catch(error){await env.DB.prepare('UPDATE archive_images SET attempts=attempts+1,next_attempt=?,error=? WHERE url=?').bind(now+Math.min(86400000,3600000*2**row.attempts),String(error).slice(0,300),row.url).run();}
  }
 }));
}
export async function serveArchiveImage(request:Request,env:Env):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(!/^\/archive\/images\/[a-f0-9]{64}$/.test(path)||!env.ARCHIVE)return new Response('Not found',{status:404});
 if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
 const key=path.slice('/archive/'.length);
 const object=request.method==='HEAD'?await env.ARCHIVE.head(key):await env.ARCHIVE.get(key);
 if(!object)return new Response('Not found',{status:404});
 const headers=new Headers({'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=31536000, immutable'});
 object.writeHttpMetadata(headers);headers.set('ETag',object.httpEtag);
 if(request.headers.get('If-None-Match')===object.httpEtag)return new Response(null,{status:304,headers});
 return new Response('body' in object?object.body as ReadableStream:null,{headers});
}

export async function archiveImages(env:Env,now=Date.now()) {
 if(!env.ARCHIVE)return {skipped:'storage not configured'};
 const owner=crypto.randomUUID();
 const lock=await env.DB.prepare(`INSERT INTO jobs(id,lease_until,owner) VALUES('archive-images',?,?) ON CONFLICT(id) DO UPDATE SET lease_until=excluded.lease_until,owner=excluded.owner WHERE jobs.lease_until<?`).bind(now+10*60000,owner,now).run();
 if(!lock.meta.changes)return {skipped:'already running'};
 try {
  await copyImages(env,now);
  return await env.DB.prepare('SELECT COUNT(*) AS total, SUM(object_key IS NOT NULL) AS saved, SUM(object_key IS NULL AND attempts<6 AND next_attempt<=?) AS ready, SUM(object_key IS NULL AND error IS NOT NULL) AS failed FROM archive_images').bind(Date.now()).first();
 }finally{await env.DB.prepare("DELETE FROM jobs WHERE id='archive-images' AND owner=?").bind(owner).run();}
}
