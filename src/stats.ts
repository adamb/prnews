import type {Env} from './ingest';
import {needsTranslation, type Translation} from './i18n';
/** Samples the same queue the scheduler serves: every article the English edition cannot yet render
 * in English — not just rows with no stored translation — so missing and invalid cached
 * translations are both counted. Language is per article: sjds/nimb/newspr rows are
 * English by source default (newspr's Spanish translation never makes a row pending
 * for the English edition), and rows marked demonstrably Spanish are pending like
 * any other Spanish article. Old samples used the narrower NULL-only
 * definition and remain as recorded; they are not recalculated. */
export async function sampleQueue(env:Env) {
 const now=Math.floor(Date.now()/900000)*900000;
 const rows=(await env.DB.prepare(`SELECT url,payload,translation FROM articles WHERE published_at>=? AND (json_extract(payload,'$.originalLanguage')='es' OR (source NOT IN ('sjds','nimb','newspr') AND COALESCE(json_extract(payload,'$.originalLanguage'),'')!='en'))`).bind(now-14*86400000).all<{url:string;payload:string;translation:string|null}>()).results;
 const translations:Record<string,Translation>={};
 for(const row of rows)if(row.translation)try{translations[row.url]=JSON.parse(row.translation) as Translation;}catch{/* Counts as awaiting translation. */}
 await env.DB.prepare('INSERT OR REPLACE INTO translation_queue_history(sampled_at,pending) VALUES(?,?)').bind(now,rows.filter(row=>needsTranslation(JSON.parse(row.payload),translations)).length).run();
}
export async function queueHistory(env:Env) {
 return (await env.DB.prepare('SELECT sampled_at,pending FROM translation_queue_history WHERE sampled_at>=? ORDER BY sampled_at').bind(Date.now()-30*86400000).all<{sampled_at:number;pending:number}>()).results;
}
// Transparent lexical signals, not a model of editorial bias or political alignment.
export function tone(text:string):number {
 const words=text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z]+/g)??[];
 const positive=new Set(['success','growth','recovery','wins','improves','benefit','exito','crecimiento','recuperacion','mejora','beneficio']);
 const negative=new Set(['death','killed','crisis','loss','violence','fraud','outage','muerte','asesinato','perdida','violencia','fraude','apagon']);
 return Math.sign(words.reduce((n,w)=>n+(positive.has(w)?1:0)-(negative.has(w)?1:0),0));
}
