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
  expect(sections).toHaveLength(13);
  expect(navigationSections).toHaveLength(10);
  expect(primarySection('educacion')).toBe('salud');
  expect(primarySection('clima')).toBe('energia');
  expect(primarySection('opinion')).toBe('otras');
  expect(primarySection('comunidad')).toBe('comunidad');
  for (const [slug] of sections) {
   expect(navigationSections.map(([s]) => s)).toContain(primarySection(slug));
   expect(primarySection(primarySection(slug))).toBe(primarySection(slug));
  }
 });
});
