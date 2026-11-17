import { describe, expect, it } from 'vitest';
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
