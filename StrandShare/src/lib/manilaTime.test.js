import {
  isPastManilaDateTimeInput,
  parseManilaDateTime,
  toManilaDatabaseTimestamp,
  toManilaDateTimeInput,
} from './manilaTime';

describe('Manila legal-document timestamps', () => {
  test('interprets a timezone-less database value as UTC+8', () => {
    expect(parseManilaDateTime('2026-09-16T08:30:00').toISOString())
      .toBe('2026-09-16T00:30:00.000Z');
  });

  test('creates Manila wall-clock values from an absolute instant', () => {
    const instant = new Date('2026-09-16T00:30:00.000Z');
    expect(toManilaDateTimeInput(instant)).toBe('2026-09-16T08:30');
    expect(toManilaDatabaseTimestamp(instant)).toBe('2026-09-16T08:30:00');
  });

  test('validates datetime-local values as Manila time', () => {
    const now = new Date('2026-09-16T00:30:00.000Z');
    expect(isPastManilaDateTimeInput('2026-09-16T08:29', now)).toBe(true);
    expect(isPastManilaDateTimeInput('2026-09-16T08:31', now)).toBe(false);
  });
});
