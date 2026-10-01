import { buildApplicationStatusData } from './DashboardPage';

describe('buildApplicationStatusData', () => {
  test('counts every supported program application status', () => {
    const result = buildApplicationStatusData([
      { Status: 'Pending Staff Review' },
      { Status: 'Pending Admin Decision' },
      { Status: 'Pending Admin Approval' },
      { Status: 'Appealed' },
      { Status: 'Approved' },
      { Status: 'Rejected' },
      { Status: 'Cancelled' },
      { Status: 'Withdrawn' },
      { Status: 'Closed' },
    ]);
    const counts = Object.fromEntries(result.map((entry) => [entry.key, entry.value]));

    expect(counts).toMatchObject({
      pendingstaffreview: 1,
      pendingadmindecision: 2,
      appealed: 1,
      approved: 1,
      rejected: 1,
      cancelled: 1,
      withdrawn: 1,
      closed: 1,
    });
  });

  test('keeps unexpected statuses visible instead of dropping them', () => {
    const result = buildApplicationStatusData([
      { Status: 'Needs Clarification' },
      { Status: 'Needs Clarification' },
      { Status: null },
    ]);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'needsclarification', name: 'Needs Clarification', value: 2 }),
      expect.objectContaining({ key: 'other', name: 'Other', value: 1 }),
    ]));
  });
});
