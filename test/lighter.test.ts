import {it,expect} from 'vitest';
import {key,valid,rejection,sensitive,CAP} from '../src/lighter';
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
 const apology={url:'https://example.com/apology',title:'Tres maneras de dejar de disculparse en exceso, según la psicología',summary:'Las disculpas automáticas son un intento de controlar la ansiedad'} as Item;
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
 expect(valid('The United States filed the same form twice this morning.',apology,'en')).toBe(true);
 expect(valid('El estado de ánimo produjo otra disculpa automática esta tarde.',apology,'es')).toBe(true);
 const protest={url:'https://example.com/indignacion',title:'Llaman a manifestarse en el “Día de Indignación Nacional”',summary:'Protesta será el próximo viernes.'} as Item;
 expect(valid('Bureaucrats are bracing for a flood of strongly worded letters on the National Day of Indignation.',protest,'en')).toBe(true);
 expect(valid('Officials drafted another memo and called the extra copy a plan.',protest,'en')).toBe(true);
 expect(valid('The authorities scheduled a second meeting about the same meeting.',protest,'en')).toBe(true);
 expect(valid('Los burócratas prepararon otra carta y la archivaron dos veces.',protest,'es')).toBe(true);
 expect(valid('Los funcionarios anunciaron otra reunión para admirar la convocatoria.',protest,'es')).toBe(true);
 expect(valid('Las autoridades pidieron otra carta y la archivaron de nuevo.',protest,'es')).toBe(true);
 expect(valid('La Autoridad archivó el mismo formulario otra vez esta mañana.',protest,'es')).toBe(true);
 const wages={url:'https://example.com/navidad',title:'“No puede haber Navidad si no hay justicia salarial”: Convocan al Día de la Indignación Nacional',summary:'La convocatoria pide justicia salarial.'} as Item;
 expect(valid('Bureaucrats are now expected to solve economic woes, just in time for holiday shopping.',wages,'en')).toBe(true);
 expect(valid('A government agency is now trying to evict the tenants before Friday.',protest,'en')).toBe(false);
 expect(valid('The ministry scheduled another hearing about the same letter.',protest,'en')).toBe(false);
 expect(valid('The department filed the same form twice this morning.',protest,'en')).toBe(false);
 expect(valid('The committee admired its own hearing and scheduled another.',protest,'en')).toBe(false);
 expect(valid('The State filed the same form twice before Friday.',protest,'en')).toBe(false);
 expect(valid('Una agencia intenta desalojar a los vecinos antes del viernes.',protest,'es')).toBe(false);
 expect(valid('El ministerio anunció otro formulario antes de la protesta.',protest,'es')).toBe(false);
 expect(valid('El departamento archivó el mismo formulario otra vez.',protest,'es')).toBe(false);
 expect(valid('El comité admiró su propia audiencia y citó otra.',protest,'es')).toBe(false);
 expect(valid('La junta archivó el mismo formulario otra vez esta mañana.',protest,'es')).toBe(false);
 expect(valid('El Estado anunció otro formulario antes de la protesta.',protest,'es')).toBe(false);
 const ddec={url:'https://www.elnuevodia.com/negocios/economia/notas/me-tomo-por-sorpresa-secretario-del-ddec-reacciona-a-los-senalamientos-de-la-junta-fiscal/',title:'“Me tomó por sorpresa”: Secretario del DDEC reacciona a los señalamientos de la Junta Fiscal',summary:'Carlos Ríos Pierluisi insistió en la independencia fiscal de la Compañía de Turismo y anticipó que buscará aclarar los señalamientos del organismo federal'} as Item;
 // The real temperature-0 Workers AI answer for this story (November 20, 2026):
 // a generic person, not a named institution, so the guard must allow it.
 expect(valid('A government official is surprised, which is apparently news.',ddec,'en')).toBe(true);
 expect(valid('A government spokesperson is surprised, which is apparently news.',ddec,'en')).toBe(true);
 expect(valid('Un funcionario del gobierno se sorprende, lo que al parecer es noticia.',ddec,'es')).toBe(true);
 // The institution noun itself, in either language, is still checked.
 expect(valid('The government is surprised, which is apparently news.',ddec,'en')).toBe(false);
 expect(valid('El gobierno se sorprendió, lo que al parecer es noticia.',ddec,'es')).toBe(false);
 expect(valid('A government agency is surprised, which is apparently news.',ddec,'en')).toBe(false);
 expect(valid('The Department of Economic Development is surprised, which is apparently news.',ddec,'en')).toBe(false);
});
it('reports which rule rejected a line',()=>{
 const board={url:'https://example.com/board',title:'La Junta exige transparencia',summary:'La Junta de Supervisión Fiscal pidió los documentos.'} as Item;
 expect(rejection('The board filed the same demand twice this morning.',board,'en')).toBe(null);
 expect(rejection('The ministry scheduled another hearing about the same letter.',board,'en')).toBe('institution');
 expect(rejection('La Junta insiste en otra audiencia para admirar su formulario.',board,'en')).toBe('language');
 expect(rejection('Traffic delayed for 99 hours.',item)).toBe('numbers');
 expect(rejection('The agency said "traffic is a lifestyle."',item)).toBe('quotes');
 expect(rejection('Do not worry, you are safe.',item)).toBe('shape');
 expect(rejection(42,item)).toBe('shape');
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
  expect(html).toContain('data-cached="1"');
  expect(html).toContain(lang==='es'?'Mostrar sátira':'Show satire');
  expect(html).not.toContain('Pedir una sátira');
  expect(html).not.toContain('Ask for a satire');
  expect(html).not.toContain('Ver la sátira guardada');
  expect(html).not.toContain('Show the saved satire');
  expect(html).not.toContain(text);
  expect(html).toContain(story.title);expect(html).toContain(encodeURIComponent(story.url));expect(html).toContain('min-height:44px');
  expect(html).toContain('max-width:390px');expect(html).toContain('--bg:#0e1311');
  expect(html).toContain('textContent');expect(html).not.toContain('innerHTML');
  const fallback=await renderer.fetch(new Request('https://news.dev.pr/?lang='+lang),{...data,lighter:{}}).text();
  expect(fallback).toContain('data-cached="0"');
  expect(fallback).toContain(lang==='es'?'Mostrar sátira':'Show satire');
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
