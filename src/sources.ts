import {additionalSources} from './additional-sources';
export interface Source {id:string;name:string;homepage:string;files:string[]}
export const sources:Source[] = [
  { id: 'nimb', name: 'News is my Business', homepage: 'https://newsismybusiness.com', files: [] },
  { id: 'noticel', name: 'NotiCel', homepage: 'https://noticel.com', files: ['noticel.xml', 'noticel_p2.xml'] },
  { id: 'endi', name: 'El Nuevo Día', homepage: 'https://www.elnuevodia.com', files: ['endi_100.xml'] },
  { id: 'primerahora', name: 'Primera Hora', homepage: 'https://www.primerahora.com', files: ['primerahora_arc.xml'] },
  { id: 'metro', name: 'Metro', homepage: 'https://www.metro.pr', files: ['metro.xml'] },
  { id: 'telemundo', name: 'Telemundo PR', homepage: 'https://www.telemundopr.com', files: ['telemundo.xml'] },
  { id: 'laperla', name: 'La Perla del Sur', homepage: 'https://www.periodicolaperla.com', files: ['laperla.xml'] },
  { id: 'sjds', name: 'San Juan Daily Star', homepage: 'https://www.sanjuandailystar.com', files: ['sjds_blogfeed.xml'] },
  { id: 'reddit_puertorico', name: 'Reddit · r/PuertoRico', homepage: 'https://www.reddit.com/r/PuertoRico/', files: ['reddit_puertorico.xml'] },
  { id: 'elvocero', name: 'El Vocero', homepage: 'https://www.elvocero.com', files: ['elvocero.xml'] },
  ...additionalSources,
];


export const isEnglishSource = (id: string) => id === 'sjds' || id === 'nimb' || id === 'newspr';

/** news.pr (https://news.pr): the AI-written English newspaper. Its items keep the
 * English original at `title`/`summary` and are translated into Spanish for the
 * Spanish edition (the reverse of the Spanish→English pipeline every other source
 * uses); see src/i18n.ts and docs/newspr-source.md. */
export const newsprSource = 'newspr';

/** Per-article language wins over the blanket source default: bilingual publishers
 * (e.g. San Juan Daily Star) ship both languages, so a per-article signal decides —
 * demonstrably Spanish ('es') is never English — while items without a signal keep
 * their source's default (sjds/nimb English, everything else Spanish). */
export const isEnglishItem = (item:{source:string;originalLanguage?:string}) => item.originalLanguage ? item.originalLanguage==='en' : isEnglishSource(item.source);
