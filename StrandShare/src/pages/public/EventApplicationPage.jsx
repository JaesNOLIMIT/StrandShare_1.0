import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, Camera, CheckCircle2, ChevronLeft, ChevronRight, Loader2, MailCheck, Search, ShieldCheck, Upload, X } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import maplibregl from 'maplibre-gl';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import { useTheme } from '../../context/ThemeContext';
import { TransitionFlipEntrance } from '../../components/transitions/TransitionFlip';
import { triggerSmtpNow } from '../../lib/smtpTriggerClient';
import philippineAddressOptions from '../../data/philippineAddressOptions.json';
import 'maplibre-gl/dist/maplibre-gl.css';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const EVENT_APPLICATION_ASSETS_BUCKET = 'event_application_assets';
const MAX_UPLOAD_FILE_SIZE_BYTES = 8 * 1024 * 1024;
let isolatedAuthClient = null;

const DEFAULT_COUNTRY = 'PHILIPPINES';
const DEFAULT_MAP_CENTER = { lat: 14.5995, lng: 120.9842 };

const MAP_SATELLITE_STYLE = {
  version: 8,
  sources: {
    googleSatellite: {
      type: 'raster',
      tiles: [
        'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
      ],
      tileSize: 256,
      attribution: '© Google',
    },
  },
  layers: [
    {
      id: 'googleSatelliteLayer',
      type: 'raster',
      source: 'googleSatellite',
    },
  ],
};

const MAP_STREET_STYLE = {
  version: 8,
  sources: {
    googleStreet: {
      type: 'raster',
      tiles: [
        'https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        'https://mt2.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        'https://mt3.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
      ],
      tileSize: 256,
      attribution: '© Google',
    },
  },
  layers: [
    {
      id: 'googleStreetLayer',
      type: 'raster',
      source: 'googleStreet',
    },
  ],
};

const CONTACT_METHOD_OPTIONS = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
];
const PH_VALID_ID_OPTIONS = [
  { value: 'philsys', label: 'PhilSys National ID' },
  { value: 'drivers_license', label: "Driver's License" },
  { value: 'passport', label: 'Philippine Passport' },
  { value: 'umid', label: 'UMID' },
  { value: 'prc', label: 'PRC ID' },
  { value: 'postal', label: 'Postal ID' },
  { value: 'voters', label: "Voter's ID" },
  { value: 'senior_citizen', label: 'Senior Citizen ID' },
  { value: 'other_government', label: 'Other Government ID' },
];

const GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];
const FORM_STEPS = [
  { id: 1, title: 'Applicant Details + Email' },
  { id: 2, title: 'Program + Venue' },
  { id: 3, title: 'Review + Submit' },
];
const TERMS_AND_AGREEMENT_PDF_PATH = '/legal/donivra-terms-and-agreement.pdf';

const INITIAL_FORM = {
  applicantValidIdType: 'philsys',
  applicantIdDocumentNumber: '',
  applicantIdAddress: '',
  applicantFirstName: '',
  applicantMiddleName: '',
  applicantLastName: '',
  applicantEmail: '',
  applicantGender: '',
  applicantContactNumber: '',
  preferredContactMethod: 'email',
  eventVisibility: 'Public',
  eventName: '',
  venueName: '',
  expectedAttendees: '',
  eventOverview: '',
  proposedStartAt: '',
  proposedEndAt: '',
  proposedDate: '',
  proposedStartTime: '',
  proposedEndTime: '',
  street: '',
  barangay: '',
  city: '',
  province: '',
  region: '',
  country: DEFAULT_COUNTRY,
  latitude: '',
  longitude: '',
  socialPageName: '',
  socialPageUrl: '',
};

function ConfirmationItem({ label, value, wide = false }) {
  const displayValue = value === null || value === undefined || value === '' ? 'N/A' : value;
  return (
    <div className={wide ? 'md:col-span-2' : ''}>
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <div className="mt-0.5 break-words text-sm leading-relaxed text-slate-800">{displayValue}</div>
    </div>
  );
}

function ConfirmationSection({ title, children }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-700">{title}</h3>
      <div className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">{children}</div>
    </section>
  );
}

const PHILIPPINE_ADDRESS_TREE = philippineAddressOptions && typeof philippineAddressOptions === 'object'
  ? philippineAddressOptions
  : {};

function toUnifiedRegionOptions(addressData) {
  const data = addressData && typeof addressData === 'object' ? addressData : {};

  return Object.entries(data)
    .filter(([, regionData]) => {
      return (
        regionData
        && typeof regionData === 'object'
        && typeof regionData.region_name === 'string'
        && regionData.region_name.trim()
        && regionData.province_list
        && typeof regionData.province_list === 'object'
      );
    })
    .map(([, regionData]) => ({
      name: regionData.region_name,
      provinces: Object.entries(regionData.province_list || {})
        .map(([provinceName, provinceData]) => ({
          name: provinceName,
          cities: Object.entries(provinceData?.municipality_list || {})
            .map(([cityName, cityData]) => ({
              name: cityName,
              barangays: Array.isArray(cityData?.barangay_list) ? cityData.barangay_list.slice().sort((a, b) => a.localeCompare(b)) : [],
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toSqlTimestampOrNull(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
  return normalized.replace('T', ' ');
}

const UTC8_OFFSET_MINUTES = 8 * 60;

function toUtc8ShiftedDate(date = new Date()) {
  const utcMilliseconds = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  return new Date(utcMilliseconds + (UTC8_OFFSET_MINUTES * 60 * 1000));
}

function getMinimumProposedStartLocalValue() {
  const pad = (value) => String(value).padStart(2, '0');
  const utc8Now = toUtc8ShiftedDate(new Date());
  utc8Now.setUTCHours(0, 0, 0, 0);
  utc8Now.setUTCDate(utc8Now.getUTCDate() + 7);
  return `${utc8Now.getUTCFullYear()}-${pad(utc8Now.getUTCMonth() + 1)}-${pad(utc8Now.getUTCDate())}T00:00`;
}

function combineProgramDateAndTime(date, time) {
  const dateValue = String(date || '').trim();
  const timeValue = String(time || '').trim();
  return dateValue && timeValue ? `${dateValue}T${timeValue}` : '';
}

function formatProgramDateLabel(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function ProgramDateCalendar({ value, minimumDateKey, blockedDates, onChange, buttonRef, hasError, primaryColor }) {
  const calendarRef = useRef(null);
  const initialMonthKey = `${String(value || minimumDateKey).slice(0, 7)}-01`;
  const [isOpen, setIsOpen] = useState(false);
  const [visibleMonthKey, setVisibleMonthKey] = useState(initialMonthKey);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!calendarRef.current?.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [isOpen]);

  useEffect(() => {
    if (value) setVisibleMonthKey(`${value.slice(0, 7)}-01`);
  }, [value]);

  const visibleMonth = useMemo(() => new Date(`${visibleMonthKey}T00:00:00Z`), [visibleMonthKey]);
  const calendarDays = useMemo(() => {
    if (!Number.isFinite(visibleMonth.getTime())) return [];
    const year = visibleMonth.getUTCFullYear();
    const month = visibleMonth.getUTCMonth();
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return [
      ...Array.from({ length: firstWeekday }, () => null),
      ...Array.from({ length: dayCount }, (_, index) => {
        const date = new Date(Date.UTC(year, month, index + 1));
        return date.toISOString().slice(0, 10);
      }),
    ];
  }, [visibleMonth]);

  const minimumMonthKey = `${String(minimumDateKey || '').slice(0, 7)}-01`;
  const moveMonth = (offset) => {
    const next = new Date(visibleMonth.getTime());
    next.setUTCMonth(next.getUTCMonth() + offset, 1);
    setVisibleMonthKey(next.toISOString().slice(0, 10));
  };

  return (
    <div ref={calendarRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        className={`flex w-full items-center justify-between rounded-lg border bg-white px-3 py-2.5 text-left text-sm outline-none focus:ring-2 ${hasError ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-300'}`}
        style={{ '--tw-ring-color': primaryColor }}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span className={value ? 'text-slate-900' : 'text-slate-400'}>
          {formatProgramDateLabel(value) || 'Choose an available date'}
        </span>
        <CalendarDays size={17} className="shrink-0 text-slate-500" />
      </button>

      {isOpen && (
        <div role="dialog" aria-label="Choose program date" className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-3rem))] rounded-xl border border-slate-200 bg-white p-3 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <button type="button" onClick={() => moveMonth(-1)} disabled={visibleMonthKey <= minimumMonthKey} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-30" aria-label="Previous month">
              <ChevronLeft size={17} />
            </button>
            <p className="text-sm font-semibold text-slate-800">
              {visibleMonth.toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'long', year: 'numeric' })}
            </p>
            <button type="button" onClick={() => moveMonth(1)} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" aria-label="Next month">
              <ChevronRight size={17} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <span key={day} className="py-1 text-[10px] font-bold uppercase text-slate-400">{day}</span>
            ))}
            {calendarDays.map((dateKey, index) => {
              if (!dateKey) return <span key={`blank-${index}`} />;
              const isReserved = blockedDates.has(dateKey);
              const isTooEarly = dateKey < minimumDateKey;
              const isDisabled = isReserved || isTooEarly;
              const isSelected = dateKey === value;
              return (
                <button
                  key={dateKey}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    onChange(dateKey);
                    setIsOpen(false);
                  }}
                  title={isReserved ? 'Reserved—available only if staff rejects the existing application' : isTooEarly ? 'The date must be at least 7 days from today' : formatProgramDateLabel(dateKey)}
                  className={`aspect-square rounded-lg text-sm font-medium transition ${isSelected ? 'text-white shadow-sm' : isReserved ? 'cursor-not-allowed bg-rose-50 text-rose-400 line-through' : isTooEarly ? 'cursor-not-allowed text-slate-300' : 'text-slate-700 hover:bg-slate-100'}`}
                  style={isSelected ? { backgroundColor: primaryColor } : undefined}
                >
                  {Number(dateKey.slice(-2))}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap gap-3 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-rose-100" />Reserved</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-slate-200" />Inside 7-day notice</span>
          </div>
        </div>
      )}
    </div>
  );
}

function parseUtc8DateTime(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || '0');

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function formatUtc8DateTimeDisplay(value) {
  const parsed = parseUtc8DateTime(value);
  if (!parsed) return 'N/A';
  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function sanitizeFileName(fileName = 'upload.bin') {
  return String(fileName)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(-120);
}

function mapStorageUploadError(rawMessage) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('bucket') && lower.includes('not found')) {
    return 'Program application upload bucket is missing. Run migration 068_refactor_event_application_form_schema.sql.';
  }

  if (lower.includes('row-level security')) {
    return 'Upload blocked by storage policy. Re-run migration 068_refactor_event_application_form_schema.sql to apply open upload policies.';
  }

  return message || 'Unable to upload file.';
}

function mapEventApplicationSubmitError(rawMessage) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('row-level security') && lower.includes('event_applications')) {
    return 'Submit blocked by Event_Applications policy. Ask admin to re-apply the latest Event_Applications RLS SQL migrations, then retry.';
  }

  if (lower.includes('row-level security')) {
    return 'Submit blocked by database policy. Please retry, or ask admin to re-apply the Event_Applications RLS policies.';
  }

  if (
    lower.includes('event_applications_one_active_program_per_date')
    || lower.includes('conflicting key value violates exclusion constraint')
    || lower.includes('selected program date is already reserved')
  ) {
    return 'One or more selected program dates were just reserved by another application. Please choose another date.';
  }

  if (
    lower.includes('active program application already exists for this email')
    || lower.includes('trg_one_active_event_application_per_email')
  ) {
    return 'This email already has an active program application. You can submit another application after the current one is approved or rejected.';
  }

  if (lower.includes('didit verification')) {
    return message.replace(/didit/gi, 'ID');
  }

  return message || 'Unable to submit program application.';
}

async function readEdgeFunctionError(error, fallbackMessage) {
  const response = error?.context;

  if (response && typeof response.clone === 'function') {
    try {
      const payload = await response.clone().json();
      const serverMessage = payload?.error || payload?.detail || payload?.message;
      if (serverMessage) return String(serverMessage);
    } catch {
      try {
        const responseText = await response.clone().text();
        if (responseText.trim()) return responseText.trim();
      } catch {
        // Fall through to the client-side error message.
      }
    }
  }

  return String(error?.message || fallbackMessage);
}

function normalizePreferredContactLabel(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'phonecall' || key === 'phone' || key === 'call' || key === 'sms') return 'Phone';
  return 'Email';
}

function normalizeEventVisibility(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'private') return 'Private';
  return 'Public';
}

function normalizePhilippineMobile(value = '') {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.startsWith('63')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits.slice(0, 10);
}

function formatPhilippineMobileInput(value = '') {
  const digits = normalizePhilippineMobile(value);
  if (!digits) return '';
  if (digits.length <= 3) return `+63 ${digits}`;
  if (digits.length <= 6) return `+63 ${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
}

function isValidPhilippineMobile(value = '') {
  return normalizePhilippineMobile(value).length === 10;
}

function toStoredPhoneNumber(value = '') {
  const digits = normalizePhilippineMobile(value);
  return digits.length === 10
    ? `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`
    : '';
}

function isPhoneContactMethod(value = '') {
  return normalizePreferredContactLabel(value) === 'Phone';
}

function mapDiditDocumentType(document = {}) {
  const value = `${document?.document_type || ''} ${document?.document_subtype || ''}`.toLowerCase();
  if (value.includes('passport')) return 'passport';
  if (value.includes('driver')) return 'drivers_license';
  if (value.includes('philsys') || value.includes('national id')) return 'philsys';
  if (value.includes('umid') || value.includes('unified multi-purpose')) return 'umid';
  if (value.includes('professional regulation') || value.includes('prc')) return 'prc';
  if (value.includes('postal')) return 'postal';
  if (value.includes('voter')) return 'voters';
  if (value.includes('senior')) return 'senior_citizen';
  return 'other_government';
}

function mapDiditGender(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'm' || key === 'male') return 'Male';
  if (key === 'f' || key === 'female') return 'Female';
  return value ? String(value) : '';
}

function toProgramDateKey(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function enumerateProgramDates(startValue, endValue) {
  const startKey = toProgramDateKey(startValue);
  const endKey = toProgramDateKey(endValue || startValue);
  if (!startKey || !endKey) return [];

  const start = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return [];

  const dates = [];
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + (24 * 60 * 60 * 1000))) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}


function isValidEmail(value = '') {
  const normalized = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function mapEmailOtpError(rawMessage) {
  const message = String(rawMessage || 'Unable to process email verification.').trim();
  const lower = message.toLowerCase();

  if (
    lower.includes('after 25 seconds')
    || lower.includes('after 60 seconds')
    || lower.includes('for security purposes')
    || lower.includes('rate limit')
  ) {
    return 'Too many requests. Please wait around 60 seconds before requesting another code.';
  }

  if (lower.includes('token has expired') || lower.includes('expired')) {
    return 'This code expired. Request a new 6-digit code.';
  }

  if (lower.includes('token') && lower.includes('invalid')) {
    return 'Invalid code. Check the 6-digit code and try again.';
  }

  if (lower.includes('email') && lower.includes('invalid')) {
    return 'Please enter a valid email address first.';
  }

  return message;
}

function createIsolatedAuthClient() {
  if (isolatedAuthClient) {
    return isolatedAuthClient;
  }

  const url = process.env.REACT_APP_SUPABASE_URL;
  const anonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Missing Supabase configuration. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
  }

  isolatedAuthClient = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'Donivra-event-application-otp-client',
    },
  });

  return isolatedAuthClient;
}

async function insertEventApplicationIntake(payload) {
  const anonClient = createIsolatedAuthClient();
  const primaryInsert = await anonClient
    .from(EVENT_APPLICATIONS_TABLE)
    .insert(payload);

  if (!primaryInsert.error) {
    return;
  }

  // Fallback for environments with custom auth behavior.
  const fallbackInsert = await supabase
    .from(EVENT_APPLICATIONS_TABLE)
    .insert(payload);

  if (fallbackInsert.error) {
    throw fallbackInsert.error;
  }
}

async function assertEventApplicationEmailAvailable(email) {
  const otpClient = createIsolatedAuthClient();
  const result = await otpClient.rpc('assert_event_application_email_available', {
    p_email: String(email || '').trim().toLowerCase(),
  });

  if (result.error) {
    throw result.error;
  }
}

async function checkEventApplicationEmailActive(email) {
  const checkClient = createIsolatedAuthClient();
  const result = await checkClient.rpc('check_event_application_email_active', {
    p_email: String(email || '').trim().toLowerCase(),
  });

  if (result.error) {
    throw result.error;
  }

  return Boolean(result.data);
}

function LocationPinPicker({ latitude, longitude, onChange }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const [mapView, setMapView] = useState('satellite');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const updateMarkerAndLocation = useCallback((nextLat, nextLng, options = {}) => {
    const map = mapRef.current;
    if (!map || !Number.isFinite(nextLat) || !Number.isFinite(nextLng)) {
      return;
    }

    const target = [Number(nextLng), Number(nextLat)];

    if (!markerRef.current) {
      markerRef.current = new maplibregl.Marker({ color: '#b91c1c' })
        .setLngLat(target)
        .addTo(map);
    } else {
      markerRef.current.setLngLat(target);
    }

    map.flyTo({
      center: target,
      zoom: Number.isFinite(options.zoom) ? options.zoom : Math.max(map.getZoom(), 13),
      essential: true,
    });

    if (options.notify !== false) {
      onChangeRef.current(Number(nextLat), Number(nextLng));
    }
  }, []);

  const runLocationSearch = useCallback(async () => {
    const query = String(searchQuery || '').trim();
    if (!query) {
      setSearchError('Enter a location to search.');
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    setSearchError('');

    try {
      const endpoint = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=ph&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, { method: 'GET', headers: { Accept: 'application/json' } });

      if (!response.ok) {
        throw new Error('Location search failed.');
      }

      const rows = await response.json();
      const normalizedRows = Array.isArray(rows)
        ? rows.filter((row) => Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon)))
        : [];

      setSearchResults(normalizedRows);

      if (normalizedRows.length === 0) {
        setSearchError('No matching location found.');
        return;
      }

      const first = normalizedRows[0];
      updateMarkerAndLocation(Number(first.lat), Number(first.lon), { notify: true, zoom: 15 });
    } catch (error) {
      setSearchError(String(error?.message || 'Unable to search location right now.'));
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, updateMarkerAndLocation]);

  const onSelectSearchResult = useCallback((result) => {
    const nextLat = Number(result?.lat);
    const nextLng = Number(result?.lon);
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) {
      return;
    }
    updateMarkerAndLocation(nextLat, nextLng, { notify: true, zoom: 15 });
  }, [updateMarkerAndLocation]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return undefined;
    }

    const initialLat = Number.isFinite(latitude) ? latitude : DEFAULT_MAP_CENTER.lat;
    const initialLng = Number.isFinite(longitude) ? longitude : DEFAULT_MAP_CENTER.lng;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_SATELLITE_STYLE,
      center: [initialLng, initialLat],
      zoom: Number.isFinite(latitude) && Number.isFinite(longitude) ? 13 : 5,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      markerRef.current = new maplibregl.Marker({ color: '#b91c1c' })
        .setLngLat([longitude, latitude])
        .addTo(map);
    }

    map.on('click', (event) => {
      const nextLng = Number(event.lngLat.lng.toFixed(7));
      const nextLat = Number(event.lngLat.lat.toFixed(7));
      updateMarkerAndLocation(nextLat, nextLng, { notify: true, zoom: 15 });
    });

    mapRef.current = map;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [latitude, longitude, updateMarkerAndLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(mapView === 'street' ? MAP_STREET_STYLE : MAP_SATELLITE_STYLE);
  }, [mapView]);

  useEffect(() => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    updateMarkerAndLocation(latitude, longitude, { notify: false });
  }, [latitude, longitude, updateMarkerAndLocation]);

  return (
    <div className="space-y-3 overflow-hidden rounded-xl border border-slate-300 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-700">Map View</p>
        <div className="inline-flex rounded-lg border border-slate-300 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => setMapView('satellite')}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${mapView === 'satellite' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
          >
            Satellite
          </button>
          <button
            type="button"
            onClick={() => setMapView('street')}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${mapView === 'street' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
          >
            Street
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold text-slate-700">Search location and pin automatically</label>
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runLocationSearch();
              }
            }}
            placeholder="Search address, barangay, city, or program location"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500"
          />
          <button
            type="button"
            onClick={runLocationSearch}
            disabled={isSearching}
            className="inline-flex min-w-24 items-center justify-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {isSearching ? 'Finding' : 'Search'}
          </button>
        </div>
        {searchError && <p className="text-xs text-rose-600">{searchError}</p>}
        {searchResults.length > 1 && (
          <div className="max-h-28 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-1">
            {searchResults.slice(0, 6).map((result) => (
              <button
                key={`${result.lat}-${result.lon}-${result.display_name}`}
                type="button"
                onClick={() => onSelectSearchResult(result)}
                className="block w-full rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-white"
              >
                {result.display_name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={mapContainerRef} className="h-72 w-full rounded-lg border border-slate-200" />
      <p className="text-xs text-slate-500">Click map to pin the exact program location.</p>
    </div>
  );
}

export default function EventApplicationPage() {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';

  const [form, setForm] = useState(INITIAL_FORM);
  const [eventPlacePhotoFile, setEventPlacePhotoFile] = useState(null);
  const [eventPosterPhotoFile, setEventPosterPhotoFile] = useState(null);
  const [eventPlacePhotoPreviewUrl, setEventPlacePhotoPreviewUrl] = useState('');
  const [eventPosterPhotoPreviewUrl, setEventPosterPhotoPreviewUrl] = useState('');
  const [diditSession, setDiditSession] = useState(null);
  const [diditStatus, setDiditStatus] = useState('Not Started');
  const [diditWarnings, setDiditWarnings] = useState([]);
  const [diditNotice, setDiditNotice] = useState('');
  const [isCreatingDiditSession, setIsCreatingDiditSession] = useState(false);
  const [isCheckingDiditStatus, setIsCheckingDiditStatus] = useState(false);
  const [isDiditModalOpen, setIsDiditModalOpen] = useState(false);
  const [unavailableProgramDates, setUnavailableProgramDates] = useState([]);
  const [isLoadingProgramDates, setIsLoadingProgramDates] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [hasConfirmedTerms, setHasConfirmedTerms] = useState(false);
  const [isSubmitConfirmationOpen, setIsSubmitConfirmationOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [submittedId, setSubmittedId] = useState(null);
  const [otpCode, setOtpCode] = useState('');
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [otpCooldownSeconds, setOtpCooldownSeconds] = useState(0);
  const [isEmailOtpVerified, setIsEmailOtpVerified] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const [otpNotice, setOtpNotice] = useState({ type: '', message: '' });
  const [emailAvailability, setEmailAvailability] = useState({ status: 'idle', message: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const fieldRefs = useRef({});

  const incomingTransition = (() => {
    try {
      return typeof window !== 'undefined' ? sessionStorage.getItem('Donivra:incoming-transition') : '';
    } catch {
      return '';
    }
  })();

  useEffect(() => {
    if (incomingTransition === 'apply') {
      try { sessionStorage.removeItem('Donivra:incoming-transition'); } catch { /* ignore */ }
    }
  }, [incomingTransition]);

  const Wrapper = incomingTransition === 'apply' ? TransitionFlipEntrance : React.Fragment;

  const setFieldRef = useCallback((fieldKey) => (node) => {
    if (!fieldKey) return;
    if (node) {
      fieldRefs.current[fieldKey] = node;
    } else {
      delete fieldRefs.current[fieldKey];
    }
  }, []);

  const focusField = useCallback((fieldKey) => {
    const applyFocus = () => {
      const node = fieldRefs.current[fieldKey];
      if (!node) return false;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => {
        if (typeof node.focus === 'function') {
          node.focus();
        }
      }, 180);
      return true;
    };

    if (!applyFocus()) {
      window.setTimeout(() => {
        applyFocus();
      }, 280);
    }
  }, []);

  const getFieldInputClassName = useCallback((fieldKey, extraClassName = '') => {
    const hasError = Boolean(fieldErrors[fieldKey]);
    const classes = [
      'rounded-lg',
      'border',
      hasError ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-300',
      'px-3',
      'py-2.5',
      'text-sm',
      'outline-none',
      'focus:ring-2',
      extraClassName,
    ].filter(Boolean);
    return classes.join(' ');
  }, [fieldErrors]);

  const markFieldError = useCallback((fieldKey, message) => {
    if (fieldKey) {
      setFieldErrors({ [fieldKey]: message || 'Please review this field.' });
      setErrorMessage('');
      focusField(fieldKey);
    } else {
      setFieldErrors({});
      setErrorMessage(message || 'Please review the required fields.');
    }
  }, [focusField]);

  const fieldError = useCallback((fieldKey) => (
    fieldErrors[fieldKey]
      ? <span className="text-xs font-medium text-rose-600">{fieldErrors[fieldKey]}</span>
      : null
  ), [fieldErrors]);

  useEffect(() => {
    if (!eventPlacePhotoFile) {
      setEventPlacePhotoPreviewUrl('');
      return undefined;
    }

    const isImage = String(eventPlacePhotoFile.type || '').toLowerCase().startsWith('image/');
    if (!isImage) {
      setEventPlacePhotoPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(eventPlacePhotoFile);
    setEventPlacePhotoPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [eventPlacePhotoFile]);

  useEffect(() => {
    if (!eventPosterPhotoFile) {
      setEventPosterPhotoPreviewUrl('');
      return undefined;
    }

    const isImage = String(eventPosterPhotoFile.type || '').toLowerCase().startsWith('image/');
    if (!isImage) {
      setEventPosterPhotoPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(eventPosterPhotoFile);
    setEventPosterPhotoPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [eventPosterPhotoFile]);

  useEffect(() => {
    if (otpCooldownSeconds <= 0) return undefined;
    const timeout = window.setTimeout(() => {
      setOtpCooldownSeconds((previous) => Math.max(0, previous - 1));
    }, 1000);
    return () => window.clearTimeout(timeout);
  }, [otpCooldownSeconds]);

  const regionOptions = useMemo(() => toUnifiedRegionOptions(PHILIPPINE_ADDRESS_TREE), []);

  const selectedRegion = useMemo(() => (
    regionOptions.find((region) => region.name === form.region) || null
  ), [regionOptions, form.region]);

  const provinceOptions = useMemo(() => (
    Array.isArray(selectedRegion?.provinces) ? selectedRegion.provinces : []
  ), [selectedRegion]);

  const selectedProvince = useMemo(() => (
    provinceOptions.find((province) => province.name === form.province) || null
  ), [provinceOptions, form.province]);

  const cityOptions = useMemo(() => (
    Array.isArray(selectedProvince?.cities) ? selectedProvince.cities : []
  ), [selectedProvince]);

  const selectedCity = useMemo(() => (
    cityOptions.find((city) => city.name === form.city) || null
  ), [cityOptions, form.city]);

  const barangayOptions = useMemo(() => (
    Array.isArray(selectedCity?.barangays) ? selectedCity.barangays : []
  ), [selectedCity]);

  const minimumProposedStartLocalValue = useMemo(() => getMinimumProposedStartLocalValue(), []);
  const normalizedEmail = useMemo(() => String(form.applicantEmail || '').trim().toLowerCase(), [form.applicantEmail]);
  const isDiditVerified = useMemo(
    () => String(diditStatus || '').toLowerCase() === 'approved' && Boolean(diditSession?.sessionId),
    [diditSession, diditStatus],
  );
  const unavailableProgramDateSet = useMemo(
    () => new Set(unavailableProgramDates),
    [unavailableProgramDates],
  );

  const minimumProgramDateKey = useMemo(
    () => toProgramDateKey(minimumProposedStartLocalValue),
    [minimumProposedStartLocalValue],
  );

  const preferredContactMethodLabel = useMemo(
    () => normalizePreferredContactLabel(form.preferredContactMethod),
    [form.preferredContactMethod],
  );

  const preferredContactAutoHelper = useMemo(() => {
    if (preferredContactMethodLabel === 'Email') {
      return form.applicantEmail.trim()
        ? 'Your email is the primary contact; your phone remains the secondary option.'
        : 'Enter your email. Your phone will remain the secondary option.';
    }
    if (preferredContactMethodLabel === 'Phone') {
      return form.applicantContactNumber.trim()
        ? 'Your phone is the primary contact; your email remains the secondary option.'
        : 'Enter your phone number. Your email will remain the secondary option.';
    }
    return '';
  }, [preferredContactMethodLabel, form.applicantEmail, form.applicantContactNumber]);

  const canSubmit = useMemo(() => {
    return Boolean(
      form.applicantValidIdType.trim()
      && form.applicantFirstName.trim()
      && form.applicantLastName.trim()
      && isValidEmail(form.applicantEmail)
      && form.applicantGender.trim()
      && isValidPhilippineMobile(form.applicantContactNumber)
      && form.preferredContactMethod.trim()
      && form.applicantIdDocumentNumber.trim()
      && form.applicantIdAddress.trim()
      && form.eventVisibility.trim()
      && form.eventName.trim()
      && form.venueName.trim()
      && form.eventOverview.trim()
      && form.expectedAttendees
      && Number(form.expectedAttendees) > 0
      && form.proposedStartAt.trim()
      && form.proposedEndAt.trim()
      && eventPlacePhotoFile
      && form.street.trim()
      && form.barangay.trim()
      && form.city.trim()
      && form.province.trim()
      && form.region.trim()
      && form.latitude.trim()
      && form.longitude.trim()
      && isDiditVerified
      && emailAvailability.status === 'available'
      && isEmailOtpVerified
      && normalizedEmail === verifiedEmail,
    );
  }, [
    form,
    isDiditVerified,
    eventPlacePhotoFile,
    emailAvailability.status,
    isEmailOtpVerified,
    normalizedEmail,
    verifiedEmail,
  ]);

  useEffect(() => {
    let cancelled = false;
    let timerId = null;

    if (!isValidEmail(normalizedEmail)) {
      setEmailAvailability({ status: 'idle', message: '' });
      return undefined;
    }

    setEmailAvailability({ status: 'checking', message: 'Checking whether this email already has an active application...' });
    timerId = window.setTimeout(async () => {
      try {
        const hasActiveApplication = await checkEventApplicationEmailActive(normalizedEmail);
        if (cancelled) return;

        setEmailAvailability(hasActiveApplication
          ? {
            status: 'blocked',
            message: 'This email already has an active application. Wait until it is approved or rejected before applying again.',
          }
          : {
            status: 'available',
            message: 'No active application was found for this email.',
          });
      } catch (error) {
        if (cancelled) return;
        setEmailAvailability({
          status: 'error',
          message: error?.message || 'Unable to check this email right now. Please try again.',
        });
      }
    }, 450);

    return () => {
      cancelled = true;
      if (timerId) window.clearTimeout(timerId);
    };
  }, [normalizedEmail]);

  useEffect(() => {
    if (!verifiedEmail) return;
    if (normalizedEmail && normalizedEmail === verifiedEmail) return;
    setIsEmailOtpVerified(false);
    setVerifiedEmail('');
    setOtpCode('');
    setOtpNotice((previous) => (
      previous?.message
        ? { type: 'info', message: 'Email changed. Request and verify a new 6-digit code.' }
        : previous
    ));
  }, [normalizedEmail, verifiedEmail]);

  const getStepValidationIssue = useCallback((stepNumber) => {
    const issue = (field, message) => ({ field, message });

    if (stepNumber === 1) {
      if (!form.applicantEmail.trim()) return issue('applicantEmail', 'Email is required.');
      if (!isValidEmail(form.applicantEmail)) return issue('applicantEmail', 'Please enter a valid email address.');
      if (emailAvailability.status === 'checking') return issue('applicantEmail', 'Wait for the active-application email check to finish.');
      if (emailAvailability.status === 'blocked') return issue('applicantEmail', emailAvailability.message);
      if (emailAvailability.status === 'error') return issue('applicantEmail', emailAvailability.message);
      if (emailAvailability.status !== 'available') return issue('applicantEmail', 'Check this email before continuing.');
      if (!isEmailOtpVerified || normalizedEmail !== verifiedEmail) {
        return issue('otpCode', 'Verify the email address so application updates are sent to the correct inbox.');
      }
      if (!isDiditVerified) return issue('diditVerification', 'Complete and pass Didit ID verification before continuing.');
      if (!form.applicantValidIdType.trim()) return issue('applicantValidIdType', 'Valid ID type is required.');
      if (!form.applicantFirstName.trim()) return issue('applicantFirstName', 'First name is required.');
      if (!form.applicantLastName.trim()) return issue('applicantLastName', 'Last name is required.');
      if (!form.applicantGender.trim()) return issue('applicantGender', 'Gender is required.');
      if (!form.applicantIdDocumentNumber.trim()) return issue('applicantIdDocumentNumber', 'ID number is required. Correct it if the scan is inaccurate.');
      if (!form.applicantIdAddress.trim()) return issue('applicantIdAddress', 'Address on the ID is required. Correct it if the scan is inaccurate.');
      if (!form.applicantContactNumber.trim()) return issue('applicantContactNumber', 'Contact number is required.');
      if (!isValidPhilippineMobile(form.applicantContactNumber)) return issue('applicantContactNumber', 'Contact number must be in +63 912 345 6789 format.');
      if (!form.preferredContactMethod.trim()) return issue('preferredContactMethod', 'Preferred contact method is required.');
      return null;
    }

    if (stepNumber === 2) {
      if (!form.eventVisibility.trim()) return issue('eventVisibility', 'Program type is required.');
      if (!form.eventName.trim()) return issue('eventName', 'Program name is required.');
      if (!form.venueName.trim()) return issue('venueName', 'Venue name is required.');
      if (!form.eventOverview.trim()) return issue('eventOverview', 'Program overview is required.');
      if (!form.expectedAttendees || Number(form.expectedAttendees) <= 0) return issue('expectedAttendees', 'Expected attendees must be greater than zero.');
      if (!form.proposedDate.trim()) return issue('proposedDate', 'Choose an available program date.');
      if (!form.proposedStartTime.trim()) return issue('proposedStartTime', 'Start time is required.');
      if (!form.proposedEndTime.trim()) return issue('proposedEndTime', 'End time is required.');
      if (!eventPlacePhotoFile) return issue('eventPlacePhoto', 'One program place photo is required.');
      if (!form.street.trim()) return issue('street', 'Street is required.');
      if (!form.barangay.trim()) return issue('barangay', 'Barangay is required.');
      if (!form.city.trim()) return issue('city', 'City/Municipality is required.');
      if (!form.province.trim()) return issue('province', 'Province is required.');
      if (!form.region.trim()) return issue('region', 'Region is required.');
      if (!form.latitude.trim() || !form.longitude.trim()) return issue('locationPin', 'Map pin location is required.');

      const minimumStart = parseUtc8DateTime(minimumProposedStartLocalValue);
      const proposedStart = parseUtc8DateTime(form.proposedStartAt);
      const proposedEnd = parseUtc8DateTime(form.proposedEndAt);

      if (!proposedStart || !proposedEnd) return issue('proposedStartTime', 'Start and end times are required.');
      if (minimumStart && proposedStart < minimumStart) return issue('proposedDate', 'Program date must be at least 7 days from today.');
      if (toProgramDateKey(form.proposedStartAt) !== toProgramDateKey(form.proposedEndAt)) return issue('proposedEndTime', 'The program must start and end on the same date.');
      if (proposedEnd <= proposedStart) return issue('proposedEndTime', 'End time must be later than start time.');
      const blockedDate = enumerateProgramDates(form.proposedStartAt, form.proposedEndAt)
        .find((date) => unavailableProgramDateSet.has(date));
      if (blockedDate) return issue('proposedDate', `${blockedDate} is already reserved by another program application.`);

      return null;
    }

    if (stepNumber === 3) {
      if (!canSubmit) return issue('eventName', 'Please complete all required fields before confirmation.');
      return null;
    }

    return null;
  }, [
    form,
    isDiditVerified,
    minimumProposedStartLocalValue,
    canSubmit,
    unavailableProgramDateSet,
    eventPlacePhotoFile,
    emailAvailability,
    isEmailOtpVerified,
    normalizedEmail,
    verifiedEmail,
  ]);

  const goNextStep = useCallback(() => {
    const validationIssue = getStepValidationIssue(currentStep);
    if (validationIssue) {
      markFieldError(validationIssue.field, validationIssue.message);
      return;
    }

    setFieldErrors({});
    setErrorMessage('');
    setCurrentStep((previous) => Math.min(FORM_STEPS.length, previous + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentStep, getStepValidationIssue, markFieldError]);

  const goPreviousStep = useCallback(() => {
    setFieldErrors({});
    setErrorMessage('');
    setCurrentStep((previous) => Math.max(1, previous - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleDeclineTerms = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.location.assign('/');
  }, []);

  const handleAcceptTerms = useCallback(() => {
    if (!hasConfirmedTerms) {
      setErrorMessage('Please confirm that you agree to the Terms and Agreement before continuing.');
      return;
    }

    setErrorMessage('');
    setFieldErrors({});
    setHasAcceptedTerms(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [hasConfirmedTerms]);

  const loadUnavailableProgramDates = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setIsLoadingProgramDates(true);
    try {
      const { data, error } = await supabase.rpc('get_unavailable_program_dates', {
        p_from_date: toProgramDateKey(minimumProposedStartLocalValue),
      });
      if (error) throw error;
      setUnavailableProgramDates((Array.isArray(data) ? data : [])
        .map((row) => toProgramDateKey(row?.program_date))
        .filter(Boolean));
    } catch (availabilityError) {
      console.warn('[Program dates] Unable to load unavailable dates:', availabilityError);
    } finally {
      setIsLoadingProgramDates(false);
    }
  }, [minimumProposedStartLocalValue]);

  useEffect(() => {
    if (!hasAcceptedTerms) return;
    loadUnavailableProgramDates();
  }, [hasAcceptedTerms, loadUnavailableProgramDates]);

  const applyDiditDocument = useCallback((document) => {
    if (!document || typeof document !== 'object') return;
    const middleName = String(document.middle_name || '').trim();

    setForm((previous) => ({
      ...previous,
      applicantValidIdType: mapDiditDocumentType(document),
      applicantFirstName: String(document.first_name || previous.applicantFirstName || '').trim(),
      applicantMiddleName: middleName || previous.applicantMiddleName,
      applicantLastName: String(document.last_name || previous.applicantLastName || '').trim(),
      applicantGender: mapDiditGender(document.gender) || previous.applicantGender,
      applicantIdDocumentNumber: String(document.document_number || previous.applicantIdDocumentNumber || '').trim(),
      applicantIdAddress: String(document.formatted_address || document.address || previous.applicantIdAddress || '').trim(),
    }));
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next.diditVerification;
      delete next.applicantValidIdType;
      delete next.applicantFirstName;
      delete next.applicantMiddleName;
      delete next.applicantLastName;
      delete next.applicantGender;
      delete next.applicantIdDocumentNumber;
      delete next.applicantIdAddress;
      return next;
    });
  }, []);

  const checkDiditStatus = useCallback(async (sessionOverride = null) => {
    const session = sessionOverride || diditSession;
    if (!session?.sessionId || !session?.clientToken) {
      setDiditNotice('Start an ID verification first.');
      return;
    }

    setIsCheckingDiditStatus(true);
    setDiditNotice('Checking the identity verification result...');
    try {
      const { data, error } = await supabase.functions.invoke('didit-verification', {
        body: {
          action: 'status',
          sessionId: session.sessionId,
          clientToken: session.clientToken,
        },
      });
      if (error) throw new Error(await readEdgeFunctionError(error, 'Unable to check ID verification.'));
      if (data?.error) throw new Error(data.error);

      setDiditStatus(String(data?.status || 'Unknown'));
      setDiditWarnings(Array.isArray(data?.warnings) ? data.warnings : []);
      if (data?.verified && data?.document) {
        applyDiditDocument(data.document);
        setDiditNotice('ID verified. Name, ID number, gender, and address were filled when detected. You may correct any scan error.');
        setIsDiditModalOpen(false);
      } else if (String(data?.status || '').toLowerCase() === 'in review') {
        setDiditNotice('The ID is still being reviewed. Check the verification status again shortly.');
        setIsDiditModalOpen(false);
      } else if (String(data?.status || '').toLowerCase() === 'declined') {
        setDiditNotice('The ID could not be verified. Review the verification instructions and try another scan if needed.');
        setIsDiditModalOpen(false);
      } else {
        setDiditNotice(`Verification status: ${String(data?.status || 'Not completed')}. Finish the verification steps, then check again.`);
      }
    } catch (verificationError) {
      setDiditNotice(String(verificationError?.message || 'Unable to check ID verification.'));
    } finally {
      setIsCheckingDiditStatus(false);
    }
  }, [applyDiditDocument, diditSession]);

  const startDiditVerification = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setDiditNotice('Identity verification is not configured.');
      return;
    }

    setIsCreatingDiditSession(true);
    setDiditNotice('Creating a secure identity verification session...');
    setDiditStatus('Not Started');
    setDiditWarnings([]);
    try {
      const { data, error } = await supabase.functions.invoke('didit-verification', {
        body: { action: 'create' },
      });
      if (error) throw new Error(await readEdgeFunctionError(error, 'Unable to start ID verification.'));
      if (data?.error) throw new Error(data.error);
      if (!data?.sessionId || !data?.clientToken || !data?.verificationUrl) {
        throw new Error('The verification service returned an incomplete session.');
      }

      const session = {
        sessionId: data.sessionId,
        clientToken: data.clientToken,
        verificationUrl: data.verificationUrl,
      };
      setDiditSession(session);
      setDiditNotice('Follow the secure instructions to photograph or upload your Philippine ID.');
      setIsDiditModalOpen(true);
    } catch (verificationError) {
      setDiditNotice(String(verificationError?.message || 'Unable to start ID verification.'));
    } finally {
      setIsCreatingDiditSession(false);
    }
  }, []);

  useEffect(() => {
    const handleDiditMessage = (event) => {
      if (event.origin !== 'https://verify.didit.me') return;
      if (event.data?.type !== 'didit:completed') return;
      checkDiditStatus();
    };
    window.addEventListener('message', handleDiditMessage);
    return () => window.removeEventListener('message', handleDiditMessage);
  }, [checkDiditStatus]);

  const handleEventPlacePhotoFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setErrorMessage('');
    if (file && !String(file.type || '').toLowerCase().startsWith('image/')) {
      markFieldError('eventPlacePhoto', 'Program place photo must be an image file.');
      event.target.value = '';
      return;
    }
    if (file && file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
      markFieldError('eventPlacePhoto', 'Program place photo must be 8 MB or smaller.');
      event.target.value = '';
      return;
    }
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next.eventPlacePhoto;
      return next;
    });
    setEventPlacePhotoFile(file);
  };

  const handleEventPosterPhotoFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setErrorMessage('');
    setEventPosterPhotoFile(file);
  };

  const autoPinFromAddressSnapshot = useCallback(async (formSnapshot) => {
    const trim = (value) => String(value || '').trim();
    const country = trim(formSnapshot?.country) || DEFAULT_COUNTRY;
    const venueName = trim(formSnapshot?.venueName);
    const street = trim(formSnapshot?.street);
    const barangay = trim(formSnapshot?.barangay);
    const city = trim(formSnapshot?.city);
    const province = trim(formSnapshot?.province);
    const region = trim(formSnapshot?.region);

    const queryPartsVariants = [
      [venueName, street, barangay, city, province, region, country],
      [street, barangay, city, province, region, country],
      [street, city, province, country],
      [barangay, city, province, country],
      [city, province, country],
    ]
      .map((parts) => parts.filter(Boolean))
      .filter((parts, index, array) => parts.length > 0 && array.findIndex((candidate) => candidate.join('|') === parts.join('|')) === index);

    if (queryPartsVariants.length === 0) {
      return false;
    }

    const fetchFirstPin = async (query, includeCountryCode = true) => {
      const endpoint = includeCountryCode
        ? `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=ph&q=${encodeURIComponent(query)}`
        : `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en',
        },
      });
      if (!response.ok) return null;
      const rows = await response.json();
      const first = Array.isArray(rows)
        ? rows.find((row) => Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon)))
        : null;
      return first || null;
    };

    try {
      for (const parts of queryPartsVariants) {
        const query = parts.join(', ');
        const strictMatch = await fetchFirstPin(query, true);
        if (strictMatch) {
          setForm((previous) => ({
            ...previous,
            latitude: Number(strictMatch.lat).toFixed(7),
            longitude: Number(strictMatch.lon).toFixed(7),
          }));
          return true;
        }

        const relaxedMatch = await fetchFirstPin(query, false);
        if (relaxedMatch) {
          setForm((previous) => ({
            ...previous,
            latitude: Number(relaxedMatch.lat).toFixed(7),
            longitude: Number(relaxedMatch.lon).toFixed(7),
          }));
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }, []);

  const autoPinFromCurrentAddress = useCallback(async () => {
    setErrorMessage('');
    setSuccessMessage('');
    if (!form.street.trim() || !form.city.trim() || !form.province.trim()) {
      setErrorMessage('Please fill street, city/municipality, and province first before auto-pin.');
      return;
    }
    const pinned = await autoPinFromAddressSnapshot(form);
    if (pinned) {
      setSuccessMessage('Map pin auto-set from your current venue address.');
    } else {
      setErrorMessage('Auto-pin could not find a match. Please refine the address or pin manually on the map.');
    }
  }, [autoPinFromAddressSnapshot, form]);

  const sendEmailOtpCode = useCallback(async () => {
    if (!isValidEmail(normalizedEmail)) {
      setOtpNotice({ type: 'error', message: 'Enter a valid email address first.' });
      markFieldError('applicantEmail', 'Enter a valid email address first.');
      return;
    }

    setIsSendingOtp(true);
    setOtpNotice({ type: '', message: '' });
    setErrorMessage('');

    try {
      const otpClient = createIsolatedAuthClient();
      const { error } = await otpClient.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${window.location.origin}/apply-event`,
        },
      });

      if (error) {
        throw error;
      }

      setIsEmailOtpVerified(false);
      setVerifiedEmail('');
      setOtpCode('');
      setOtpCooldownSeconds(60);
      setOtpNotice({
        type: 'info',
        message: `A 6-digit code was sent to ${normalizedEmail}. Enter the OTP below to verify your email.`,
      });
    } catch (otpError) {
      setOtpNotice({ type: 'error', message: mapEmailOtpError(otpError?.message) });
    } finally {
      setIsSendingOtp(false);
    }
  }, [normalizedEmail, markFieldError]);

  const verifyEmailOtpCode = useCallback(async () => {
    if (!isValidEmail(normalizedEmail)) {
      setOtpNotice({ type: 'error', message: 'Enter a valid email address first.' });
      markFieldError('applicantEmail', 'Enter a valid email address first.');
      return;
    }

    const normalizedCode = String(otpCode || '').replace(/\D/g, '').slice(0, 6);
    if (normalizedCode.length !== 6) {
      setOtpNotice({ type: 'error', message: 'Please enter the 6-digit code sent to your email.' });
      markFieldError('otpCode', 'Please enter the 6-digit code sent to your email.');
      return;
    }

    setIsVerifyingOtp(true);
    setOtpNotice({ type: '', message: '' });
    setErrorMessage('');

    try {
      const otpClient = createIsolatedAuthClient();
      const { error } = await otpClient.auth.verifyOtp({
        email: normalizedEmail,
        token: normalizedCode,
        type: 'email',
      });

      if (error) {
        throw error;
      }

      setIsEmailOtpVerified(true);
      setVerifiedEmail(normalizedEmail);
      setOtpNotice({ type: 'success', message: 'Email verified successfully. You can now continue to your application.' });
      setFieldErrors((previous) => {
        if (!previous.otpCode) return previous;
        const next = { ...previous };
        delete next.otpCode;
        return next;
      });
    } catch (otpError) {
      setOtpNotice({ type: 'error', message: mapEmailOtpError(otpError?.message) });
    } finally {
      setIsVerifyingOtp(false);
    }
  }, [normalizedEmail, otpCode, markFieldError]);

  const updateField = (key) => (event) => {
    let nextValue = event.target.value;
    setErrorMessage('');
    setSuccessMessage('');

    if (key === 'country') {
      nextValue = String(nextValue || '').toUpperCase();
    }

    if (key === 'applicantContactNumber') {
      nextValue = formatPhilippineMobileInput(nextValue);
    }

    if (key === 'preferredContactMethod') {
      nextValue = String(nextValue || '');
      setForm((previous) => ({
        ...previous,
        preferredContactMethod: nextValue,
      }));
      setFieldErrors((previous) => {
        if (!previous.preferredContactMethod) return previous;
        const next = { ...previous };
        delete next.preferredContactMethod;
        return next;
      });
      return;
    }

    if (key === 'applicantEmail') {
      const nextNormalizedEmail = String(nextValue || '').trim().toLowerCase();
      if (nextNormalizedEmail !== verifiedEmail) {
        setIsEmailOtpVerified(false);
        setVerifiedEmail('');
        setOtpCode('');
      }
    }

    setFieldErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });

    setForm((previous) => ({ ...previous, [key]: nextValue }));
  };

  const updateScheduleField = (key) => (eventOrValue) => {
    const nextValue = typeof eventOrValue === 'string' ? eventOrValue : eventOrValue.target.value;
    setErrorMessage('');
    setSuccessMessage('');

    if (key === 'proposedDate' && nextValue && unavailableProgramDateSet.has(nextValue)) {
      markFieldError('proposedDate', `${nextValue} is reserved and cannot be selected unless staff rejects the existing application.`);
      return;
    }

    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      if (key === 'proposedDate') delete next.proposedDate;
      if (key === 'proposedStartTime') delete next.proposedStartTime;
      if (key === 'proposedEndTime') delete next.proposedEndTime;
      return next;
    });

    setForm((previous) => {
      const nextForm = { ...previous, [key]: nextValue };
      if (key === 'proposedStartTime' && nextForm.proposedEndTime && nextForm.proposedEndTime <= nextValue) {
        nextForm.proposedEndTime = '';
      }
      nextForm.proposedStartAt = combineProgramDateAndTime(nextForm.proposedDate, nextForm.proposedStartTime);
      nextForm.proposedEndAt = combineProgramDateAndTime(nextForm.proposedDate, nextForm.proposedEndTime);
      return nextForm;
    });
  };

  const handleRegionChange = (event) => {
    const nextRegion = event.target.value;
    setErrorMessage('');
    setSuccessMessage('');
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next.region;
      delete next.province;
      delete next.city;
      delete next.barangay;
      return next;
    });
    setForm((previous) => ({
      ...previous,
      region: nextRegion,
      province: '',
      city: '',
      barangay: '',
    }));
  };

  const handleProvinceChange = (event) => {
    const nextProvince = event.target.value;
    setErrorMessage('');
    setSuccessMessage('');
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next.province;
      delete next.city;
      delete next.barangay;
      return next;
    });
    setForm((previous) => ({
      ...previous,
      province: nextProvince,
      city: '',
      barangay: '',
    }));
  };

  const handleCityChange = (event) => {
    const nextCity = event.target.value;
    setErrorMessage('');
    setSuccessMessage('');
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next.city;
      delete next.barangay;
      return next;
    });
    setForm((previous) => ({
      ...previous,
      city: nextCity,
      barangay: '',
    }));
  };

  const handleLocationChange = useCallback((nextLat, nextLng) => {
    setFieldErrors((previous) => {
      if (!previous.locationPin) return previous;
      const next = { ...previous };
      delete next.locationPin;
      return next;
    });
    setForm((previous) => ({
      ...previous,
      latitude: Number(nextLat).toFixed(7),
      longitude: Number(nextLng).toFixed(7),
    }));
  }, []);

  const uploadEventAsset = async (file, folderName) => {
    if (!file) {
      return { path: null, url: null };
    }

    if (!supabase) {
      throw new Error('Supabase is not configured.');
    }

    if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
      throw new Error(`File ${file.name} exceeds the 8MB upload limit.`);
    }

    const sanitizedName = sanitizeFileName(file.name || 'upload.bin');
    const filePath = `${folderName}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${sanitizedName}`;

    const { error: uploadError } = await supabase.storage
      .from(EVENT_APPLICATION_ASSETS_BUCKET)
      .upload(filePath, file, {
        upsert: false,
        cacheControl: '3600',
      });

    if (uploadError) {
      throw new Error(mapStorageUploadError(uploadError.message));
    }

    const { data: publicUrlData } = supabase.storage
      .from(EVENT_APPLICATION_ASSETS_BUCKET)
      .getPublicUrl(filePath);

    return {
      path: filePath,
      url: publicUrlData?.publicUrl || null,
    };
  };

  const validateSchedule = useCallback(() => {
    const minimumStart = parseUtc8DateTime(minimumProposedStartLocalValue);
    const proposedStart = parseUtc8DateTime(form.proposedStartAt);
    const proposedEnd = parseUtc8DateTime(form.proposedEndAt);

    if (!proposedStart || !proposedEnd) {
      return 'Proposed start and end are required.';
    }

    if (minimumStart && proposedStart < minimumStart) {
      return 'Proposed start must be at least 7 days from today.';
    }

    if (toProgramDateKey(form.proposedStartAt) !== toProgramDateKey(form.proposedEndAt)) {
      return 'The program must start and end on the same date.';
    }

    if (proposedEnd <= proposedStart) {
      return 'End time must be later than start time.';
    }

    const blockedDate = enumerateProgramDates(form.proposedStartAt, form.proposedEndAt)
      .find((date) => unavailableProgramDateSet.has(date));
    if (blockedDate) {
      return `${blockedDate} is already reserved by another program application.`;
    }

    return '';
  }, [form.proposedEndAt, form.proposedStartAt, minimumProposedStartLocalValue, unavailableProgramDateSet]);

  const handleSubmit = async (event, isConfirmed = false) => {
    event?.preventDefault();

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Please set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const step1Issue = getStepValidationIssue(1);
    if (step1Issue) {
      setCurrentStep(1);
      markFieldError(step1Issue.field, step1Issue.message);
      return;
    }

    const step2Issue = getStepValidationIssue(2);
    if (step2Issue) {
      setCurrentStep(2);
      markFieldError(step2Issue.field, step2Issue.message);
      return;
    }

    if (!canSubmit) {
      setCurrentStep(3);
      markFieldError('eventName', 'Please complete all required fields and pass ID verification before submitting.');
      return;
    }

    if (!isEmailOtpVerified || normalizedEmail !== verifiedEmail) {
      setCurrentStep(1);
      markFieldError('otpCode', 'Please verify your email with the 6-digit OTP before submitting.');
      return;
    }

    const scheduleError = validateSchedule();
    if (scheduleError) {
      setCurrentStep(2);
      markFieldError('proposedEndTime', scheduleError);
      return;
    }

    if (!isConfirmed) {
      setIsSubmitConfirmationOpen(true);
      return;
    }

    setIsSubmitConfirmationOpen(false);
    setIsSubmitting(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      // Check before uploading assets. The database insert trigger performs the
      // same check atomically to protect against simultaneous submissions.
      await assertEventApplicationEmailAvailable(normalizedEmail);

      const placePhotoUpload = eventPlacePhotoFile
        ? await uploadEventAsset(eventPlacePhotoFile, 'event-place-photos')
        : { path: null, url: null };
      const posterPhotoUpload = eventPosterPhotoFile
        ? await uploadEventAsset(eventPosterPhotoFile, 'event-poster-photos')
        : { path: null, url: null };

      const venueAddress = [form.venueName, form.street, form.barangay, form.city, form.province, form.region, form.country]
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(', ');

      const payload = {
        Applicant_First_Name: form.applicantFirstName.trim(),
        Applicant_Middle_Name: form.applicantMiddleName.trim() || null,
        Applicant_Last_Name: form.applicantLastName.trim(),
        Applicant_Email: form.applicantEmail.trim() || null,
        Applicant_Gender: form.applicantGender.trim() || null,
        Applicant_ID_Document_Number: form.applicantIdDocumentNumber.trim() || null,
        Applicant_ID_Address: form.applicantIdAddress.trim() || null,
        Applicant_Contact_Number: toStoredPhoneNumber(form.applicantContactNumber) || null,
        Applicant_Valid_ID_Type: form.applicantValidIdType.trim() || null,
        Didit_Session_ID: diditSession.sessionId,
        Preferred_Contact_Method: form.preferredContactMethod.trim(),
        Preferred_Contact_Detail: isPhoneContactMethod(form.preferredContactMethod)
          ? (toStoredPhoneNumber(form.applicantContactNumber) || null)
          : form.applicantEmail.trim(),
        Event_Visibility: normalizeEventVisibility(form.eventVisibility),
        Event_Name: form.eventName.trim(),
        Event_Overview: form.eventOverview.trim() || null,
        Proposed_Start_At: toSqlTimestampOrNull(form.proposedStartAt),
        Proposed_End_At: toSqlTimestampOrNull(form.proposedEndAt),
        Venue_Address: venueAddress || null,
        Street: form.street.trim() || null,
        Barangay: form.barangay.trim() || null,
        City: form.city.trim() || null,
        Province: form.province.trim() || null,
        Region: form.region.trim() || null,
        Country: form.country.trim() || DEFAULT_COUNTRY,
        Expected_Attendees: form.expectedAttendees ? Number(form.expectedAttendees) : null,
        Latitude: form.latitude ? Number(form.latitude) : null,
        Longitude: form.longitude ? Number(form.longitude) : null,
        Applicant_Valid_ID_Path: null,
        Applicant_Valid_ID_URL: null,
        Event_Place_Photo_Path: placePhotoUpload.path,
        Event_Place_Photo_URL: placePhotoUpload.url,
        Event_Poster_Photo_Path: posterPhotoUpload.path,
        Event_Poster_Photo_URL: posterPhotoUpload.url,
        Social_Page_Name: form.socialPageName.trim() || null,
        Social_Page_URL: form.socialPageUrl.trim() || null,
        Status: 'Pending Staff Review',
        Staff_Reviewer_User_ID: null,
        Staff_Reviewed_At: null,
        Staff_Rejected_By_User_ID: null,
        Staff_Rejected_At: null,
        Staff_Rejection_Reason: null,
        Linked_Event_Request_ID: null,
        Resubmission_Count: 0,
      };

      await insertEventApplicationIntake(payload);

      const smtpKickResult = await triggerSmtpNow('event_application_submitted');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after event application submit failed:', smtpKickResult.message || smtpKickResult);
      }

      setSubmittedId(null);
      setSuccessMessage('');
      try {
        window.sessionStorage.setItem('eventApplicationSuccessEmail', String(form.applicantEmail || '').trim().toLowerCase());
      } catch {
        // ignore storage failures
      }
      window.location.assign('/apply-event/success');
    } catch (submitError) {
      setErrorMessage(mapEventApplicationSubmitError(submitError?.message || submitError));
      loadUnavailableProgramDates();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!hasAcceptedTerms) {
    return (
      <Wrapper>
        <div className="min-h-screen bg-gradient-to-b from-slate-100 to-slate-50 px-4 py-8 md:px-8">
          <div className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white/95 p-6 shadow-lg backdrop-blur md:p-8">
            <button
              type="button"
              onClick={handleDeclineTerms}
              className="mb-5 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            >
              <ArrowLeft size={16} />
              Back To Landing
            </button>

            <h1 className="text-2xl font-bold text-slate-900 md:text-3xl">Terms and Conditions</h1>
            <p className="mt-2 text-sm text-slate-600">
              Review and accept the Donivra Terms and Agreement before starting the program application.
            </p>

            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
              <iframe
                title="Donivra Terms and Agreement"
                src={TERMS_AND_AGREEMENT_PDF_PATH}
                className="h-[60vh] w-full bg-white"
              />
            </div>

            <p className="mt-2 text-xs text-slate-500">
              If the preview does not load, open the file here:{' '}
              <a
                href={TERMS_AND_AGREEMENT_PDF_PATH}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-slate-700 underline"
              >
                Donivra Terms and Agreement (PDF)
              </a>
            </p>

            <label className="mt-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={hasConfirmedTerms}
                onChange={(event) => {
                  setHasConfirmedTerms(event.target.checked);
                  if (event.target.checked) {
                    setErrorMessage('');
                  }
                }}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>I have read and agree to the Donivra Terms and Agreement.</span>
            </label>

            {errorMessage ? (
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {errorMessage}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleDeclineTerms}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={handleAcceptTerms}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: primaryColor }}
              >
                Accept and Continue
              </button>
            </div>
          </div>
        </div>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <div className="min-h-screen bg-gradient-to-b from-slate-100 to-slate-50 px-4 py-8 md:px-8">
      <div className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white/95 p-6 shadow-lg backdrop-blur md:p-8">
        <button
          type="button"
          onClick={() => window.location.assign('/')}
          className="mb-5 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
        >
          <ArrowLeft size={16} />
          Back
        </button>

        <h1 className="text-2xl font-bold text-slate-900 md:text-3xl">Program Application Form</h1>
        <p className="mt-2 text-sm text-slate-600">
          Submit your program details for staff review. Your preferred contact is used first, and your other contact detail is the secondary option.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {errorMessage}
          </div>
        )}

        {successMessage && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {successMessage}
            {submittedId ? ` Reference ID: EA-${submittedId}` : ''}
          </div>
        )}
        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Application Steps</div>
          <div className="flex gap-2 overflow-x-auto pb-1 md:grid md:grid-cols-3 md:overflow-visible">
            {FORM_STEPS.map((step) => (
              <div
                key={step.id}
                className={`min-w-[150px] rounded-xl border px-3 py-2 text-xs transition md:min-w-0 md:text-sm ${currentStep === step.id ? 'border-slate-700 bg-white text-slate-900 shadow-sm' : 'border-slate-200 bg-white/70 text-slate-600'}`}
              >
                <div className="font-semibold">Step {step.id}</div>
                <div>{step.title}</div>
              </div>
            ))}
          </div>
        </div>

        <form onSubmit={(event) => event.preventDefault()} className="mt-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {currentStep === 1 && (
            <>
              <div className="md:col-span-2 rounded-xl border border-slate-300 bg-slate-50 p-4">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-slate-800">Applicant Email *</span>
                  <input
                    ref={setFieldRef('applicantEmail')}
                    type="email"
                    value={form.applicantEmail}
                    onChange={updateField('applicantEmail')}
                    placeholder="name@example.com"
                    className={getFieldInputClassName('applicantEmail')}
                    style={{ '--tw-ring-color': primaryColor }}
                    autoComplete="email"
                  />
                  {fieldError('applicantEmail')}
                </label>

                {emailAvailability.message && (
                  <p className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                    emailAvailability.status === 'blocked' || emailAvailability.status === 'error'
                      ? 'border-rose-200 bg-rose-50 text-rose-800'
                      : emailAvailability.status === 'available'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-sky-200 bg-sky-50 text-sky-800'
                  }`}>
                    {emailAvailability.status === 'checking' && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                    {emailAvailability.message}
                  </p>
                )}

                {emailAvailability.status === 'available' && (
                  <div className="mt-3 border-t border-slate-200 pt-3">
                    <div className="flex items-start gap-2 text-xs text-slate-600">
                      <MailCheck size={15} className="mt-0.5 flex-none text-slate-500" />
                      <p>
                        Email verification confirms that the address was entered correctly and can receive application updates.
                        It does not create another contact record.
                      </p>
                    </div>

                    {!isEmailOtpVerified && (
                      <>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={sendEmailOtpCode}
                            disabled={isSendingOtp || otpCooldownSeconds > 0 || !isValidEmail(normalizedEmail)}
                            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ backgroundColor: primaryColor }}
                          >
                            {isSendingOtp ? <Loader2 size={14} className="animate-spin" /> : <MailCheck size={14} />}
                            {isSendingOtp ? 'Sending...' : otpCooldownSeconds > 0 ? `Resend in ${otpCooldownSeconds}s` : 'Send 6-digit Code'}
                          </button>
                        </div>

                        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                          <div>
                            <input
                              ref={setFieldRef('otpCode')}
                              value={otpCode}
                              onChange={(event) => {
                                setOtpCode(String(event.target.value || '').replace(/\D/g, '').slice(0, 6));
                                setFieldErrors((previous) => {
                                  if (!previous.otpCode) return previous;
                                  const next = { ...previous };
                                  delete next.otpCode;
                                  return next;
                                });
                              }}
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={6}
                              placeholder="Enter 6-digit code"
                              className={getFieldInputClassName('otpCode')}
                              style={{ '--tw-ring-color': primaryColor }}
                            />
                            {fieldError('otpCode')}
                          </div>
                          <button
                            type="button"
                            onClick={verifyEmailOtpCode}
                            disabled={isVerifyingOtp || otpCode.length !== 6 || !isValidEmail(normalizedEmail)}
                            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isVerifyingOtp ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                            {isVerifyingOtp ? 'Verifying...' : 'Verify Code'}
                          </button>
                        </div>
                      </>
                    )}

                    {otpNotice.message && !isEmailOtpVerified && (
                      <p className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                        otpNotice.type === 'error'
                          ? 'border border-rose-200 bg-rose-50 text-rose-800'
                          : otpNotice.type === 'success'
                            ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border border-slate-200 bg-white text-slate-700'
                      }`}>
                        {otpNotice.message}
                      </p>
                    )}

                    {isEmailOtpVerified && normalizedEmail === verifiedEmail && (
                      <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                        <ShieldCheck size={14} /> Email verified successfully. You can now continue to your application.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div
                ref={setFieldRef('diditVerification')}
                className={`md:col-span-2 rounded-xl border p-4 ${fieldErrors.diditVerification ? 'border-rose-500 bg-rose-50' : isDiditVerified ? 'border-emerald-300 bg-emerald-50' : 'border-slate-300 bg-slate-50'}`}
              >
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div>
                    <div className="flex items-center gap-2">
                      {isDiditVerified ? <CheckCircle2 size={18} className="text-emerald-600" /> : <ShieldCheck size={18} className="text-slate-600" />}
                      <h2 className="text-sm font-semibold text-slate-800">Verify a Philippine Government ID *</h2>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      The secure verification checks the ID and fills only the name, ID number, gender, and address when available.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={startDiditVerification}
                    disabled={isCreatingDiditSession || isCheckingDiditStatus}
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {isCreatingDiditSession ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                    {isCreatingDiditSession ? 'Starting...' : isDiditVerified ? 'Verify Another ID' : 'Start ID Verification'}
                  </button>
                </div>

                {diditSession && !isDiditVerified && (
                  <button
                    type="button"
                    onClick={() => checkDiditStatus()}
                    disabled={isCheckingDiditStatus}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
                  >
                    {isCheckingDiditStatus && <Loader2 size={14} className="animate-spin" />}
                    Check verification status
                  </button>
                )}

                {diditNotice && <p className={`mt-3 text-xs ${isDiditVerified ? 'text-emerald-700' : 'text-slate-600'}`}>{diditNotice}</p>}
                {fieldError('diditVerification')}
                {diditWarnings.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-700">
                    {diditWarnings.slice(0, 4).map((warning, index) => (
                      <li key={`${warning?.risk || 'warning'}-${index}`}>{warning?.short_description || warning?.risk || 'Verification warning'}</li>
                    ))}
                  </ul>
                )}
              </div>

              {isDiditVerified && (
                <label className="flex flex-col gap-1 md:col-span-2">
                  <span className="text-sm font-medium text-slate-700">Verified ID Type (Philippines) *</span>
                  <input
                    ref={setFieldRef('applicantValidIdType')}
                    type="text"
                    value={PH_VALID_ID_OPTIONS.find((option) => option.value === form.applicantValidIdType)?.label || 'Government ID'}
                    readOnly
                    aria-readonly="true"
                    className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2.5 text-sm text-slate-700 outline-none"
                  />
                  {fieldError('applicantValidIdType')}
                  <span className="text-xs text-slate-500">Detected automatically from the verified document.</span>
                </label>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">First Name *</span>
                <input ref={setFieldRef('applicantFirstName')} type="text" value={form.applicantFirstName} onChange={updateField('applicantFirstName')} className={getFieldInputClassName('applicantFirstName')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('applicantFirstName')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Middle Name (optional)</span>
                <input ref={setFieldRef('applicantMiddleName')} type="text" value={form.applicantMiddleName} onChange={updateField('applicantMiddleName')} className={getFieldInputClassName('applicantMiddleName')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Last Name *</span>
                <input ref={setFieldRef('applicantLastName')} type="text" value={form.applicantLastName} onChange={updateField('applicantLastName')} className={getFieldInputClassName('applicantLastName')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('applicantLastName')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Gender *</span>
                <select ref={setFieldRef('applicantGender')} value={form.applicantGender} onChange={updateField('applicantGender')} className={getFieldInputClassName('applicantGender')} style={{ '--tw-ring-color': primaryColor }}>
                  <option value="">Select gender</option>
                  {GENDER_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                {fieldError('applicantGender')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">ID Number *</span>
                <input ref={setFieldRef('applicantIdDocumentNumber')} type="text" value={form.applicantIdDocumentNumber} onChange={updateField('applicantIdDocumentNumber')} className={getFieldInputClassName('applicantIdDocumentNumber')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('applicantIdDocumentNumber')}
              </label>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Address on ID *</span>
                <textarea ref={setFieldRef('applicantIdAddress')} value={form.applicantIdAddress} onChange={updateField('applicantIdAddress')} rows={2} className={getFieldInputClassName('applicantIdAddress')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('applicantIdAddress')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Contact Number *</span>
                <input ref={setFieldRef('applicantContactNumber')} type="text" value={form.applicantContactNumber} onChange={updateField('applicantContactNumber')} placeholder="+63 912 345 6789" className={getFieldInputClassName('applicantContactNumber')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('applicantContactNumber')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Preferred Contact Method *</span>
                <select ref={setFieldRef('preferredContactMethod')} value={form.preferredContactMethod} onChange={updateField('preferredContactMethod')} className={getFieldInputClassName('preferredContactMethod')} style={{ '--tw-ring-color': primaryColor }}>
                  {CONTACT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {fieldError('preferredContactMethod')}
                <span className="text-xs text-slate-500">{preferredContactAutoHelper}</span>
              </label>

              <p className="md:col-span-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                Your preferred contact method is our first option. The contact method you did not choose will automatically be used as the second option.
              </p>

              <div className="flex flex-col gap-2 md:col-span-2">
                <div>
                  <p className="text-sm font-medium text-slate-700">
                    Are you a member of an organization or more? Please input your social media below.
                  </p>
                  <p className="text-xs text-slate-500">Optional — used as the partner credit when admin publishes your program.</p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-slate-600">Social Media Name</span>
                    <input
                      type="text"
                      value={form.socialPageName}
                      onChange={updateField('socialPageName')}
                      placeholder="e.g., Donivra PH, John's Page"
                      className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:ring-2"
                      style={{ '--tw-ring-color': primaryColor }}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-slate-600">Social Media Page Link</span>
                    <input
                      type="url"
                      value={form.socialPageUrl}
                      onChange={updateField('socialPageUrl')}
                      placeholder="https://facebook.com/yourpage"
                      className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:ring-2"
                      style={{ '--tw-ring-color': primaryColor }}
                    />
                  </label>
                </div>
              </div>
            </>
          )}

          {currentStep === 2 && (
            <>
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Program Type *</span>
                <select ref={setFieldRef('eventVisibility')} value={form.eventVisibility} onChange={updateField('eventVisibility')} className={getFieldInputClassName('eventVisibility')} style={{ '--tw-ring-color': primaryColor }}>
                  <option value="Public">Public Program</option>
                  <option value="Private">Private Program</option>
                </select>
                {fieldError('eventVisibility')}
                <span className="text-xs text-slate-500">Private programs receive a private access code after admin approval.</span>
              </label>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Program Name *</span>
                <input ref={setFieldRef('eventName')} type="text" value={form.eventName} onChange={updateField('eventName')} className={getFieldInputClassName('eventName')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('eventName')}
              </label>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Program Poster Photo (optional)</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleEventPosterPhotoFileChange}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                />
                <span className="text-xs text-slate-500">Main program image used for the poster and publicity design.</span>
              </label>

              {eventPosterPhotoPreviewUrl && (
                <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Program Poster Preview</p>
                  <img src={eventPosterPhotoPreviewUrl} alt="Program poster preview" className="max-h-72 w-full rounded border border-slate-200 object-contain" />
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Expected Attendees *</span>
                <input ref={setFieldRef('expectedAttendees')} type="number" min="1" value={form.expectedAttendees} onChange={updateField('expectedAttendees')} className={getFieldInputClassName('expectedAttendees')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('expectedAttendees')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Program Date (UTC+8) *</span>
                <ProgramDateCalendar
                  value={form.proposedDate}
                  minimumDateKey={minimumProgramDateKey}
                  blockedDates={unavailableProgramDateSet}
                  onChange={updateScheduleField('proposedDate')}
                  buttonRef={setFieldRef('proposedDate')}
                  hasError={Boolean(fieldErrors.proposedDate)}
                  primaryColor={primaryColor}
                />
                {fieldError('proposedDate')}
                <span className="text-xs text-slate-500">Choose from the calendar. Reserved dates and dates inside the 7-day notice are disabled.</span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Start Time *</span>
                <input ref={setFieldRef('proposedStartTime')} type="time" value={form.proposedStartTime} onChange={updateScheduleField('proposedStartTime')} disabled={!form.proposedDate} className={getFieldInputClassName('proposedStartTime', 'disabled:cursor-not-allowed disabled:bg-slate-100')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('proposedStartTime')}
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">End Time *</span>
                <input ref={setFieldRef('proposedEndTime')} type="time" value={form.proposedEndTime} onChange={updateScheduleField('proposedEndTime')} min={form.proposedStartTime || undefined} disabled={!form.proposedDate || !form.proposedStartTime} className={getFieldInputClassName('proposedEndTime', 'disabled:cursor-not-allowed disabled:bg-slate-100')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('proposedEndTime')}
                <span className="text-xs text-slate-500">The program must end later on the same date.</span>
              </label>

              <div className="md:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span className="font-semibold">One application per date:</span>{' '}
                pending and approved program dates are reserved for everyone. A date reopens only after staff rejects its application.
                {isLoadingProgramDates && <span> Checking dates...</span>}
                {!isLoadingProgramDates && unavailableProgramDates.length > 0 && (
                  <span className="block pt-1 text-amber-700">
                    Currently reserved: {unavailableProgramDates.slice(0, 12).join(', ')}{unavailableProgramDates.length > 12 ? ` and ${unavailableProgramDates.length - 12} more` : ''}
                  </span>
                )}
              </div>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Program Overview *</span>
                <textarea ref={setFieldRef('eventOverview')} value={form.eventOverview} onChange={updateField('eventOverview')} rows={4} className={getFieldInputClassName('eventOverview')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('eventOverview')}
              </label>

              <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-600">Venue Address *</h2>
                <p className="mt-1 text-xs text-slate-500">Choose address fields, then pin exact location on map.</p>

                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-sm font-medium text-slate-700">Venue Name *</span>
                    <input ref={setFieldRef('venueName')} type="text" value={form.venueName} onChange={updateField('venueName')} className={getFieldInputClassName('venueName')} style={{ '--tw-ring-color': primaryColor }} />
                    {fieldError('venueName')}
                  </label>

                  <div ref={setFieldRef('eventPlacePhoto')} className={`flex flex-col gap-2 rounded-lg border p-3 md:col-span-2 ${fieldErrors.eventPlacePhoto ? 'border-rose-500 bg-rose-50' : 'border-slate-300 bg-white'}`}>
                    <span className="text-sm font-medium text-slate-700">Program Place Photo *</span>
                    <div className="flex flex-wrap gap-2">
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}>
                        <Camera size={16} /> Take Photo
                        <input type="file" accept="image/*" capture="environment" onChange={handleEventPlacePhotoFileChange} className="sr-only" />
                      </label>
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
                        <Upload size={16} /> Upload Photo
                        <input type="file" accept="image/*" onChange={handleEventPlacePhotoFileChange} className="sr-only" />
                      </label>
                    </div>
                    {eventPlacePhotoFile && <span className="text-xs text-emerald-700">Selected: {eventPlacePhotoFile.name}</span>}
                    {fieldError('eventPlacePhoto')}
                    <span className="text-xs text-slate-500">Exactly one venue/place image is required. Choosing another image replaces the current one.</span>
                  </div>

                  {eventPlacePhotoPreviewUrl && (
                    <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Program Place Photo Preview</p>
                      <img src={eventPlacePhotoPreviewUrl} alt="Program place preview" className="max-h-72 w-full rounded border border-slate-200 object-contain" />
                    </div>
                  )}

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Region *</span>
                    <select ref={setFieldRef('region')} value={form.region} onChange={handleRegionChange} className={getFieldInputClassName('region')} style={{ '--tw-ring-color': primaryColor }}>
                      <option value="">Select region</option>
                      {regionOptions.map((region) => <option key={region.name} value={region.name}>{region.name}</option>)}
                    </select>
                    {fieldError('region')}
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Province *</span>
                    <select ref={setFieldRef('province')} value={form.province} onChange={handleProvinceChange} className={getFieldInputClassName('province')} style={{ '--tw-ring-color': primaryColor }} disabled={!form.region}>
                      <option value="">Select province</option>
                      {provinceOptions.map((province) => <option key={province.name} value={province.name}>{province.name}</option>)}
                    </select>
                    {fieldError('province')}
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">City/Municipality *</span>
                    <select ref={setFieldRef('city')} value={form.city} onChange={handleCityChange} className={getFieldInputClassName('city')} style={{ '--tw-ring-color': primaryColor }} disabled={!form.province}>
                      <option value="">Select city/municipality</option>
                      {cityOptions.map((city) => <option key={city.name} value={city.name}>{city.name}</option>)}
                    </select>
                    {fieldError('city')}
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Barangay *</span>
                    <select ref={setFieldRef('barangay')} value={form.barangay} onChange={updateField('barangay')} className={getFieldInputClassName('barangay')} style={{ '--tw-ring-color': primaryColor }} disabled={!form.city}>
                      <option value="">Select barangay</option>
                      {barangayOptions.map((barangay) => <option key={barangay} value={barangay}>{barangay}</option>)}
                    </select>
                    {fieldError('barangay')}
                  </label>

                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-sm font-medium text-slate-700">Street *</span>
                    <input ref={setFieldRef('street')} type="text" value={form.street} onChange={updateField('street')} className={getFieldInputClassName('street')} style={{ '--tw-ring-color': primaryColor }} />
                    {fieldError('street')}
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Country</span>
                    <input type="text" value={form.country} onChange={updateField('country')} className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:ring-2" style={{ '--tw-ring-color': primaryColor }} />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Map Coordinates</span>
                    <input ref={setFieldRef('locationPin')} type="text" value={form.latitude && form.longitude ? `${form.latitude}, ${form.longitude}` : ''} onChange={() => {}} readOnly placeholder="Set by map pin" className={`rounded-lg border bg-slate-100 px-3 py-2.5 text-sm text-slate-600 ${fieldErrors.locationPin ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-300'}`} />
                    {fieldError('locationPin')}
                  </label>
                </div>

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={autoPinFromCurrentAddress}
                    className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                  >
                    Auto-pin from address
                  </button>
                </div>

                <div className="mt-4">
                  <LocationPinPicker
                    latitude={form.latitude ? Number(form.latitude) : null}
                    longitude={form.longitude ? Number(form.longitude) : null}
                    onChange={handleLocationChange}
                  />
                </div>
              </div>

            </>
          )}

          {currentStep === 3 && (
            <div className="md:col-span-2 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">Final Confirmation</h2>
                <p className="mt-1 text-xs text-slate-500">Review all values before submitting your program application.</p>
                <div className="mt-4 space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Applicant</p>
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
                      {[
                        ['Name', [form.applicantFirstName, form.applicantMiddleName, form.applicantLastName].filter(Boolean).join(' ') || 'N/A'],
                        ['Gender', form.applicantGender || 'N/A'],
                        ['ID Type', PH_VALID_ID_OPTIONS.find((option) => option.value === form.applicantValidIdType)?.label || 'N/A'],
                        ['ID Verification', isDiditVerified ? 'Approved' : diditStatus],
                        ['ID Number', form.applicantIdDocumentNumber || 'N/A'],
                        ['Address on ID', form.applicantIdAddress || 'N/A'],
                        ['Email', form.applicantEmail || 'N/A'],
                        ['Contact Number', form.applicantContactNumber || 'N/A'],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <span className="font-semibold">{label}:</span> {value}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Preferred Contact Way</p>
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
                      <div>
                        <span className="font-semibold">Preferred Contact Method:</span> {normalizePreferredContactLabel(form.preferredContactMethod)}
                      </div>
                      <div>
                        <span className="font-semibold">Primary:</span>{' '}
                        {isPhoneContactMethod(form.preferredContactMethod) ? form.applicantContactNumber : form.applicantEmail}
                      </div>
                      <div className="md:col-span-2 text-xs text-slate-500">
                        Secondary: {isPhoneContactMethod(form.preferredContactMethod) ? form.applicantEmail : form.applicantContactNumber}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Program & Schedule</p>
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
                      <div className="md:col-span-2"><span className="font-semibold">Program Name:</span> {form.eventName || 'N/A'}</div>
                      <div><span className="font-semibold">Program Type:</span> {normalizeEventVisibility(form.eventVisibility)}</div>
                      <div><span className="font-semibold">Expected Attendees:</span> {form.expectedAttendees || 'N/A'}</div>
                      <div className="md:col-span-2"><span className="font-semibold">Venue Name:</span> {form.venueName || 'N/A'}</div>
                      <div className="md:col-span-2">
                        <span className="font-semibold">Schedule (UTC+8):</span>{' '}
                        {formatUtc8DateTimeDisplay(form.proposedStartAt)} to {formatUtc8DateTimeDisplay(form.proposedEndAt)}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Locations</p>
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700">
                      <div><span className="font-semibold">Address:</span> {[form.street, form.barangay, form.city, form.province, form.region, form.country].filter(Boolean).join(', ') || 'N/A'}</div>
                      <div><span className="font-semibold">Map Coordinates:</span> {form.latitude && form.longitude ? `${form.latitude}, ${form.longitude}` : 'N/A'}</div>
                      <div><span className="font-semibold">Overview:</span> {form.eventOverview || 'N/A'}</div>

                      <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Pinned Map Location</p>
                        {form.latitude && form.longitude ? (
                          <iframe
                            title="Pinned map location preview"
                            src={`https://maps.google.com/maps?q=${encodeURIComponent(`${form.latitude},${form.longitude}`)}&z=16&output=embed`}
                            className="h-56 w-full rounded border border-slate-200 bg-white"
                            loading="lazy"
                            referrerPolicy="no-referrer-when-downgrade"
                          />
                        ) : (
                          <div className="flex h-56 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-xs text-slate-500">
                            No pinned location yet.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {(eventPlacePhotoPreviewUrl || eventPosterPhotoPreviewUrl) && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {eventPlacePhotoPreviewUrl && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Program Place Photo Preview</p>
                      <img src={eventPlacePhotoPreviewUrl} alt="Program place preview" className="max-h-52 w-auto rounded border border-slate-200 object-contain" />
                    </div>
                  )}
                  {eventPosterPhotoPreviewUrl && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Program Poster Photo Preview</p>
                      <img src={eventPosterPhotoPreviewUrl} alt="Program poster preview" className="max-h-52 w-auto rounded border border-slate-200 object-contain" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">Step {currentStep} of {FORM_STEPS.length}</div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
              {currentStep > 1 && (
                <button
                  type="button"
                  onClick={goPreviousStep}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 sm:w-auto"
                >
                  <ChevronLeft size={15} />
                  Previous
                </button>
              )}
              {currentStep < FORM_STEPS.length ? (
                 <button
                   type="button"
                   onClick={goNextStep}
                   disabled={
                     currentStep === 1
                     && (
                       emailAvailability.status !== 'available'
                       || !isEmailOtpVerified
                       || normalizedEmail !== verifiedEmail
                     )
                   }
                   title={
                     currentStep === 1 && (!isEmailOtpVerified || normalizedEmail !== verifiedEmail)
                       ? 'Verify the applicant email before continuing.'
                       : undefined
                   }
                   className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                   style={{ backgroundColor: primaryColor }}
                 >
                  Next
                  <ChevronRight size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSubmit(null, false)}
                  disabled={isSubmitting || !canSubmit || !isEmailOtpVerified || normalizedEmail !== verifiedEmail}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto"
                  style={{ backgroundColor: primaryColor }}
                >
                  {isSubmitting && <Loader2 size={16} className="animate-spin" />}
                  {isSubmitting ? 'Submitting...' : 'Submit Program Application'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

      {isSubmitConfirmationOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSubmitting) {
              setIsSubmitConfirmationOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="submit-confirmation-title"
            className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex flex-none items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div className="flex items-start gap-3">
                <div
                  className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  <CheckCircle2 size={19} />
                </div>
                <div>
                  <h2 id="submit-confirmation-title" className="text-lg font-bold text-slate-900">
                    Confirm program application
                  </h2>
                  <p className="mt-0.5 text-sm text-slate-600">
                    Verify every submitted detail before creating your application.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsSubmitConfirmationOpen(false)}
                disabled={isSubmitting}
                className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-60"
                aria-label="Close confirmation"
              >
                <X size={17} />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <ConfirmationSection title="Applicant and verification">
                <ConfirmationItem
                  label="Full name"
                  value={[form.applicantFirstName, form.applicantMiddleName, form.applicantLastName].filter(Boolean).join(' ')}
                />
                <ConfirmationItem label="Gender" value={form.applicantGender} />
                <ConfirmationItem
                  label="Government ID type"
                  value={PH_VALID_ID_OPTIONS.find((option) => option.value === form.applicantValidIdType)?.label}
                />
                <ConfirmationItem label="ID verification" value={isDiditVerified ? 'Approved' : diditStatus} />
                <ConfirmationItem label="ID number" value={form.applicantIdDocumentNumber} />
                <ConfirmationItem label="Address on ID" value={form.applicantIdAddress} />
                <ConfirmationItem label="Verified email" value={verifiedEmail} />
                <ConfirmationItem label="Email verification" value={isEmailOtpVerified ? 'Verified' : 'Not verified'} />
              </ConfirmationSection>

              <ConfirmationSection title="Contact and organization">
                <ConfirmationItem label="Contact number" value={form.applicantContactNumber} />
                <ConfirmationItem
                  label="Preferred contact method"
                  value={normalizePreferredContactLabel(form.preferredContactMethod)}
                />
                <ConfirmationItem
                  label="Primary contact"
                  value={isPhoneContactMethod(form.preferredContactMethod) ? form.applicantContactNumber : form.applicantEmail}
                />
                <ConfirmationItem
                  label="Secondary contact"
                  value={isPhoneContactMethod(form.preferredContactMethod) ? form.applicantEmail : form.applicantContactNumber}
                />
                <ConfirmationItem label="Social media name" value={form.socialPageName || 'Not provided'} />
                <ConfirmationItem label="Social media page link" value={form.socialPageUrl || 'Not provided'} />
              </ConfirmationSection>

              <ConfirmationSection title="Program details">
                <ConfirmationItem label="Program name" value={form.eventName} />
                <ConfirmationItem label="Program type" value={normalizeEventVisibility(form.eventVisibility)} />
                <ConfirmationItem label="Expected attendees" value={form.expectedAttendees} />
                <ConfirmationItem label="Program date" value={form.proposedDate} />
                <ConfirmationItem label="Start" value={formatUtc8DateTimeDisplay(form.proposedStartAt)} />
                <ConfirmationItem label="End" value={formatUtc8DateTimeDisplay(form.proposedEndAt)} />
                <ConfirmationItem
                  label="Program overview"
                  value={<span className="whitespace-pre-wrap">{form.eventOverview}</span>}
                  wide
                />
              </ConfirmationSection>

              <ConfirmationSection title="Venue and location">
                <ConfirmationItem label="Venue name" value={form.venueName} />
                <ConfirmationItem label="Country" value={form.country} />
                <ConfirmationItem label="Region" value={form.region} />
                <ConfirmationItem label="Province" value={form.province} />
                <ConfirmationItem label="City or municipality" value={form.city} />
                <ConfirmationItem label="Barangay" value={form.barangay} />
                <ConfirmationItem label="Street" value={form.street} wide />
                <ConfirmationItem
                  label="Complete venue address"
                  value={[form.venueName, form.street, form.barangay, form.city, form.province, form.region, form.country].filter(Boolean).join(', ')}
                  wide
                />
                <ConfirmationItem
                  label="Pinned map coordinates"
                  value={form.latitude && form.longitude ? `${form.latitude}, ${form.longitude}` : 'N/A'}
                  wide
                />
              </ConfirmationSection>

              <ConfirmationSection title="Submitted images">
                <ConfirmationItem
                  label="Program place photo"
                  value={eventPlacePhotoFile?.name || 'Selected place photo'}
                />
                <ConfirmationItem
                  label="Program poster photo"
                  value={eventPosterPhotoFile?.name || 'Not provided'}
                />
                {eventPlacePhotoPreviewUrl && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Place photo preview</p>
                    <img
                      src={eventPlacePhotoPreviewUrl}
                      alt="Submitted program place"
                      className="h-40 w-full rounded-lg border border-slate-200 bg-white object-contain"
                    />
                  </div>
                )}
                {eventPosterPhotoPreviewUrl && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Poster photo preview</p>
                    <img
                      src={eventPosterPhotoPreviewUrl}
                      alt="Submitted program poster"
                      className="h-40 w-full rounded-lg border border-slate-200 bg-white object-contain"
                    />
                  </div>
                )}
              </ConfirmationSection>

              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
                No application has been created yet. Click <strong>Confirm &amp; Submit Program Application</strong> below only after checking every detail.
              </div>
            </div>

            <div className="flex flex-none flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setIsSubmitConfirmationOpen(false)}
                disabled={isSubmitting}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => handleSubmit(null, true)}
                disabled={isSubmitting}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: primaryColor }}
              >
                {isSubmitting && <Loader2 size={15} className="animate-spin" />}
                {isSubmitting ? 'Submitting...' : 'Confirm & Submit Program Application'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isDiditModalOpen && diditSession?.verificationUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 p-2 md:p-5">
          <div className="flex h-[96vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Philippine ID Verification</h2>
                <p className="text-xs text-slate-500">Complete the secure verification steps below.</p>
              </div>
              <button
                type="button"
                onClick={() => setIsDiditModalOpen(false)}
                className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-100"
                aria-label="Close ID verification"
              >
                <X size={18} />
              </button>
            </div>
            <iframe
              title="Identity verification"
              src={diditSession.verificationUrl}
              allow="camera; microphone; fullscreen; autoplay; encrypted-media"
              className="min-h-0 flex-1 border-0 bg-white"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs text-slate-600">Finished but the window did not close automatically?</p>
              <button
                type="button"
                onClick={() => checkDiditStatus()}
                disabled={isCheckingDiditStatus}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"
              >
                {isCheckingDiditStatus && <Loader2 size={14} className="animate-spin" />}
                Check verification status
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </Wrapper>
  );
}

