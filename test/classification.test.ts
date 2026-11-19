import { describe, expect, it } from 'vitest';
import { currentItem } from '../src/current-item';
import type { Item } from '../src/parse';
import { classify, navigationSections, primarySection, sections } from '../src/sections';

describe('bilingual classification', () => {
 it.each([
  ['Hieren de bala a un hombre; fue trasladado al hospital', 'policiales'],
  ['Shooting victim taken to hospital on the main road', 'policiales'],
  ['Motociclista muere arrollado en carretera de Canóvanas', 'policiales'],
  ['Hit-and-run leaves pedestrian injured near hospital', 'policiales'],
  ['Falla de Microsoft afecta las operaciones del aeropuerto', 'negocios'],
  ['Microsoft cloud outage disrupts hospital systems', 'negocios'],
  ['Power outage leaves homes without electricity', 'energia'],
  ['Agua: una historia de recuerdos', 'otras'],
  ['El cantante genera entusiasmo entre vecinos', 'otras'],
  ['Santurce defeats Carolina in BSNF quarterfinals', 'deportes'],
  ['Nasdaq futures fall as AI stocks tumble', 'negocios'],
  ['University students win education award', 'educacion'],
  ['Vivir con dermatitis atópica y sus tratamientos', 'salud'],
  ['Healthcare doctors discuss treatment', 'salud'],
  ['Orchestra concert celebrates classical music', 'entretenimiento'],
  ['House speaker proposes Agriculture Dept. overhaul', 'politica'],
  ['Trump discusses war in Ukraine', 'mundo'],
  ['Una historia distinta', 'otras'],
 ])('%s → %s', (text, section) => {
  expect(classify('https://example.com/story/', [], text).section).toBe(section);
 });
 it('preserves publisher routing and category signals', () => {
  expect(classify('https://example.com/opinion/story/', ['Sports'], 'Microsoft outage').section).toBe('opinion');
  expect(classify('https://example.com/sports/story/', [], 'Hospital sponsors team').section).toBe('deportes');
  expect(classify('https://example.com/story/', [' Health '], 'New clinic').section).toBe('salud');
  expect(classify('https://example.com/story/', ['Educación'], 'Una historia').section).toBe('educacion');
  expect(classify('https://example.com/technology/story/', [], 'Global disruption').section).toBe('negocios');
 });
 it('keeps old routes and groups page content with navigation', () => {
  expect(sections).toHaveLength(14);
  expect(navigationSections).toHaveLength(11);
  expect(primarySection('bienes-raices')).toBe('bienes-raices');
  expect(navigationSections.slice(0, 3).map(([slug]) => slug)).not.toContain('bienes-raices');
  expect(navigationSections.slice(3).map(([slug]) => slug)).toContain('bienes-raices');
  expect(primarySection('educacion')).toBe('salud');
  expect(primarySection('clima')).toBe('energia');
  expect(primarySection('opinion')).toBe('otras');
  expect(primarySection('comunidad')).toBe('comunidad');
  for (const [slug] of sections) {
   expect(navigationSections.map(([s]) => s)).toContain(primarySection(slug));
   expect(primarySection(primarySection(slug))).toBe(primarySection(slug));
  }
 });
 it('routes property sales and leaves crime, fires, and generic words alone', () => {
  const rio = 'https://www.elnuevodia.com/negocios/bienes-raices/notas/mansion-costera-en-rio-grande-se-vende-por-27-millones/';
  expect(classify(rio, [], 'Mansión costera en Río Grande se vende por $27 millones')).toEqual({ section: 'bienes-raices', reason: 'url' });
  expect(classify('https://example.com/a/', [], 'Bahia Beach property sells for $28.5 million').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Una propiedad en Bahía Beach se vende por $28.5 millones').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', ['Bienes Raíces'], 'Nota breve')).toEqual({ section: 'bienes-raices', reason: 'category' });
  expect(classify('https://example.com/a/', ['Real Estate'], 'Mortgage note')).toEqual({ section: 'bienes-raices', reason: 'category' });
  expect(classify('https://example.com/a/', [], 'El mercado de alquiler y las tasas hipotecarias').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Municipio publica la zonificación de un proyecto residencial').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Departamento de la Vivienda anuncia vivienda asequible').section).toBe('bienes-raices');
  expect(classify('https://example.com/ley-y-orden/a/', ['Real Estate'], 'Casa en venta').section).toBe('policiales');
  expect(classify('https://example.com/a/', [], 'Asesinan a un hombre dentro de una casa en Río Grande').section).toBe('policiales');
  expect(classify('https://example.com/a/', [], 'Robo a un banco en San Juan').section).toBe('policiales');
  expect(classify('https://example.com/a/', [], 'Shooting inside a home listed for sale').section).toBe('policiales');
  expect(classify('https://example.com/a/', [], 'Incendio en una casa en venta en San Juan').section).toBe('otras');
  expect(classify('https://example.com/a/', [], 'Robo en un apartamento en alquiler').section).toBe('policiales');
  expect(classify('https://example.com/a/', [], 'Governor signs a housing bill after senate debate').section).toBe('politica');
  expect(classify('https://example.com/a/', [], 'The estate sold family heirlooms at auction').section).not.toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'House sold out for the concert').section).not.toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Alquiler de autos en el aeropuerto').section).not.toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Suben los alquileres de apartamentos en Condado').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Oceanfront apartment for rent in Condado').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Se alquila apartamento en Isla Verde').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Se vende casa en Rincón').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'New housing announced in Dorado').section).toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Irrumpieron en la vivienda y se llevaron efectivo').section).not.toBe('bienes-raices');
  expect(classify('https://example.com/a/', [], 'Incendio en una casa en San Juan deja a una familia sin hogar')).toEqual({ section: 'otras', reason: 'fallback' });
  expect(classify('https://example.com/a/', [], 'Mujer pierde a sus mascotas tras incendio en su casa')).toEqual({ section: 'otras', reason: 'fallback' });
  expect(classify('https://www.elnuevodia.com/negocios/autos/notas/venta-de-autos/', [], 'Venta de autos más baja desde 2020').section).toBe('negocios');
  expect(classify('https://example.com/entretenimiento/farandula/notas/boletos/', [], 'Pondrá a la venta más boletos').section).toBe('entretenimiento');
  expect(classify('https://example.com/opinion/a/', [], 'Columna sobre bienes raíces').section).toBe('opinion');
  expect(classify('https://example.com/a/', [], 'Nasdaq futures fall as AI stocks tumble').section).toBe('negocios');
 });
});

describe('sports court, shooting, and defend versus a legal court', () => {
 const pollitasUrl = 'https://www.sanjuandailystar.com/post/pollitas-defend-home-court-manat%C3%AD-holds-off-caguas-to-go-up-2-0/';
 const pollitasTitle = 'Pollitas defend home court; Manatí holds off Caguas to go up 2-0';
 const pollitasSummary = 'Quionche Carter had 28 points and eight rebounds to lead the Pollitas of Isabela to a 73-62 win over the Gigantes of Carolina in Game 1 of their best-of-five BSNF semifinal series. The Pollitas of Isabela defended their home court.';
 const pollitasText = `${pollitasTitle} ${pollitasSummary}`;
 const story = (title: string, summary = ''): Item => ({
  url: pollitasUrl, source: 'sjds', title, summary, image: '', time: 1, observed: false, section: 'deportes', reason: 'category',
 });

 it('keeps the Sports category at ingest and sends the game recap to deportes on render', () => {
  expect(classify(pollitasUrl, ['Sports'], pollitasText)).toEqual({ section: 'deportes', reason: 'category' });
  expect(classify(pollitasUrl, [], pollitasTitle)).toEqual({ section: 'deportes', reason: 'keywords' });
  expect(classify(pollitasUrl, [], pollitasText)).toEqual({ section: 'deportes', reason: 'keywords' });
  expect(currentItem(story(pollitasTitle, pollitasSummary))).toMatchObject({ section: 'deportes', reason: 'keywords' });
 });

 it.each([
  ['Shooting guard scores 28 in the home-court win', 'deportes'],
  ["Carter's shooting leads the Pollitas with 28 points and eight rebounds", 'deportes'],
  ['Three-point shooting carries Isabela to a 73-62 win', 'deportes'],
  ['Three-point shooting wins it in sudden death overtime', 'deportes'],
  ['Shooting leaves two dead outside the arena', 'policiales'],
  ['Las Pollitas defendieron su cancha; Carter anotó 28 puntos y ocho rebotes', 'deportes'],
  ['Las Pollitas defienden su cancha en el juego 1 de la serie', 'deportes'],
  ['Shooting victim taken to hospital on the main road', 'policiales'],
  ['Shooting inside a home listed for sale', 'policiales'],
  ['Former BSN player arrested after a shooting near the arena', 'policiales'],
  ['BSNF star appears in court on a fraud charge', 'policiales'],
  ['Court sentences a former basketball player in a hit-and-run', 'policiales'],
  ['Animal welfare group to seek court order requiring a government plan', 'policiales'],
  ['The parties appeared at a status hearing in federal court', 'policiales'],
  ['Supreme Court sanctions siblings for using artificial intelligence to defend themselves', 'policiales'],
  ['Jugador de baloncesto acusado de tiroteo comparece ante el tribunal', 'policiales'],
  ['El atleta defiende su caso en el tribunal', 'policiales'],
  ['Tiroteo en la cancha del residencial deja a una mujer herida', 'policiales'],
 ])('%s → %s', (text, section) => {
  expect(classify('https://example.com/post/story/', [], text).section).toBe(section);
 });

 it('does not treat a residential court or the verb courting as sports or crime', () => {
  expect(classify('https://example.com/post/story/', [], 'Una mujer fue apuñalada en la cancha del residencial').section).not.toBe('deportes');
  expect(classify('https://example.com/post/story/', [], 'The Margaritaville hotel brand is courting Ponce').section).not.toBe('policiales');
 });

 it('keeps publisher paths ahead of the game-recap rule', () => {
  expect(classify('https://example.com/ley-y-orden/a/', [], pollitasText)).toEqual({ section: 'policiales', reason: 'url' });
  expect(classify('https://www.noticel.com/deportes/20261118/bsnf-las-pollitas/', [], 'Jugador acusado de asesinato')).toEqual({ section: 'deportes', reason: 'url' });
 });

 it('still skips Reddit and manual imports when reclassifying', () => {
  const reddit = currentItem({ ...story('Pollitas defend home court'), source: 'reddit_puertorico', section: 'comunidad', reason: 'community' });
  expect(reddit).toMatchObject({ section: 'comunidad', reason: 'community' });
  const manual = currentItem({ ...story('Pollitas defend home court'), source: 'nimb', section: 'negocios', reason: 'manual-import' });
  expect(manual).toMatchObject({ section: 'negocios', reason: 'manual-import' });
 });
});
