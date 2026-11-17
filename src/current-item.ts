import {classify} from './sections';
import type {Item} from './parse';
/** Repair only manually imported NIMB slugs, never publisher-provided titles. */
export function repairNimbTitle(title:string):string {
 return title.replace(/\b(\d+) (\d+)([mk])\b/gi,'$$$1.$2$3').replace(/(?<![\w$.])\b(\d+)([mk])\b/gi,'$$$1$2')
  .replace(/\bPuerto Ricos\b/gi,"Puerto Rico’s").replace(/\bAmgens\b/gi,'Amgen’s').replace(/\bGoogle org\b/gi,'Google.org')
  .replace(/\b3q\b/gi,'3Q').replace(/nearly 80$/,'nearly 80%').replace(/rises 63 sales/,'rises 63%, sales').replace(/climbs 24 lifts/,'climbs 24%, lifts');
}
export function currentItem(item:Item):Item {
 if(item.source==='reddit_puertorico')return item;
 if(item.reason==='manual-import')return item.source==='nimb'&&('titleOrigin' in item)&&item.titleOrigin==='url-slug'?{...item,title:repairNimbTitle(item.title)}:item;
 return {...item,...classify(item.url,[],item.title+' '+item.summary)};
}
