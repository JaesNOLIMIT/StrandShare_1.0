export const PERSON_SUFFIX_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'Jr.', label: 'Jr.' },
  { value: 'Sr.', label: 'Sr.' },
  { value: 'II', label: 'II' },
  { value: 'III', label: 'III' },
  { value: 'IV', label: 'IV' },
  { value: 'V', label: 'V' },
  { value: 'VI', label: 'VI' },
  { value: 'VII', label: 'VII' },
  { value: 'VIII', label: 'VIII' },
  { value: 'IX', label: 'IX' },
  { value: 'X', label: 'X' },
];

const SUFFIX_BY_KEY = new Map(
  PERSON_SUFFIX_OPTIONS
    .filter((option) => option.value)
    .map((option) => [option.value.replace(/\./g, '').toUpperCase(), option.value]),
);

export function normalizePersonSuffix(value) {
  const key = String(value || '').trim().replace(/\./g, '').toUpperCase();
  return key ? (SUFFIX_BY_KEY.get(key) || '') : '';
}

export function formatPhilippineMobile(value) {
  const rawDigits = String(value || '').replace(/\D/g, '');
  if (!rawDigits) return '';

  let localDigits = rawDigits;
  if (localDigits.startsWith('63')) localDigits = localDigits.slice(2);
  if (localDigits.startsWith('0')) localDigits = localDigits.slice(1);
  localDigits = localDigits.slice(0, 10);

  const first = localDigits.slice(0, 3);
  const middle = localDigits.slice(3, 6);
  const last = localDigits.slice(6, 10);
  return ['+63', first, middle, last].filter(Boolean).join(' ');
}

export function isValidPhilippineMobile(value) {
  return /^\+63 9\d{2} \d{3} \d{4}$/.test(String(value || '').trim());
}
