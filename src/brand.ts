/** Presentation-only identity: the little monogram shown when a story has no usable thumbnail,
 * and the accent each section wears. Nothing here touches stored data; ids come from sources.ts
 * and sections.ts, and unknown ids degrade to initials derived from the display name. */
export interface Mark { code: string; hue: number }

const MARKS: Record<string, Mark> = {
 endi: { code: 'END', hue: 18 },
 primerahora: { code: 'PH', hue: 350 },
 metro: { code: 'METRO', hue: 205 },
 telemundo: { code: 'T·PR', hue: 265 },
 elvocero: { code: 'EV', hue: 28 },
 noticel: { code: 'NC', hue: 0 },
 nimb: { code: 'NIMB', hue: 160 },
 sjds: { code: 'SJDS', hue: 225 },
 laperla: { code: 'LPS', hue: 190 },
 wapa: { code: 'WAPA', hue: 48 },
 wipr: { code: 'WIPR', hue: 140 },
 claridad: { code: 'CLA', hue: 330 },
 radioisla: { code: 'RI', hue: 292 },
 walo: { code: 'WALO', hue: 122 },
 reddit_puertorico: { code: 'r/PR', hue: 15 },
 vision: { code: 'VIS', hue: 208 },
 lacalle: { code: 'LC', hue: 172 },
 elsol: { code: 'SOL', hue: 24 },
 esnoticia: { code: 'ESN', hue: 258 },
 eloriental: { code: 'EO', hue: 88 },
 laesquina: { code: 'LE', hue: 316 },
 millones: { code: '9M', hue: 154 },
 eyboricua: { code: '¡E!', hue: 335 },
 pasquines: { code: 'PAS', hue: 232 },
 wkaq: { code: 'WKAQ', hue: 105 },
 prreport: { code: 'PRR', hue: 220 },
 centro: { code: 'CEN', hue: 280 },
 laprensafl: { code: 'LPO', hue: 15 },
 thecity: { code: 'CITY', hue: 200 },
 documented: { code: 'DOC', hue: 240 },
 nbclatino: { code: 'NBC', hue: 310 },
 presencia: { code: 'PRE', hue: 272 },
};

/** Two-to-five character mark and a stable hue (0-359) for a source. */
export function sourceMark(id: string, name: string): Mark {
 const known = MARKS[id];
 if (known) return known;
 const initials = name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 4).toUpperCase();
 let hash = 0;
 for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
 return { code: initials || '·', hue: hash };
}

/** Section accent hues. Lightness and saturation are applied in CSS per theme so every accent
 * clears WCAG AA text contrast on both backgrounds; only the hue lives here. */
export const SECTION_HUE: Record<string, number> = {
 politica: 222, negocios: 165, policiales: 355, 'bienes-raices': 28, energia: 44,
 salud: 188, deportes: 100, entretenimiento: 312, mundo: 252, otras: 210, comunidad: 16,
};
export const sectionHue = (slug: string): number => SECTION_HUE[slug] ?? 160;
