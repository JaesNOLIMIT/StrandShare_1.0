import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info, Loader2, Save, MapPin, Search } from 'lucide-react';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { logAuditAction } from '../../../lib/auditLogger';
import philippineAddressOptions from '../../../data/philippineAddressOptions.json';
import 'maplibre-gl/dist/maplibre-gl.css';

const UI_SETTINGS_TABLE = 'UI_Settings';
const LOGISTICS_SETTINGS_TABLE = 'Logistics_Settings';
const DEFAULT_MAP_CENTER = { lat: 14.5995, lng: 120.9842 };
const DEFAULT_COUNTRY = 'Philippines';
const PHILIPPINE_ADDRESS_TREE = philippineAddressOptions && typeof philippineAddressOptions === 'object'
  ? philippineAddressOptions
  : {};
const MAP_SATELLITE_STYLE = {
  version: 8,
  sources: {
    esriSatellite: {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [
    {
      id: 'esriSatelliteLayer',
      type: 'raster',
      source: 'esriSatellite',
    },
  ],
};
const MAP_STREET_STYLE = {
  version: 8,
  sources: {
    openStreetMap: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'openStreetMapLayer',
      type: 'raster',
      source: 'openStreetMap',
    },
  ],
};

const DEFAULT_FORM = {
  destinationName: '',
  street: '',
  region: '',
  barangay: '',
  city: '',
  province: '',
  country: DEFAULT_COUNTRY,
  contactPerson: '',
  contactNumber: '',
  longitude: '',
  latitude: '',
};

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
  return localNumber ? `+63 ${localNumber}` : '+63 ';
}

function toStoredPhoneNumber(value = '') {
  const digits = normalizePhilippineMobile(value);
  return digits.length === 10
    ? `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`
    : '';
}

function optionExists(options = [], value = '') {
  const target = String(value || '').trim();
  if (!target) return false;

  return options.some((option) => {
    if (typeof option === 'string') {
      return option === target;
    }
    return String(option?.name || '').trim() === target;
  });
}

function normalizeRoleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function mapLoadError(rawMessage) {
  const message = String(rawMessage || 'Unable to load logistics destination settings.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('row-level security')) {
    return 'Viewing logistics destination settings is blocked by database policy. Please verify role permissions.';
  }

  if (lowerMessage.includes('relation') && lowerMessage.includes('logistics_settings') && lowerMessage.includes('does not exist')) {
    return 'Logistics_Settings table is missing. Run migration 057_logistics_destination_settings.sql, then refresh.';
  }

  return message;
}

function mapSaveError(rawMessage) {
  const message = String(rawMessage || 'Unable to save logistics destination settings.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('duplicate key value') || lowerMessage.includes('idx_logistics_settings_singleton')) {
    return 'Only one logistics destination record is allowed. Refresh and update the existing record.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Saving logistics destination settings is blocked by database policy. Only admin and staff can modify this page.';
  }

  if (lowerMessage.includes('relation') && lowerMessage.includes('logistics_settings') && lowerMessage.includes('does not exist')) {
    return 'Logistics_Settings table is missing. Run migration 057_logistics_destination_settings.sql, then refresh.';
  }

  return message;
}

function toNumberOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';

  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function LogisticsLocationPinPicker({ latitude, longitude, onChange, disabled = false }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const initialLatitudeRef = useRef(latitude);
  const initialLongitudeRef = useRef(longitude);
  const appliedMapViewRef = useRef('satellite');
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
  }, [onSelectSearchResult, searchQuery]);

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
      if (disabled) {
        return;
      }
      const nextLng = Number(event.lngLat.lng.toFixed(7));
      const nextLat = Number(event.lngLat.lat.toFixed(7));
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
  }, [disabled, updateMarkerAndLocation]);

  useEffect(() => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }
    updateMarkerAndLocation(latitude, longitude, { notify: false });
  }, [latitude, longitude, updateMarkerAndLocation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedMapViewRef.current === mapView) {
      return undefined;
    }

    const nextStyle = mapView === 'street' ? MAP_STREET_STYLE : MAP_SATELLITE_STYLE;
    const applyStyle = () => {
      if (mapRef.current !== map || appliedMapViewRef.current === mapView) return;
      map.setStyle(nextStyle);
      appliedMapViewRef.current = mapView;
    };

    if (map.isStyleLoaded()) {
      applyStyle();
      return undefined;
    }

    map.once('style.load', applyStyle);
    return () => map.off('style.load', applyStyle);
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
            disabled={disabled}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={runLocationSearch}
            disabled={isSearching || disabled}
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

export default function LogisticsDestinationSettingsPage({ userProfile }) {
  const { theme } = useTheme();

  const [uiSettings, setUiSettings] = useState(null);
  const [recordId, setRecordId] = useState(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [form, setForm] = useState(DEFAULT_FORM);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const roleKey = normalizeRoleKey(userProfile?.role);
  const canManage = roleKey === 'superadmin' || roleKey === 'staff';

  const primaryColor = uiSettings?.Primary_Color || theme.primaryColor || '#0f766e';
  const secondaryColor = uiSettings?.Secondary_Color || theme.secondaryColor || '#64748b';
  const backgroundColor = uiSettings?.Background_Color || theme.backgroundColor || '#f8fafc';
  const primaryTextColor = uiSettings?.Primary_Text_Color || theme.primaryTextColor || '#0f172a';
  const secondaryTextColor = uiSettings?.Secondary_Text_Color || theme.secondaryTextColor || '#334155';
  const headingFont = uiSettings?.Secondary_Font_Family || theme.secondaryFontFamily || theme.fontFamily || 'Poppins';
  const bodyFont = uiSettings?.Font_Family || theme.fontFamily || 'Poppins';

  const rootStyle = {
    color: primaryTextColor,
    fontFamily: `${bodyFont}, sans-serif`,
  };

  const hydrateFromRow = useCallback((row) => {
    if (!row) {
      setRecordId(null);
      setUpdatedAt('');
      setForm(DEFAULT_FORM);
      return;
    }

    setRecordId(Number(row.Logistics_Settings_ID || 0) || null);
    setUpdatedAt(String(row.Updated_At || ''));
    setForm({
      destinationName: String(row.Destination_Name || ''),
      street: String(row.Street || ''),
      region: String(row.Region || ''),
      barangay: String(row.Barangay || ''),
      city: String(row.City || ''),
      province: String(row.Province || ''),
      country: String(row.Country || DEFAULT_COUNTRY),
      contactPerson: String(row.Contact_Person || ''),
      contactNumber: normalizePhilippineMobile(String(row.Contact_Number || '')),
      longitude: row.Longitude === null || row.Longitude === undefined ? '' : String(row.Longitude),
      latitude: row.Latitude === null || row.Latitude === undefined ? '' : String(row.Latitude),
    });
  }, []);

  const fetchUiSettings = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;

    const { data, error } = await supabase
      .from(UI_SETTINGS_TABLE)
      .select('*')
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      setUiSettings(data);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      hydrateFromRow(null);
      return;
    }

    try {
      setIsLoading(true);
      setNotice({ kind: '', text: '' });

      const { data, error } = await supabase
        .from(LOGISTICS_SETTINGS_TABLE)
        .select('*')
        .order('Logistics_Settings_ID', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      hydrateFromRow(data || null);
    } catch (error) {
      setNotice({ kind: 'error', text: mapLoadError(error?.message) });
    } finally {
      setIsLoading(false);
    }
  }, [hydrateFromRow]);

  useEffect(() => {
    void fetchUiSettings();
    void loadSettings();
  }, [fetchUiSettings, loadSettings]);

  const cards = useMemo(() => {
    const fullAddress = [form.street, form.barangay, form.city, form.province, form.region, form.country]
      .filter((item) => String(item || '').trim())
      .join(', ');

    return [
      { label: 'Destination', value: form.destinationName || 'Not set' },
      { label: 'City / Province', value: [form.city, form.province].filter(Boolean).join(', ') || 'Not set' },
      { label: 'Contact Person', value: form.contactPerson || 'Not set' },
      { label: 'Contact Number', value: toStoredPhoneNumber(form.contactNumber) || 'Not set' },
      { label: 'Address', value: fullAddress || 'Not set' },
    ];
  }, [form]);

  const regionOptions = useMemo(() => toUnifiedRegionOptions(PHILIPPINE_ADDRESS_TREE), []);
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

  const handleFieldChange = (field) => (event) => {
    const nextValue = event.target.value;
    setForm((prev) => ({ ...prev, [field]: nextValue }));
  };

  const handleContactNumberChange = (event) => {
    const digits = normalizePhilippineMobile(event.target.value);
    setForm((prev) => ({
      ...prev,
      contactNumber: digits,
    }));
  };

  const handleRegionChange = (event) => {
    const regionName = event.target.value;
    setForm((prev) => ({
      ...prev,
      region: regionName,
      province: '',
      city: '',
      barangay: '',
    }));
  };

  const handleProvinceChange = (event) => {
    const provinceName = event.target.value;
    setForm((prev) => ({
      ...prev,
      province: provinceName,
      city: '',
      barangay: '',
    }));
  };

  const handleCityChange = (event) => {
    const cityName = event.target.value;
    setForm((prev) => ({
      ...prev,
      city: cityName,
      barangay: '',
    }));
  };
  const numericLatitude = toNumberOrNull(form.latitude);
  const numericLongitude = toNumberOrNull(form.longitude);

  const handleLocationPinChange = useCallback((nextLat, nextLng) => {
    setForm((prev) => ({
      ...prev,
      latitude: Number(nextLat).toFixed(7),
      longitude: Number(nextLng).toFixed(7),
    }));
  }, []);

  const handleSave = async () => {
    if (!canManage) {
      setNotice({ kind: 'error', text: 'Only admin and staff can update logistics destination settings.' });
      return;
    }

    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured. Saving is unavailable.' });
      return;
    }

    const destinationName = String(form.destinationName || '').trim();
    if (!destinationName) {
      setNotice({ kind: 'error', text: 'Destination name is required.' });
      return;
    }

    const longitude = toNumberOrNull(form.longitude);
    const latitude = toNumberOrNull(form.latitude);

    if (String(form.longitude || '').trim() && longitude === null) {
      setNotice({ kind: 'error', text: 'Longitude must be a valid number.' });
      return;
    }

    if (String(form.latitude || '').trim() && latitude === null) {
      setNotice({ kind: 'error', text: 'Latitude must be a valid number.' });
      return;
    }

    if (longitude !== null && (longitude < -180 || longitude > 180)) {
      setNotice({ kind: 'error', text: 'Longitude must be between -180 and 180.' });
      return;
    }

    if (latitude !== null && (latitude < -90 || latitude > 90)) {
      setNotice({ kind: 'error', text: 'Latitude must be between -90 and 90.' });
      return;
    }

    if (String(form.contactNumber || '').trim() && normalizePhilippineMobile(form.contactNumber).length !== 10) {
      setNotice({ kind: 'error', text: 'Contact number must be complete and follow +63 912 345 6789 format.' });
      return;
    }

    const payload = {
      Destination_Name: destinationName,
      Street: String(form.street || '').trim() || null,
      Region: String(form.region || '').trim() || null,
      Barangay: String(form.barangay || '').trim() || null,
      City: String(form.city || '').trim() || null,
      Province: String(form.province || '').trim() || null,
      Country: String(form.country || '').trim() || DEFAULT_COUNTRY,
      Contact_Person: String(form.contactPerson || '').trim() || null,
      Contact_Number: toStoredPhoneNumber(form.contactNumber) || null,
      Longitude: longitude,
      Latitude: latitude,
      Updated_At: new Date().toISOString(),
    };

    try {
      setIsSaving(true);
      setNotice({ kind: '', text: '' });

      if (recordId) {
        const { error } = await supabase
          .from(LOGISTICS_SETTINGS_TABLE)
          .update(payload)
          .eq('Logistics_Settings_ID', recordId);

        if (error) throw error;
      } else {
        const { data: insertedRow, error } = await supabase
          .from(LOGISTICS_SETTINGS_TABLE)
          .insert(payload)
          .select('*')
          .maybeSingle();

        if (error) throw error;
        setRecordId(Number(insertedRow?.Logistics_Settings_ID || 0) || null);
      }

      await logAuditAction({
        userProfile,
        action: 'logistics_settings.save',
        description: 'Saved logistics destination settings.',
        resource: 'Logistics_Settings',
        status: 'success',
      });

      setNotice({ kind: 'success', text: 'Logistics destination settings saved successfully.' });
      await loadSettings();
    } catch (error) {
      setNotice({ kind: 'error', text: mapSaveError(error?.message) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6" style={rootStyle}>
      <section className="rounded-2xl border bg-white p-6 shadow-sm" style={{ borderColor: `${secondaryColor}30`, backgroundColor }}>
        <div>
          <div>
            <h2 className="text-2xl font-bold" style={{ color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` }}>
              Logistics Destination Settings
            </h2>
            <p className="mt-1 text-sm" style={{ color: secondaryTextColor }}>
              Maintain the single global logistics destination record shown to users.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {cards.map((card) => (
            <article key={card.label} className="rounded-xl border bg-white p-4" style={{ borderColor: `${secondaryColor}33` }}>
              <p className="text-sm" style={{ color: secondaryTextColor }}>{card.label}</p>
              <p className="mt-1 text-sm font-semibold" style={{ color: primaryTextColor }}>{card.value}</p>
            </article>
          ))}
        </div>
      </section>

      {notice.text ? (
        <div className={`rounded-lg border px-4 py-3 text-sm ${notice.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
          {notice.kind === 'success' ? notice.text : `Error: ${notice.text}`}
        </div>
      ) : null}

      <section className="rounded-2xl border bg-white p-6 shadow-sm" style={{ borderColor: `${secondaryColor}30` }}>
        <div className="mb-4 flex items-center gap-2 text-sm" style={{ color: secondaryTextColor }}>
          <MapPin size={15} />
          <span>Exactly one row is allowed in this table.</span>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Destination Name *
            </label>
            <input
              value={form.destinationName}
              onChange={handleFieldChange('destinationName')}
              disabled={!canManage || isSaving}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Contact Person
            </label>
            <input
              value={form.contactPerson}
              onChange={handleFieldChange('contactPerson')}
              disabled={!canManage || isSaving}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Contact Number
            </label>
            <input
              value={formatPhilippineMobileWithCountry(form.contactNumber)}
              onChange={handleContactNumberChange}
              disabled={!canManage || isSaving}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
            <p className="mt-1 text-xs" style={{ color: secondaryTextColor }}>Format: +63 912 345 6789</p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Country
            </label>
            <input
              value={form.country}
              readOnly
              disabled
              className="w-full rounded-lg border bg-slate-50 px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Street
            </label>
            <input
              value={form.street}
              onChange={handleFieldChange('street')}
              disabled={!canManage || isSaving}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Region
            </label>
            <select
              value={form.region}
              onChange={handleRegionChange}
              disabled={!canManage || isSaving}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            >
              <option value="">Select region</option>
              {form.region && !optionExists(regionOptions, form.region) ? (
                <option value={form.region}>{form.region} (saved)</option>
              ) : null}
              {regionOptions.map((region) => (
                <option key={region.name} value={region.name}>{region.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Province
            </label>
            <select
              value={form.province}
              onChange={handleProvinceChange}
              disabled={!canManage || isSaving || !form.region}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            >
              <option value="">Select province</option>
              {form.province && !optionExists(provinceOptions, form.province) ? (
                <option value={form.province}>{form.province} (saved)</option>
              ) : null}
              {provinceOptions.map((province) => (
                <option key={province.name} value={province.name}>{province.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              City / Municipality
            </label>
            <select
              value={form.city}
              onChange={handleCityChange}
              disabled={!canManage || isSaving || !form.province}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            >
              <option value="">Select city/municipality</option>
              {form.city && !optionExists(cityOptions, form.city) ? (
                <option value={form.city}>{form.city} (saved)</option>
              ) : null}
              {cityOptions.map((city) => (
                <option key={city.name} value={city.name}>{city.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Barangay
            </label>
            <select
              value={form.barangay}
              onChange={handleFieldChange('barangay')}
              disabled={!canManage || isSaving || !form.city}
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            >
              <option value="">{barangayOptions.length ? 'Select barangay' : 'No barangay options'}</option>
              {form.barangay && !optionExists(barangayOptions, form.barangay) ? (
                <option value={form.barangay}>{form.barangay} (saved)</option>
              ) : null}
              {barangayOptions.map((barangay) => (
                <option key={barangay} value={barangay}>{barangay}</option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Pin Destination (MapLibre)
            </label>
            <LogisticsLocationPinPicker
              latitude={Number.isFinite(numericLatitude) ? numericLatitude : null}
              longitude={Number.isFinite(numericLongitude) ? numericLongitude : null}
              onChange={handleLocationPinChange}
              disabled={!canManage || isSaving}
            />
            <p className="mt-1 text-xs" style={{ color: secondaryTextColor }}>
              Click the map or search a location to set exact latitude and longitude.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Latitude
            </label>
            <input
              value={form.latitude}
              onChange={handleFieldChange('latitude')}
              disabled={!canManage || isSaving}
              type="number"
              step="0.000001"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider" style={{ color: secondaryTextColor }}>
              Longitude
            </label>
            <input
              value={form.longitude}
              onChange={handleFieldChange('longitude')}
              disabled={!canManage || isSaving}
              type="number"
              step="0.000001"
              className="w-full rounded-lg border px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderColor: `${secondaryColor}44` }}
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: `${secondaryColor}30` }}>
          <div className="flex items-center gap-2 text-xs" style={{ color: secondaryTextColor }}>
            <Info size={14} /> Last updated: {formatDateTime(updatedAt)}
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canManage || isSaving || isLoading}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: primaryColor }}
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Settings
          </button>
        </div>
      </section>
    </div>
  );
}
