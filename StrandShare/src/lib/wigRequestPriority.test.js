import {
  compareWigRequestPriority,
  getAutomaticWigRequestPriority,
  getWigRequestPriorityDetails,
} from './wigRequestPriority';

describe('wig request display priority', () => {
  test.each([
    [{ conditionCategory: 'Cancer', hospitalId: 10 }, 1],
    [{ medicalCondition: 'Cancer', hospitalId: null }, 2],
    [{ conditionCategory: 'Alopecia', hospitalId: 10 }, 3],
    [{ medicalCondition: 'Alopecia Universalis', hospitalId: null }, 4],
    [{ conditionCategory: 'Other Hair-Loss Disease', hospitalId: 10 }, 5],
  ])('calculates the requested automatic priority', (row, expected) => {
    expect(getAutomaticWigRequestPriority(row)).toBe(expected);
  });

  test('puts urgent requests first and keeps urgent requests oldest-first', () => {
    const rows = [
      { reqId: 1, conditionCategory: 'Cancer', hospitalId: 1, statusKey: 'pending', requestDate: '2026-09-01T10:00:00' },
      { reqId: 2, conditionCategory: 'Cancer', hospitalId: 1, statusKey: 'pending', isUrgent: true, requestDate: '2026-09-02T10:00:00' },
      { reqId: 3, conditionCategory: 'Alopecia', hospitalId: null, statusKey: 'pending', isUrgent: true, requestDate: '2026-09-01T09:00:00' },
    ];
    expect([...rows].sort(compareWigRequestPriority).map((row) => row.reqId)).toEqual([3, 2, 1]);
  });

  test('ignores urgent on terminal requests', () => {
    expect(getWigRequestPriorityDetails({ statusKey: 'released', isUrgent: true }).urgent).toBe(false);
  });
});
