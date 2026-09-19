const TERMINAL_STATUS_KEYS = new Set([
  'released',
  'returned_completed',
  'rejected',
  'cancelled',
]);

function normalizedCondition(row) {
  return `${row?.conditionCategory || ''} ${row?.medicalCondition || ''}`
    .trim()
    .toLowerCase();
}

function requestTime(value) {
  const raw = String(value || '').trim().replace(' ', 'T');
  if (!raw) return Number.POSITIVE_INFINITY;
  const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = new Date(hasOffset ? raw : `${raw}+08:00`).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function isTerminalWigRequest(statusKey) {
  return TERMINAL_STATUS_KEYS.has(String(statusKey || '').trim());
}

export function getAutomaticWigRequestPriority(row) {
  const condition = normalizedCondition(row);
  const fromPartnerHospital = Number(row?.hospitalId || 0) > 0;

  if (condition.includes('cancer')) return fromPartnerHospital ? 1 : 2;
  if (condition.includes('alopecia')) return fromPartnerHospital ? 3 : 4;
  return 5;
}

export function getWigRequestPriorityDetails(row) {
  const terminal = isTerminalWigRequest(row?.statusKey);
  const automaticPriority = getAutomaticWigRequestPriority(row);
  const urgent = !terminal && Boolean(row?.isUrgent);
  const fromPartnerHospital = Number(row?.hospitalId || 0) > 0;
  const condition = normalizedCondition(row);

  let reason = 'Other medical condition';
  if (condition.includes('cancer')) {
    reason = `Cancer patient ${fromPartnerHospital ? 'from a Partner Hospital' : 'outside a Partner Hospital'}`;
  } else if (condition.includes('alopecia')) {
    reason = `Alopecia patient ${fromPartnerHospital ? 'from a Partner Hospital' : 'outside a Partner Hospital'}`;
  }

  return {
    automaticPriority,
    displayLabel: urgent ? 'Urgent' : `Priority ${automaticPriority}`,
    reason,
    terminal,
    urgent,
  };
}

export function compareWigRequestPriority(a, b) {
  const aDetails = getWigRequestPriorityDetails(a);
  const bDetails = getWigRequestPriorityDetails(b);

  if (aDetails.terminal !== bDetails.terminal) return aDetails.terminal ? 1 : -1;

  if (aDetails.terminal && bDetails.terminal) {
    return requestTime(b?.requestDate) - requestTime(a?.requestDate);
  }

  if (aDetails.urgent !== bDetails.urgent) return aDetails.urgent ? -1 : 1;
  if (aDetails.urgent && bDetails.urgent) {
    const byOldestUrgentRequest = requestTime(a?.requestDate) - requestTime(b?.requestDate);
    if (byOldestUrgentRequest !== 0) return byOldestUrgentRequest;
    return Number(a?.reqId || 0) - Number(b?.reqId || 0);
  }
  if (aDetails.automaticPriority !== bDetails.automaticPriority) {
    return aDetails.automaticPriority - bDetails.automaticPriority;
  }

  const byOldestRequest = requestTime(a?.requestDate) - requestTime(b?.requestDate);
  if (byOldestRequest !== 0) return byOldestRequest;
  return Number(a?.reqId || 0) - Number(b?.reqId || 0);
}
