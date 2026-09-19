export const MANILA_TIME_ZONE = 'Asia/Manila';
export const MANILA_UTC_OFFSET = '+08:00';

const EXPLICIT_TIME_ZONE_PATTERN = /(?:z|[+-]\d{2}:?\d{2})$/i;

function dateTimeParts(value) {
  const date = value instanceof Date ? value : parseManilaDateTime(value);
  if (!date || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MANILA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
}

// PostgreSQL returns `timestamp without time zone` values without an offset.
// Legal-document timestamps are Philippine wall-clock time, so never let the
// browser's local timezone decide how those values are interpreted.
export function parseManilaDateTime(value) {
  if (value instanceof Date) return value;
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T');
  return new Date(EXPLICIT_TIME_ZONE_PATTERN.test(normalized)
    ? normalized
    : `${normalized}${MANILA_UTC_OFFSET}`);
}

export function formatManilaDateTime(value, options = {}) {
  const date = parseManilaDateTime(value);
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-PH', {
    timeZone: MANILA_TIME_ZONE,
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    ...options,
  });
}

export function toManilaDateTimeInput(value = new Date()) {
  const parts = dateTimeParts(value);
  if (!parts) return '';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function toManilaDatabaseTimestamp(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value.trim())) {
    const raw = value.trim();
    const parsed = parseManilaDateTime(raw);
    if (!parsed || Number.isNaN(parsed.getTime())) return '';
    return raw.length === 16 ? `${raw}:00` : raw;
  }
  const parts = dateTimeParts(value);
  if (!parts) return '';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function isPastManilaDateTimeInput(value, now = new Date()) {
  const parsed = parseManilaDateTime(value);
  return !parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime();
}
