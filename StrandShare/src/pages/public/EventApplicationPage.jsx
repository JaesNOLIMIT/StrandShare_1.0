import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, MailCheck, Search, ShieldCheck } from 'lucide-react';
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
  { value: 'phone_call', label: 'Phone Call' },
  { value: 'sms', label: 'SMS' },
  { value: 'messenger', label: 'Messenger' },
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
  { id: 1, title: 'Applicant Details' },
  { id: 2, title: 'Event + Venue' },
  { id: 3, title: 'Full Confirmation' },
  { id: 4, title: 'Verify Email' },
];
const TERMS_AND_AGREEMENT_PDF_PATH = '/legal/donivra-terms-and-agreement.pdf';

const INITIAL_FORM = {
  applicantValidIdType: 'philsys',
  applicantFirstName: '',
  applicantMiddleName: '',
  applicantLastName: '',
  applicantEmail: '',
  applicantGender: '',
  applicantContactNumber: '',
  preferredContactMethod: 'email',
  preferredContactDetail: '',
  eventVisibility: 'Public',
  eventName: '',
  venueName: '',
  expectedAttendees: '',
  eventOverview: '',
  proposedStartAt: '',
  proposedEndAt: '',
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

function toUtc8DateTimeLocalValue(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const utc8 = toUtc8ShiftedDate(date);
  return `${utc8.getUTCFullYear()}-${pad(utc8.getUTCMonth() + 1)}-${pad(utc8.getUTCDate())}T${pad(utc8.getUTCHours())}:${pad(utc8.getUTCMinutes())}`;
}

function getMinimumProposedStartLocalValue() {
  const utc8Now = toUtc8ShiftedDate(new Date());
  utc8Now.setUTCSeconds(0, 0);
  utc8Now.setUTCDate(utc8Now.getUTCDate() + 7);
  return toUtc8DateTimeLocalValue(utc8Now);
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
    return 'Event application upload bucket is missing. Run migration 068_refactor_event_application_form_schema.sql.';
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

  return message || 'Unable to submit event application.';
}

function normalizePreferredContactLabel(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'phonecall' || key === 'phone' || key === 'call') return 'Phone Call';
  if (key === 'messenger') return 'Messenger';
  if (key === 'sms') return 'SMS';
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
  const method = normalizePreferredContactLabel(value);
  return method === 'SMS' || method === 'Phone Call';
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
            placeholder="Search address, barangay, city, or event location"
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
      <p className="text-xs text-slate-500">Click map to pin exact event location.</p>
    </div>
  );
}

export default function EventApplicationPage() {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';

  const [form, setForm] = useState(INITIAL_FORM);
  const [validIdFile, setValidIdFile] = useState(null);
  const [eventPlacePhotoFile, setEventPlacePhotoFile] = useState(null);
  const [eventPosterPhotoFile, setEventPosterPhotoFile] = useState(null);
  const [validIdPreviewUrl, setValidIdPreviewUrl] = useState('');
  const [eventPlacePhotoPreviewUrl, setEventPlacePhotoPreviewUrl] = useState('');
  const [eventPosterPhotoPreviewUrl, setEventPosterPhotoPreviewUrl] = useState('');
  const [currentStep, setCurrentStep] = useState(1);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [hasConfirmedTerms, setHasConfirmedTerms] = useState(false);
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
      setFieldErrors({ [fieldKey]: true });
      focusField(fieldKey);
    } else {
      setFieldErrors({});
    }
    setErrorMessage(message || 'Please review the required fields.');
  }, [focusField]);

  useEffect(() => {
    if (!validIdFile) {
      setValidIdPreviewUrl('');
      return undefined;
    }

    if (!String(validIdFile.type || '').toLowerCase().startsWith('image/')) {
      setValidIdPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(validIdFile);
    setValidIdPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [validIdFile]);

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

  const preferredContactDetailPlaceholder = useMemo(() => {
    const method = normalizePreferredContactLabel(form.preferredContactMethod);
    if (method === 'Messenger') return 'Enter Messenger profile link or name';
    if (method === 'SMS' || method === 'Phone Call') return '+63 912 345 6789';
    return 'Enter active email address';
  }, [form.preferredContactMethod]);

  const preferredContactMethodLabel = useMemo(
    () => normalizePreferredContactLabel(form.preferredContactMethod),
    [form.preferredContactMethod],
  );

  const isPreferredContactAutoLinked = useMemo(
    () => ['Email', 'SMS', 'Phone Call'].includes(preferredContactMethodLabel),
    [preferredContactMethodLabel],
  );

  const preferredContactAutoHelper = useMemo(() => {
    if (preferredContactMethodLabel === 'Email') {
      return form.applicantEmail.trim()
        ? 'Auto-using Email field above.'
        : 'Will auto-use Email field above. Enter email first.';
    }
    if (preferredContactMethodLabel === 'SMS' || preferredContactMethodLabel === 'Phone Call') {
      return form.applicantContactNumber.trim()
        ? 'Auto-using Contact Number field above.'
        : 'Will auto-use Contact Number field above. Enter contact number first.';
    }
    return 'For Messenger, enter your profile link or name.';
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
      && (
        isPhoneContactMethod(form.preferredContactMethod)
          ? isValidPhilippineMobile(form.preferredContactDetail)
          : form.preferredContactDetail.trim()
      )
      && form.eventVisibility.trim()
      && form.eventName.trim()
      && form.venueName.trim()
      && form.eventOverview.trim()
      && form.expectedAttendees
      && Number(form.expectedAttendees) > 0
      && form.proposedStartAt.trim()
      && form.proposedEndAt.trim()
      && form.street.trim()
      && form.barangay.trim()
      && form.city.trim()
      && form.province.trim()
      && form.region.trim()
      && form.latitude.trim()
      && form.longitude.trim()
      && validIdFile,
    );
  }, [form, validIdFile]);

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
      if (!form.applicantValidIdType.trim()) return issue('applicantValidIdType', 'Please select your ID type.');
      if (!validIdFile) return issue('validIdFile', 'Upload your valid ID before continuing.');
      if (!form.applicantFirstName.trim()) return issue('applicantFirstName', 'First name is required.');
      if (!form.applicantLastName.trim()) return issue('applicantLastName', 'Last name is required.');
      if (!form.applicantEmail.trim()) return issue('applicantEmail', 'Email is required.');
      if (!isValidEmail(form.applicantEmail)) return issue('applicantEmail', 'Please enter a valid email address.');
      if (!form.applicantGender.trim()) return issue('applicantGender', 'Gender is required.');
      if (!form.applicantContactNumber.trim()) return issue('applicantContactNumber', 'Contact number is required.');
      if (!isValidPhilippineMobile(form.applicantContactNumber)) return issue('applicantContactNumber', 'Contact number must be in +63 912 345 6789 format.');
      if (!form.preferredContactMethod.trim()) return issue('preferredContactMethod', 'Preferred contact method is required.');
      if (!form.preferredContactDetail.trim()) return issue('preferredContactDetail', 'Preferred contact detail is required.');
      if (isPhoneContactMethod(form.preferredContactMethod) && !isValidPhilippineMobile(form.preferredContactDetail)) {
        return issue('preferredContactDetail', 'Preferred contact detail must be a valid +63 mobile number for SMS/Phone Call.');
      }
      return null;
    }

    if (stepNumber === 2) {
      if (!form.eventVisibility.trim()) return issue('eventVisibility', 'Event type is required.');
      if (!form.eventName.trim()) return issue('eventName', 'Event name is required.');
      if (!form.venueName.trim()) return issue('venueName', 'Venue name is required.');
      if (!form.eventOverview.trim()) return issue('eventOverview', 'Event overview is required.');
      if (!form.expectedAttendees || Number(form.expectedAttendees) <= 0) return issue('expectedAttendees', 'Expected attendees must be greater than zero.');
      if (!form.proposedStartAt.trim()) return issue('proposedStartAt', 'Proposed start is required.');
      if (!form.proposedEndAt.trim()) return issue('proposedEndAt', 'Proposed end is required.');
      if (!form.street.trim()) return issue('street', 'Street is required.');
      if (!form.barangay.trim()) return issue('barangay', 'Barangay is required.');
      if (!form.city.trim()) return issue('city', 'City/Municipality is required.');
      if (!form.province.trim()) return issue('province', 'Province is required.');
      if (!form.region.trim()) return issue('region', 'Region is required.');
      if (!form.latitude.trim() || !form.longitude.trim()) return issue('locationPin', 'Map pin location is required.');

      const minimumStart = parseUtc8DateTime(minimumProposedStartLocalValue);
      const proposedStart = parseUtc8DateTime(form.proposedStartAt);
      const proposedEnd = parseUtc8DateTime(form.proposedEndAt);

      if (!proposedStart || !proposedEnd) return issue('proposedStartAt', 'Proposed start and end are required.');
      if (minimumStart && proposedStart < minimumStart) return issue('proposedStartAt', 'Proposed start must be at least 7 days from today.');
      if (proposedEnd < proposedStart) return issue('proposedEndAt', 'Proposed end cannot be earlier than proposed start.');

      return null;
    }

    if (stepNumber === 3) {
      if (!canSubmit) return issue('eventName', 'Please complete all required fields before confirmation.');
      return null;
    }

    return null;
  }, [form, validIdFile, minimumProposedStartLocalValue, canSubmit]);

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

  const handleValidIdFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setFieldErrors((previous) => {
      if (!previous.validIdFile) return previous;
      const next = { ...previous };
      delete next.validIdFile;
      return next;
    });
    setErrorMessage('');
    setValidIdFile(file);
  };

  const handleEventPlacePhotoFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setErrorMessage('');
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
      setOtpNotice({ type: 'success', message: 'Email verified successfully. You can now submit your event application.' });
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

    if (key === 'preferredContactDetail' && isPhoneContactMethod(form.preferredContactMethod)) {
      nextValue = formatPhilippineMobileInput(nextValue);
    }

    if (key === 'preferredContactMethod') {
      nextValue = String(nextValue || '');
      const methodLabel = normalizePreferredContactLabel(nextValue);
      const autoDetail = methodLabel === 'Email'
        ? String(form.applicantEmail || '').trim()
        : (methodLabel === 'SMS' || methodLabel === 'Phone Call'
          ? formatPhilippineMobileInput(form.applicantContactNumber)
          : form.preferredContactDetail);

      setForm((previous) => ({
        ...previous,
        preferredContactMethod: nextValue,
        preferredContactDetail: autoDetail,
      }));
      setFieldErrors((previous) => {
        if (!previous.preferredContactMethod && !previous.preferredContactDetail) return previous;
        const next = { ...previous };
        delete next.preferredContactMethod;
        delete next.preferredContactDetail;
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

    setForm((previous) => {
      const nextForm = {
        ...previous,
        [key]: nextValue,
      };

      const methodLabel = normalizePreferredContactLabel(nextForm.preferredContactMethod);
      if (key === 'applicantEmail' && methodLabel === 'Email') {
        nextForm.preferredContactDetail = String(nextValue || '').trim();
      }
      if (key === 'applicantContactNumber' && (methodLabel === 'SMS' || methodLabel === 'Phone Call')) {
        nextForm.preferredContactDetail = formatPhilippineMobileInput(nextValue);
      }

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

    if (proposedEnd < proposedStart) {
      return 'Proposed end cannot be earlier than proposed start.';
    }

    return '';
  }, [form.proposedEndAt, form.proposedStartAt, minimumProposedStartLocalValue]);

  const handleSubmit = async (event) => {
    event.preventDefault();

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
      markFieldError('eventName', 'Please fill in all required fields and upload a valid ID before submitting.');
      return;
    }

    if (!isEmailOtpVerified || normalizedEmail !== verifiedEmail) {
      setCurrentStep(4);
      markFieldError('otpCode', 'Please verify your email with the 6-digit OTP before submitting.');
      return;
    }

    const scheduleError = validateSchedule();
    if (scheduleError) {
      setErrorMessage(scheduleError);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const validIdUpload = await uploadEventAsset(validIdFile, 'applicant-valid-ids');
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
        Applicant_Contact_Number: toStoredPhoneNumber(form.applicantContactNumber) || null,
        Applicant_Valid_ID_Type: form.applicantValidIdType.trim() || null,
        Preferred_Contact_Method: form.preferredContactMethod.trim(),
        Preferred_Contact_Detail: isPhoneContactMethod(form.preferredContactMethod)
          ? (toStoredPhoneNumber(form.preferredContactDetail) || null)
          : form.preferredContactDetail.trim(),
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
        Applicant_Valid_ID_Path: validIdUpload.path,
        Applicant_Valid_ID_URL: validIdUpload.url,
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
              Review and accept the Donivra Terms and Agreement before starting the event application.
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

        <h1 className="text-2xl font-bold text-slate-900 md:text-3xl">Event Application Form</h1>
        <p className="mt-2 text-sm text-slate-600">
          Any user can submit event details. Staff will review and contact you through your selected method.
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
          <div className="flex gap-2 overflow-x-auto pb-1 md:grid md:grid-cols-4 md:overflow-visible">
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

        <form onSubmit={handleSubmit} className="mt-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {currentStep === 1 && (
            <>
              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Valid ID Type (PH) *</span>
                <select
                  ref={setFieldRef('applicantValidIdType')}
                  value={form.applicantValidIdType}
                  onChange={updateField('applicantValidIdType')}
                  className={getFieldInputClassName('applicantValidIdType')}
                  style={{ '--tw-ring-color': primaryColor }}
                >
                  {PH_VALID_ID_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">Select the Philippine ID type you are submitting.</span>
              </label>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Applicant Valid ID *</span>
                <input
                  ref={setFieldRef('validIdFile')}
                  type="file"
                  accept="image/*,.pdf"
                  onChange={handleValidIdFileChange}
                  className={getFieldInputClassName('validIdFile', 'py-2')}
                />
                <span className="text-xs text-slate-500">Required proof of legitimacy.</span>
              </label>

              {validIdPreviewUrl && (
                <div className="md:col-span-2 rounded-xl border border-slate-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">ID Preview</p>
                  <img src={validIdPreviewUrl} alt="Valid ID preview" className="max-h-72 w-full rounded border border-slate-200 object-contain" />
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">First Name *</span>
                <input ref={setFieldRef('applicantFirstName')} type="text" value={form.applicantFirstName} onChange={updateField('applicantFirstName')} className={getFieldInputClassName('applicantFirstName')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Middle Name (optional)</span>
                <input ref={setFieldRef('applicantMiddleName')} type="text" value={form.applicantMiddleName} onChange={updateField('applicantMiddleName')} className={getFieldInputClassName('applicantMiddleName')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Last Name *</span>
                <input ref={setFieldRef('applicantLastName')} type="text" value={form.applicantLastName} onChange={updateField('applicantLastName')} className={getFieldInputClassName('applicantLastName')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Gender *</span>
                <select ref={setFieldRef('applicantGender')} value={form.applicantGender} onChange={updateField('applicantGender')} className={getFieldInputClassName('applicantGender')} style={{ '--tw-ring-color': primaryColor }}>
                  <option value="">Select gender</option>
                  {GENDER_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Email *</span>
                <input ref={setFieldRef('applicantEmail')} type="email" value={form.applicantEmail} onChange={updateField('applicantEmail')} className={getFieldInputClassName('applicantEmail')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Contact Number *</span>
                <input ref={setFieldRef('applicantContactNumber')} type="text" value={form.applicantContactNumber} onChange={updateField('applicantContactNumber')} placeholder="+63 912 345 6789" className={getFieldInputClassName('applicantContactNumber')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Preferred Contact Method *</span>
                <select ref={setFieldRef('preferredContactMethod')} value={form.preferredContactMethod} onChange={updateField('preferredContactMethod')} className={getFieldInputClassName('preferredContactMethod')} style={{ '--tw-ring-color': primaryColor }}>
                  {CONTACT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Preferred Contact Detail *</span>
                <input
                  ref={setFieldRef('preferredContactDetail')}
                  type="text"
                  value={form.preferredContactDetail}
                  onChange={updateField('preferredContactDetail')}
                  placeholder={preferredContactDetailPlaceholder}
                  className={getFieldInputClassName('preferredContactDetail')}
                  style={{ '--tw-ring-color': primaryColor }}
                  readOnly={isPreferredContactAutoLinked}
                />
                <span className="text-xs text-slate-500">{preferredContactAutoHelper}</span>
              </label>

              <div className="flex flex-col gap-2 md:col-span-2">
                <div>
                  <p className="text-sm font-medium text-slate-700">
                    Are you a member of an organization or more? Please input your social media below.
                  </p>
                  <p className="text-xs text-slate-500">Optional — used as the partner credit when admin publishes your event.</p>
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
                <span className="text-sm font-medium text-slate-700">Event Type *</span>
                <select ref={setFieldRef('eventVisibility')} value={form.eventVisibility} onChange={updateField('eventVisibility')} className={getFieldInputClassName('eventVisibility')} style={{ '--tw-ring-color': primaryColor }}>
                  <option value="Public">Public Event</option>
                  <option value="Private">Private Event</option>
                </select>
                <span className="text-xs text-slate-500">Private events receive a private access code after admin approval.</span>
              </label>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Event Name *</span>
                <input ref={setFieldRef('eventName')} type="text" value={form.eventName} onChange={updateField('eventName')} className={getFieldInputClassName('eventName')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Expected Attendees *</span>
                <input ref={setFieldRef('expectedAttendees')} type="number" min="1" value={form.expectedAttendees} onChange={updateField('expectedAttendees')} className={getFieldInputClassName('expectedAttendees')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Proposed Start (UTC+8) *</span>
                <input ref={setFieldRef('proposedStartAt')} type="datetime-local" value={form.proposedStartAt} onChange={updateField('proposedStartAt')} min={minimumProposedStartLocalValue} className={getFieldInputClassName('proposedStartAt')} style={{ '--tw-ring-color': primaryColor }} />
                <span className="text-xs text-slate-500">Minimum start: 7 days from today (UTC+8).</span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium text-slate-700">Proposed End (UTC+8) *</span>
                <input ref={setFieldRef('proposedEndAt')} type="datetime-local" value={form.proposedEndAt} onChange={updateField('proposedEndAt')} min={form.proposedStartAt || minimumProposedStartLocalValue} className={getFieldInputClassName('proposedEndAt')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Event Overview *</span>
                <textarea ref={setFieldRef('eventOverview')} value={form.eventOverview} onChange={updateField('eventOverview')} rows={4} className={getFieldInputClassName('eventOverview')} style={{ '--tw-ring-color': primaryColor }} />
              </label>

              <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-600">Venue Address *</h2>
                <p className="mt-1 text-xs text-slate-500">Choose address fields, then pin exact location on map.</p>

                <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-sm font-medium text-slate-700">Venue Name *</span>
                    <input ref={setFieldRef('venueName')} type="text" value={form.venueName} onChange={updateField('venueName')} className={getFieldInputClassName('venueName')} style={{ '--tw-ring-color': primaryColor }} />
                  </label>

                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-sm font-medium text-slate-700">Event Place Photo (optional)</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleEventPlacePhotoFileChange}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <span className="text-xs text-slate-500">Optional proof photo of the actual event venue/place.</span>
                  </label>

                  {eventPlacePhotoPreviewUrl && (
                    <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Event Place Photo Preview</p>
                      <img src={eventPlacePhotoPreviewUrl} alt="Event place preview" className="max-h-72 w-full rounded border border-slate-200 object-contain" />
                    </div>
                  )}

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Region *</span>
                    <select ref={setFieldRef('region')} value={form.region} onChange={handleRegionChange} className={getFieldInputClassName('region')} style={{ '--tw-ring-color': primaryColor }}>
                      <option value="">Select region</option>
                      {regionOptions.map((region) => <option key={region.name} value={region.name}>{region.name}</option>)}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Province *</span>
                    <select ref={setFieldRef('province')} value={form.province} onChange={handleProvinceChange} className={getFieldInputClassName('province')} style={{ '--tw-ring-color': primaryColor }} disabled={!form.region}>
                      <option value="">Select province</option>
                      {provinceOptions.map((province) => <option key={province.name} value={province.name}>{province.name}</option>)}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">City/Municipality *</span>
                    <select ref={setFieldRef('city')} value={form.city} onChange={handleCityChange} className={getFieldInputClassName('city')} style={{ '--tw-ring-color': primaryColor }} disabled={!form.province}>
                      <option value="">Select city/municipality</option>
                      {cityOptions.map((city) => <option key={city.name} value={city.name}>{city.name}</option>)}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Barangay *</span>
                    <select ref={setFieldRef('barangay')} value={form.barangay} onChange={updateField('barangay')} className={getFieldInputClassName('barangay')} style={{ '--tw-ring-color': primaryColor }} disabled={!form.city}>
                      <option value="">Select barangay</option>
                      {barangayOptions.map((barangay) => <option key={barangay} value={barangay}>{barangay}</option>)}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1 md:col-span-2">
                    <span className="text-sm font-medium text-slate-700">Street *</span>
                    <input ref={setFieldRef('street')} type="text" value={form.street} onChange={updateField('street')} className={getFieldInputClassName('street')} style={{ '--tw-ring-color': primaryColor }} />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Country</span>
                    <input type="text" value={form.country} onChange={updateField('country')} className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:ring-2" style={{ '--tw-ring-color': primaryColor }} />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium text-slate-700">Map Coordinates</span>
                    <input ref={setFieldRef('locationPin')} type="text" value={form.latitude && form.longitude ? `${form.latitude}, ${form.longitude}` : ''} onChange={() => {}} readOnly placeholder="Set by map pin" className={`rounded-lg border bg-slate-100 px-3 py-2.5 text-sm text-slate-600 ${fieldErrors.locationPin ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-300'}`} />
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

              <label className="flex flex-col gap-1 md:col-span-2">
                <span className="text-sm font-medium text-slate-700">Event Poster Photo (optional)</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleEventPosterPhotoFileChange}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <span className="text-xs text-slate-500">Optional image to use for event poster/publicity design.</span>
              </label>

              {eventPosterPhotoPreviewUrl && (
                <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Event Poster Photo Preview</p>
                  <img src={eventPosterPhotoPreviewUrl} alt="Event poster preview" className="max-h-72 w-full rounded border border-slate-200 object-contain" />
                </div>
              )}
            </>
          )}

          {currentStep === 3 && (
            <div className="md:col-span-2 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">Final Confirmation</h2>
                <p className="mt-1 text-xs text-slate-500">Review all values before proceeding to email verification.</p>
                <div className="mt-4 space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Applicant</p>
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
                      {[
                        ['Name', [form.applicantFirstName, form.applicantMiddleName, form.applicantLastName].filter(Boolean).join(' ') || 'N/A'],
                        ['Gender', form.applicantGender || 'N/A'],
                        ['ID Type', PH_VALID_ID_OPTIONS.find((option) => option.value === form.applicantValidIdType)?.label || 'N/A'],
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
                        <span className="font-semibold">Preferred Contact Detail:</span> {form.preferredContactDetail || 'N/A'}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Event & Schedule</p>
                    <div className="grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
                      <div className="md:col-span-2"><span className="font-semibold">Event Name:</span> {form.eventName || 'N/A'}</div>
                      <div><span className="font-semibold">Event Type:</span> {normalizeEventVisibility(form.eventVisibility)}</div>
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

              {(validIdPreviewUrl || eventPlacePhotoPreviewUrl || eventPosterPhotoPreviewUrl) && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {validIdPreviewUrl && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">ID Preview</p>
                      <img src={validIdPreviewUrl} alt="Valid ID preview" className="max-h-52 w-auto rounded border border-slate-200 object-contain" />
                    </div>
                  )}
                  {eventPlacePhotoPreviewUrl && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Event Place Photo Preview</p>
                      <img src={eventPlacePhotoPreviewUrl} alt="Event place preview" className="max-h-52 w-auto rounded border border-slate-200 object-contain" />
                    </div>
                  )}
                  {eventPosterPhotoPreviewUrl && (
                    <div className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Event Poster Photo Preview</p>
                      <img src={eventPosterPhotoPreviewUrl} alt="Event poster preview" className="max-h-52 w-auto rounded border border-slate-200 object-contain" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {currentStep === 4 && (
            <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-700">Verify Applicant Email</h2>
              <p className="mt-1 text-sm text-slate-600">
                Verify <span className="font-semibold">{normalizedEmail || 'your email'}</span> using a 6-digit OTP before final submission.
              </p>

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

              {otpNotice.message ? (
                <p
                  className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                    otpNotice.type === 'error'
                      ? 'border border-rose-200 bg-rose-50 text-rose-800'
                      : otpNotice.type === 'success'
                        ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  {otpNotice.message}
                </p>
              ) : null}

              {isEmailOtpVerified && normalizedEmail === verifiedEmail ? (
                <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                  <ShieldCheck size={14} /> Email verified. Submission is now enabled.
                </p>
              ) : (
                <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                  <ShieldCheck size={14} /> Verify email first to unlock final submit.
                </p>
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
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white sm:w-auto"
                  style={{ backgroundColor: primaryColor }}
                >
                  Next
                  <ChevronRight size={15} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isSubmitting || !canSubmit || !isEmailOtpVerified || normalizedEmail !== verifiedEmail}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto"
                  style={{ backgroundColor: primaryColor }}
                >
                  {isSubmitting && <Loader2 size={16} className="animate-spin" />}
                  {isSubmitting ? 'Submitting...' : 'Submit Event Application'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
    </Wrapper>
  );
}

