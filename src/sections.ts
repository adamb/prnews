export const sections = [
 ['comunidad', 'Reddit'],
 ['politica', 'Gobierno y Política'], ['negocios', 'Economía y Negocios'],
 ['policiales', 'Policiales y Tribunales'], ['energia', 'Energía e Infraestructura'],
 ['salud', 'Salud'], ['educacion', 'Educación'], ['clima', 'Clima y Ambiente'],
 ['deportes', 'Deportes'], ['entretenimiento', 'Entretenimiento y Cultura'],
 ['mundo', 'Estados Unidos y Mundo'], ['opinion', 'Opinión'], ['otras', 'Otras'],
] as const;
export type Section = typeof sections[number][0];
export const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
// Legacy section slugs remain valid; renderers should group both pages and placement.
export function primarySection(section: string): string {
 return ({ educacion: 'salud', clima: 'energia', opinion: 'otras' } as Record<string, string>)[section] ?? section;
}
export const navigationSections = [
 ['politica', 'Gobierno y Política'],
 ['negocios', 'Economía, Negocios y Tecnología'], ['policiales', 'Seguridad y Justicia'],
 ['energia', 'Ambiente e Infraestructura'], ['salud', 'Salud, Educación y Sociedad'],
 ['deportes', 'Deportes'], ['entretenimiento', 'Entretenimiento y Cultura'],
 ['mundo', 'Estados Unidos y Mundo'], ['otras', 'Otras y Opinión'],
 ['comunidad', 'Reddit'],
] as const;
const keywords: Partial<Record<Section, string[]>> = {
 politica: ['gobernadora', 'gobernador', 'senado', 'legislatura', 'alcalde', 'pnp', 'ppd', 'mvc', 'pip', 'comisionada residente', 'proyecto de ley', 'junta de supervision fiscal', 'governor', 'mayor', 'senate', 'legislature', 'elections?', 'chief of staff', 'ethics complaint', 'vistas publicas', 'house speaker', 'house of representatives', 'legislation', 'gobierno', 'nmead'],
 policiales: ['polici[ae]s?', 'asesin\\w*', 'arrest\\w*', 'tiroteo', 'fiscalia', 'tribunal\\w*', 'juez', 'acusad[oa]', 'feminicid\\w*', 'carcel', 'hieren', 'bala', 'asalt\\w*', 'robo', 'agresion sexual', 'desaparecid[oa]', 'desaparecio', 'fbi', 'juicio', 'poder judicial', 'police', 'murder\\w*', 'shooting', 'court', 'crime', 'hit.and.run', 'atropell\\w*', 'arrollad[oa]', 'accidente', 'collision', 'crash'],
 energia: ['luma', 'genera pr', 'aee', 'apagon', 'negociado de energia', 'aaa', 'acueductos', 'carreteras?', 'aeropuert\\w*', 'aerostar', 'electric\\w*', 'power outage', 'water outage', 'grid', 'airport', 'vuelos?', 'aerolineas?', 'faa', 'transito', 'infrastructur\\w*'],
 negocios: ['hacienda', 'ivu', 'empresas?', 'econom\\w*', 'empleo', 'turismo', 'vivienda', 'inversion', 'business', 'investment', 'housing', 'tax\\w*', 'tourism', 'comercio', 'precios?', 'ddec', 'mercado', 'acciones', 'nasdaq', 'stocks', 'futures', 'fraudulentos', 'microsoft', 'outlook', 'software', 'tecnolog\\w*', 'technology', 'pep boys', 'crucero', 'norwegian prima'],
 salud: ['hospital\\w*', 'salud', 'dengue', 'medic[oa]s?', 'medicaid', 'plan vital', 'health\\w*', 'doctor', 'enfermedad', 'dermatitis', 'tratamiento', 'higado', 'espalda', 'mente activa', 'maltrato infantil', 'programas comunitarios', 'sin fines de lucro', 'givingtuesday'],
 educacion: ['educacion', 'escuela', 'maestr[oa]s?', 'upr', 'estudiante', 'universidad', 'school', 'university', 'college', 'education', 'doctoral', 'interamericana'],
 clima: ['huracan', 'tormenta', 'lluvias?', 'sequia', 'meteorologia', 'nws', 'inundacion', 'sargazo', 'hurricane', 'storm', 'drought', 'flood\\w*', 'weather', 'contaminacion', 'climate', 'environmental', 'medio ambiente'],
 deportes: ['bsnf', 'quarterfinals', 'semis', 'bsn', 'lbprc', 'beisbol', 'baloncesto', 'criollos', 'cangrejeros', 'voleibol', 'deport\\w*', 'baseball', 'basketball', 'volleyball', 'sports?', 'balonmano', 'exatleta', 'boxing', 'boxeo', 'tenis', 'soccer', 'futbol'],
 entretenimiento: ['concierto', 'latin grammy', 'regueton', 'farandula', 'pelicula', 'bad bunny', 'music\\w*', 'festival', 'concert', 'movie', 'film', 'trombonist', 'orchestra', 'navid\\w*', 'chef', 'restaurante', 'certamen', 'miss universe', 'telemundo', 'artesania', 'cultura', 'theater', 'teatro'],
 mundo: ['estados unidos', 'eeuu', 'united states', 'trump', 'iran', 'guerra', 'ucran\\w*', 'ukraine', 'gaza', 'israel', 'peru', 'bukele', 'haiti', 'pope', 'pontifice', 'papa leon', 'international', 'world'],
};
const matches = (text: string, pattern: string) => new RegExp(`\\b(?:${pattern})\\b`).test(text);
export function classify(url: string, categories: string[], text: string): { section: Section; reason: string } {
 let path = '';
 try { path = fold(decodeURIComponent(new URL(url).pathname)); } catch { /* Text still works for invalid feed links. */ }
 const paths: [RegExp, Section][] = [
 [/\/opinion\//, 'opinion'], [/\/(policia-tribunales|tribunales|policiacas|policiales|ley-y-orden|crime)\//, 'policiales'],
 [/\/(gobierno-politica|puerto-rico-voto|elecciones|gobierno|politics)\/|\/corresponsalias\/washington-dc\//, 'politica'],
 [/\/(negocios|tu-dinero|economia|business|technology|tecnologia)\/|\/noticias\/consumo\//, 'negocios'],
 [/\/(deportes[^/]*|sports)\//, 'deportes'], [/\/(entretenimiento|sabrosia|estilos?-de-vida|escenario|entertainment|culture)\//, 'entretenimiento'],
 [/\/(salud|health)\//, 'salud'], [/\/(educacion|education)\//, 'educacion'],
 [/\/(clima|ambiente|weather|environment)\//, 'clima'],
 [/\/noticias\/(estados-unidos|eeuu|mundo|texas)\/|\/(world|international)\//, 'mundo'],
 ];
 for (const [rule, section] of paths) if (rule.test(path)) return { section, reason: 'url' };
 const cats: Record<string, Section> = { policiacas: 'policiales', policiales: 'policiales', seguridad: 'policiales', policia: 'policiales', crime: 'policiales', gobierno: 'politica', legislatura: 'politica', politics: 'politica', deportes: 'deportes', mundo: 'mundo', 'estados unidos': 'mundo', business: 'negocios', negocios: 'negocios', economia: 'negocios', technology: 'negocios', tecnologia: 'negocios', sports: 'deportes', mainland: 'mundo', international: 'mundo', viewpoint: 'opinion', opinion: 'opinion', salud: 'salud', health: 'salud', educacion: 'educacion', education: 'educacion', entretenimiento: 'entretenimiento', entertainment: 'entretenimiento', cultura: 'entretenimiento', clima: 'clima', weather: 'clima', ambiente: 'clima', energia: 'energia' };
 for (const category of categories) if (cats[fold(category).trim()]) return { section: cats[fold(category).trim()], reason: 'category' };
 const normalized = fold(text);
 // Events of violence and traffic injury beat incidental hospitals and roads.
 if (matches(normalized, 'tiroteo|shooting|asesin\\w*|feminicid\\w*|hieren de bala|hit.and.run|arrollad[oa]|atropell\\w*|agresion sexual|explotacion sexual|pornografia infantil|asalt\\w*|robo|motociclista.*accidente')) return { section: 'policiales', reason: 'keywords' };
 // A software outage is a technology/business story, even when transport is affected.
 if (matches(normalized, 'microsoft|outlook|software outage|it outage|cloud outage')) return { section: 'negocios', reason: 'keywords' };
 let best: Section = 'otras', highest = 0;
 for (const [section, words] of Object.entries(keywords)) {
  const score = words.filter(w => matches(normalized, w)).length;
  if (score > highest) { highest = score; best = section as Section; }
 }
 return { section: best, reason: highest ? 'keywords' : 'fallback' };
}
