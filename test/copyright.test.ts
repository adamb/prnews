import { expect, it } from 'vitest';
import { copyrightNotice } from '../src/copyright';

it('uses the Puerto Rico year boundary and localized publisher attribution', () => {
 expect(copyrightNotice('en', new Date('2027-01-01T03:59:00Z'))).toBe('© 2026 Adam Beguelin · Linked articles and images belong to their respective publishers.');
 expect(copyrightNotice('es', new Date('2027-01-01T04:00:00Z'))).toBe('© 2027 Adam Beguelin · Los artículos e imágenes enlazados pertenecen a sus respectivos medios.');
});
