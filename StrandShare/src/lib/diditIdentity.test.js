import { normalizeDiditBirthdate, normalizeDiditDocument } from './diditIdentity';

describe('Didit identity normalization', () => {
  it('normalizes ISO timestamps and Philippine day-first birthdates', () => {
    expect(normalizeDiditBirthdate('1990-05-17T00:00:00Z')).toBe('1990-05-17');
    expect(normalizeDiditBirthdate('17/05/1990')).toBe('1990-05-17');
    expect(normalizeDiditBirthdate({ value: '17-05-1990' })).toBe('1990-05-17');
  });

  it('rejects impossible dates', () => {
    expect(normalizeDiditBirthdate('31/02/1990')).toBe('');
  });

  it('reads identity fields from nested provider responses', () => {
    expect(normalizeDiditDocument({
      status: 'Approved',
      extracted_data: {
        firstName: 'Maria',
        lastName: 'Santos',
        dob: '17/05/1990',
        sex: 'F',
        id_number: 'ABC-123',
        parsed_address: { street_1: '1 Rizal St', city: 'Manila', country: 'PHL' },
        extra_fields: { middle_name: 'Reyes' },
      },
    })).toEqual(expect.objectContaining({
      first_name: 'Maria',
      middle_name: 'Reyes',
      last_name: 'Santos',
      date_of_birth: '1990-05-17',
      gender: 'F',
      document_number: 'ABC-123',
      formatted_address: '1 Rizal St, Manila, PHL',
    }));
  });

  it('finds a birthdate nested several levels inside a provider result', () => {
    expect(normalizeDiditDocument({
      result: {
        document: {
          fields: {
            date_of_birth: { value: '1992-11-03T00:00:00Z' },
          },
        },
      },
    })).toEqual(expect.objectContaining({ date_of_birth: '1992-11-03' }));
  });

  it('supports structured and labeled birthdate values', () => {
    expect(normalizeDiditBirthdate({ year: 1988, month: 4, day: 9 })).toBe('1988-04-09');
    expect(normalizeDiditDocument({
      fields: [{ key: 'date_of_birth', value: '09/04/1988' }],
    })).toEqual(expect.objectContaining({ date_of_birth: '1988-04-09' }));
  });
});
