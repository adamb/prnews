import {readFile,writeFile} from 'node:fs/promises';
import type {Item} from '../src/parse';
import type {Translation} from '../src/i18n';
const data=JSON.parse(await readFile('src/data.json','utf8')) as {capturedAt:number;items:Item[]};
const translations=JSON.parse(await readFile('src/translations.en.json','utf8')) as Record<string,Translation>;
const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
const statements=data.items.map(i=>`INSERT OR IGNORE INTO articles(url,source,payload,first_seen,updated_at,published_at,translation) VALUES(${quote(i.url)},${quote(i.source)},${quote(JSON.stringify(i))},${data.capturedAt},${data.capturedAt},${i.time},${translations[i.url]?quote(JSON.stringify(translations[i.url])):'NULL'});`);
await writeFile('.wrangler/seed.sql',statements.join('\n'));
console.log('Wrote .wrangler/seed.sql; apply only after migrations. Existing articles are never overwritten.');
