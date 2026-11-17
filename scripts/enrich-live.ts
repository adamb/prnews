// Bounded operational run of the same enrichment function used by scheduled refresh.
import {execFileSync} from 'node:child_process';
import {enrichImages} from '../src/image-enrich';
const literal=(v:unknown)=>typeof v==='number'?String(v):v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const DB={prepare(sql:string){let args:unknown[]=[];const run=async()=>{let i=0;const result=JSON.parse(execFileSync('npx',['wrangler','d1','execute','prnews','--remote','--command',sql.replace(/\?/g,()=>literal(args[i++])),'--json'],{encoding:'utf8'}).replace(/^[\s\S]*?(?=\[\s*\{)/,''))[0];return result;};return {bind(...values:unknown[]){args=values;return this;},run,all:run,async first(){return (await run()).results[0]??null;}};}};
console.log(JSON.stringify(await enrichImages({DB} as any)));

