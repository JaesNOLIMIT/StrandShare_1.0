import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, CalendarDays, Camera, CheckCircle2, ChevronLeft, ChevronRight, Download, FileText, Loader2, MailCheck, Ruler, Search, ShieldCheck, Smartphone, Upload, Users, X } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import maplibregl from 'maplibre-gl';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import { useTheme } from '../../context/ThemeContext';
import { triggerSmtpNow } from '../../lib/smtpTriggerClient';
import LegalTermsGate from '../../components/LegalTermsGate';
import useActiveLegalDocument from '../../hooks/useActiveLegalDocument';
import philippineAddressOptions from '../../data/philippineAddressOptions.json';
import { getAdultBirthdateMax, isAtLeastAge } from '../../lib/personIdentity';
import { normalizeDiditBirthdate, normalizeDiditDocument } from '../../lib/diditIdentity';
import 'maplibre-gl/dist/maplibre-gl.css';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const WIG_REQUIREMENTS_TABLE = 'wig_requirements';
const EVENT_APPLICATION_ASSETS_BUCKET = 'event_application_assets';
const MAX_UPLOAD_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_EXPECTED_ATTENDEES = 500;
const PROGRAM_DATE_AVAILABILITY_CHANNEL = 'program-date-availability';
// Realtime broadcasts and the final submit-time availability check provide the
// fast path. Keep a low-frequency polling fallback for missed broadcasts.
const PROGRAM_DATE_REFRESH_INTERVAL_MS = 60 * 1000;
const MOBILE_APP_APK_URL = String(process.env.REACT_APP_MOBILE_APP_APK_URL || '/downloads/donivra.apk').trim();
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

const GENDER_OPTIONS = ['Male', 'Female'];
const FORM_STEPS = [
  { id: 1, title: 'Applicant', description: 'Details & email' },
  { id: 2, title: 'Program', description: 'Schedule & venue' },
  { id: 3, title: 'Review', description: 'Confirm & submit' },
];
const APPLICATION_STEPS = [
  { id: 1, title: 'About', description: 'What you are applying for' },
  { id: 2, title: 'Terms', description: 'Read & agree' },
  ...FORM_STEPS.map((step) => ({ ...step, id: step.id + 2 })),
];
const HAIR_TREATMENT_REQUIREMENTS = [
  { key: 'Chemical_Treatment_Status', label: 'Chemically treated hair' },
  { key: 'Colored_Hair_Status', label: 'Colored hair' },
  { key: 'Bleached_Hair_Status', label: 'Bleached hair' },
  { key: 'Rebonded_Hair_Status', label: 'Rebonded hair' },
];
const EVENT_TERMS_DOCUMENT_TYPE = 'event_application_terms';

const INITIAL_FORM = {
  applicantValidIdType: 'philsys',
  applicantIdDocumentNumber: '',
  applicantIdAddress: '',
  applicantFirstName: '',
  applicantMiddleName: '',
  applicantLastName: '',
  applicantEmail: '',
  applicantBirthdate: '',
  applicantGender: '',
  applicantContactNumber: '',
  preferredContactMethod: 'email',
  eventVisibility: '',
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
  // Shift the absolute instant by UTC+8, then read it through UTC getters as a
  // Manila wall-clock value. Applying the browser timezone offset here would
  // incorrectly expose yesterday's UTC date on devices already set to UTC+8.
  return new Date(date.getTime() + (UTC8_OFFSET_MINUTES * 60 * 1000));
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

function addMinutesToTime(time, minutesToAdd = 1) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return '';
  const totalMinutes = (Number(match[1]) * 60) + Number(match[2]) + minutesToAdd;
  if (totalMinutes < 0 || totalMinutes >= 24 * 60) return '';
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
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
                  title={isReserved ? 'Reserved—available only if staff rejects the existing application' : isTooEarly ? 'The date must be at least 7 calendar days in advance (UTC+8)' : formatProgramDateLabel(dateKey)}
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
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-slate-200" />Inside 7-day notice (UTC+8)</span>
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

function getAttendeeListFileKind(file) {
  if (!file) return '';
  const mimeType = String(file.type || '').trim().toLowerCase();
  const fileName = String(file.name || '').trim().toLowerCase();
  if (mimeType === 'text/csv' || mimeType === 'application/csv' || fileName.endsWith('.csv')) return 'csv';
  if (mimeType.startsWith('image/') || /\.(?:jpe?g|png|webp|heic|heif)$/i.test(fileName)) return 'image';
  return '';
}

function mapStorageUploadError(rawMessage) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('bucket') && lower.includes('not found')) {
    return 'Program application uploads are temporarily unavailable. Please contact an administrator.';
  }

  if (lower.includes('row-level security')) {
    return 'The file could not be uploaded because program upload access is unavailable. Please contact an administrator.';
  }

  return message || 'Unable to upload file.';
}

function mapEventApplicationSubmitError(rawMessage) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('row-level security') && lower.includes('event_applications')) {
    return 'Your program application could not be submitted because access is unavailable. Please contact an administrator.';
  }

  if (lower.includes('row-level security')) {
    return 'Your program application could not be submitted. Please retry or contact an administrator.';
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

  const clientMessage = String(error?.message || '').trim();
  if (clientMessage.toLowerCase().includes('failed to send a request to the edge function')) {
    return 'The ID verification service could not be reached from this site. Ask the administrator to allow this exact site origin in DIDIT_ALLOWED_ORIGINS and redeploy the didit-verification Edge Function.';
  }

  return clientMessage || fallbackMessage;
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
  return '';
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
  const eventTerms = useActiveLegalDocument(EVENT_TERMS_DOCUMENT_TYPE);

  const [form, setForm] = useState(INITIAL_FORM);
  const [eventPlacePhotoFile, setEventPlacePhotoFile] = useState(null);
  const [eventPosterPhotoFile, setEventPosterPhotoFile] = useState(null);
  const [attendeeListPdfFile, setAttendeeListPdfFile] = useState(null);
  const [eventPlacePhotoPreviewUrl, setEventPlacePhotoPreviewUrl] = useState('');
  const [eventPosterPhotoPreviewUrl, setEventPosterPhotoPreviewUrl] = useState('');
  const [attendeeListPreviewUrl, setAttendeeListPreviewUrl] = useState('');
  const [diditSession, setDiditSession] = useState(null);
  const [diditStatus, setDiditStatus] = useState('Not Started');
  const [verifiedIdPreviewUrl, setVerifiedIdPreviewUrl] = useState('');
  const [diditWarnings, setDiditWarnings] = useState([]);
  const [diditNotice, setDiditNotice] = useState('');
  const [isCreatingDiditSession, setIsCreatingDiditSession] = useState(false);
  const [isCheckingDiditStatus, setIsCheckingDiditStatus] = useState(false);
  const [isDiditModalOpen, setIsDiditModalOpen] = useState(false);
  const [unavailableProgramDates, setUnavailableProgramDates] = useState([]);
  const [isLoadingProgramDates, setIsLoadingProgramDates] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [applicationStage, setApplicationStage] = useState('about');
  const [aboutPanel, setAboutPanel] = useState('checklist');
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
  const [wigRequirements, setWigRequirements] = useState(null);
  const [isLoadingWigRequirements, setIsLoadingWigRequirements] = useState(true);
  const [wigRequirementsError, setWigRequirementsError] = useState('');
  const fieldRefs = useRef({});
  const diditStatusCheckInFlightRef = useRef(false);
  const programDateAvailabilityChannelRef = useRef(null);
  const idPreviewRefreshSessionRef = useRef('');
  const submitConfirmationScrollRef = useRef(null);

  useEffect(() => {
    if (!isSubmitConfirmationOpen) return undefined;
    submitConfirmationScrollRef.current?.scrollTo({ top: 0 });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isSubmitConfirmationOpen]);

  useEffect(() => {
    let isCurrent = true;

    const loadWigRequirements = async () => {
      if (!isSupabaseConfigured || !supabase) {
        if (isCurrent) {
          setWigRequirementsError('Wig requirements are temporarily unavailable.');
          setIsLoadingWigRequirements(false);
        }
        return;
      }

      setIsLoadingWigRequirements(true);
      setWigRequirementsError('');

      const result = await supabase
        .from(WIG_REQUIREMENTS_TABLE)
        .select(
          'Minimum_Number_Donor,Minimum_Hair_Length,Chemical_Treatment_Status,Colored_Hair_Status,Bleached_Hair_Status,Rebonded_Hair_Status,Hair_Texture_Status,Notes,Updated_At',
        )
        .order('Wig_Requirement_ID', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!isCurrent) return;
      if (result.error || !result.data) {
        setWigRequirements(null);
        setWigRequirementsError('Wig requirements are temporarily unavailable. Please contact Donivra before organizing the program.');
      } else {
        setWigRequirements(result.data);
      }
      setIsLoadingWigRequirements(false);
    };

    void loadWigRequirements();
    return () => {
      isCurrent = false;
    };
  }, []);

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

  const markFieldErrors = useCallback((errors) => {
    const nextErrors = errors && typeof errors === 'object' ? errors : {};
    setFieldErrors(nextErrors);
    setErrorMessage(Object.keys(nextErrors).length ? 'Complete the highlighted required fields before continuing.' : '');
    const firstField = Object.keys(nextErrors)[0];
    if (firstField) focusField(firstField);
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
    if (!attendeeListPdfFile || !getAttendeeListFileKind(attendeeListPdfFile)) {
      setAttendeeListPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(attendeeListPdfFile);
    setAttendeeListPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [attendeeListPdfFile]);

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

  const [minimumProposedStartLocalValue, setMinimumProposedStartLocalValue] = useState(
    () => getMinimumProposedStartLocalValue(),
  );
  const normalizedEmail = useMemo(() => String(form.applicantEmail || '').trim().toLowerCase(), [form.applicantEmail]);
  const isDiditVerified = useMemo(
    () => String(diditStatus || '').toLowerCase() === 'approved' && Boolean(diditSession?.sessionId),
    [diditSession, diditStatus],
  );
  const unavailableProgramDateSet = useMemo(
    () => new Set(unavailableProgramDates),
    [unavailableProgramDates],
  );

  const minimumRequiredDonors = useMemo(() => {
    const parsedMinimum = Number(wigRequirements?.Minimum_Number_Donor);
    return Number.isInteger(parsedMinimum) && parsedMinimum > 0 ? parsedMinimum : null;
  }, [wigRequirements]);

  const minimumExpectedAttendees = minimumRequiredDonors || 1;
  const expectedAttendeeCount = Number(form.expectedAttendees);
  const isExpectedAttendeesBelowMinimum = Boolean(form.expectedAttendees)
    && Number.isFinite(expectedAttendeeCount)
    && expectedAttendeeCount < minimumExpectedAttendees;

  const minimumProgramDateKey = useMemo(
    () => toProgramDateKey(minimumProposedStartLocalValue),
    [minimumProposedStartLocalValue],
  );
  const minimumProgramDateLabel = useMemo(
    () => formatProgramDateLabel(minimumProgramDateKey),
    [minimumProgramDateKey],
  );
  const minimumProgramEndTime = useMemo(
    () => addMinutesToTime(form.proposedStartTime),
    [form.proposedStartTime],
  );

  useEffect(() => {
    const refreshMinimumProgramDate = () => {
      const nextMinimum = getMinimumProposedStartLocalValue();
      setMinimumProposedStartLocalValue((previous) => (
        previous === nextMinimum ? previous : nextMinimum
      ));
    };

    refreshMinimumProgramDate();
    const intervalId = window.setInterval(refreshMinimumProgramDate, 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, []);

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
      && isAtLeastAge(form.applicantBirthdate, 18)
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
      && Number.isInteger(Number(form.expectedAttendees))
      && Number(form.expectedAttendees) >= minimumExpectedAttendees
      && Number(form.expectedAttendees) <= MAX_EXPECTED_ATTENDEES
      && attendeeListPdfFile
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
    minimumExpectedAttendees,
    attendeeListPdfFile,
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
      if (!form.applicantBirthdate) return issue('applicantBirthdate', 'Birthdate is required.');
      if (!isAtLeastAge(form.applicantBirthdate, 18)) return issue('applicantBirthdate', 'The applicant must be at least 18 years old.');
      if (!GENDER_OPTIONS.includes(form.applicantGender.trim())) return issue('applicantGender', 'Select Male or Female.');
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
      if (!form.expectedAttendees) return issue('expectedAttendees', 'Expected attendees is required.');
      if (!Number.isInteger(Number(form.expectedAttendees)) || Number(form.expectedAttendees) <= 0) {
        return issue('expectedAttendees', 'Expected attendees must be a whole number greater than zero.');
      }
      if (Number(form.expectedAttendees) > MAX_EXPECTED_ATTENDEES) {
        return issue('expectedAttendees', `Expected attendees cannot exceed ${MAX_EXPECTED_ATTENDEES}.`);
      }
      if (Number(form.expectedAttendees) < minimumExpectedAttendees) {
        return issue(
          'expectedAttendees',
          `Expected attendees cannot be below the required ${minimumExpectedAttendees} donors for a program.`,
        );
      }
      if (!attendeeListPdfFile) return issue('attendeeListPdf', 'Upload the attendee list as a CSV file or clear image.');
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

      const proposedStart = parseUtc8DateTime(form.proposedStartAt);
      const proposedEnd = parseUtc8DateTime(form.proposedEndAt);

      if (!proposedStart || !proposedEnd) return issue('proposedStartTime', 'Start and end times are required.');
      if (form.proposedDate < minimumProgramDateKey) {
        return issue('proposedDate', `Choose ${minimumProgramDateLabel} or later. Dates use UTC+8.`);
      }
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
    minimumProgramDateKey,
    minimumProgramDateLabel,
    canSubmit,
    unavailableProgramDateSet,
    eventPlacePhotoFile,
    emailAvailability,
    isEmailOtpVerified,
    normalizedEmail,
    verifiedEmail,
    minimumExpectedAttendees,
    attendeeListPdfFile,
  ]);

  const getStepValidationErrors = useCallback((stepNumber) => {
    const errors = {};
    const add = (field, message) => { if (!errors[field]) errors[field] = message; };

    if (stepNumber === 1) {
      if (!form.applicantEmail.trim()) add('applicantEmail', 'Email is required.');
      else if (!isValidEmail(form.applicantEmail)) add('applicantEmail', 'Enter a valid email address.');
      else if (emailAvailability.status === 'checking') add('applicantEmail', 'Wait for the email check to finish.');
      else if (emailAvailability.status !== 'available') add('applicantEmail', emailAvailability.message || 'Check this email before continuing.');
      if (!isEmailOtpVerified || normalizedEmail !== verifiedEmail) add('otpCode', 'Verify the applicant email before continuing.');
      if (!isDiditVerified) add('diditVerification', 'Complete and pass the government ID verification.');
      if (!form.applicantValidIdType.trim()) add('applicantValidIdType', 'Valid ID type is required.');
      if (!form.applicantFirstName.trim()) add('applicantFirstName', 'First name is required.');
      if (!form.applicantLastName.trim()) add('applicantLastName', 'Last name is required.');
      if (!form.applicantBirthdate) add('applicantBirthdate', 'Birthdate is required.');
      else if (!isAtLeastAge(form.applicantBirthdate, 18)) add('applicantBirthdate', 'The applicant must be at least 18 years old.');
      if (!GENDER_OPTIONS.includes(form.applicantGender.trim())) add('applicantGender', 'Select Male or Female.');
      if (!form.applicantIdDocumentNumber.trim()) add('applicantIdDocumentNumber', 'ID number is required.');
      if (!form.applicantIdAddress.trim()) add('applicantIdAddress', 'Address on the ID is required.');
      if (!isValidPhilippineMobile(form.applicantContactNumber)) add('applicantContactNumber', 'Use the +63 912 345 6789 format.');
      if (!form.preferredContactMethod.trim()) add('preferredContactMethod', 'Preferred contact method is required.');
    }

    if (stepNumber === 2) {
      if (!form.eventVisibility.trim()) add('eventVisibility', 'Program type is required.');
      if (!form.eventName.trim()) add('eventName', 'Program name is required.');
      if (!form.venueName.trim()) add('venueName', 'Venue name is required.');
      if (!form.eventOverview.trim()) add('eventOverview', 'Program overview is required.');
      if (!Number.isInteger(Number(form.expectedAttendees)) || Number(form.expectedAttendees) < minimumExpectedAttendees) {
        add('expectedAttendees', `Enter at least ${minimumExpectedAttendees} expected attendees.`);
      } else if (Number(form.expectedAttendees) > MAX_EXPECTED_ATTENDEES) {
        add('expectedAttendees', `Expected attendees cannot exceed ${MAX_EXPECTED_ATTENDEES}.`);
      }
      if (!attendeeListPdfFile) add('attendeeListPdf', 'Upload a CSV file or clear image containing each attendee’s full name and age.');
      if (!form.proposedDate.trim()) add('proposedDate', 'Choose an available program date.');
      if (!form.proposedStartTime.trim()) add('proposedStartTime', 'Start time is required.');
      if (!form.proposedEndTime.trim()) add('proposedEndTime', 'End time is required.');
      if (!eventPlacePhotoFile) add('eventPlacePhoto', 'One program place photo is required.');
      if (!form.street.trim()) add('street', 'Street is required.');
      if (!form.barangay.trim()) add('barangay', 'Barangay is required.');
      if (!form.city.trim()) add('city', 'City/Municipality is required.');
      if (!form.province.trim()) add('province', 'Province is required.');
      if (!form.region.trim()) add('region', 'Region is required.');
      if (!form.latitude.trim() || !form.longitude.trim()) add('locationPin', 'Map pin location is required.');

      const scheduleIssue = getStepValidationIssue(2);
      if (scheduleIssue) add(scheduleIssue.field, scheduleIssue.message);
    }

    return errors;
  }, [
    emailAvailability,
    eventPlacePhotoFile,
    form,
    getStepValidationIssue,
    isDiditVerified,
    isEmailOtpVerified,
    minimumExpectedAttendees,
    attendeeListPdfFile,
    normalizedEmail,
    verifiedEmail,
  ]);

  const goNextStep = useCallback(() => {
    const validationErrors = getStepValidationErrors(currentStep);
    if (Object.keys(validationErrors).length) {
      markFieldErrors(validationErrors);
      return;
    }

    setFieldErrors({});
    setErrorMessage('');
    setCurrentStep((previous) => Math.min(FORM_STEPS.length, previous + 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentStep, getStepValidationErrors, markFieldErrors]);

  const goPreviousStep = useCallback(() => {
    setFieldErrors({});
    setErrorMessage('');
    setCurrentStep((previous) => Math.max(1, previous - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleDeclineTerms = useCallback(() => {
    setErrorMessage('');
    setApplicationStage('about');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const returnToHome = useCallback(() => {
    try { sessionStorage.setItem('Donivra:skip-landing-intro', 'true'); } catch { /* ignore */ }
    window.location.assign('/');
  }, []);

  const handleAcceptTerms = useCallback(() => {
    if (!eventTerms.document?.legal_document_id || !eventTerms.previewUrl) {
      setErrorMessage('The Program Application Terms PDF is unavailable. Please try again after an administrator publishes it.');
      return;
    }
    if (!hasConfirmedTerms) {
      setErrorMessage('Please confirm that you agree to the Terms and Agreement before continuing.');
      return;
    }

    setErrorMessage('');
    setFieldErrors({});
    setHasAcceptedTerms(true);
    setApplicationStage('form');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [eventTerms.document?.legal_document_id, eventTerms.previewUrl, hasConfirmedTerms]);

  const loadUnavailableProgramDates = useCallback(async ({ showLoading = true } = {}) => {
    if (!isSupabaseConfigured || !supabase) return null;
    if (showLoading) setIsLoadingProgramDates(true);
    try {
      const { data, error } = await supabase.rpc('get_unavailable_program_dates', {
        p_from_date: minimumProgramDateKey,
      });
      if (error) throw error;
      const nextUnavailableDates = (Array.isArray(data) ? data : [])
        .map((row) => toProgramDateKey(row?.program_date))
        .filter(Boolean);
      setUnavailableProgramDates(nextUnavailableDates);
      return nextUnavailableDates;
    } catch (availabilityError) {
      console.warn('[Program dates] Unable to load unavailable dates:', availabilityError);
      return null;
    } finally {
      if (showLoading) setIsLoadingProgramDates(false);
    }
  }, [minimumProgramDateKey]);

  useEffect(() => {
    if (!hasAcceptedTerms) return;
    void loadUnavailableProgramDates();

    const refreshDates = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadUnavailableProgramDates({ showLoading: false });
    };

    const availabilityChannel = supabase
      .channel(PROGRAM_DATE_AVAILABILITY_CHANNEL, {
        config: { broadcast: { ack: true } },
      })
      .on('broadcast', { event: 'availability_changed' }, refreshDates)
      .subscribe();

    programDateAvailabilityChannelRef.current = availabilityChannel;

    const intervalId = window.setInterval(refreshDates, PROGRAM_DATE_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshDates);
    document.addEventListener('visibilitychange', refreshDates);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshDates);
      document.removeEventListener('visibilitychange', refreshDates);
      if (programDateAvailabilityChannelRef.current === availabilityChannel) {
        programDateAvailabilityChannelRef.current = null;
      }
      void supabase.removeChannel(availabilityChannel);
    };
  }, [hasAcceptedTerms, loadUnavailableProgramDates]);

  useEffect(() => {
    if (!form.proposedDate || !unavailableProgramDateSet.has(form.proposedDate)) return;

    const newlyReservedDate = form.proposedDate;
    setForm((previous) => {
      if (previous.proposedDate !== newlyReservedDate) return previous;
      return {
        ...previous,
        proposedDate: '',
        proposedStartTime: '',
        proposedEndTime: '',
        proposedStartAt: '',
        proposedEndAt: '',
      };
    });
    setFieldErrors((previous) => ({
      ...previous,
      proposedDate: `${newlyReservedDate} was just reserved by another application. Please choose another date.`,
    }));
  }, [form.proposedDate, unavailableProgramDateSet]);

  useEffect(() => {
    if (!form.proposedDate || form.proposedDate >= minimumProgramDateKey) return;

    setForm((previous) => {
      if (!previous.proposedDate || previous.proposedDate >= minimumProgramDateKey) return previous;
      return {
        ...previous,
        proposedDate: '',
        proposedStartTime: '',
        proposedEndTime: '',
        proposedStartAt: '',
        proposedEndAt: '',
      };
    });
    setFieldErrors((previous) => ({
      ...previous,
      proposedDate: `The notice window changed. Choose ${minimumProgramDateLabel} or later (UTC+8).`,
    }));
  }, [form.proposedDate, minimumProgramDateKey, minimumProgramDateLabel]);

  const applyDiditDocument = useCallback((document) => {
    const normalizedDocument = normalizeDiditDocument(document);
    if (!normalizedDocument) return;
    const middleName = String(normalizedDocument.middle_name || '').trim();

    setForm((previous) => ({
      ...previous,
      applicantValidIdType: mapDiditDocumentType(normalizedDocument),
      applicantFirstName: String(normalizedDocument.first_name || previous.applicantFirstName || '').trim(),
      applicantMiddleName: middleName || previous.applicantMiddleName,
      applicantLastName: String(normalizedDocument.last_name || previous.applicantLastName || '').trim(),
      applicantBirthdate: normalizeDiditBirthdate(normalizedDocument.date_of_birth) || previous.applicantBirthdate,
      applicantGender: mapDiditGender(normalizedDocument.gender) || previous.applicantGender,
      applicantIdDocumentNumber: String(normalizedDocument.document_number || previous.applicantIdDocumentNumber || '').trim(),
      applicantIdAddress: String(normalizedDocument.formatted_address || previous.applicantIdAddress || '').trim(),
    }));
    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next.diditVerification;
      delete next.applicantValidIdType;
      delete next.applicantFirstName;
      delete next.applicantMiddleName;
      delete next.applicantLastName;
      delete next.applicantBirthdate;
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
    if (diditStatusCheckInFlightRef.current) return;

    diditStatusCheckInFlightRef.current = true;
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
      const nextIdPreviewUrl = data?.verified ? String(data?.idFrontImageUrl || '') : '';
      setVerifiedIdPreviewUrl(nextIdPreviewUrl);
      if (data?.verified && (data?.document || data?.birthdate)) {
        applyDiditDocument({
          ...(data?.document || {}),
          date_of_birth: data?.document?.date_of_birth || data?.birthdate || '',
        });
        setDiditNotice(
          nextIdPreviewUrl
            ? 'ID verified. Name, birthdate, ID number, gender, and address were filled when detected. You may correct any scan error.'
            : `ID verified, but the image preview could not be loaded. ${String(data?.idImageNotice || 'Use Refresh ID preview to try again.')}`,
        );
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
      diditStatusCheckInFlightRef.current = false;
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
    setVerifiedIdPreviewUrl('');
    idPreviewRefreshSessionRef.current = '';
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
    const sessionId = String(diditSession?.sessionId || '');
    if (currentStep !== 3 || !isDiditVerified || verifiedIdPreviewUrl || !sessionId) return;
    if (idPreviewRefreshSessionRef.current === sessionId) return;
    idPreviewRefreshSessionRef.current = sessionId;
    void checkDiditStatus();
  }, [checkDiditStatus, currentStep, diditSession?.sessionId, isDiditVerified, verifiedIdPreviewUrl]);

  useEffect(() => {
    const handleDiditMessage = (event) => {
      if (event.origin !== 'https://verify.didit.me') return;
      const eventType = String(event.data?.type || event.data?.event || '').toLowerCase();
      const completionEvents = new Set(['didit:completed', 'verification_complete', 'verification_completed']);
      const terminalStatusEvent = eventType === 'didit:status_updated'
        && ['approved', 'declined', 'in review', 'in_review'].includes(String(event.data?.status || event.data?.data?.status || '').toLowerCase());
      if (!completionEvents.has(eventType) && !terminalStatusEvent) return;

      const messageSessionId = String(event.data?.sessionId || event.data?.session_id || event.data?.data?.sessionId || '').trim();
      if (messageSessionId && messageSessionId !== String(diditSession?.sessionId || '')) return;
      void checkDiditStatus();
    };
    window.addEventListener('message', handleDiditMessage);
    return () => window.removeEventListener('message', handleDiditMessage);
  }, [checkDiditStatus, diditSession?.sessionId]);

  useEffect(() => {
    if (!isDiditModalOpen || !diditSession?.sessionId || isDiditVerified) return undefined;

    const intervalId = window.setInterval(() => {
      void checkDiditStatus();
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [checkDiditStatus, diditSession?.sessionId, isDiditModalOpen, isDiditVerified]);

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

  const handleAttendeeListPdfFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setErrorMessage('');

    if (file) {
      if (!getAttendeeListFileKind(file)) {
        setAttendeeListPdfFile(null);
        markFieldError('attendeeListPdf', 'The attendee list must be a CSV or image file.');
        event.target.value = '';
        return;
      }
      if (file.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
        setAttendeeListPdfFile(null);
        markFieldError('attendeeListPdf', 'The attendee list file must be 8 MB or smaller.');
        event.target.value = '';
        return;
      }
    }

    setAttendeeListPdfFile(file);
    setFieldErrors((previous) => {
      if (!previous.attendeeListPdf) return previous;
      const next = { ...previous };
      delete next.attendeeListPdf;
      return next;
    });
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

    if (key === 'expectedAttendees') {
      setFieldErrors((previous) => {
        const next = { ...previous };
        delete next.expectedAttendees;
        return next;
      });
      setForm((previous) => ({
        ...previous,
        expectedAttendees: nextValue,
      }));
      return;
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

    if (key === 'proposedDate' && nextValue && nextValue < minimumProgramDateKey) {
      markFieldError('proposedDate', `Choose ${minimumProgramDateLabel} or later. Dates use UTC+8.`);
      return;
    }

    if (key === 'proposedDate' && nextValue && unavailableProgramDateSet.has(nextValue)) {
      markFieldError('proposedDate', `${nextValue} is reserved and cannot be selected unless staff rejects the existing application.`);
      return;
    }

    if (
      key === 'proposedEndTime'
      && nextValue
      && form.proposedStartTime
      && nextValue <= form.proposedStartTime
    ) {
      setFieldErrors((previous) => ({
        ...previous,
        proposedEndTime: 'End time must be later than the selected start time.',
      }));
      return;
    }

    if (key === 'proposedStartTime' && nextValue === '23:59') {
      setFieldErrors((previous) => ({
        ...previous,
        proposedStartTime: 'Choose an earlier start time so the program can end on the same date.',
      }));
      return;
    }

    const clearsInvalidEndTime = key === 'proposedStartTime'
      && form.proposedEndTime
      && form.proposedEndTime <= nextValue;

    setFieldErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      if (key === 'proposedDate') delete next.proposedDate;
      if (key === 'proposedStartTime') delete next.proposedStartTime;
      if (key === 'proposedEndTime') delete next.proposedEndTime;
      if (clearsInvalidEndTime) {
        next.proposedEndTime = 'The previous end time was cleared. Choose a time later than the new start time.';
      }
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
    const proposedStart = parseUtc8DateTime(form.proposedStartAt);
    const proposedEnd = parseUtc8DateTime(form.proposedEndAt);

    if (!proposedStart || !proposedEnd) {
      return 'Proposed start and end are required.';
    }

    if (form.proposedDate < minimumProgramDateKey) {
      return `Choose ${minimumProgramDateLabel} or later. Program dates use UTC+8.`;
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
  }, [
    form.proposedDate,
    form.proposedEndAt,
    form.proposedStartAt,
    minimumProgramDateKey,
    minimumProgramDateLabel,
    unavailableProgramDateSet,
  ]);

  const handleSubmit = async (event, isConfirmed = false) => {
    event?.preventDefault();

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Please set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const step1Errors = getStepValidationErrors(1);
    if (Object.keys(step1Errors).length) {
      setCurrentStep(1);
      markFieldErrors(step1Errors);
      return;
    }

    const step2Errors = getStepValidationErrors(2);
    if (Object.keys(step2Errors).length) {
      setCurrentStep(2);
      markFieldErrors(step2Errors);
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
      const selectedProgramDate = form.proposedDate;
      const latestUnavailableDates = await loadUnavailableProgramDates({ showLoading: false });
      if (latestUnavailableDates?.includes(selectedProgramDate)) {
        setCurrentStep(2);
        markFieldError(
          'proposedDate',
          `${selectedProgramDate} was just reserved by another application. Please choose another date.`,
        );
        return;
      }

      // Check before uploading assets. The database insert trigger performs the
      // same check atomically to protect against simultaneous submissions.
      await assertEventApplicationEmailAvailable(normalizedEmail);

      const placePhotoUpload = eventPlacePhotoFile
        ? await uploadEventAsset(eventPlacePhotoFile, 'event-place-photos')
        : { path: null, url: null };
      const posterPhotoUpload = eventPosterPhotoFile
        ? await uploadEventAsset(eventPosterPhotoFile, 'event-poster-photos')
        : { path: null, url: null };
      const attendeeListUpload = attendeeListPdfFile
        ? await uploadEventAsset(attendeeListPdfFile, 'attendee-lists')
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
        Applicant_Birthdate: form.applicantBirthdate,
        Applicant_Gender: GENDER_OPTIONS.includes(form.applicantGender.trim())
          ? form.applicantGender.trim()
          : null,
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
        Expected_Attendee_Details: [],
        Expected_Attendee_List_Path: attendeeListUpload.path,
        Expected_Attendee_List_URL: attendeeListUpload.url,
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
        Terms_Document_ID: eventTerms.document.legal_document_id,
        Terms_Version: eventTerms.document.version,
      };

      await insertEventApplicationIntake(payload);

      try {
        const broadcastResult = await programDateAvailabilityChannelRef.current?.send({
          type: 'broadcast',
          event: 'availability_changed',
          payload: { programDate: selectedProgramDate },
        });
        if (broadcastResult && broadcastResult !== 'ok') {
          console.warn('[Program dates] Realtime availability broadcast was not acknowledged:', broadcastResult);
        }
      } catch (broadcastError) {
        // Other calendars also poll the availability RPC, so a temporary
        // Realtime failure cannot weaken the database reservation guarantee.
        console.warn('[Program dates] Realtime availability broadcast failed:', broadcastError);
      }

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

  if (applicationStage === 'about') {
    return (
      <React.Fragment>
        <div className="flex min-h-screen justify-center bg-slate-50 px-4 py-5 md:px-8">
          <main className="my-auto w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
            <div className="grid lg:grid-cols-2">
              <section className="bg-white p-7 sm:p-9 lg:p-10">
                <button
                  type="button"
                  onClick={returnToHome}
                  className="mb-7 inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-900"
                >
                  <ArrowLeft size={16} />
                  Back to Home
                </button>

                <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: primaryColor }}>Program Application</p>
                <h1 className="mt-3 max-w-lg text-3xl font-bold leading-[1.12] text-slate-900">
                  Host a Hair Donation Program
                </h1>
                <p className="mt-4 max-w-md text-[15px] leading-6 text-slate-600">
                  Organize a verified hair donation program with Donivra in your community.
                </p>

                <div className="mt-8 grid max-w-lg gap-x-8 gap-y-7 sm:grid-cols-2">
                  <section className="border-t border-slate-200 pt-4">
                    <div className="flex items-center gap-3"><Users size={19} style={{ color: primaryColor }} /><h2 className="text-base font-bold text-slate-900">Who can apply</h2></div>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-5 text-slate-600 marker:text-slate-400">
                      <li>Individuals and community groups</li><li>Schools and companies</li><li>Organizations</li>
                    </ul>
                  </section>
                  <section className="border-t border-slate-200 pt-4">
                    <div className="flex items-center gap-3"><FileText size={19} style={{ color: primaryColor }} /><h2 className="text-base font-bold text-slate-900">What you need</h2></div>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-5 text-slate-600 marker:text-slate-400">
                      <li>Contact and identity details</li><li>Schedule, venue, and location</li><li>Attendee list and photos</li>
                    </ul>
                  </section>
                  <section className="border-t border-slate-200 pt-4">
                    <div className="flex items-center gap-3"><ShieldCheck size={19} style={{ color: primaryColor }} /><h2 className="text-base font-bold text-slate-900">Your responsibility</h2></div>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-5 text-slate-600 marker:text-slate-400">
                      <li>Provide accurate information</li><li>Prepare a safe venue</li><li>Coordinate with Donivra staff</li>
                    </ul>
                  </section>
                  <section className="border-t border-slate-200 pt-4">
                    <div className="flex items-center gap-3"><CalendarDays size={19} style={{ color: primaryColor }} /><h2 className="text-base font-bold text-slate-900">What happens next</h2></div>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] leading-5 text-slate-600 marker:text-slate-400">
                      <li>Staff checks the application</li><li>An administrator decides</li><li>Approved programs receive staff support</li>
                    </ul>
                  </section>
                </div>
              </section>

              <aside className="flex flex-col border-t border-[#eadbd6] bg-[#fbf7f5] p-7 text-slate-900 sm:p-9 lg:border-l lg:border-t-0 lg:p-10">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: primaryColor }}>Program essentials</p>
                  <h2 className="mt-2 text-2xl font-bold text-slate-900">Know before you apply</h2>

                  <div className="mt-5 grid grid-cols-2 rounded-xl bg-white/70 p-1" role="tablist" aria-label="Program application information">
                    <button type="button" role="tab" aria-selected={aboutPanel === 'checklist'} onClick={() => setAboutPanel('checklist')} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition-colors ${aboutPanel === 'checklist' ? 'text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} style={aboutPanel === 'checklist' ? { backgroundColor: primaryColor } : undefined}>Before you begin</button>
                    <button type="button" role="tab" aria-selected={aboutPanel === 'requirements'} onClick={() => setAboutPanel('requirements')} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition-colors ${aboutPanel === 'requirements' ? 'text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} style={aboutPanel === 'requirements' ? { backgroundColor: primaryColor } : undefined}>Donation rules</button>
                  </div>

                  {aboutPanel === 'checklist' ? (
                    <div role="tabpanel">
                  <ul className="mt-6 space-y-3.5 text-[15px] leading-5 text-slate-800">
                    {[
                      'Valid government ID',
                      'Verified email address',
                      'Program date, time, and venue',
                      'Clear venue photo',
                      'Attendee list with names and ages (CSV preferred, or image)',
                    ].map((text) => (
                      <li key={text} className="flex items-start gap-3">
                        <CheckCircle2 size={16} className="mt-0.5 flex-none" style={{ color: primaryColor }} />
                        <span>{text}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-6 rounded-xl border border-white/80 bg-white/65 p-4">
                    <div className="flex items-start gap-3">
                      <Smartphone size={19} className="mt-0.5 flex-none" style={{ color: primaryColor }} />
                      <div>
                        <h3 className="text-[15px] font-bold text-slate-900">Want to donate too?</h3>
                        <p className="mt-1.5 text-sm leading-5 text-slate-700">
                          A host application does not register you as a donor. After approval, register separately in the Donivra mobile app. Join public programs from the Events list; use the private code for private programs.
                        </p>
                        <a href={MOBILE_APP_APK_URL} download className="mt-3 inline-flex items-center gap-2 text-sm font-bold hover:underline" style={{ color: primaryColor }}>
                          <Download size={14} /> Download the Donivra app
                        </a>
                      </div>
                    </div>
                  </div>
                    </div>
                  ) : (
                <section className="mt-6" role="tabpanel">
                  <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: primaryColor }}>Eligibility requirements</p>
                  <h3 className="mt-2 text-xl font-bold text-slate-900">Donation rules</h3>

                  {isLoadingWigRequirements ? (
                    <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                      <Loader2 size={14} className="animate-spin" /> Loading current requirements...
                    </p>
                  ) : wigRequirementsError || !wigRequirements ? (
                    <p className="mt-4 text-sm leading-5 text-rose-700">{wigRequirementsError || 'Current hair requirements are unavailable.'}</p>
                  ) : (
                    <div className="mt-5 space-y-6">
                      <dl className="grid grid-cols-2 divide-x divide-slate-200">
                        <div className="pr-6">
                          <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Minimum hair length</dt>
                          <dd className="mt-1 text-lg font-bold text-slate-900">
                            {wigRequirements.Minimum_Hair_Length == null
                              ? 'Not specified'
                              : `${Number(wigRequirements.Minimum_Hair_Length).toLocaleString()} ${Number(wigRequirements.Minimum_Hair_Length) === 1 ? 'inch' : 'inches'}`}
                          </dd>
                        </div>
                        <div className="pl-6">
                          <dt className="text-xs font-bold uppercase tracking-wide text-slate-500">Required donors</dt>
                          <dd className="mt-1 text-lg font-bold text-slate-900">{minimumRequiredDonors || 'Not specified'}</dd>
                          <p className="mt-1 text-xs text-slate-500">Minimum needed for a program</p>
                        </div>
                      </dl>

                      <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Not accepted</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {HAIR_TREATMENT_REQUIREMENTS.filter((requirement) => !wigRequirements[requirement.key]).map((requirement) => (
                            <span key={requirement.key} className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700">
                              <X size={11} /> {requirement.label}
                            </span>
                          ))}
                          {HAIR_TREATMENT_REQUIREMENTS.every((requirement) => wigRequirements[requirement.key]) && (
                            <span className="text-xs text-slate-600">No listed treatments are rejected.</span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Accepted hair patterns</p>
                        <p className="mt-1.5 text-[15px] leading-5 text-slate-700">{wigRequirements.Hair_Texture_Status || 'No restriction'}</p>
                      </div>
                    </div>
                  )}
                </section>
                  )}
                </div>

                <div className="mt-7 border-t border-[#e5d3cd] pt-6 lg:mt-auto">
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <div><p className="text-sm font-bold text-slate-900">Step 1 of {APPLICATION_STEPS.length}</p><p className="mt-0.5 text-sm text-slate-600">Application overview</p></div>
                    <span className="text-sm font-bold" style={{ color: primaryColor }}>{Math.round(100 / APPLICATION_STEPS.length)}%</span>
                  </div>
                  <div className="mb-5 h-2.5 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full" style={{ width: `${100 / APPLICATION_STEPS.length}%`, backgroundColor: primaryColor }} />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setErrorMessage('');
                      setApplicationStage('terms');
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-bold text-white shadow-sm hover:brightness-95"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Review Terms & Conditions
                    <ChevronRight size={17} />
                  </button>
                </div>
              </aside>
            </div>
          </main>
        </div>
      </React.Fragment>
    );
  }

  if (applicationStage === 'terms') {
    return (
      <React.Fragment>
        <div className="flex min-h-screen justify-center bg-slate-50 px-4 py-5 md:px-8">
          <main className="my-auto w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10">
            <div className="grid lg:grid-cols-[0.38fr_0.62fr]">
              <section className="flex flex-col border-b border-[#eadbd6] bg-[#fbf7f5] p-7 sm:p-9 lg:border-b-0 lg:border-r lg:p-10">
            <button
              type="button"
              onClick={handleDeclineTerms}
              className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft size={16} />
              About This Application
            </button>

            <p className="mt-10 text-xs font-bold uppercase tracking-[0.18em]" style={{ color: primaryColor }}>
              Step 2 of {APPLICATION_STEPS.length} · Terms & Conditions
            </p>
            <h1 className="mt-3 text-3xl font-bold leading-tight text-slate-900">Terms &amp; Conditions</h1>
            <p className="mt-4 text-[15px] leading-6 text-slate-600">Review the official program terms before entering your application details.</p>

            <div className="mt-8 border-t border-[#e5d3cd] pt-6">
              <h2 className="text-base font-bold text-slate-900">Three quick steps</h2>
              <ol className="mt-4 space-y-4 text-[15px] leading-5 text-slate-700">
                {['Read the complete PDF', 'Confirm your agreement', 'Continue to applicant details'].map((item, index) => (
                  <li key={item} className="flex items-center gap-3">
                    <span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: primaryColor }}>{index + 1}</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="mt-8 lg:mt-auto lg:pt-8">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-700">Application progress</span>
                <span className="font-bold" style={{ color: primaryColor }}>{Math.round((2 / APPLICATION_STEPS.length) * 100)}%</span>
              </div>
              <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-white">
                <div className="h-full rounded-full" style={{ width: `${(2 / APPLICATION_STEPS.length) * 100}%`, backgroundColor: primaryColor }} />
              </div>
            </div>
          </section>

          <section className="p-7 sm:p-9 lg:p-10">
            <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: primaryColor }}>Official document</p>
            <h2 className="mt-2 text-2xl font-bold text-slate-900">Program application terms</h2>
            <p className="mt-2 text-[15px] leading-6 text-slate-600">Read all pages, then confirm your agreement below.</p>

            <div className="mt-5">
            <LegalTermsGate
              title="Program Application Terms and Conditions"
              description="Review the active Program Application Terms PDF before entering your application details."
              {...eventTerms}
              checked={hasConfirmedTerms}
              onCheckedChange={(checked) => {
                setHasConfirmedTerms(checked);
                if (checked) setErrorMessage('');
              }}
              onReload={eventTerms.reload}
              accentColor={primaryColor}
              showHeader={false}
              previewClassName="h-[min(48vh,430px)] min-h-[300px]"
            />
            </div>

            {errorMessage ? (
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {errorMessage}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleDeclineTerms}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleAcceptTerms}
                className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white shadow-sm hover:brightness-95"
                style={{ backgroundColor: primaryColor }}
              >
                Accept and Continue
                <ChevronRight size={17} />
              </button>
            </div>
          </section>
            </div>
          </main>
        </div>
      </React.Fragment>
    );
  }

  return (
    <React.Fragment>
      <div className="min-h-screen bg-gradient-to-b from-slate-100 to-slate-50 px-4 py-8 md:px-8">
      <div className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white/95 p-6 shadow-lg backdrop-blur md:p-8">
        <button
          type="button"
          onClick={currentStep > 1 ? goPreviousStep : () => {
            setHasAcceptedTerms(false);
            setApplicationStage('terms');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="mb-5 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
        >
          <ArrowLeft size={16} />
          {currentStep > 1 ? 'Previous Step' : 'Review Terms'}
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

        <nav aria-label="Application progress" className="sticky top-3 z-30 mt-5 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-md backdrop-blur md:p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                Step {currentStep + 2} of {APPLICATION_STEPS.length}
              </p>
              <p className="mt-0.5 text-sm font-bold text-slate-900">
                {FORM_STEPS[currentStep - 1].title}
                <span className="ml-1.5 font-normal text-slate-500">{FORM_STEPS[currentStep - 1].description}</span>
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              {Math.round(((currentStep + 2) / APPLICATION_STEPS.length) * 100)}%
            </span>
          </div>

          <ol className="mt-3 grid grid-cols-5 gap-1.5">
            {APPLICATION_STEPS.map((step) => {
              const activeApplicationStep = currentStep + 2;
              const isActive = activeApplicationStep === step.id;
              const isComplete = activeApplicationStep > step.id;
              return (
                <li key={step.id} aria-current={isActive ? 'step' : undefined}>
                  <div
                    className={`h-1.5 rounded-full transition-colors ${isActive || isComplete ? '' : 'bg-slate-200'}`}
                    style={isActive || isComplete ? { backgroundColor: primaryColor } : undefined}
                  />
                  <div className={`mt-1.5 flex items-center gap-1.5 text-xs ${isActive ? 'font-bold text-slate-900' : isComplete ? 'font-semibold text-slate-600' : 'text-slate-400'}`}>
                    <span
                      className={`inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[10px] ${isActive || isComplete ? 'text-white' : 'border-slate-200 bg-white'}`}
                      style={isActive || isComplete ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined}
                    >
                      {isComplete ? <CheckCircle2 size={12} /> : step.id}
                    </span>
                    <span className="truncate">{step.title}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </nav>

        <details className="group mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <span
              className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg text-white"
              style={{ backgroundColor: primaryColor }}
            >
              <ShieldCheck size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-slate-900">Program donation requirements</h2>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {isLoadingWigRequirements
                  ? 'Loading current requirements...'
                  : wigRequirementsError
                    ? wigRequirementsError
                    : `${wigRequirements.Minimum_Number_Donor ?? '—'} required donors · ${wigRequirements.Minimum_Hair_Length ?? '—'}-inch minimum hair length`}
              </p>
            </div>
            <span className="flex-none text-xs font-semibold text-slate-500 group-open:hidden">View</span>
            <span className="hidden flex-none text-xs font-semibold text-slate-500 group-open:inline">Hide</span>
          </summary>

          {isLoadingWigRequirements ? (
            <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-4 text-sm text-slate-600">
              <Loader2 size={16} className="animate-spin" />
              Loading current requirements...
            </div>
          ) : wigRequirementsError ? (
            <div className="border-t border-slate-100 px-4 py-3 text-sm text-amber-800">
              {wigRequirementsError}
            </div>
          ) : (
            <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    <Users size={13} />
                    Required donors
                  </p>
                  <p className="mt-1 text-base font-bold text-slate-900">
                    {wigRequirements.Minimum_Number_Donor ?? 'Not specified'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">Minimum needed for the program</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    <Ruler size={13} />
                    Hair length
                  </p>
                  <p className="mt-1 text-base font-bold text-slate-900">
                    {wigRequirements.Minimum_Hair_Length === null
                      || wigRequirements.Minimum_Hair_Length === undefined
                      ? 'Not specified'
                      : `${Number(wigRequirements.Minimum_Hair_Length).toLocaleString()} ${Number(wigRequirements.Minimum_Hair_Length) === 1 ? 'inch' : 'inches'}`}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">Measured before donation</p>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Treatment history</p>
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  {HAIR_TREATMENT_REQUIREMENTS.map((requirement) => {
                    const isAllowed = Boolean(wigRequirements[requirement.key]);
                    return (
                      <div
                        key={requirement.key}
                        className={`flex items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-xs ${
                          isAllowed
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-200 text-slate-600'
                        }`}
                      >
                        <span className="font-medium">{requirement.label}</span>
                        <span className="inline-flex items-center gap-1 font-bold">
                          {isAllowed ? <CheckCircle2 size={13} /> : <X size={13} />}
                          {isAllowed ? 'Accepted' : 'Not accepted'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Accepted hair patterns</p>
                  <p className="mt-1 text-xs leading-5 text-slate-700">
                    {wigRequirements.Hair_Texture_Status || 'No hair pattern restriction specified'}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Additional guidance</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-700">
                    {wigRequirements.Notes || 'No additional notes provided'}
                  </p>
                </div>
              </div>
            </div>
          )}
        </details>

        <form onSubmit={(event) => event.preventDefault()} className="mt-4">
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
                      The secure verification checks the ID and fills only the name, birthdate, ID number, gender, and address when available.
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
                <span className="text-sm font-medium text-slate-700">Birthdate *</span>
                <input ref={setFieldRef('applicantBirthdate')} type="date" max={getAdultBirthdateMax()} value={form.applicantBirthdate} onChange={updateField('applicantBirthdate')} className={getFieldInputClassName('applicantBirthdate')} style={{ '--tw-ring-color': primaryColor }} />
                {fieldError('applicantBirthdate')}
                <span className="text-xs text-slate-500">The applicant must be at least 18 years old.</span>
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
              <fieldset className="flex flex-col gap-2 md:col-span-2">
                <legend className="text-sm font-medium text-slate-700">Program Visibility *</legend>
                <div
                  ref={setFieldRef('eventVisibility')}
                  tabIndex={-1}
                  role="radiogroup"
                  aria-label="Program visibility"
                  aria-invalid={Boolean(fieldErrors.eventVisibility)}
                  className={`grid gap-3 rounded-xl outline-none sm:grid-cols-2 ${fieldErrors.eventVisibility ? 'ring-2 ring-rose-300' : ''}`}
                >
                  {[
                    {
                      value: 'Public',
                      title: 'Public Program',
                      description: 'Listed publicly so eligible donors and visitors can find and register for it.',
                    },
                    {
                      value: 'Private',
                      title: 'Private Program',
                      description: 'Limited to people who receive the private access code after approval.',
                    },
                  ].map((option) => {
                    const isSelected = form.eventVisibility === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => {
                          setForm((previous) => ({ ...previous, eventVisibility: option.value }));
                          setFieldErrors((previous) => {
                            if (!previous.eventVisibility) return previous;
                            const next = { ...previous };
                            delete next.eventVisibility;
                            return next;
                          });
                        }}
                        className={`rounded-xl border-2 p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-offset-2 ${isSelected ? 'bg-slate-50 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                        style={isSelected ? { borderColor: primaryColor, '--tw-ring-color': primaryColor } : { '--tw-ring-color': primaryColor }}
                      >
                        <span className="flex items-center justify-between gap-3">
                          <span className="text-sm font-bold text-slate-900">{option.title}</span>
                          <span
                            className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${isSelected ? 'text-white' : 'border-slate-300 bg-white text-transparent'}`}
                            style={isSelected ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined}
                          >
                            <CheckCircle2 size={13} />
                          </span>
                        </span>
                        <span className="mt-2 block text-xs leading-5 text-slate-600">{option.description}</span>
                      </button>
                    );
                  })}
                </div>
                {fieldError('eventVisibility')}
              </fieldset>

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

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-slate-700">
                  <span>Expected Attendees *</span>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                    Minimum {minimumExpectedAttendees}
                  </span>
                </span>
                <input
                  ref={setFieldRef('expectedAttendees')}
                  type="number"
                  inputMode="numeric"
                  min={minimumExpectedAttendees}
                  max={MAX_EXPECTED_ATTENDEES}
                  step="1"
                  value={form.expectedAttendees}
                  onChange={updateField('expectedAttendees')}
                  aria-describedby="expected-attendees-requirement"
                  aria-invalid={Boolean(fieldErrors.expectedAttendees) || isExpectedAttendeesBelowMinimum}
                  className={getFieldInputClassName('expectedAttendees')}
                  style={{ '--tw-ring-color': primaryColor }}
                />
                {fieldError('expectedAttendees')}
                {isExpectedAttendeesBelowMinimum && !fieldErrors.expectedAttendees && (
                  <span role="alert" className="text-xs font-bold text-rose-700">
                    Too low: enter at least {minimumExpectedAttendees} expected attendees.
                  </span>
                )}
                <span id="expected-attendees-requirement" className="text-xs text-slate-500">
                  {minimumRequiredDonors
                    ? `Enter at least ${minimumExpectedAttendees} attendees and check that enough people can meet the required donor count.`
                    : 'Enter the expected attendance as a whole number greater than zero.'}
                </span>
              </label>

              <section
                ref={setFieldRef('attendeeListPdf')}
                className={`md:col-span-2 rounded-xl border p-4 ${fieldErrors.attendeeListPdf ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-100' : 'border-slate-200 bg-slate-50/70'}`}
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-white text-slate-600 shadow-sm ring-1 ring-slate-200">
                      <FileText size={18} />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-slate-900">Attendee name list *</p>
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">CSV recommended</span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        Upload a CSV listing every expected attendee's full name and age. A clear image is also accepted. Maximum file size: 8 MB.
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}>
                      <Upload size={15} />
                      {attendeeListPdfFile ? 'Replace file' : 'Upload CSV'}
                      <input type="file" accept=".csv,text/csv,application/csv,image/*" onChange={handleAttendeeListPdfFileChange} className="sr-only" />
                    </label>
                    <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700">
                      <Camera size={15} />
                      Take photo
                      <input type="file" accept="image/*" capture="environment" onChange={handleAttendeeListPdfFileChange} className="sr-only" />
                    </label>
                  </div>
                </div>

                {attendeeListPdfFile && (
                  <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-slate-900" title={attendeeListPdfFile.name}>{attendeeListPdfFile.name}</p>
                        <p className="text-[11px] text-slate-500">{(attendeeListPdfFile.size / (1024 * 1024)).toFixed(2)} MB · Ready to upload</p>
                      </div>
                      <CheckCircle2 size={17} className="flex-none text-emerald-600" />
                    </div>
                    {attendeeListPreviewUrl && getAttendeeListFileKind(attendeeListPdfFile) === 'image' && (
                      <img src={attendeeListPreviewUrl} alt="Attendee name list preview" className="max-h-80 w-full bg-slate-100 object-contain" />
                    )}
                    {attendeeListPreviewUrl && getAttendeeListFileKind(attendeeListPdfFile) === 'csv' && (
                      <div className="flex items-center justify-between gap-3 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                        <span>CSV selected — recommended format</span>
                        <a href={attendeeListPreviewUrl} target="_blank" rel="noreferrer" className="font-bold hover:underline" style={{ color: primaryColor }}>Preview CSV</a>
                      </div>
                    )}
                  </div>
                )}
                {fieldError('attendeeListPdf')}
              </section>

              <section className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">Program schedule</h2>
                    <p className="mt-0.5 text-xs text-slate-500">
                      UTC+8 · 7-day notice · Earliest available date: <span className="font-semibold text-slate-700">{minimumProgramDateLabel}</span>
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Live availability
                  </span>
                </div>

                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-bold">One application per date.</span> Pending and approved dates remain unavailable until staff rejects the application.
                  {isLoadingProgramDates && <span> Checking availability...</span>}
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.7fr)]">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-semibold text-slate-700">Program Date *</span>
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
                  </label>

                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-semibold text-slate-700">Start Time *</span>
                    <input
                      ref={setFieldRef('proposedStartTime')}
                      type="time"
                      value={form.proposedStartTime}
                      onChange={updateScheduleField('proposedStartTime')}
                      max="23:58"
                      step="60"
                      disabled={!form.proposedDate}
                      aria-invalid={Boolean(fieldErrors.proposedStartTime)}
                      className={getFieldInputClassName('proposedStartTime', 'disabled:cursor-not-allowed disabled:bg-slate-100')}
                      style={{ '--tw-ring-color': primaryColor }}
                    />
                    {fieldError('proposedStartTime')}
                  </label>

                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-semibold text-slate-700">End Time *</span>
                    <input
                      ref={setFieldRef('proposedEndTime')}
                      type="time"
                      value={form.proposedEndTime}
                      onChange={updateScheduleField('proposedEndTime')}
                      min={minimumProgramEndTime || undefined}
                      step="60"
                      disabled={!form.proposedDate || !form.proposedStartTime || !minimumProgramEndTime}
                      aria-invalid={Boolean(fieldErrors.proposedEndTime)}
                      className={getFieldInputClassName('proposedEndTime', 'disabled:cursor-not-allowed disabled:bg-slate-100')}
                      style={{ '--tw-ring-color': primaryColor }}
                    />
                    {fieldError('proposedEndTime')}
                  </label>
                </div>

                {!isLoadingProgramDates && unavailableProgramDates.length > 0 && (
                  <p className="mt-2 truncate text-[11px] text-slate-500" title={unavailableProgramDates.join(', ')}>
                    Reserved dates: {unavailableProgramDates.slice(0, 8).join(', ')}{unavailableProgramDates.length > 8 ? ` +${unavailableProgramDates.length - 8} more` : ''}
                  </p>
                )}
              </section>

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
                        <Upload size={16} /> Upload from Device
                        <input type="file" accept="image/*" onChange={handleEventPlacePhotoFileChange} className="sr-only" />
                      </label>
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
                        <Camera size={16} /> Take Photo on Phone
                        <input type="file" accept="image/*" capture="environment" onChange={handleEventPlacePhotoFileChange} className="sr-only" />
                      </label>
                    </div>
                    {eventPlacePhotoFile && <span className="text-xs text-emerald-700">Selected: {eventPlacePhotoFile.name}</span>}
                    {fieldError('eventPlacePhoto')}
                    <span className="text-xs text-slate-500">
                      On a laptop, upload an existing image from your files. On a phone, you can upload an image or take a new one. Exactly one venue/place image is required; choosing another replaces it.
                    </span>
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
            <div className="md:col-span-2 space-y-5">
              <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Review your application</h2>
                  <p className="mt-1 text-sm text-slate-500">Check the important details before submitting.</p>
                </div>
                <span className="w-fit rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: `${primaryColor}12`, color: primaryColor }}>
                  Ready for confirmation
                </span>
              </header>

              <div className="grid items-start gap-4 lg:grid-cols-[1.05fr_0.95fr]">
                <div className="space-y-4">
                  <section className="rounded-xl border border-slate-200 bg-white p-4">
                    <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Applicant</h3>
                    <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4">
                      <div className="col-span-2">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Full name</dt>
                        <dd className="mt-1 text-sm font-semibold text-slate-900">{[form.applicantFirstName, form.applicantMiddleName, form.applicantLastName].filter(Boolean).join(' ') || 'N/A'}</dd>
                      </div>
                      {[
                        ['Birthdate', form.applicantBirthdate || 'N/A'],
                        ['Gender', form.applicantGender || 'N/A'],
                        ['ID type', PH_VALID_ID_OPTIONS.find((option) => option.value === form.applicantValidIdType)?.label || 'N/A'],
                        ['ID status', isDiditVerified ? 'Approved' : diditStatus],
                        ['Email', form.applicantEmail || 'N/A'],
                        ['Phone', form.applicantContactNumber || 'N/A'],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</dt>
                          <dd className="mt-1 break-words text-sm text-slate-700">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="mt-4 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-600">
                      <p><span className="font-semibold text-slate-800">ID number:</span> {form.applicantIdDocumentNumber || 'N/A'}</p>
                      <p className="mt-1"><span className="font-semibold text-slate-800">Address on ID:</span> {form.applicantIdAddress || 'N/A'}</p>
                      <p className="mt-1"><span className="font-semibold text-slate-800">Preferred contact:</span> {normalizePreferredContactLabel(form.preferredContactMethod)}</p>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Program</p>
                        <h3 className="mt-1 text-lg font-bold text-slate-900">{form.eventName || 'Untitled program'}</h3>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{normalizeEventVisibility(form.eventVisibility)}</span>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-slate-100 pt-4">
                      <div>
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Expected attendees</dt>
                        <dd className="mt-1 text-lg font-bold text-slate-900">{form.expectedAttendees || 'N/A'}</dd>
                        {attendeeListPreviewUrl && (
                          <a href={attendeeListPreviewUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold hover:underline" style={{ color: primaryColor }}>
                            <FileText size={13} /> View attendee name list
                          </a>
                        )}
                      </div>
                      <div>
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Venue</dt>
                        <dd className="mt-1 text-sm font-semibold text-slate-800">{form.venueName || 'N/A'}</dd>
                      </div>
                    </dl>
                    <div className="mt-4 border-t border-slate-100 pt-4">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Overview</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{form.eventOverview || 'N/A'}</p>
                    </div>
                  </section>
                </div>

                <div className="space-y-4">
                  <section className="rounded-xl border border-slate-200 bg-white p-4">
                    <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Schedule and location</h3>
                    <div className="mt-4 space-y-3 text-sm text-slate-700">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Schedule (UTC+8)</p>
                        <p className="mt-1 font-semibold text-slate-900">{formatUtc8DateTimeDisplay(form.proposedStartAt)}</p>
                        <p className="text-xs text-slate-500">until {formatUtc8DateTimeDisplay(form.proposedEndAt)}</p>
                      </div>
                      <div className="border-t border-slate-100 pt-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Complete address</p>
                        <p className="mt-1 leading-5">{[form.street, form.barangay, form.city, form.province, form.region, form.country].filter(Boolean).join(', ') || 'N/A'}</p>
                      </div>
                    </div>
                    <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                      {form.latitude && form.longitude ? (
                        <iframe
                          title="Pinned map location preview"
                          src={`https://maps.google.com/maps?q=${encodeURIComponent(`${form.latitude},${form.longitude}`)}&z=16&output=embed`}
                          className="h-48 w-full border-0 bg-white"
                          loading="lazy"
                          referrerPolicy="no-referrer-when-downgrade"
                        />
                      ) : (
                        <div className="flex h-48 items-center justify-center text-xs text-slate-500">No pinned location yet.</div>
                      )}
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-white p-4">
                    <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Photos</h3>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {[
                        { label: 'Verified ID', url: verifiedIdPreviewUrl },
                        { label: 'Venue', url: eventPlacePhotoPreviewUrl },
                        { label: 'Poster', url: eventPosterPhotoPreviewUrl },
                      ].map((item) => (
                        <div key={item.label} className="min-w-0">
                          {item.url ? (
                            <img src={item.url} alt={`${item.label} preview`} className="aspect-square w-full rounded-lg bg-slate-100 object-contain" />
                          ) : (
                            <div className="flex aspect-square w-full items-center justify-center rounded-lg bg-slate-100 px-2 text-center text-[10px] text-slate-400">Not provided</div>
                          )}
                          <p className="mt-1.5 truncate text-center text-[10px] font-semibold text-slate-500">{item.label}</p>
                        </div>
                      ))}
                    </div>
                    {!verifiedIdPreviewUrl && (
                      <button type="button" onClick={() => checkDiditStatus()} disabled={isCheckingDiditStatus} className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-60">
                        {isCheckingDiditStatus && <Loader2 size={13} className="animate-spin" />}
                        Refresh ID preview
                      </button>
                    )}
                  </section>
                </div>
              </div>

              <p className="rounded-lg bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                Nothing has been submitted yet. Use Previous to correct anything, or continue to the final confirmation.
              </p>
            </div>
          )}

          </div>

          <div className="mt-3 flex justify-end">
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
                  disabled={isSubmitting}
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

      {isSubmitConfirmationOpen && createPortal((
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
            className="flex h-[min(90vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            style={{ backgroundColor: '#ffffff' }}
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

            <div ref={submitConfirmationScrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-white px-5 py-4 sm:px-6">
              <ConfirmationSection title="Applicant and verification">
                <ConfirmationItem
                  label="Full name"
                  value={[form.applicantFirstName, form.applicantMiddleName, form.applicantLastName].filter(Boolean).join(' ')}
                />
                <ConfirmationItem label="Birthdate" value={form.applicantBirthdate} />
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
                <ConfirmationItem
                  label="Expected attendees"
                  value={(
                    <div>
                      <p>{form.expectedAttendees || 'N/A'}</p>
                      {attendeeListPreviewUrl && (
                        <a href={attendeeListPreviewUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold hover:underline" style={{ color: primaryColor }}>
                          <FileText size={13} /> View attendee name list
                        </a>
                      )}
                    </div>
                  )}
                />
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

              <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3">
                  <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-700">Submitted images</h3>
                  <p className="mt-1 text-xs text-slate-500">Check that each image is clear and belongs to this application.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <article className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-100 px-3 py-2.5">
                      <p className="text-xs font-bold text-slate-800">Government ID</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">Secure verified identity image</p>
                    </div>
                    {verifiedIdPreviewUrl ? (
                      <img
                        src={verifiedIdPreviewUrl}
                        alt="Verified government ID"
                        onError={() => setVerifiedIdPreviewUrl('')}
                        className="h-44 w-full bg-slate-100 object-contain"
                      />
                    ) : (
                      <div className="flex h-44 flex-col items-center justify-center gap-2 bg-amber-50 px-4 text-center">
                        <p className="text-xs font-semibold text-amber-900">Secure preview is not available yet.</p>
                        <button
                          type="button"
                          onClick={() => checkDiditStatus()}
                          disabled={isCheckingDiditStatus}
                          className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                        >
                          {isCheckingDiditStatus && <Loader2 size={13} className="animate-spin" />}
                          Refresh preview
                        </button>
                      </div>
                    )}
                  </article>

                  <article className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-100 px-3 py-2.5">
                      <p className="text-xs font-bold text-slate-800">Venue photo</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500" title={eventPlacePhotoFile?.name}>{eventPlacePhotoFile?.name || 'Selected venue photo'}</p>
                    </div>
                    {eventPlacePhotoPreviewUrl ? (
                      <img src={eventPlacePhotoPreviewUrl} alt="Program venue" className="h-44 w-full bg-slate-100 object-contain" />
                    ) : (
                      <div className="flex h-44 items-center justify-center bg-slate-100 px-4 text-center text-xs text-slate-500">Preview unavailable</div>
                    )}
                  </article>

                  <article className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="border-b border-slate-100 px-3 py-2.5">
                      <p className="text-xs font-bold text-slate-800">Program poster</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500" title={eventPosterPhotoFile?.name}>{eventPosterPhotoFile?.name || 'Optional poster not provided'}</p>
                    </div>
                    {eventPosterPhotoPreviewUrl ? (
                      <img src={eventPosterPhotoPreviewUrl} alt="Program poster" className="h-44 w-full bg-slate-100 object-contain" />
                    ) : (
                      <div className="flex h-44 items-center justify-center bg-slate-100 px-4 text-center text-xs text-slate-500">No poster attached</div>
                    )}
                  </article>
                </div>
              </section>

              <div className="flex items-start gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-700">
                <Smartphone size={18} className="mt-0.5 flex-none" style={{ color: primaryColor }} />
                <p>
                  <span className="font-bold text-slate-900">Donating is a separate registration.</span>{' '}
                  If you want to donate, use the Donivra mobile app after approval. Join a public program from the Events list or enter the private code for a private program.
                </p>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
                Nothing has been submitted yet. Review the information above, then submit the application when everything is correct.
              </div>
            </div>

            <div className="flex flex-none flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setIsSubmitConfirmationOpen(false)}
                disabled={isSubmitting}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                Back to edit
              </button>
              <button
                type="button"
                onClick={() => handleSubmit(null, true)}
                disabled={isSubmitting}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: primaryColor }}
              >
                {isSubmitting && <Loader2 size={15} className="animate-spin" />}
                {isSubmitting ? 'Submitting...' : 'Submit application'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}

      {isDiditModalOpen && diditSession?.verificationUrl && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[10020] m-0 flex h-[100dvh] w-screen items-center justify-center bg-slate-950/70 p-2 md:p-5">
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
        </div>,
        document.body,
      )}
    </div>
    </React.Fragment>
  );
}

