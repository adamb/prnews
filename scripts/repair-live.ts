import {currentItem} from '../src/current-item';
import {validTranslation} from '../src/i18n';
import {isEnglishSource} from '../src/sources';
const token=process.env.CLOUDFLARE_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID,database=process.env.CLOUDFLARE_DATABASE_ID;
if(!token||!account||!database)throw Error('Cloudflare credentials required');
async function query(sql:string,params:unknown[]=[]) {
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
 const data=await r.json() as any;if(!r.ok||!data.success)throw Error('D1 repair failed');return data.result[0].results;
}
const rows=await query('SELECT url,payload,translation FROM articles');
let repaired=0,queued=0;const before:Record<string,number>={},after:Record<string,number>={};
for(const row of rows){
 const original=JSON.parse(row.payload),item=currentItem(original);
 before[original.section]=(before[original.section]??0)+1;after[item.section]=(after[item.section]??0)+1;
 const bad=row.translation&&!isEnglishSource(item.source)&&!validTranslation(item,JSON.parse(row.translation));
 const payload=JSON.stringify(item);
 if(payload!==row.payload||bad){await query('UPDATE articles SET payload=?,translation=CASE WHEN translation IS ? THEN ? ELSE translation END,translation_attempt=CASE WHEN ? THEN 0 ELSE translation_attempt END WHERE url=? AND payload=?',[payload,row.translation,bad?null:row.translation,bad?1:0,row.url,row.payload]);repaired++;if(bad)queued++;}
}
console.log(JSON.stringify({articles:rows.length,repaired,translationRepairsQueued:queued,before,after}));
