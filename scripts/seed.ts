import { readFile, writeFile } from 'node:fs/promises';
import { sources } from '../src/sources';
import { parseFeed } from '../src/parse';
const capturedAt = Date.parse('2026-11-14T04:30:00Z');
const items = new Map();
for (const source of sources) for (const file of source.files) {
 for (const item of parseFeed(await readFile(new URL('../test/fixtures/' + file, import.meta.url), 'utf8'), source, capturedAt)) items.set(item.url, item);
}
await writeFile(new URL('../src/data.json', import.meta.url), JSON.stringify({ capturedAt, items: [...items.values()].sort((a, b) => b.time - a.time) }));
console.log(`Loaded ${items.size} articles from ${sources.length} sources. ${Math.round([...items.values()].filter(i => i.section !== 'otras').length / items.size * 100)}% classified.`);
