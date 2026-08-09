import { parseMedicalDocumentFields } from './medicalDocumentAutofill';

describe('parseMedicalDocumentFields', () => {
  it('extracts clearly labeled patient and clinical details', () => {
    const fields = parseMedicalDocumentFields(`
      First Name: Maria
      Middle Name: Santos
      Last Name: Reyes
      Date of Birth: February 14, 2012
      Sex: Female
      Email: maria.reyes@example.com
      Date of Diagnosis: 2025-04-03
      Clinical Diagnosis: Alopecia areata
      Guardian Name: Ana Reyes
      Guardian Contact Number: 0917 123 4567
      Relationship to Patient: Mother
    `);

    expect(fields).toEqual(expect.objectContaining({
      email: 'maria.reyes@example.com',
      firstName: 'Maria',
      middleName: 'Santos',
      lastName: 'Reyes',
      birthdate: '2012-02-14',
      gender: 'Female',
      dateOfDiagnosis: '2025-04-03',
      medicalCondition: 'Alopecia areata',
      guardian: 'Ana Reyes',
      guardianContactNumber: '+63 917 123 4567',
      guardianRelationship: 'Mother',
    }));
  });

  it('supports a labeled last-name-first patient name', () => {
    const fields = parseMedicalDocumentFields(`
      Patient Name: Dela Cruz, Juan Miguel Jr.
      Gender: Male
    `);

    expect(fields).toEqual(expect.objectContaining({
      firstName: 'Juan',
      middleName: 'Miguel',
      lastName: 'Dela Cruz',
      suffix: 'Jr',
      gender: 'Male',
    }));
  });

  it('does not guess an ambiguous numeric date', () => {
    const fields = parseMedicalDocumentFields('Date of Birth: 05/06/2014');
    expect(fields.birthdate).toBeUndefined();
  });
});
