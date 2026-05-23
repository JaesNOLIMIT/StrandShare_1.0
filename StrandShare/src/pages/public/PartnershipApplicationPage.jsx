import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, Loader2, MailCheck, Search, ShieldCheck, UploadCloud } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabaseClient';
import philippineAddressOptions from '../../data/philippineAddressOptions.json';
import { TransitionFlipEntrance } from '../../components/transitions/TransitionFlip';
import 'maplibre-gl/dist/maplibre-gl.css';

const USERS_TABLE = 'users';
const USER_DETAILS_TABLE = 'user_details';
const HOSPITALS_TABLE = 'Hospitals';
const HOSPITAL_LOGOS_BUCKET = 'hospital_logos';
const MAX_LOGO_FILE_SIZE_BYTES = 5 * 1024 * 1024;
let isolatedAuthClient = null;
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

const DEFAULT_COUNTRY = 'Philippines';
const PHILIPPINE_ADDRESS_TREE = philippineAddressOptions && typeof philippineAddressOptions === 'object'
  ? philippineAddressOptions
  : {};

function toUnifiedRegionOptions(addressData) {
  const data = addressData && typeof addressData === 'object' ? addressData : {};

  const psgcRegionOptions = Object.entries(data)
    .filter(([, regionData]) => {
      return (
        regionData
        && typeof regionData === 'object'
        && !Array.isArray(regionData)
        && typeof regionData.region_name === 'string'
        && regionData.region_name.trim()
        && regionData.province_list
        && typeof regionData.province_list === 'object'
        && !Array.isArray(regionData.province_list)
      );
    })
    .map(([, regionData]) => ({
      name: regionData.region_name,
      provinces: Object.entries(regionData.province_list || {}).map(([provinceName, provinceData]) => ({
        name: provinceName,
        cities: Object.entries(provinceData?.municipality_list || {}).map(([cityName, cityData]) => ({
          name: cityName,
          barangays: Array.isArray(cityData?.barangay_list) ? cityData.barangay_list : [],
        })),
      })),
    }));

  if (psgcRegionOptions.length > 0) {
    return psgcRegionOptions
      .map((region) => ({
        ...region,
        provinces: (region.provinces || [])
          .map((province) => ({
            ...province,
            cities: (province.cities || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const countries = Array.isArray(data.countries) ? data.countries : [];
  const countryNode = countries.find((country) => country?.name === DEFAULT_COUNTRY) || countries[0] || null;
  const regions = Array.isArray(countryNode?.regions) ? countryNode.regions : [];

  return regions
    .map((region) => ({
      name: String(region?.name || '').trim(),
      provinces: (Array.isArray(region?.provinces) ? region.provinces : []).map((province) => ({
        name: String(province?.name || '').trim(),
        cities: (Array.isArray(province?.cities) ? province.cities : []).map((cityName) => ({
          name: String(cityName || '').trim(),
          barangays: [],
        })),
      })),
    }))
    .filter((region) => region.name)
    .map((region) => ({
      ...region,
      provinces: (region.provinces || [])
        .filter((province) => province.name)
        .map((province) => ({
          ...province,
          cities: (province.cities || [])
            .filter((city) => city.name)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

const initialForm = {
  hospitalName: '',
  hospitalHeadName: '',
  hospitalHeadTitle: '',
  hospitalHeadContactNumber: '',
  hospitalHeadEmail: '',
  street: '',
  barangay: '',
  city: '',
  province: '',
  region: '',
  country: DEFAULT_COUNTRY,
  latitude: '',
  longitude: '',
  firstName: '',
  middleName: '',
  suffix: '',
  birthdate: '',
  gender: '',
  lastName: '',
  leadContactNumber: '',
  leadStreet: '',
  leadBarangay: '',
  leadCity: '',
  leadProvince: '',
  leadRegion: '',
  leadCountry: DEFAULT_COUNTRY,
  email: '',
};

const LEAD_GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];
const PHILIPPINE_TIME_ZONE = 'Asia/Manila';
const TERMS_AND_AGREEMENT_PDF_PATH = '/legal/donivra-terms-and-agreement.pdf';

function toTitle(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDisplayName(firstName = '', lastName = '') {
  return [toTitle(firstName), toTitle(lastName)]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRole(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function toSafeFileName(fileName = 'hospital-logo.png') {
  return String(fileName)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

function toSlug(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
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

function formatPhilippineMobile(value = '') {
  const digits = normalizePhilippineMobile(value);

  if (!digits) return '';
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
}

function formatPhilippineMobileWithCountry(value = '') {
  const localNumber = formatPhilippineMobile(value);
  return localNumber ? `+63 ${localNumber}` : '';
}

function toStoredPhoneNumber(value = '') {
  const digits = normalizePhilippineMobile(value);
  return digits.length === 10
    ? `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`
    : '';
}

function getPhilippineTimestamp(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function toCoordinateOrNull(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapStorageUploadError(rawMessage, bucketId = HOSPITAL_LOGOS_BUCKET) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('bucket') && lower.includes('not found')) {
    return 'Hospital logo bucket is missing. Run migration 138_fix_hospital_logos_storage_policies.sql and retry.';
  }

  if (lower.includes('row-level security')) {
    return 'Hospital logo upload blocked by Storage RLS policy. Run migration 138_fix_hospital_logos_storage_policies.sql in Supabase SQL Editor and retry. If still blocked, check storage.objects policies in pg_policies for leftover restrictive rules.';
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
      storageKey: 'Donivra-org-application-otp-client',
    },
  });

  return isolatedAuthClient;
}

function LocationPinPicker({ latitude, longitude, onChange }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const initialLatitudeRef = useRef(latitude);
  const initialLongitudeRef = useRef(longitude);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [selectedPlaceLabel, setSelectedPlaceLabel] = useState('');
  const [mapView, setMapView] = useState('satellite');

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

  const onSelectSearchResult = useCallback((result) => {
    const nextLat = Number(result?.lat);
    const nextLng = Number(result?.lon);
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) {
      return;
    }
    updateMarkerAndLocation(nextLat, nextLng, { notify: true, zoom: 15 });
    setSelectedPlaceLabel(String(result?.display_name || '').trim());
    setSearchError('');
  }, [updateMarkerAndLocation]);

  const runLocationSearch = async () => {
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
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Search request failed.');
      }

      const resultRows = await response.json();
      const normalizedResults = Array.isArray(resultRows)
        ? resultRows.filter((row) => Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon)))
        : [];

      setSearchResults(normalizedResults);

      if (normalizedResults.length === 0) {
        setSearchError('No matching location found. Try a more specific place name.');
        return;
      }

      onSelectSearchResult(normalizedResults[0]);
    } catch (error) {
      setSearchError(String(error?.message || 'Unable to search location right now. Please try again.'));
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return undefined;
    }

    const initialLat = Number.isFinite(initialLatitudeRef.current) ? initialLatitudeRef.current : DEFAULT_MAP_CENTER.lat;
    const initialLng = Number.isFinite(initialLongitudeRef.current) ? initialLongitudeRef.current : DEFAULT_MAP_CENTER.lng;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_SATELLITE_STYLE,
      center: [initialLng, initialLat],
      zoom: Number.isFinite(initialLatitudeRef.current) && Number.isFinite(initialLongitudeRef.current) ? 13 : 5,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

    if (Number.isFinite(initialLatitudeRef.current) && Number.isFinite(initialLongitudeRef.current)) {
      markerRef.current = new maplibregl.Marker({ color: '#b91c1c' })
        .setLngLat([initialLongitudeRef.current, initialLatitudeRef.current])
        .addTo(map);
    }

    map.on('click', (event) => {
      const nextLng = Number(event.lngLat.lng.toFixed(7));
      const nextLat = Number(event.lngLat.lat.toFixed(7));

      if (!markerRef.current) {
        markerRef.current = new maplibregl.Marker({ color: '#b91c1c' });
      }
      updateMarkerAndLocation(nextLat, nextLng, { notify: true, zoom: 15 });
      setSelectedPlaceLabel('');
    });

    mapRef.current = map;

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [updateMarkerAndLocation]);

  useEffect(() => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }
    updateMarkerAndLocation(latitude, longitude, { notify: false });
  }, [latitude, longitude, updateMarkerAndLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const nextStyle = mapView === 'street' ? MAP_STREET_STYLE : MAP_SATELLITE_STYLE;
    map.setStyle(nextStyle);
  }, [mapView]);

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
            placeholder="Search address, barangay, city, or hospital"
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
      </div>

      {searchError ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{searchError}</p>
      ) : null}

      {selectedPlaceLabel ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Selected: {selectedPlaceLabel}
        </p>
      ) : null}

      {searchResults.length > 1 ? (
        <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50">
          {searchResults.slice(0, 6).map((result) => (
            <button
              key={`${result.place_id}-${result.lat}-${result.lon}`}
              type="button"
              onClick={() => onSelectSearchResult(result)}
              className="w-full border-b border-slate-200 px-3 py-2 text-left text-xs text-slate-700 last:border-b-0 hover:bg-slate-100"
            >
              {result.display_name}
            </button>
          ))}
        </div>
      ) : null}

      <div ref={mapContainerRef} className="h-72 w-full" />
    </div>
  );
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
    return 'This code already expired. Request a new 6-digit code.';
  }

  if (lower.includes('token') && lower.includes('invalid')) {
    return 'Invalid code. Please check the 6-digit code and try again.';
  }

  if (lower.includes('email') && lower.includes('invalid')) {
    return 'Please enter a valid email address first.';
  }

  return message;
}

function mapApplicationSchemaError(rawMessage) {
  const message = String(rawMessage || '').trim();
  const lower = message.toLowerCase();

  if (
    message.includes("Could not find the table 'public.Hospitals'")
  ) {
    return 'Hospital application tables are not ready yet. Run the latest hospital migrations, then refresh the app.';
  }

  if (
    (lower.includes('column') && lower.includes('hospitals') && lower.includes('does not exist'))
    || lower.includes('is_approved')
    || lower.includes('approval_status')
    || lower.includes('approved_by')
    || lower.includes('approved_at')
    || lower.includes('review_notes')
    || lower.includes('province')
    || lower.includes('latitude')
    || lower.includes('longitude')
    || lower.includes('hospital_head_name')
    || lower.includes('hospital_head_title')
    || lower.includes('hospital_head_contact_number')
    || lower.includes('hospital_head_email')
  ) {
    return 'Hospitals schema is missing required application columns. Run migrations 048_alter_hospitals_application_columns.sql, 049_add_hospitals_province_column.sql, and 065_add_hospital_head_details_columns.sql, then refresh.';
  }

  if (lower.includes('bucket') && lower.includes('hospital_logos')) {
    return 'Hospital logo bucket is missing or blocked. Run migration 138_fix_hospital_logos_storage_policies.sql, then refresh the app.';
  }

  if (lower.includes('storage') || lower.includes('row-level security')) {
    return mapStorageUploadError(message, HOSPITAL_LOGOS_BUCKET);
  }

  if (lower.includes('no unique or exclusion constraint matching the on conflict specification')) {
    return 'Your database is missing a required unique constraint from old migrations. The form now avoids conflict-based upserts, so please refresh and submit again.';
  }

  return message;
}

function isRecoverableOptionalLogoUploadError(rawMessage) {
  const lower = String(rawMessage || '').trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes('row-level security')
    || (lower.includes('bucket') && lower.includes('hospital_logos'))
    || (lower.includes('bucket') && lower.includes('not found'))
    || lower.includes('storage policy')
  );
}

async function uploadApplicationLogo(file, entityName, bucketId = HOSPITAL_LOGOS_BUCKET) {
  if (!supabase) {
    throw new Error('Supabase is not configured for file upload.');
  }

  const safeName = toSafeFileName(file?.name || 'hospital-logo.png');
  const slug = toSlug(entityName) || 'application';
  const filePath = `applications/${slug}-${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from(bucketId)
    .upload(filePath, file, {
      upsert: false,
      contentType: file?.type || 'image/png',
    });

  if (uploadError) {
    throw new Error(mapStorageUploadError(uploadError.message, bucketId));
  }

  const { data: publicUrlData } = supabase.storage
    .from(bucketId)
    .getPublicUrl(filePath);

  const publicUrl = publicUrlData?.publicUrl;

  if (!publicUrl) {
    throw new Error('Could not resolve uploaded hospital logo URL.');
  }

  return {
    filePath,
    publicUrl,
  };
}

export default function PartnershipApplicationPage() {
  const { theme } = useTheme();
  const primaryColor = theme.primaryColor || '#0f766e';
  const secondaryColor = theme.secondaryColor || '#64748b';
  const backgroundColor = theme.backgroundColor || '#f8fafc';
  const primaryTextColor = theme.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme.secondaryTextColor || '#334155';
  const [form, setForm] = useState(initialForm);
  const [activePage, setActivePage] = useState(1);
  const [hasAcceptedTerms, setHasAcceptedTerms] = useState(false);
  const [hasConfirmedTerms, setHasConfirmedTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmissionComplete, setIsSubmissionComplete] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [submittedHospitalName, setSubmittedHospitalName] = useState('');
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState('');
  const [isDraggingLogo, setIsDraggingLogo] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpNotice, setOtpNotice] = useState({ type: '', message: '' });
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false);
  const [otpCooldownSeconds, setOtpCooldownSeconds] = useState(0);
  const [otpVerifiedEmail, setOtpVerifiedEmail] = useState('');
  const [otpVerifiedAuthUserId, setOtpVerifiedAuthUserId] = useState('');
  const fieldRefs = useRef({});
  const logoInputRef = useRef(null);
  const otpClientRef = useRef(null);
  const fieldClassName = 'w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:ring-2';
  const fieldStyle = {
    borderColor: `${secondaryColor}55`,
    '--tw-ring-color': `${primaryColor}55`,
  };

  const regionOptions = useMemo(() => {
    return toUnifiedRegionOptions(PHILIPPINE_ADDRESS_TREE);
  }, []);

  const selectedRegion = useMemo(() => {
    return regionOptions.find((region) => region.name === form.region) || null;
  }, [form.region, regionOptions]);

  const provinceOptions = useMemo(() => {
    return Array.isArray(selectedRegion?.provinces) ? selectedRegion.provinces : [];
  }, [selectedRegion]);

  const selectedProvince = useMemo(() => {
    return provinceOptions.find((province) => province.name === form.province) || null;
  }, [form.province, provinceOptions]);

  const cityOptions = useMemo(() => {
    return Array.isArray(selectedProvince?.cities) ? selectedProvince.cities : [];
  }, [selectedProvince]);

  const selectedCity = useMemo(() => {
    return cityOptions.find((city) => city.name === form.city) || null;
  }, [form.city, cityOptions]);

  const barangayOptions = useMemo(() => {
    return Array.isArray(selectedCity?.barangays) ? selectedCity.barangays : [];
  }, [selectedCity]);

  const leadRegionOptions = useMemo(() => {
    return regionOptions;
  }, [regionOptions]);

  const selectedLeadRegion = useMemo(() => {
    return leadRegionOptions.find((region) => region.name === form.leadRegion) || null;
  }, [form.leadRegion, leadRegionOptions]);

  const leadProvinceOptions = useMemo(() => {
    return Array.isArray(selectedLeadRegion?.provinces) ? selectedLeadRegion.provinces : [];
  }, [selectedLeadRegion]);

  const selectedLeadProvince = useMemo(() => {
    return leadProvinceOptions.find((province) => province.name === form.leadProvince) || null;
  }, [form.leadProvince, leadProvinceOptions]);

  const leadCityOptions = useMemo(() => {
    return Array.isArray(selectedLeadProvince?.cities) ? selectedLeadProvince.cities : [];
  }, [selectedLeadProvince]);

  const selectedLeadCity = useMemo(() => {
    return leadCityOptions.find((city) => city.name === form.leadCity) || null;
  }, [form.leadCity, leadCityOptions]);

  const leadBarangayOptions = useMemo(() => {
    return Array.isArray(selectedLeadCity?.barangays) ? selectedLeadCity.barangays : [];
  }, [selectedLeadCity]);

  const normalizedEmail = useMemo(() => {
    return form.email.trim().toLowerCase();
  }, [form.email]);

  const isEmailOtpVerified = useMemo(() => {
    return Boolean(
      otpVerifiedAuthUserId
      && otpVerifiedEmail
      && otpVerifiedEmail === normalizedEmail
    );
  }, [normalizedEmail, otpVerifiedAuthUserId, otpVerifiedEmail]);

  useEffect(() => {
    return () => {
      if (logoPreviewUrl) {
        URL.revokeObjectURL(logoPreviewUrl);
      }
    };
  }, [logoPreviewUrl]);

  useEffect(() => {
    if (otpCooldownSeconds <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setOtpCooldownSeconds((previous) => (previous > 1 ? previous - 1 : 0));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [otpCooldownSeconds]);

  const selectedLatitude = useMemo(() => toCoordinateOrNull(form.latitude), [form.latitude]);
  const selectedLongitude = useMemo(() => toCoordinateOrNull(form.longitude), [form.longitude]);

  const hasHospitalRequiredFields = useMemo(() => {
    return (
      form.hospitalName.trim()
      && form.hospitalHeadName.trim()
      && form.hospitalHeadTitle.trim()
      && normalizePhilippineMobile(form.hospitalHeadContactNumber).length === 10
      && isValidEmail(form.hospitalHeadEmail)
      && form.street.trim()
      && form.city.trim()
      && form.province.trim()
      && form.region.trim()
      && form.country.trim()
      && selectedLatitude !== null
      && selectedLongitude !== null
    );
  }, [
    form.hospitalName,
    form.hospitalHeadName,
    form.hospitalHeadTitle,
    form.hospitalHeadContactNumber,
    form.hospitalHeadEmail,
    form.street,
    form.city,
    form.province,
    form.region,
    form.country,
    selectedLatitude,
    selectedLongitude,
  ]);

  const hasLeadRequiredFields = useMemo(() => {
    return (
      form.firstName.trim()
      && form.lastName.trim()
      && normalizePhilippineMobile(form.leadContactNumber).length === 10
      && form.leadStreet.trim()
      && form.leadCity.trim()
      && form.leadProvince.trim()
      && form.leadRegion.trim()
      && form.leadCountry.trim()
      && isValidEmail(form.email)
    );
  }, [form.firstName, form.lastName, form.leadContactNumber, form.leadStreet, form.leadCity, form.leadProvince, form.leadRegion, form.leadCountry, form.email]);

  const hasEntityRequiredFields = useMemo(() => hasHospitalRequiredFields, [hasHospitalRequiredFields]);

  const hasRequiredFields = hasEntityRequiredFields && hasLeadRequiredFields;

  const canSubmit = hasRequiredFields && isEmailOtpVerified;

  const setFieldRef = useCallback((fieldKey) => (node) => {
    if (!fieldKey) return;
    if (node) {
      fieldRefs.current[fieldKey] = node;
    } else {
      delete fieldRefs.current[fieldKey];
    }
  }, []);

  const focusField = useCallback((fieldKey) => {
    const node = fieldRefs.current[fieldKey];
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      if (typeof node.focus === 'function') node.focus();
    }, 140);
  }, []);

  const getValidationIssue = useCallback((page) => {
    const issue = (field, message) => ({ field, message });

    if (page === 1) {
      if (!form.hospitalName.trim()) return issue('hospitalName', 'Hospital name is required.');
      if (!form.hospitalHeadName.trim()) return issue('hospitalHeadName', 'Hospital head/owner name is required.');
      if (!form.hospitalHeadTitle.trim()) return issue('hospitalHeadTitle', 'Head/owner position is required.');
      if (normalizePhilippineMobile(form.hospitalHeadContactNumber).length !== 10) return issue('hospitalHeadContactNumber', 'Head/owner contact number must be valid (+63 912 345 6789).');
      if (!isValidEmail(form.hospitalHeadEmail)) return issue('hospitalHeadEmail', 'Head/owner email must be valid.');
      if (!form.street.trim()) return issue('street', 'Street is required.');
      if (!form.region.trim()) return issue('region', 'Region is required.');
      if (!form.province.trim()) return issue('province', 'Province is required.');
      if (!form.city.trim()) return issue('city', 'City/Municipality is required.');
      if (selectedLatitude === null || selectedLongitude === null) return issue('latitude', 'Please set the exact location pin.');
      return null;
    }

    if (page === 2) {
      if (!form.firstName.trim()) return issue('firstName', 'First name is required.');
      if (!form.lastName.trim()) return issue('lastName', 'Last name is required.');
      if (normalizePhilippineMobile(form.leadContactNumber).length !== 10) return issue('leadContactNumber', 'H-Representative contact number must be valid (+63 912 345 6789).');
      if (!isValidEmail(form.email)) return issue('email', 'H-Representative email must be valid.');
      if (!form.leadStreet.trim()) return issue('leadStreet', 'Street is required.');
      if (!form.leadRegion.trim()) return issue('leadRegion', 'Region is required.');
      if (!form.leadProvince.trim()) return issue('leadProvince', 'Province is required.');
      if (!form.leadCity.trim()) return issue('leadCity', 'City/Municipality is required.');
      return null;
    }

    if (page === 4 && !isEmailOtpVerified) {
      return issue('otpCode', 'Please verify email with the 6-digit OTP before submitting.');
    }

    return null;
  }, [
    form,
    selectedLatitude,
    selectedLongitude,
    isEmailOtpVerified,
  ]);

  const clearOtpVerificationState = (nextNotice = { type: '', message: '' }) => {
    setOtpCode('');
    setOtpVerifiedEmail('');
    setOtpVerifiedAuthUserId('');
    setOtpNotice(nextNotice);
  };

  const updateField = (field) => (event) => {
    const nextValue = event.target.value;
    setErrorMessage('');
    setSuccessMessage('');

    if (field === 'email') {
      const normalizedNextEmail = String(nextValue || '').trim().toLowerCase();
      const shouldResetOtp = normalizedNextEmail !== otpVerifiedEmail;

      if (shouldResetOtp) {
        clearOtpVerificationState(
          normalizedNextEmail
            ? { type: 'info', message: 'Email changed. Request and verify a new 6-digit code.' }
            : { type: '', message: '' }
        );
      }
    }

    setForm((prev) => ({
      ...prev,
      [field]: nextValue,
    }));
  };

  const onLocationPinChange = (nextLat, nextLng) => {
    setErrorMessage('');
    setSuccessMessage('');
    setForm((prev) => ({
      ...prev,
      latitude: Number(nextLat).toFixed(7),
      longitude: Number(nextLng).toFixed(7),
    }));
  };

  const onCountryChange = (event) => {
    const countryName = event.target.value || DEFAULT_COUNTRY;
    setForm((prev) => ({
      ...prev,
      country: countryName,
      region: '',
      province: '',
      city: '',
      barangay: '',
    }));
  };

  const onRegionChange = (event) => {
    const regionName = event.target.value;
    setForm((prev) => ({
      ...prev,
      region: regionName,
      province: '',
      city: '',
      barangay: '',
    }));
  };

  const onProvinceChange = (event) => {
    const provinceName = event.target.value;
    setForm((prev) => ({
      ...prev,
      province: provinceName,
      city: '',
      barangay: '',
    }));
  };

  const onCityChange = (event) => {
    const cityName = event.target.value;
    setForm((prev) => ({
      ...prev,
      city: cityName,
      barangay: '',
    }));
  };

  const onLeadCountryChange = (event) => {
    const countryName = event.target.value || DEFAULT_COUNTRY;
    setForm((prev) => ({
      ...prev,
      leadCountry: countryName,
      leadRegion: '',
      leadProvince: '',
      leadCity: '',
      leadBarangay: '',
    }));
  };

  const onLeadRegionChange = (event) => {
    const regionName = event.target.value;
    setForm((prev) => ({
      ...prev,
      leadRegion: regionName,
      leadProvince: '',
      leadCity: '',
      leadBarangay: '',
    }));
  };

  const onLeadProvinceChange = (event) => {
    const provinceName = event.target.value;
    setForm((prev) => ({
      ...prev,
      leadProvince: provinceName,
      leadCity: '',
      leadBarangay: '',
    }));
  };

  const onLeadCityChange = (event) => {
    const cityName = event.target.value;
    setForm((prev) => ({
      ...prev,
      leadCity: cityName,
      leadBarangay: '',
    }));
  };

  const onContactNumberChange = (field) => (event) => {
    const formatted = formatPhilippineMobileWithCountry(event.target.value);
    setForm((prev) => ({
      ...prev,
      [field]: formatted,
    }));
  };

  const autoPinFromAddressSnapshot = useCallback(async (formSnapshot) => {
    const query = [
      formSnapshot?.hospitalName,
      formSnapshot?.street,
      formSnapshot?.barangay,
      formSnapshot?.city,
      formSnapshot?.province,
      formSnapshot?.region,
      formSnapshot?.country || DEFAULT_COUNTRY,
    ]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(', ');

    if (!query) {
      return false;
    }

    try {
      const endpoint = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=ph&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!response.ok) return false;
      const rows = await response.json();
      const first = Array.isArray(rows)
        ? rows.find((row) => Number.isFinite(Number(row?.lat)) && Number.isFinite(Number(row?.lon)))
        : null;

      if (!first) return false;

      setForm((previous) => ({
        ...previous,
        latitude: Number(first.lat).toFixed(7),
        longitude: Number(first.lon).toFixed(7),
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const autoPinFromHospitalAddress = useCallback(async () => {
    setErrorMessage('');
    setSuccessMessage('');

    if (!form.street.trim() || !form.city.trim() || !form.province.trim() || !form.region.trim()) {
      setErrorMessage('Please complete street, city/municipality, province, and region first before auto-pin.');
      focusField('street');
      return;
    }

    const pinned = await autoPinFromAddressSnapshot(form);
    if (pinned) {
      setSuccessMessage('Map pin auto-set from hospital address.');
    } else {
      setErrorMessage('Unable to auto-pin this address right now. Adjust address or pin manually on the map.');
    }
  }, [autoPinFromAddressSnapshot, focusField, form]);

  const applyLogoFile = (file) => {
    if (!file) {
      if (logoPreviewUrl) {
        URL.revokeObjectURL(logoPreviewUrl);
      }
      setLogoPreviewUrl('');
      setLogoFile(null);
      return;
    }

    if (!String(file.type || '').startsWith('image/')) {
      setErrorMessage('Only image files are allowed for logo upload.');
      if (logoInputRef.current) {
        logoInputRef.current.value = '';
      }
      return;
    }

    if (file.size > MAX_LOGO_FILE_SIZE_BYTES) {
      setErrorMessage('Logo image must be 5MB or smaller.');
      if (logoInputRef.current) {
        logoInputRef.current.value = '';
      }
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    if (logoPreviewUrl) {
      URL.revokeObjectURL(logoPreviewUrl);
    }

    setErrorMessage('');
    setLogoPreviewUrl(nextPreviewUrl);
    setLogoFile(file);
  };

  const onLogoFileChange = (event) => {
    applyLogoFile(event.target.files?.[0] || null);
  };

  const onLogoDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isDraggingLogo) setIsDraggingLogo(true);
  };

  const onLogoDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingLogo(false);
  };

  const onLogoDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingLogo(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) applyLogoFile(file);
  };

  const sendEmailOtpCode = async () => {
    setErrorMessage('');
    setSuccessMessage('');

    if (!isValidEmail(normalizedEmail)) {
      setOtpNotice({ type: 'error', message: 'Enter a valid email address first.' });
      return;
    }

    if (otpCooldownSeconds > 0 || isSendingOtp) {
      return;
    }

    setIsSendingOtp(true);

    try {
      const otpClient = createIsolatedAuthClient();
      otpClientRef.current = otpClient;

      const { error } = await otpClient.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          shouldCreateUser: true,
        },
      });

      if (error) {
        throw error;
      }

      setOtpCode('');
      setOtpVerifiedEmail('');
      setOtpVerifiedAuthUserId('');
      setOtpNotice({
        type: 'success',
        message: `A 6-digit code was sent to ${normalizedEmail}. Enter it below to verify your email.`,
      });
      setOtpCooldownSeconds(60);
    } catch (error) {
      setOtpNotice({
        type: 'error',
        message: mapEmailOtpError(error?.message),
      });
    } finally {
      setIsSendingOtp(false);
    }
  };

  const verifyEmailOtpCode = async () => {
    setErrorMessage('');
    setSuccessMessage('');

    const normalizedCode = String(otpCode || '').replace(/\D/g, '').slice(0, 6);

    if (!isValidEmail(normalizedEmail)) {
      setOtpNotice({ type: 'error', message: 'Enter a valid email address first.' });
      return;
    }

    if (normalizedCode.length !== 6) {
      setOtpNotice({ type: 'error', message: 'Please enter the 6-digit code sent to your email.' });
      return;
    }

    setIsVerifyingOtp(true);

    try {
      const otpClient = otpClientRef.current || createIsolatedAuthClient();
      otpClientRef.current = otpClient;

      const { data, error } = await otpClient.auth.verifyOtp({
        email: normalizedEmail,
        token: normalizedCode,
        type: 'email',
      });

      if (error) {
        throw error;
      }

      const verifiedAuthUserId = data?.user?.id || '';

      if (!verifiedAuthUserId) {
        throw new Error('Verification passed, but account information could not be resolved. Please try again.');
      }

      setOtpCode(normalizedCode);
      setOtpVerifiedEmail(normalizedEmail);
      setOtpVerifiedAuthUserId(verifiedAuthUserId);
      setOtpNotice({
        type: 'success',
        message: 'Email verified successfully. You can now submit your partner hospital application.',
      });

      const otpDisplayName = buildDisplayName(form.firstName, form.lastName);
      if (otpDisplayName) {
        await otpClient.auth.updateUser({
          data: {
            display_name: otpDisplayName,
            full_name: otpDisplayName,
            name: otpDisplayName,
          },
        }).catch(() => undefined);
      }

      await otpClient.auth.signOut().catch(() => undefined);
    } catch (error) {
      setOtpVerifiedEmail('');
      setOtpVerifiedAuthUserId('');
      setOtpNotice({
        type: 'error',
        message: mapEmailOtpError(error?.message),
      });
    } finally {
      setIsVerifyingOtp(false);
    }
  };

  const goBack = () => {
    if (typeof window === 'undefined') return;
    window.location.assign('/');
  };

  const acceptTermsAndContinue = () => {
    if (!hasConfirmedTerms) {
      setErrorMessage('Please confirm that you agree to the Terms and Agreement before continuing.');
      return;
    }

    setErrorMessage('');
    setSuccessMessage('');
    setHasAcceptedTerms(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goToLeadPage = () => {
    setErrorMessage('');
    setSuccessMessage('');

    const issue = getValidationIssue(1);
    if (issue) {
      setErrorMessage(issue.message);
      focusField(issue.field);
      return;
    }

    setActivePage(2);
  };

  const goToDetailsFromLeadPage = () => {
    setErrorMessage('');
    setSuccessMessage('');
    setActivePage(1);
  };

  const goToConfirmationPage = () => {
    setErrorMessage('');
    setSuccessMessage('');

    const issue = getValidationIssue(2);
    if (issue) {
      setErrorMessage(issue.message);
      focusField(issue.field);
      return;
    }

    setActivePage(3);
  };

  const goToLeadPageFromConfirmation = () => {
    setErrorMessage('');
    setSuccessMessage('');
    setActivePage(2);
  };

  const goToOtpPage = () => {
    setErrorMessage('');
    setSuccessMessage('');
    setActivePage(4);
  };

  const goBackToConfirmationFromOtp = () => {
    setErrorMessage('');
    setSuccessMessage('');
    setActivePage(3);
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    if (activePage === 1) {
      goToLeadPage();
      return;
    }

    if (activePage === 2) {
      goToConfirmationPage();
      return;
    }

    if (activePage === 3) {
      goToOtpPage();
      return;
    }

    if (!hasRequiredFields) {
      setErrorMessage('Please complete all required fields.');
      return;
    }

    if (!isEmailOtpVerified) {
      setErrorMessage('Please verify your email with the 6-digit code before submitting.');
      return;
    }

    const firstName = toTitle(form.firstName);
    const middleName = toTitle(form.middleName);
    const suffix = toTitle(form.suffix);
    const gender = toTitle(form.gender);
    const lastName = toTitle(form.lastName);
    const nowIso = getPhilippineTimestamp();
    const joinedDate = nowIso.slice(0, 10);
    const hospitalName = form.hospitalName.trim();
    const hospitalHeadName = form.hospitalHeadName.trim();
    const hospitalHeadTitle = form.hospitalHeadTitle.trim();
    const hospitalHeadContactNumber = toStoredPhoneNumber(form.hospitalHeadContactNumber);
    const hospitalHeadEmail = form.hospitalHeadEmail.trim().toLowerCase();
    const entityName = hospitalName;
    const entityContactNumber = toStoredPhoneNumber(form.hospitalHeadContactNumber);
    const leadContactNumber = toStoredPhoneNumber(form.leadContactNumber);
    const selectedLat = toCoordinateOrNull(form.latitude);
    const selectedLng = toCoordinateOrNull(form.longitude);

    setIsSubmitting(true);

    try {
      const existingUserResponse = await supabase
        .from(USERS_TABLE)
        .select('user_id, email, role, auth_user_id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (existingUserResponse.error) {
        throw new Error(existingUserResponse.error.message);
      }

      const existingUser = existingUserResponse.data || null;
      const existingRole = normalizeRole(existingUser?.role);
      const allowedExistingRole = !existingRole
        || ['user', 'partner', 'hospital', 'partnerhospital', 'hrepresentative'].includes(existingRole);

      if (existingUser && !allowedExistingRole) {
        throw new Error('This email is linked to a restricted account role. Use a different email for the H-Representative account.');
      }

      if (existingUser?.auth_user_id && otpVerifiedAuthUserId && existingUser.auth_user_id !== otpVerifiedAuthUserId) {
        throw new Error('The verified OTP account does not match this email. Request a new code and verify again.');
      }

      const authUserId = existingUser?.auth_user_id || otpVerifiedAuthUserId || null;

      if (!authUserId) {
        throw new Error('Email verification session expired. Please request and verify a new 6-digit code.');
      }

      let userId = Number(existingUser?.user_id || 0);

      if (existingUser?.user_id) {
        const updateUserResult = await supabase
          .from(USERS_TABLE)
          .update({
            auth_user_id: authUserId,
            role: 'user',
            access_start: null,
            access_end: null,
            is_active: false,
            updated_at: nowIso,
          })
          .eq('user_id', existingUser.user_id)
          .select('user_id')
          .maybeSingle();

        if (updateUserResult.error) {
          throw new Error(updateUserResult.error.message);
        }

        userId = Number(updateUserResult.data?.user_id || existingUser.user_id);
      } else {
        const insertUserResult = await supabase
          .from(USERS_TABLE)
          .insert({
            auth_user_id: authUserId,
            email: normalizedEmail,
            role: 'user',
            access_start: null,
            access_end: null,
            is_active: false,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .select('user_id')
          .maybeSingle();

        if (insertUserResult.error) {
          throw new Error(insertUserResult.error.message);
        }

        userId = Number(insertUserResult.data?.user_id || 0);
      }

      if (!userId) {
        throw new Error('Unable to resolve local user profile for the applicant.');
      }

      const userDetailsPayload = {
        user_id: userId,
        first_name: firstName,
        middle_name: middleName || null,
        suffix: suffix || null,
        birthdate: form.birthdate || null,
        gender: gender || null,
        last_name: lastName,
        contact_number: leadContactNumber,
        street: form.leadStreet.trim(),
        barangay: form.leadBarangay.trim() || null,
        city: form.leadCity.trim(),
        province: form.leadProvince.trim(),
        region: form.leadRegion.trim(),
        country: form.leadCountry.trim(),
        updated_at: nowIso,
      };

      const existingDetailsResult = await supabase
        .from(USER_DETAILS_TABLE)
        .select('user_id')
        .eq('user_id', userId)
        .limit(1);

      if (existingDetailsResult.error) {
        throw new Error(existingDetailsResult.error.message);
      }

      if ((existingDetailsResult.data || []).length > 0) {
        const updateDetailsResult = await supabase
          .from(USER_DETAILS_TABLE)
          .update(userDetailsPayload)
          .eq('user_id', userId);

        if (updateDetailsResult.error) {
          throw new Error(updateDetailsResult.error.message);
        }
      } else {
        const insertDetailsResult = await supabase
          .from(USER_DETAILS_TABLE)
          .insert({
            ...userDetailsPayload,
            joined_date: joinedDate,
            created_at: nowIso,
          });

        if (insertDetailsResult.error) {
          throw new Error(insertDetailsResult.error.message);
        }
      }

      let hospitalLogoUrl = '';
      let logoUploadNotice = '';

      if (logoFile) {
        try {
          const uploadResult = await uploadApplicationLogo(logoFile, entityName, HOSPITAL_LOGOS_BUCKET);
          hospitalLogoUrl = uploadResult.publicUrl;
        } catch (logoUploadError) {
          const rawLogoUploadMessage = String(logoUploadError?.message || logoUploadError || '');
          if (!isRecoverableOptionalLogoUploadError(rawLogoUploadMessage)) {
            throw logoUploadError;
          }
          logoUploadNotice = mapStorageUploadError(rawLogoUploadMessage, HOSPITAL_LOGOS_BUCKET);
          console.warn('[PartnershipApplication] Optional hospital logo upload failed; continuing without logo:', rawLogoUploadMessage);
          hospitalLogoUrl = '';
        }
      }

      const createHospitalResult = await supabase
        .from(HOSPITALS_TABLE)
        .insert({
          Hospital_Name: hospitalName,
          Hospital_Logo: hospitalLogoUrl || null,
          Hospital_Head_Name: hospitalHeadName || null,
          Hospital_Head_Title: hospitalHeadTitle || null,
          Hospital_Head_Contact_Number: hospitalHeadContactNumber || null,
          Hospital_Head_Email: hospitalHeadEmail || null,
          Contact_Number: entityContactNumber,
          Street: form.street.trim(),
          Barangay: form.barangay.trim() || null,
          City: form.city.trim(),
          Province: form.province.trim(),
          Region: form.region.trim(),
          Country: form.country.trim(),
          Latitude: selectedLat,
          Longitude: selectedLng,
          Is_Approved: false,
          Approval_Status: 'Pending',
          Approved_By: null,
          Approved_At: null,
          Review_Notes: null,
          Created_By: userId,
          Updated_By: userId,
          Created_At: nowIso,
          Updated_At: nowIso,
        })
        .select('Hospital_ID')
        .maybeSingle();

      if (createHospitalResult.error) {
        throw new Error(createHospitalResult.error.message);
      }

      setForm(initialForm);
      setLogoFile(null);
      if (logoPreviewUrl) {
        URL.revokeObjectURL(logoPreviewUrl);
      }
      setLogoPreviewUrl('');
      setOtpCode('');
      setOtpNotice({ type: '', message: '' });
      setOtpVerifiedEmail('');
      setOtpVerifiedAuthUserId('');
      setOtpCooldownSeconds(0);
      setActivePage(1);
      if (logoInputRef.current) {
        logoInputRef.current.value = '';
      }
      if (otpClientRef.current) {
        await otpClientRef.current.auth.signOut().catch(() => undefined);
      }
      setSuccessMessage(
        logoUploadNotice
          ? `Application submitted successfully. Your partner hospital application is now pending admin review. Logo upload was skipped: ${logoUploadNotice}`
          : 'Application submitted successfully. Your partner hospital application is now pending admin review.'
      );
      setSubmittedHospitalName(entityName);
      setIsSubmissionComplete(true);
    } catch (error) {
      setErrorMessage(
        mapApplicationSchemaError(error?.message)
        || 'Unable to submit application.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

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
  const entityDisplayName = 'Partner Hospital';
  const formTitle = 'Submit Partner Hospital Application';
  const currentStepNumber = activePage;
  const stepLabel = activePage === 1
    ? `${entityDisplayName} Details`
    : activePage === 2
      ? 'H-Representative Account Setup'
      : activePage === 3
        ? 'Review & Confirmation'
        : 'Email Verification';

  if (!hasAcceptedTerms) {
    return (
      <Wrapper>
        <div className="min-h-screen px-4 py-8 md:px-8" style={{ backgroundColor }}>
          <div className="mx-auto max-w-4xl">
            <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: `${secondaryColor}44` }}>
              <header
                className="border-b px-5 py-5 md:px-7"
                style={{
                  borderColor: `${secondaryColor}33`,
                  background: `linear-gradient(120deg, ${primaryColor}22, #ffffff)`,
                }}
              >
                <h1 className="text-2xl font-extrabold tracking-tight md:text-3xl" style={{ color: primaryTextColor }}>
                  Terms and Conditions
                </h1>
                <p className="mt-2 max-w-3xl text-sm md:text-base" style={{ color: secondaryTextColor }}>
                  Review and accept the Donivra Terms and Agreement before starting the partnership application.
                </p>
              </header>

              <div className="space-y-4 px-5 py-6 md:px-7 md:py-7">
                <div className="overflow-hidden rounded-xl border bg-slate-50" style={{ borderColor: `${secondaryColor}33` }}>
                  <iframe
                    title="Donivra Terms and Agreement"
                    src={TERMS_AND_AGREEMENT_PDF_PATH}
                    className="h-[60vh] w-full bg-white"
                  />
                </div>

                <p className="text-xs" style={{ color: secondaryTextColor }}>
                  If the preview does not load, open the file here:{' '}
                  <a
                    href={TERMS_AND_AGREEMENT_PDF_PATH}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold underline"
                    style={{ color: primaryTextColor }}
                  >
                    Donivra Terms and Agreement (PDF)
                  </a>
                </p>

                <label
                  className="flex items-start gap-2 rounded-xl border bg-white px-3 py-3 text-sm"
                  style={{ borderColor: `${secondaryColor}33`, color: secondaryTextColor }}
                >
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
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                    {errorMessage}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={goBack}
                    className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold"
                    style={{ borderColor: `${secondaryColor}44`, color: secondaryTextColor }}
                  >
                    <ArrowLeft size={14} /> Decline
                  </button>
                  <button
                    type="button"
                    onClick={acceptTermsAndContinue}
                    className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Accept and Continue
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </Wrapper>
    );
  }

  if (isSubmissionComplete) {
    return (
      <div className="min-h-screen px-4 py-8 md:px-8" style={{ backgroundColor }}>
        <div className="mx-auto max-w-3xl">
          <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: `${secondaryColor}44` }}>
            <header
              className="border-b px-5 py-5 md:px-7"
              style={{
                borderColor: `${secondaryColor}33`,
                background: `linear-gradient(120deg, ${primaryColor}22, #ffffff)`,
              }}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color: secondaryTextColor }}>Application Status</p>
                  <h1 className="mt-1 text-2xl font-extrabold tracking-tight md:text-3xl" style={{ color: primaryTextColor }}>
                    Partner Hospital Application Submitted
                  </h1>
                  {submittedHospitalName ? (
                    <p className="mt-2 text-sm md:text-base" style={{ color: secondaryTextColor }}>
                      {submittedHospitalName}
                    </p>
                  ) : null}
                </div>
                <div
                  className="grid h-12 w-12 place-items-center rounded-xl text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  <CheckCircle2 size={22} />
                </div>
              </div>
            </header>

            <div className="space-y-4 px-5 py-6 md:px-7 md:py-7">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                <p className="inline-flex items-center gap-2 font-semibold"><CheckCircle2 size={16} /> Success</p>
                <p className="mt-1">{successMessage || 'Application submitted successfully. Your partner hospital application is now pending admin review.'}</p>
              </div>

              <div className="rounded-lg border bg-slate-50 px-4 py-3 text-sm" style={{ borderColor: `${secondaryColor}33`, color: secondaryTextColor }}>
                Please wait for the email update to know if your application is accepted or rejected.
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  <ArrowLeft size={16} /> Back To Landing Page
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <Wrapper>
    <div className="min-h-screen px-4 py-8 md:px-8" style={{ backgroundColor }}>
      <div className="mx-auto max-w-4xl">
        <button
          type="button"
          onClick={goBack}
          className="mb-4 inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm font-semibold"
          style={{ borderColor: `${secondaryColor}55`, color: secondaryTextColor }}
        >
          <ArrowLeft size={14} /> Back To Landing
        </button>

        <section className="overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: `${secondaryColor}44` }}>
          <header
            className="border-b px-5 py-5 md:px-7"
            style={{
              borderColor: `${secondaryColor}33`,
              background: `linear-gradient(120deg, ${primaryColor}22, #ffffff)`,
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color: secondaryTextColor }}>Application Onboarding</p>
                <h1 className="mt-1 text-2xl font-extrabold tracking-tight md:text-3xl" style={{ color: primaryTextColor }}>
                  {formTitle}
                </h1>
                <p className="mt-2 max-w-2xl text-sm md:text-base" style={{ color: secondaryTextColor }}>
                  Step 1: complete hospital profile details. Step 2: set up who will use the H-Representative account. Step 3: review all details. Step 4: verify email with OTP and submit.
                </p>
              </div>
              <div
                className="grid h-12 w-12 place-items-center rounded-xl text-white"
                style={{ backgroundColor: primaryColor }}
              >
                <Building2 size={22} />
              </div>
            </div>
          </header>

          <form onSubmit={onSubmit} className="space-y-6 px-5 py-6 md:px-7 md:py-7">
            <div className="flex items-center justify-between rounded-xl border bg-slate-50 px-4 py-2 text-xs font-semibold" style={{ borderColor: `${secondaryColor}33`, color: secondaryTextColor }}>
              <span>Page {currentStepNumber} of 4</span>
              <span>{stepLabel}</span>
            </div>

            {activePage === 1 ? (
              <fieldset className="space-y-5 rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: `${secondaryColor}33` }}>
                <legend className="px-2 text-sm font-bold" style={{ color: primaryTextColor }}>{entityDisplayName} Information</legend>
                <div className="rounded-xl border bg-slate-50 px-3 py-2 text-xs font-semibold" style={{ borderColor: `${secondaryColor}22`, color: secondaryTextColor }}>
                  Provide partner hospital details, contact info, full address, and exact map pin.
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Hospital Name *</span>
                    <input
                      ref={setFieldRef('hospitalName')}
                      value={form.hospitalName}
                      onChange={updateField('hospitalName')}
                      className={fieldClassName}
                      style={fieldStyle}
                      placeholder="Example: Donivra Medical Center"
                      required
                    />
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Hospital Head / Owner Name *</span>
                    <input
                      ref={setFieldRef('hospitalHeadName')}
                      value={form.hospitalHeadName}
                      onChange={updateField('hospitalHeadName')}
                      className={fieldClassName}
                      style={fieldStyle}
                      placeholder="Full name of owner or hospital head"
                      required
                    />
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Head / Owner Position *</span>
                    <input
                      ref={setFieldRef('hospitalHeadTitle')}
                      value={form.hospitalHeadTitle}
                      onChange={updateField('hospitalHeadTitle')}
                      className={fieldClassName}
                      style={fieldStyle}
                      placeholder="Example: Medical Director"
                      required
                    />
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Head / Owner Contact Number *</span>
                    <input
                      ref={setFieldRef('hospitalHeadContactNumber')}
                      type="tel"
                      value={form.hospitalHeadContactNumber}
                      onChange={onContactNumberChange('hospitalHeadContactNumber')}
                      className={fieldClassName}
                      style={fieldStyle}
                      inputMode="numeric"
                      placeholder="+63 912 345 6789"
                      required
                    />
                    <p className="text-[11px]" style={{ color: secondaryTextColor }}>Format only: +63 912 345 6789</p>
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Head / Owner Email *</span>
                    <input
                      ref={setFieldRef('hospitalHeadEmail')}
                      type="email"
                      value={form.hospitalHeadEmail}
                      onChange={updateField('hospitalHeadEmail')}
                      className={fieldClassName}
                      style={fieldStyle}
                      placeholder="head@example.com"
                      required
                    />
                  </label>

                  <label className="space-y-2 text-sm md:col-span-2">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>
                      Hospital Logo (Upload Image)
                    </span>
                    <div
                      className="rounded-xl border border-dashed p-4 transition"
                      style={{
                        borderColor: isDraggingLogo ? primaryColor : `${secondaryColor}55`,
                        backgroundColor: isDraggingLogo ? `${primaryColor}12` : '#f8fafc',
                      }}
                      onDragOver={onLogoDragOver}
                      onDragEnter={onLogoDragOver}
                      onDragLeave={onLogoDragLeave}
                      onDrop={onLogoDrop}
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <label
                          htmlFor="hospitalLogo"
                          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border bg-white px-3 py-2 text-xs font-semibold"
                          style={{ borderColor: `${secondaryColor}55`, color: secondaryTextColor }}
                        >
                          <UploadCloud size={14} /> Choose Logo
                        </label>
                        <input
                          id="hospitalLogo"
                          ref={logoInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/jpg"
                          onChange={onLogoFileChange}
                          className="hidden"
                        />
                        <p className="text-xs" style={{ color: secondaryTextColor }}>
                          {isDraggingLogo
                            ? 'Drop your image here...'
                            : 'Drag and drop an image here, or click Choose Logo. PNG, JPG, or WEBP up to 5MB.'}
                        </p>
                      </div>

                      {logoFile ? (
                        <p className="mt-2 text-xs" style={{ color: secondaryTextColor }}>
                          Selected file: <span className="font-semibold">{logoFile.name}</span>
                        </p>
                      ) : null}

                      {logoPreviewUrl ? (
                        <div
                          className="mt-3 flex items-center justify-center overflow-hidden rounded-lg border bg-slate-50 p-3"
                          style={{ borderColor: `${secondaryColor}44` }}
                        >
                          <img
                            src={logoPreviewUrl}
                            alt="Logo preview"
                            className="max-h-56 max-w-[16rem] w-auto h-auto object-contain"
                          />
                        </div>
                      ) : null}
                    </div>
                  </label>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Street *</span>
                    <input
                      ref={setFieldRef('street')}
                      value={form.street}
                      onChange={updateField('street')}
                      className={fieldClassName}
                      style={fieldStyle}
                      placeholder="Street address"
                      required
                    />
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Country *</span>
                    <select
                      value={form.country}
                      onChange={onCountryChange}
                      className={fieldClassName}
                      style={fieldStyle}
                      required
                    >
                      <option value={DEFAULT_COUNTRY}>{DEFAULT_COUNTRY}</option>
                    </select>
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Region *</span>
                    <select
                      ref={setFieldRef('region')}
                      value={form.region}
                      onChange={onRegionChange}
                      disabled={!form.country || regionOptions.length === 0}
                      className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                      style={fieldStyle}
                      required
                    >
                      <option value="">Select region</option>
                      {regionOptions.map((region) => (
                        <option key={region.name} value={region.name}>
                          {region.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Province *</span>
                    <select
                      ref={setFieldRef('province')}
                      value={form.province}
                      onChange={onProvinceChange}
                      disabled={!form.region || provinceOptions.length === 0}
                      className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                      style={fieldStyle}
                      required
                    >
                      <option value="">Select province</option>
                      {provinceOptions.map((province) => (
                        <option key={province.name} value={province.name}>
                          {province.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1 text-sm">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>City / Municipality *</span>
                    <select
                      ref={setFieldRef('city')}
                      value={form.city}
                      onChange={onCityChange}
                      disabled={!form.province || cityOptions.length === 0}
                      className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                      style={fieldStyle}
                      required
                    >
                      <option value="">Select city / municipality</option>
                      {cityOptions.map((city) => (
                        <option key={city.name} value={city.name}>
                          {city.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1 text-sm md:col-span-2">
                    <span className="font-semibold" style={{ color: secondaryTextColor }}>Barangay</span>
                    {barangayOptions.length > 0 ? (
                      <select
                        value={form.barangay}
                        onChange={updateField('barangay')}
                        disabled={!form.city}
                        className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                        style={fieldStyle}
                      >
                        <option value="">Select barangay</option>
                        {barangayOptions.map((barangay) => (
                          <option key={barangay} value={barangay}>
                            {barangay}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={form.barangay}
                        onChange={updateField('barangay')}
                        className={fieldClassName}
                        style={fieldStyle}
                        placeholder="Type barangay if not listed"
                      />
                    )}
                  </label>
                </div>

                <div className="space-y-3">
                  <p className="text-sm font-semibold" style={{ color: secondaryTextColor }}>Exact Location Pin *</p>
                  <LocationPinPicker
                    latitude={selectedLatitude}
                    longitude={selectedLongitude}
                    onChange={onLocationPinChange}
                  />
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Latitude *</span>
                      <input
                        ref={setFieldRef('latitude')}
                        value={form.latitude}
                        onChange={updateField('latitude')}
                        className={fieldClassName}
                        style={fieldStyle}
                        placeholder="Auto-filled from map pin"
                        readOnly
                        required
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Longitude *</span>
                      <input
                        value={form.longitude}
                        onChange={updateField('longitude')}
                        className={fieldClassName}
                        style={fieldStyle}
                        placeholder="Auto-filled from map pin"
                        readOnly
                        required
                      />
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={autoPinFromHospitalAddress}
                      className="inline-flex items-center rounded-lg border bg-white px-3 py-2 text-xs font-semibold"
                      style={{ borderColor: `${secondaryColor}55`, color: secondaryTextColor }}
                    >
                      Auto-pin from selected address
                    </button>
                  </div>
                </div>
              </fieldset>
            ) : null}

            {activePage === 2 ? (
              <>
                <fieldset className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: `${secondaryColor}33` }}>
                  <legend className="px-2 text-sm font-bold" style={{ color: primaryTextColor }}>H-Representative Account Details</legend>
                  <div className="rounded-xl border bg-slate-50 px-3 py-2 text-xs font-semibold" style={{ borderColor: `${secondaryColor}22`, color: secondaryTextColor }}>
                    Enter the person who will use the H-Representative account for this hospital.
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>First Name *</span>
                      <input
                        ref={setFieldRef('firstName')}
                        value={form.firstName}
                        onChange={updateField('firstName')}
                        className={fieldClassName}
                        style={fieldStyle}
                        required
                      />
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Middle Name (Optional)</span>
                      <input
                        value={form.middleName}
                        onChange={updateField('middleName')}
                        className={fieldClassName}
                        style={fieldStyle}
                      />
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Last Name *</span>
                      <input
                        ref={setFieldRef('lastName')}
                        value={form.lastName}
                        onChange={updateField('lastName')}
                        className={fieldClassName}
                        style={fieldStyle}
                        required
                      />
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Suffix (Optional)</span>
                      <input
                        value={form.suffix}
                        onChange={updateField('suffix')}
                        className={fieldClassName}
                        style={fieldStyle}
                        placeholder="Jr., Sr., III"
                      />
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Birthdate (Optional)</span>
                      <input
                        type="date"
                        value={form.birthdate}
                        onChange={updateField('birthdate')}
                        className={fieldClassName}
                        style={fieldStyle}
                      />
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Gender (Optional)</span>
                      <select
                        value={form.gender}
                        onChange={updateField('gender')}
                        className={fieldClassName}
                        style={fieldStyle}
                      >
                        <option value="">Select gender</option>
                        {LEAD_GENDER_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>H-Representative Contact Number *</span>
                      <input
                        ref={setFieldRef('leadContactNumber')}
                        type="tel"
                        value={form.leadContactNumber}
                        onChange={onContactNumberChange('leadContactNumber')}
                        className={fieldClassName}
                        style={fieldStyle}
                        inputMode="numeric"
                        placeholder="+63 912 345 6789"
                        required
                      />
                      <p className="text-[11px]" style={{ color: secondaryTextColor }}>Format only: +63 912 345 6789</p>
                    </label>

                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>H-Representative Email *</span>
                      <input
                        ref={setFieldRef('email')}
                        type="email"
                        value={form.email}
                        onChange={updateField('email')}
                        className={fieldClassName}
                        style={fieldStyle}
                        placeholder="name@example.com"
                        required
                      />
                    </label>

                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Street *</span>
                      <input
                        ref={setFieldRef('leadStreet')}
                        value={form.leadStreet}
                        onChange={updateField('leadStreet')}
                        className={fieldClassName}
                        style={fieldStyle}
                        placeholder="Street address"
                        required
                      />
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Country *</span>
                      <select
                        value={form.leadCountry}
                        onChange={onLeadCountryChange}
                        className={fieldClassName}
                        style={fieldStyle}
                        required
                      >
                        <option value={DEFAULT_COUNTRY}>{DEFAULT_COUNTRY}</option>
                      </select>
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Region *</span>
                      <select
                        ref={setFieldRef('leadRegion')}
                        value={form.leadRegion}
                        onChange={onLeadRegionChange}
                        disabled={!form.leadCountry || leadRegionOptions.length === 0}
                        className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                        style={fieldStyle}
                        required
                      >
                        <option value="">Select region</option>
                        {leadRegionOptions.map((region) => (
                          <option key={region.name} value={region.name}>
                            {region.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Province *</span>
                      <select
                        ref={setFieldRef('leadProvince')}
                        value={form.leadProvince}
                        onChange={onLeadProvinceChange}
                        disabled={!form.leadRegion || leadProvinceOptions.length === 0}
                        className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                        style={fieldStyle}
                        required
                      >
                        <option value="">Select province</option>
                        {leadProvinceOptions.map((province) => (
                          <option key={province.name} value={province.name}>
                            {province.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1 text-sm">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>City / Municipality *</span>
                      <select
                        ref={setFieldRef('leadCity')}
                        value={form.leadCity}
                        onChange={onLeadCityChange}
                        disabled={!form.leadProvince || leadCityOptions.length === 0}
                        className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                        style={fieldStyle}
                        required
                      >
                        <option value="">Select city / municipality</option>
                        {leadCityOptions.map((city) => (
                          <option key={city.name} value={city.name}>
                            {city.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1 text-sm md:col-span-2">
                      <span className="font-semibold" style={{ color: secondaryTextColor }}>Barangay</span>
                      {leadBarangayOptions.length > 0 ? (
                        <select
                          value={form.leadBarangay}
                          onChange={updateField('leadBarangay')}
                          disabled={!form.leadCity}
                          className={`${fieldClassName} disabled:cursor-not-allowed disabled:opacity-60`}
                          style={fieldStyle}
                        >
                          <option value="">Select barangay</option>
                          {leadBarangayOptions.map((barangay) => (
                            <option key={barangay} value={barangay}>
                              {barangay}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={form.leadBarangay}
                          onChange={updateField('leadBarangay')}
                          className={fieldClassName}
                          style={fieldStyle}
                          placeholder="Type barangay if not listed"
                        />
                      )}
                    </label>
                  </div>
                </fieldset>

              </>
            ) : null}

            {activePage === 3 ? (
              <fieldset className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: `${secondaryColor}33` }}>
                <legend className="px-2 text-sm font-bold" style={{ color: primaryTextColor }}>Review & Confirmation</legend>
                <p className="text-sm" style={{ color: secondaryTextColor }}>Please confirm all details before proceeding to email verification.</p>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <section className="rounded-xl border bg-slate-50 p-3" style={{ borderColor: `${secondaryColor}22` }}>
                    <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: secondaryTextColor }}>Hospital Profile</p>
                    <div className="mt-2 space-y-1.5 text-sm text-slate-700">
                      <div><span className="font-semibold">Hospital Name:</span> {form.hospitalName || 'N/A'}</div>
                      <div><span className="font-semibold">Hospital Contact:</span> {form.hospitalHeadContactNumber || 'N/A'}</div>
                    </div>
                  </section>

                  <section className="rounded-xl border bg-slate-50 p-3" style={{ borderColor: `${secondaryColor}22` }}>
                    <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: secondaryTextColor }}>Head / Owner</p>
                    <div className="mt-2 space-y-1.5 text-sm text-slate-700">
                      <div><span className="font-semibold">Name:</span> {form.hospitalHeadName || 'N/A'}</div>
                      <div><span className="font-semibold">Position:</span> {form.hospitalHeadTitle || 'N/A'}</div>
                      <div><span className="font-semibold">Contact:</span> {form.hospitalHeadContactNumber || 'N/A'}</div>
                      <div><span className="font-semibold">Email:</span> {form.hospitalHeadEmail || 'N/A'}</div>
                    </div>
                  </section>

                  <section className="rounded-xl border bg-slate-50 p-3 md:col-span-2" style={{ borderColor: `${secondaryColor}22` }}>
                    <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: secondaryTextColor }}>Hospital Location</p>
                    <div className="mt-2 space-y-1.5 text-sm text-slate-700">
                      <div><span className="font-semibold">Address:</span> {[form.street, form.barangay, form.city, form.province, form.region, form.country].filter(Boolean).join(', ') || 'N/A'}</div>
                      <div><span className="font-semibold">Map Coordinates:</span> {form.latitude && form.longitude ? `${form.latitude}, ${form.longitude}` : 'N/A'}</div>
                    </div>
                  </section>

                  <section className="rounded-xl border bg-slate-50 p-3 md:col-span-2" style={{ borderColor: `${secondaryColor}22` }}>
                    <p className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: secondaryTextColor }}>H-Representative Account</p>
                    <div className="mt-2 grid grid-cols-1 gap-1.5 text-sm text-slate-700 md:grid-cols-2">
                      <div><span className="font-semibold">Name:</span> {[form.firstName, form.middleName, form.lastName, form.suffix].filter(Boolean).join(' ') || 'N/A'}</div>
                      <div><span className="font-semibold">Contact:</span> {form.leadContactNumber || 'N/A'}</div>
                      <div className="md:col-span-2"><span className="font-semibold">Email:</span> {form.email || 'N/A'}</div>
                      <div className="md:col-span-2"><span className="font-semibold">Address:</span> {[form.leadStreet, form.leadBarangay, form.leadCity, form.leadProvince, form.leadRegion, form.leadCountry].filter(Boolean).join(', ') || 'N/A'}</div>
                    </div>
                  </section>
                </div>
              </fieldset>
            ) : null}

            {activePage === 4 ? (
              <fieldset className="space-y-4 rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: `${secondaryColor}33` }}>
                <legend className="px-2 text-sm font-bold" style={{ color: primaryTextColor }}>Verify H-Representative Email</legend>
                <div className="rounded-xl border bg-slate-50 p-4" style={{ borderColor: `${secondaryColor}33` }}>
                  <p className="text-sm font-bold" style={{ color: primaryTextColor }}>Email Verification</p>
                  <p className="mt-1 text-xs" style={{ color: secondaryTextColor }}>
                    Send a code to the H-Representative email, then enter the 6-digit OTP below. Submission unlocks only after verification.
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
                    <span className="text-[11px]" style={{ color: secondaryTextColor }}>
                      Codes expire quickly for security.
                    </span>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                    <input
                      ref={setFieldRef('otpCode')}
                      value={otpCode}
                      onChange={(event) => setOtpCode(String(event.target.value || '').replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="Enter 6-digit code"
                      className={fieldClassName}
                      style={fieldStyle}
                    />
                    <button
                      type="button"
                      onClick={verifyEmailOtpCode}
                      disabled={isVerifyingOtp || otpCode.length !== 6 || !isValidEmail(normalizedEmail)}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border bg-white px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ borderColor: `${secondaryColor}55`, color: secondaryTextColor }}
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

                  {isEmailOtpVerified ? (
                    <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
                      <CheckCircle2 size={14} /> Email verified. You can now submit.
                    </p>
                  ) : (
                    <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                      <ShieldCheck size={14} /> Verify email first to enable submission.
                    </p>
                  )}
                </div>
              </fieldset>
            ) : null}

            {errorMessage ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                {errorMessage}
              </div>
            ) : null}

            {successMessage ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                <p className="inline-flex items-center gap-2 font-semibold"><CheckCircle2 size={16} /> Success</p>
                <p className="mt-1">{successMessage}</p>
              </div>
            ) : null}

            {activePage === 1 ? (
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={goBack}
                  className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold"
                  style={{ borderColor: `${secondaryColor}44`, color: secondaryTextColor }}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={goToLeadPage}
                  className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white"
                  style={{ backgroundColor: primaryColor }}
                >
                  Next: H-Representative Account
                </button>
              </div>
            ) : null}

            {activePage === 2 ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs" style={{ color: secondaryTextColor }}>
                  Confirm account details for the H-Representative user.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goToDetailsFromLeadPage}
                    className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold"
                    style={{ borderColor: `${secondaryColor}44`, color: secondaryTextColor }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={goToConfirmationPage}
                    className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Next: Review & Confirmation
                  </button>
                </div>
              </div>
            ) : null}

            {activePage === 3 ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs" style={{ color: secondaryTextColor }}>
                  By continuing, you confirm your details are accurate before email verification.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goToLeadPageFromConfirmation}
                    className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold"
                    style={{ borderColor: `${secondaryColor}44`, color: secondaryTextColor }}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={goToOtpPage}
                    className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Next: Email Verification
                  </button>
                </div>
              </div>
            ) : null}

            {activePage === 4 ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs" style={{ color: secondaryTextColor }}>
                  Submit once OTP verification is completed.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goBackToConfirmationFromOtp}
                    className="inline-flex items-center gap-2 rounded-xl border bg-white px-4 py-2.5 text-sm font-semibold"
                    style={{ borderColor: `${secondaryColor}44`, color: secondaryTextColor }}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || !canSubmit}
                    className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 size={16} className="animate-spin" /> Submitting...
                      </>
                    ) : (
                      canSubmit ? 'Submit Application' : 'Verify Email To Submit'
                    )}
                  </button>
                </div>
              </div>
            ) : null}
          </form>
        </section>
      </div>
    </div>
    </Wrapper>
  );
}

