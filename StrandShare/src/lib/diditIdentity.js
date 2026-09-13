function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function validIsoDate(year, month, day) {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeDiditBirthdate(value) {
  if (value && typeof value === 'object') {
    const year = Number(value.year ?? value.yyyy);
    const month = Number(value.month ?? value.mm);
    const day = Number(value.day ?? value.dd);
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
      return validIsoDate(year, month, day);
    }
    return normalizeDiditBirthdate(firstPresent(
      value.date_of_birth,
      value.birth_date,
      value.date,
      value.value,
      value.iso,
      value.raw,
    ));
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const yearFirst = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
  if (yearFirst) {
    return validIsoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  }

  // Philippine IDs commonly print dates as DD/MM/YYYY or DD-MM-YYYY.
  const dayFirst = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\D|$)/);
  if (dayFirst) {
    return validIsoDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return validIsoDate(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

function objectSources(report = {}) {
  const sources = [];
  const queue = [{ value: report, depth: 0 }];
  const visited = new Set();

  while (queue.length && sources.length < 60) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);

    if (Array.isArray(value)) {
      if (depth < 4) value.forEach((entry) => queue.push({ value: entry, depth: depth + 1 }));
      continue;
    }

    sources.push(value);
    if (depth < 4) Object.values(value).forEach((entry) => queue.push({ value: entry, depth: depth + 1 }));
  }

  return sources;
}

function pickFromSources(sources, keys) {
  for (const source of sources) {
    const value = firstPresent(...keys.map((key) => source[key]));
    if (value !== undefined) return value;
  }
  return '';
}

function pickLabeledValue(sources, labels) {
  const acceptedLabels = new Set(labels.map((label) => label.toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const source of sources) {
    const label = String(source.key || source.name || source.label || source.field || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!acceptedLabels.has(label)) continue;
    const value = firstPresent(source.value, source.extracted_value, source.raw_value, source.text);
    if (value !== undefined) return value;
  }
  return '';
}

function normalizeAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object' || Array.isArray(value)) return String(value).trim();

  return [
    value.street_1,
    value.street_2,
    value.street,
    value.barangay,
    value.city,
    value.municipality,
    value.province,
    value.region,
    value.postal_code,
    value.country,
  ].map((part) => String(part || '').trim()).filter(Boolean).join(', ');
}

export function normalizeDiditDocument(report = {}) {
  if (!report || typeof report !== 'object') return null;
  const sources = objectSources(report);
  const extraSources = sources
    .map((source) => source.extra_fields)
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const middleName = pickFromSources([...sources, ...extraSources], [
    'middle_name',
    'middleName',
    'middlename',
    'middle',
  ]);
  const address = pickFromSources(sources, ['formatted_address', 'full_address', 'address', 'parsed_address']);

  const birthdate = pickFromSources(sources, ['date_of_birth', 'birth_date', 'birthdate', 'dob'])
    || pickLabeledValue(sources, ['date_of_birth', 'birth_date', 'birthdate', 'dob']);

  return {
    status: String(pickFromSources(sources, ['status']) || '').trim(),
    document_type: String(pickFromSources(sources, ['document_type', 'documentType', 'type']) || '').trim(),
    document_subtype: String(pickFromSources(sources, ['document_subtype', 'documentSubtype', 'subtype']) || '').trim(),
    document_number: String(pickFromSources(sources, ['document_number', 'documentNumber', 'id_number', 'personal_number']) || '').trim(),
    first_name: String(pickFromSources(sources, ['first_name', 'firstName', 'given_name', 'given_names']) || '').trim(),
    middle_name: String(middleName || '').trim(),
    last_name: String(pickFromSources(sources, ['last_name', 'lastName', 'surname', 'family_name']) || '').trim(),
    full_name: String(pickFromSources(sources, ['full_name', 'fullName', 'name']) || '').trim(),
    date_of_birth: normalizeDiditBirthdate(birthdate),
    gender: String(pickFromSources(sources, ['gender', 'sex']) || '').trim(),
    formatted_address: normalizeAddress(address),
  };
}
