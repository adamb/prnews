import {it,expect} from 'vitest';
import {key,valid,sensitive,CAP} from '../src/lighter';
import type {Item} from '../src/parse';
const item={url:'https://example.com/a',title:'Traffic delays',summary:'The agency reports traffic delays.'} as Item;
it('separates content, URL and editions',()=>{
 expect(key(item,'es')).not.toBe(key(item,'en'));
 expect(key(item,'es')).not.toBe(key({...item,summary:'Changed'},'es'));
 expect(key(item,'es')).not.toBe(key({...item,url:'https://example.com/b'},'es'));
 expect(key({...item},'es')).toBe(key(item,'es'));
});
it('rejects unchanged, oversized, markup, invented numbers and reassurance',()=>{
 for(const text of [item.summary,'x'.repeat(301),'<script>alert(1)</script>','Traffic delayed for 99 hours.','Do not worry, you are safe.'])expect(valid(text,item)).toBe(false);
 expect(valid('The agency reports delays on the roads.',item)).toBe(true);
});
it('rejects an invented institution and keeps a joke aimed at the situation',()=>{
 const apology={url:'https://example.com/apology',title:'Tres formas de dejar de pedir perdón en exceso, según la psicología',summary:'Las disculpas automáticas son un intento de controlar la ansiedad'} as Item;
 expect(valid('Government apologizes in advance for upcoming apologies.',apology)).toBe(false);
 expect(valid('Government apologizes in advance for upcoming apologies.',apology,'en')).toBe(false);
 expect(valid('El gobierno se disculpó por adelantado y anunció más disculpas.',apology,'es')).toBe(false);
 expect(valid('Automatic apologies filed a second apology and called the extra one growth.',apology,'en')).toBe(true);
 const governed={url:'https://example.com/gov',title:'El gobierno publicó el acuerdo',summary:'El texto salió esta mañana.'} as Item;
 expect(valid('The Gobierno filed the same signature twice this morning.',governed,'en')).toBe(true);
 const governor={url:'https://example.com/governor',title:'Visita a la isla',summary:'El gobernador firmó el texto esta mañana.'} as Item;
 expect(valid('The Gobierno filed the same signature twice this morning.',governor,'en')).toBe(true);
 const englishGovernment={url:'https://example.com/en-gov',title:'The government published the text',summary:'The signature was filed this morning.'} as Item;
 expect(valid('El gobierno archivó la misma firma otra vez esta mañana.',englishGovernment,'es')).toBe(true);
 const board={url:'https://example.com/board',title:'La Junta exige transparencia',summary:'La Junta de Supervisión Fiscal pidió los documentos.'} as Item;
 expect(valid('The board filed the same demand twice this morning.',board,'en')).toBe(true);
 expect(valid('The apology stayed in a state of rehearsal and filed itself again.',apology,'en')).toBe(true);
});
it('withholds recognized sensitive topics in both languages',()=>{
 for(const text of ['Two dead after outage','Heridos en accidente','Health hazard','Emergencia por huracán','Police investigate murder'])expect(sensitive(text)).toBe(true);
 expect(sensitive('Agency paperwork and traffic delays')).toBe(false);
 expect(CAP).toBe(2);
});
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generate,read} from '../src/lighter';
import type {Env} from '../src/ingest';
import {vi} from 'vitest';
it('bounds concurrent generation, caches successes and backs off failures',async()=>{
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync('migrations/0011_lighter.sql','utf8'));sql.exec('CREATE TABLE articles(payload TEXT,published_at INTEGER)');
 sql.prepare('INSERT INTO articles VALUES(?,1)').run(JSON.stringify(item));
 const DB={prepare(query:string){let args: any[]=[];return {bind(...a:any[]){args=a;return this},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}}},async first(){return sql.prepare(query).get(...args)},async all(){return {results:sql.prepare(query).all(...args)}}}}} as unknown as D1Database;
 const run=vi.fn(async(_model:string,options:{messages:{content:string}[]})=>{const english=options.messages[0].content.includes('sentence in English');return {response:JSON.stringify({text:english?'The agency reports delays on the roads.':'La agencia informa demoras en las carreteras hoy.'})};});const env={DB,AI:{run}} as unknown as Env;
 await Promise.all([generate(env,9000000),generate(env,9000000)]);expect(run).toHaveBeenCalledTimes(2);
 await generate(env,9900000);expect(run).toHaveBeenCalledTimes(2);expect(Object.keys(await read(env))).toHaveLength(2);
 const log=vi.spyOn(console,'info').mockImplementation(()=>{});
 sql.prepare('UPDATE articles SET payload=?').run(JSON.stringify({...item,summary:'A changed report.'}));run.mockRejectedValue(new Error('private error'));
 await generate(env,10800000);expect(run).toHaveBeenCalledTimes(4);
 await generate(env,11700000);expect(run).toHaveBeenCalledTimes(4);
 expect(log).toHaveBeenCalledWith('lighter_result',{lang:'es',status:'model_error'});
 sql.prepare('UPDATE articles SET payload=?').run(JSON.stringify({...item,summary:'Another public report.'}));
 run.mockResolvedValue({response:'private malformed response'});
 await generate(env,12600000);
 expect(log).toHaveBeenCalledWith('lighter_result',{lang:'es',status:'decode_error'});
 expect(JSON.stringify(log.mock.calls)).not.toContain('private');
 log.mockRestore();
 sql.close();
});
import renderer from '../src/render';
it('renders optional escaped edition-specific disclosure with originals and mobile styling',async()=>{
 const story={...item,source:'nimb',image:'',time:Date.now(),observed:false,section:'negocios',reason:'manual-import'} as Item;
 for(const lang of ['es','en']){
  const text=lang==='es'?'La agencia informa demoras & más trámites.':'The agency reports delays & more paperwork.';
  const data={items:[story],translations:{},feeds:[],lighter:{[key(story,lang)]:text}};
  const html=await renderer.fetch(new Request('https://news.dev.pr/?lang='+lang),data).text();
  expect(html).toContain('class="lighter-ask"');
  expect(html).toContain(lang==='es'?'Ver la sátira guardada':'Show the saved satire');
  expect(html).not.toContain(text);
  expect(html).toContain(story.title);expect(html).toContain(encodeURIComponent(story.url));expect(html).toContain('min-height:44px');
  expect(html).toContain('max-width:390px');expect(html).toContain('--bg:#0e1311');
  expect(html).toContain('textContent');expect(html).not.toContain('innerHTML');
  const fallback=await renderer.fetch(new Request('https://news.dev.pr/?lang='+lang),{...data,lighter:{}}).text();
  expect(fallback).toContain(lang==='es'?'Pedir una sátira':'Ask for a satire');
  expect(fallback).not.toContain('<details class="lighter">');
 }
});

import {decode} from '../src/lighter';
it('decodes fenced and structured model JSON without relaxing text validation',()=>{
 expect(decode('```json\n{"text":"An alternative summary."}\n```')).toBe('An alternative summary.');
 expect(decode({text:'An alternative summary.'})).toBe('An alternative summary.');
 expect(decode({text:{sentence:'An alternative summary.'}})).toBe('An alternative summary.');
 expect(decode('{"text":{"content":"An alternative summary."}}')).toBe('An alternative summary.');
 expect(()=>decode('Unstructured prose')).toThrow();
 for(const title of ['Hallan el cadáver de un hombre','Muere conductor tras choque vehicular'])expect(sensitive(title)).toBe(true);
});

it('parses the sanitized real November 17 Workers AI responses',()=>{
 // Only public response.text retained from the two budgeted 13:30 UTC calls.
 const original={...item,title:'Maestros realizan hoy manifestaciones en escuelas: “Hay unos reclamos puntuales”',summary:'Maestros de distintas escuelas públicas de Puerto Rico comenzaron este martes una nueva jornada de manifestaciones para exigir mejoras salariales, el pago de deudas pendientes y atención a sus reclamos de retiro, como parte de un plan de lucha que…'};
 for(const response of [
  {text:'Maestros en Puerto Rico realizan manifestaciones para exigir mejoras salariales y pago de deudas.'},
  {text:'Teachers in Puerto Rico are protesting for salary improvements and debt payment.'},
 ]) {
  expect(decode(response)).toBe(response.text);
  expect(valid(decode(response),original)).toBe(true);
  expect(sensitive(original.title+' '+original.summary)).toBe(false);
 }
});
