import {detectSpanish} from '../src/parse';
import * as he from 'he';
import {execFileSync} from 'node:child_process';
/** One-time, idempotent repair for items already stored before per-article language detection
 * existed: bilingual publishers (San Juan Daily Star / News is my Business) were blanket-labeled
 * English by source even when an item is demonstrably Spanish. Repairs only the rolling 14-day
 * window (live articles and the archive revisions rendered for it), never history, never titles,
 * and adds no translations: the existing bounded queue translates the newly detected articles. */
async function query(sql:string,params:unknown[]=[]){
 const literal=(v:unknown)=>v===null?'NULL':typeof v==='number'?String(v):"'"+String(v).replaceAll("'","''")+"'";
 let i=0;const command=sql.replace(/\?/g,()=>literal(params[i++]));
 const env={...process.env};delete env.CLOUDFLARE_API_TOKEN;
 const result=JSON.parse(execFileSync('npx',['wrangler','d1','execute','prnews','--remote','--json','--command',command],{env,encoding:'utf8',maxBuffer:16*1024*1024}));
 return result[0].results;
}
const window=Date.now()-14*86400000;
const rows=await query("SELECT url,payload FROM articles WHERE source IN ('sjds','nimb') AND published_at>=? AND COALESCE(json_extract(payload,'$.originalLanguage'),'')!='es'",[window]);
let articles=0;
for(const row of rows){
 const item=JSON.parse(row.payload) as {title:string;summary:string};
 const decoded=[item.title,item.summary].map(t=>he.decode(he.decode(t??'')));
 if(detectSpanish(decoded[0],decoded[1])!=='es')continue;
 // Same-payload guard: a rerun (or a racing scan) cannot double-apply or overwrite fresh text.
 await query("UPDATE articles SET payload=json_set(payload,'$.originalLanguage','es') WHERE url=? AND payload=?",[row.url,row.payload]);
 articles++;
}
const revisions=await query("SELECT id,url,payload FROM archive_revisions WHERE source IN ('sjds','nimb') AND captured_at>=? AND COALESCE(json_extract(payload,'$.originalLanguage'),'')!='es'",[window]);
let archived=0;
for(const row of revisions){
 const item=JSON.parse(row.payload) as {title:string;summary:string};
 const decoded=[item.title,item.summary].map(t=>he.decode(he.decode(t??'')));
 if(detectSpanish(decoded[0],decoded[1])!=='es')continue;
 await query("UPDATE archive_revisions SET payload=json_set(payload,'$.originalLanguage','es') WHERE id=? AND payload=?",[row.id,row.payload]);
 archived++;
}
console.log(JSON.stringify({checked:rows.length,detectedSpanish:articles,archiveRevisionsChecked:revisions.length,archivedDetected:archived}));
