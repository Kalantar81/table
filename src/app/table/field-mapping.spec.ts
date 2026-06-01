import { extractRows, mapRecord } from './field-mapping';

describe('field-mapping', () => {
  describe('mapRecord', () => {
    const person = {
      firstname: 'Ada',
      lastname: 'Lovelace',
      email: 'ada@example.com',
      address: { country: 'UK' },
    };

    it('resolves a string shorthand as a direct field', () => {
      expect(mapRecord(person, 0, { email: 'email' })).toEqual({ email: 'ada@example.com' });
    });

    it('resolves a dot-notation path into nested objects', () => {
      expect(mapRecord(person, 0, { country: 'address.country' })).toEqual({ country: 'UK' });
    });

    it('falls back to default when a path resolves to undefined', () => {
      const row = mapRecord(person, 0, { country: { path: 'address.region', default: '' } });
      expect(row).toEqual({ country: '' });
    });

    it('keeps an existing value over the default', () => {
      const row = mapRecord(person, 0, { country: { path: 'address.country', default: 'N/A' } });
      expect(row).toEqual({ country: 'UK' });
    });

    it('interpolates a template over source paths', () => {
      const row = mapRecord(person, 0, { name: { template: '${firstname} ${lastname}' } });
      expect(row).toEqual({ name: 'Ada Lovelace' });
    });

    it('renders missing template paths as empty strings', () => {
      const row = mapRecord(person, 0, { label: { template: '${firstname} ${missing}' } });
      expect(row).toEqual({ label: 'Ada ' });
    });

    it('produces a 1-based index by default', () => {
      expect(mapRecord(person, 0, { id: { type: 'index' } })).toEqual({ id: 1 });
      expect(mapRecord(person, 4, { id: { type: 'index' } })).toEqual({ id: 5 });
    });

    it('honours a custom index start', () => {
      expect(mapRecord(person, 0, { id: { type: 'index', start: 100 } })).toEqual({ id: 100 });
    });

    it('combines several mappings into one row', () => {
      const row = mapRecord(person, 2, {
        id: { type: 'index' },
        name: { template: '${firstname} ${lastname}' },
        email: 'email',
        country: { path: 'address.country', default: '' },
      });
      expect(row).toEqual({ id: 3, name: 'Ada Lovelace', email: 'ada@example.com', country: 'UK' });
    });

    it('passes the record through unchanged when no fields are given', () => {
      expect(mapRecord(person, 0)).toBe(person);
    });

    it('returns an empty row for a nullish record without fields', () => {
      expect(mapRecord(null, 0)).toEqual({});
    });
  });

  describe('extractRows', () => {
    it('returns the array at a dot-notation path', () => {
      expect(extractRows({ data: [1, 2, 3] }, 'data')).toEqual([1, 2, 3]);
    });

    it('reads a nested path', () => {
      expect(extractRows({ result: { items: [{ a: 1 }] } }, 'result.items')).toEqual([{ a: 1 }]);
    });

    it('treats the top-level value as the array when no path is given', () => {
      expect(extractRows([1, 2])).toEqual([1, 2]);
    });

    it('returns an empty array when the path is missing or not an array', () => {
      expect(extractRows({ data: 'oops' }, 'data')).toEqual([]);
      expect(extractRows({}, 'data')).toEqual([]);
      expect(extractRows(null, 'data')).toEqual([]);
    });
  });
});
