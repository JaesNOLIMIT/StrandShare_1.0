import { getAdultBirthdateMax, isAtLeastAge } from './personIdentity';

describe('adult birthdate validation', () => {
  const referenceDate = new Date('2026-09-03T04:00:00Z');

  it('returns the latest eligible birthdate for an 18-year-old', () => {
    expect(getAdultBirthdateMax(18, referenceDate)).toBe('2008-09-03');
  });

  it('accepts someone turning 18 today', () => {
    expect(isAtLeastAge('2008-09-03', 18, referenceDate)).toBe(true);
  });

  it('rejects someone who turns 18 tomorrow and invalid dates', () => {
    expect(isAtLeastAge('2008-09-04', 18, referenceDate)).toBe(false);
    expect(isAtLeastAge('not-a-date', 18, referenceDate)).toBe(false);
  });
});
