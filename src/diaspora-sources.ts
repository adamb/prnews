import type {Source} from './sources';
export const diasporaSources: Source[] = [
 {id:'prreport',name:'Puerto Rico Report',homepage:'https://puertoricoreport.com',files:[]},
 {id:'centro',name:'CENTRO · CUNY',homepage:'https://centropr.hunter.cuny.edu',files:[]},
 {id:'laprensafl',name:'La Prensa Orlando',homepage:'https://laprensafl.com',files:[]},
 {id:'thecity',name:'THE CITY',homepage:'https://www.thecity.nyc',files:[]},
 {id:'documented',name:'Documented NY',homepage:'https://documentedny.com',files:[]},
 {id:'nbclatino',name:'NBC Latino',homepage:'https://www.nbcnews.com',files:[]},
];
export const diasporaFeeds: Record<string,string[]> = {
 prreport:['https://puertoricoreport.com/feed/'],
 centro:['https://centropr.hunter.cuny.edu/feed/'],
 laprensafl:['https://laprensafl.com/feed/'],
 thecity:['https://www.thecity.nyc/feed/'],
 documented:['https://documentedny.com/feed/'],
 nbclatino:['https://feeds.nbcnews.com/nbcnews/public/news'],
};
/** Match editorial title/excerpt only, never publisher boilerplate or URL keywords. */
export function diasporaRelevant(source:string, title:string, excerpt:string, url:string):boolean {
 if (!['laprensafl','thecity','documented','nbclatino'].includes(source)) return true;
 if (source === 'nbclatino') {
  const u = new URL(url);
  if (u.hostname !== 'www.nbcnews.com' || !u.pathname.startsWith('/news/latino/')) return false;
 }
 const text = (title+' '+excerpt).normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 return /\b(?:puerto\s+ric(?:o|an(?:s)?)|puertorriquen[oa]s?|boricuas?|nuyoricans?)\b/i.test(text) || (source==='thecity' && /\bSOMOS\b/.test(title+' '+excerpt) && /\b(?:conference|conferencia|legislativ[eo]|albany)\b/i.test(text));
}
