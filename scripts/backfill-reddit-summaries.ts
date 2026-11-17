import {redditExcerpt} from '../src/parse';
import {arcticFeed} from '../src/reddit';
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('Set CLOUDFLARE_API_TOKEN');
const account=process.env.CLOUDFLARE_ACCOUNT_ID,database=process.env.CLOUDFLARE_DATABASE_ID;
if(!account||!database)throw Error('Set account and database IDs');
async function query(sql:string,params:unknown[]=[]){
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
 const result=await response.json() as any;if(!response.ok||!result.success)throw Error(JSON.stringify(result.errors));return result.result[0].results;
}
const response=await fetch(arcticFeed,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error(`Arctic Shift ${response.status}`);
const archive=await response.json() as any;
if(!Array.isArray(archive.data))throw Error('Invalid archive');
const posts=new Map<string,any>(archive.data.filter((p:any)=>p.subreddit?.toLowerCase()==='puertorico').map((p:any)=>[p.id,p]));
const rows=await query("SELECT url,payload FROM articles WHERE source='reddit_puertorico' AND json_extract(payload,'$.summary')=''");
let count=0;
for(const row of rows){
 const item=JSON.parse(row.payload),id=new URL(item.url).pathname.split('/')[4],post=posts.get(id);
 if(post?.removed_by_category||post?.selftext==='[removed]'||post?.selftext==='[deleted]')continue;
 item.summary=redditExcerpt(typeof post?.selftext==='string'?post.selftext:'');
 await query('UPDATE articles SET payload=?,translation=NULL,translation_attempt=0,updated_at=? WHERE url=? AND payload=?',[JSON.stringify(item),Date.now(),row.url,row.payload]);count++;
}
console.log(`Prepared ${count} Reddit summaries.`);
