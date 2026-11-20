import {it,expect} from 'vitest';
import renderer from '../src/render';
import {digestRoute} from '../src/digest-http';
import {sources} from '../src/sources';
import type {Item} from '../src/parse';
const item=(source:string,title:string):Item=>({url:`https://example.org/${source}`,source,title,summary:'This is the supplied excerpt.',image:'',time:Date.now(),observed:false,section:'negocios',reason:'manual-import'});
it('filters sources, serves English-readable items only with ?lang=en, and never renders the retired English-only checkbox',async()=>{
 const es=item('noticel','Spanish headline'),en=item('nimb','English headline');
 const cache={[es.url]:{originalTitle:es.title,originalSummary:es.summary,title:'Translated headline',summary:es.summary}};
 const data={items:[es,en],translations:cache,feeds:[]};
 const english=await renderer.fetch(new Request('https://news.dev.pr/s/negocios?source=nimb&lang=en'),data).text();
 expect(english).toContain('English headline');expect(english).not.toContain('Spanish headline');
 expect(english).toContain('name="source"');expect(english).toContain('role="search"');
 expect(english).not.toContain('name="english"');expect(english).not.toContain('Solo en inglés');
 expect(english).not.toContain('English only');
 // Language (not a filter flag) decides the rendered edition: English shows the valid translation.
 const englishHome=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),data).text();
 expect(englishHome).toContain('Translated headline');expect(englishHome).not.toContain('>Spanish headline<');
 const spanish=await renderer.fetch(new Request('https://news.dev.pr/?lang=es'),data).text();
 expect(spanish).toContain('Spanish headline');expect(spanish).toContain('English headline'); // the Spanish edition is not filtered
 expect(spanish).not.toContain('name="english"');expect(spanish).not.toContain('Solo en inglés');
 const untranslated=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),{items:[es],translations:{},feeds:[]}).text();
 expect(untranslated).not.toContain('>Spanish headline<');
});
it('never renders raw feed errors and includes contact and alerts entry points',async()=>{
 const html=await renderer.fetch(new Request('https://news.dev.pr/fuentes'),{items:[],translations:{},feeds:[{source:'nimb',url:'https://example.org/feed',error:'D1_ERROR: sensitive SQL',last_ok:Date.now()} as any]}).text();
 expect(html).not.toContain('sensitive SQL');expect(html).toContain('Actualizando');expect(html).toContain('prnews@code.pr');
 expect(html).toContain('/signup');expect(html).not.toContain('/digest/subscribe');
});
it('uses the same code.pr contact in the mailto link and about page',async()=>{
 const html=await renderer.fetch(new Request('https://news.dev.pr/about'),{items:[],translations:{},feeds:[],contactEmail:'prnews@code.pr'}).text();
 expect(html).toContain('mailto:prnews@code.pr');
});
it('returns unavailable without sending mail and keeps token pages private',async()=>{
 const r=await digestRoute(new Request('https://news.dev.pr/digest/subscribe',{method:'POST',body:'email=a%40example.org',headers:{'Content-Type':'application/x-www-form-urlencoded'}}),{} as any);
 expect(r?.status).toBe(503);expect(r?.headers.get('Cache-Control')).toBe('no-store');expect(await r?.text()).not.toContain('cloudflareinsights');
 const invalid=await digestRoute(new Request('https://news.dev.pr/digest/confirm?token=invalid'),{} as any);
 expect(invalid?.status).toBe(200);expect(await invalid?.text()).not.toContain('invalid');
});
it('shows keyword alerts with a truthful paused state when verification is missing',async()=>{
 const off=await renderer.fetch(new Request('https://news.dev.pr/signup'),{items:[],translations:{},feeds:[],alerts:{available:false}}).text();
 expect(off).toContain('Alertas por palabra clave');
 expect(off).not.toContain('action="/alerts/signup?lang=es"');
 expect(off).toContain('temporalmente');
 expect(off).not.toContain('/digest/subscribe');
 const footerEn=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),{items:[],translations:{},feeds:[],alerts:{available:false}}).text();
 expect(footerEn).toContain('Get email matches for your phrase');
 expect(footerEn).toContain('Signups temporarily paused');
 const footerEs=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[],translations:{},feeds:[],alerts:{available:false}}).text();
 expect(footerEs).toContain('Recibe por correo las noticias');
 expect(footerEs).toContain('pausadas temporalmente');
 const on=await renderer.fetch(new Request('https://news.dev.pr/signup'),{items:[],translations:{},feeds:[],alerts:{available:true,siteKey:'0xSITEKEY'}}).text();
 expect(on).toContain('action="/alerts/signup?lang=es"');
 expect(on).toContain('name="phrase"');
 expect(on).toContain('0xSITEKEY');
 expect(on).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
 expect(on).toContain('data-action="signup"');
 // The client guard ships with the widget: expiry/error callbacks, an accessible live
 // status region, and the reset logic that guides retry instead of posting dead tokens.
 expect(on).toContain('data-expired-callback="__prTsExp"');
 expect(on).toContain('data-error-callback="__prTsErr"');
 expect(on).toContain('__prTsOk');
 expect(on).toContain('aria-live');
 expect(on).toContain('preventDefault');
 const onEn=await renderer.fetch(new Request('https://news.dev.pr/signup?lang=en'),{items:[],translations:{},feeds:[],alerts:{available:true,siteKey:'0xSITEKEY'}}).text();
 expect(onEn).toContain('Keyword alerts');expect(onEn).toContain('Create alert');
});
it('rejects malformed JSON subscription input with a truthful 400',async()=>{
  const r=await digestRoute(new Request('https://news.dev.pr/digest/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:'not-json{'}),{} as any);
  expect(r?.status).toBe(400);
  expect(await r?.text()).toContain('/ Invalid request.');
 });
it('places every homepage article only once, including hero and trending',async()=>{
 const a=item('noticel','Primer titular'),b=item('nimb','Second headline'),reddit={...item('reddit_puertorico','Hospital discussion'),section:'comunidad' as const};
 const html=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[a,b,reddit],translations:{},feeds:[],trending:[{item:a,clicks:4}]}).text();
 // The "Última hora" ticker (outside <main>) deliberately repeats the newest headlines; everything
 // inside <main> — hero, side stories, sections, rail — must still place each article once.
 const main=html.slice(html.indexOf('<main'),html.indexOf('</main>'));
 for(const title of [a.title,b.title,reddit.title])expect(main.split('>'+title+'</a>').length-1).toBe(1);
 // Stories without a thumbnail get the source's monogram block, never a broken or shifting image.
 expect(main).toContain('class="ph"');expect(main).not.toContain('<img');expect(html).not.toContain('this.closest');
 expect(html).not.toContain('Feeds checked every 15 minutes');
});
it('shows the excerpt once per hero and story card, with no repeated Why-it-matters block, in both languages',async()=>{
 const es={...item('noticel','Titular en español'),summary:'Un portavoz confirmó el acuerdo esta mañana.'};
 const en={...item('nimb','English headline'),summary:'The agency published the report today.'};
 const cache={[es.url]:{originalTitle:es.title,originalSummary:es.summary,title:'Translated headline',summary:'An official confirmed the agreement this morning.'}};
 const data={items:[es,en],translations:cache,feeds:[]};
 for(const edition of ['/','/?lang=en']){
  const html=await renderer.fetch(new Request('https://news.dev.pr'+edition),data).text();
  expect(html).not.toContain('class="importance"');
  expect(html).not.toContain('Por qué importa');expect(html).not.toContain('Why it matters');
 }
 const spanish=await renderer.fetch(new Request('https://news.dev.pr/'),data).text();
 expect(spanish.split(es.summary).length-1).toBe(1);
 expect(spanish.split(en.summary).length-1).toBe(1);
 expect(spanish.split('An official confirmed the agreement this morning.').length-1).toBe(0);
 const english=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),data).text();
 expect(english.split('An official confirmed the agreement this morning.').length-1).toBe(1);
 expect(english.split(en.summary).length-1).toBe(1);
 expect(english.split(es.summary).length-1).toBe(0);
 const storyEs=await renderer.fetch(new Request('https://news.dev.pr/story?id=x'),{...data,story:true}).text();
 expect(storyEs).not.toContain('class="importance"');expect(storyEs).not.toContain('Por qué importa');
 expect(storyEs.split(es.summary).length-1).toBe(1);
 const storyEn=await renderer.fetch(new Request('https://news.dev.pr/story?id=x&lang=en'),{...data,story:true}).text();
 expect(storyEn.split('An official confirmed the agreement this morning.').length-1).toBe(1);
 expect(storyEn).not.toContain('Why it matters');
});
it('opens the More-sections menu in-flow at full width on narrow viewports instead of an offscreen popup',async()=>{
 const html=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[],translations:{},feeds:[]}).text();
 expect(html).toContain('<details class="more-nav">');expect(html).toContain('<summary>Más secciones</summary>');
 // Phones: the panel is a full-width sheet anchored to the sticky bar, not a right-aligned popup.
 expect(html).toContain('@media(max-width:768px){');
 expect(html).toContain('.more-nav{position:static}');
 expect(html).toContain('.more-nav>div{left:0;right:0;width:auto;max-width:none;');
 // Wider screens keep the anchored dropdown.
 expect(html).toContain('.more-nav>div{position:absolute;right:0;top:100%;width:260px');
});

it('omits the status strip even when cached status data is supplied',async()=>{
 const html=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[],translations:{},feeds:[],status:{chips:[{id:'weather',es:'NWS: sin alertas activas',en:'NWS: no active alerts',link:'https://www.weather.gov/sju/',ts:Date.now()}],generatedAt:Date.now(),needsRefresh:false}}).text();
 expect(html).not.toContain('La isla ahora');expect(html).not.toContain('NWS: sin alertas activas');expect(html).not.toContain('<aside class="island-now"');
});

const mainOf = (html: string) => html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const chipOf = (html: string) => {
 const main = mainOf(html);
 const at = main.indexOf('class="source-chip"');
 return main.slice(at, main.indexOf('</p>', at));
};
it('links each card source to its own view and leaves the headline on /click',async()=>{
 const endi=item('endi','Titular de Endi');
 const reddit={...item('reddit_puertorico','Hilo de la comunidad'),section:'comunidad' as const};
 const unknown={...item('not-a-source','Titular sin registro')};
 const html=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[endi,reddit,unknown],translations:{},feeds:[]}).text();
 const main=mainOf(html);
 expect(main).toContain('<span class="src"><a href="/?source=endi&amp;lang=es">El Nuevo Día</a></span>');
 expect(main).toContain('<span class="src"><a href="/?source=reddit_puertorico&amp;lang=es">Reddit · r/PuertoRico</a></span>');
 expect(main).toContain('<span class="src">not-a-source</span>');
 expect(main).not.toContain('source=not-a-source');
 const srcHrefs=[...main.matchAll(/<span class="src"><a href="([^"]+)">/g)].map(match=>match[1]);
 expect(srcHrefs.length).toBeGreaterThan(0);
 expect(srcHrefs.every(href=>href.startsWith('/?source=')&&!href.includes('/click'))).toBe(true);
 expect(main.split(`/click?url=${encodeURIComponent(endi.url)}`).length-1).toBeGreaterThan(0);
 const en=await renderer.fetch(new Request('https://news.dev.pr/s/negocios?lang=en'),{items:[item('nimb','English headline')],translations:{},feeds:[]}).text();
 expect(mainOf(en)).toContain('<span class="src"><a href="/?source=nimb&amp;lang=en">News is my Business</a></span>');
 const story=await renderer.fetch(new Request('https://news.dev.pr/story?id=4'),{items:[endi],translations:{},feeds:[],story:true}).text();
 const storyMain=mainOf(story);
 expect(storyMain).toContain('<span class="src"><a href="/?source=endi&amp;lang=es">El Nuevo Día</a></span>');
 expect(storyMain).toContain(`/click?url=${encodeURIComponent(endi.url)}`);
 expect(html).toContain('.meta .src a:hover,.meta .src a:focus-visible{text-decoration:underline');
});
it('adds a stories link on /fuentes and a clearable chip while a source filter is active',async()=>{
 const fuentes=await renderer.fetch(new Request('https://news.dev.pr/fuentes'),{items:[],translations:{},feeds:[]}).text();
 expect(fuentes.match(/Ver sus noticias →/g)).toHaveLength(sources.length);
 expect(fuentes).toContain('href="/?source=endi&amp;lang=es"');
 expect(fuentes).toContain('href="/?source=reddit_puertorico&amp;lang=es"');
 expect(fuentes).not.toContain('See its stories');
 const fuentesEn=await renderer.fetch(new Request('https://news.dev.pr/fuentes?lang=en'),{items:[],translations:{},feeds:[]}).text();
 expect(fuentesEn.match(/See its stories →/g)).toHaveLength(sources.length);
 expect(fuentesEn).toContain('href="/?source=metro&amp;lang=en"');
 const endi=item('endi','Solo Endi');
 const other=item('noticel','Solo Noticel');
 const home=await renderer.fetch(new Request('https://news.dev.pr/?source=endi'),{items:[endi,other],translations:{},feeds:[],trending:[{item:other,clicks:9},{item:endi,clicks:2}]}).text();
 const main=mainOf(home);
 const chip=chipOf(home);
 expect(chip).toContain('Mostrando solo:');
 expect(chip).toContain('<strong>El Nuevo Día</strong>');
 expect(chip).toContain('>Quitar filtro</a>');
 expect(chip).toContain('href="/?lang=es"');
 expect(chip).not.toContain('source=');
 expect(main).toContain('Solo Endi');
 expect(main).not.toContain('Solo Noticel');
 expect(home).not.toContain('Solo Noticel');
 expect(main).toContain('class="rail"');
 expect(main).toContain('name="source"');
 expect(main).toContain('>Aplicar</button>');
 const plain=await renderer.fetch(new Request('https://news.dev.pr/'),{items:[endi],translations:{},feeds:[]}).text();
 expect(plain).not.toContain('class="source-chip"');
 const ignored=await renderer.fetch(new Request('https://news.dev.pr/?source=nope'),{items:[endi],translations:{},feeds:[]}).text();
 expect(ignored).not.toContain('class="source-chip"');
 expect(mainOf(ignored)).toContain('Solo Endi');
 const section=await renderer.fetch(new Request('https://news.dev.pr/s/politica?source=endi&lang=en&page=2'),{items:[endi],translations:{},feeds:[]}).text();
 const sectionChip=chipOf(section);
 expect(sectionChip).toContain('Showing only:');
 expect(sectionChip).toContain('>Clear filter</a>');
 expect(sectionChip).toContain('href="/s/politica?lang=en&amp;page=2"');
 expect(sectionChip).not.toContain('source=');
 expect(section).toContain('>Apply</button>');
 expect(section).toContain('<option value="endi" selected>');
 const star=item('sjds','Solo Daily Star');
 const search=await renderer.fetch(new Request('https://news.dev.pr/search?q=luma&source=sjds&lang=en&page=3'),{items:[star,other],translations:{},feeds:[]}).text();
 const searchChip=chipOf(search);
 expect(searchChip).toContain('Showing only:');
 expect(searchChip).toContain('<strong>San Juan Daily Star</strong>');
 expect(searchChip).toContain('href="/search?lang=en&amp;q=luma&amp;page=3"');
 expect(searchChip).not.toContain('source=');
 expect(mainOf(search)).toContain('Solo Daily Star');
 expect(mainOf(search)).not.toContain('Solo Noticel');
 expect(search).toContain('name="source"');
 expect(search).toContain('<option value="sjds" selected>');
 const empty=await renderer.fetch(new Request('https://news.dev.pr/?source=endi'),{items:[other],translations:{},feeds:[]}).text();
 expect(chipOf(empty)).toContain('Quitar filtro');
 expect(empty).toContain('No hay noticias para mostrar con estos filtros.');
 expect(mainOf(empty)).not.toContain('Solo Noticel');
});
it('includes verified English originals from mixed-language publishers without a Translated label',async()=>{
 const en={...item('endi','Senate confirms the new ambassador'),originalLanguage:'en' as const};
 const html=await renderer.fetch(new Request('https://news.dev.pr/?lang=en'),{items:[en],translations:{},feeds:[]}).text();
 expect(html).toContain('Senate confirms the new ambassador');expect(html).toContain('Original in English');expect(html).not.toContain('Translated · Original');
});

 it('describes the build process in each edition without inventing model usage statistics',async()=>{
  for(const [lang,heading,credit] of [['en','How this was built','Created for fun by'],['es','Cómo se construyó','Creado por diversión por']]){
   const html=await renderer.fetch(new Request('https://news.dev.pr/about?lang='+lang),{items:[],translations:{},feeds:[]}).text();
   expect(html).toContain(heading);
   for(const name of ['Grok','t3.codes','Roux','Codex','GLM-5.3-Flash Cloud','OpenCode','Ollama Cloud','Cloudflare Workers','D1','R2','Llama 3.3',credit,'https://blog.beguelin.com','mailto:prnews@code.pr'])expect(html).toContain(name);
   expect(html).toContain(lang==='en'?'not a complete authorship record':'no un registro completo de autoría');
   expect(html).not.toContain(lang==='en'?'Cómo se construyó':'How this was built');
   expect(html).not.toContain('DeepSeek');
  }
 });
