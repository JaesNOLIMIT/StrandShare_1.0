import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  Image as ImageIcon,
  Inbox,
  Info,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Satellite,
  Search,
  Send,
  ShieldAlert,
  User,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import { useTheme } from '../../../context/ThemeContext';
import { triggerSmtpNow } from '../../../lib/smtpTriggerClient';
import PageHeaderActions from '../../../components/PageHeaderActions';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const EVENT_REQUESTS_TABLE = 'Event_Requests';
const USERS_TABLE = 'users';
const PRIVATE_ID_BUCKET = 'event_application_private_ids';
const LEGACY_EVENT_ASSETS_BUCKET = 'event_application_assets';

function normalizePrivateIdObjectPath(value) {
  const raw = String(value || '').trim().replace(/^\/+/, '');
  if (!raw) return '';
  const bucketPrefix = `${PRIVATE_ID_BUCKET}/`;
  return raw.startsWith(bucketPrefix) ? raw.slice(bucketPrefix.length) : raw;
}

function resolveLegacyApplicantIdUrl(path, storedUrl) {
  if (!path.startsWith('applicant-valid-ids/')) return '';
  const existingUrl = String(storedUrl || '').trim();
  if (existingUrl) return existingUrl;
  return supabase?.storage.from(LEGACY_EVENT_ASSETS_BUCKET).getPublicUrl(path).data?.publicUrl || '';
}

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusLabel(value) {
  const key = normalizeStatus(value);
  if (key === 'pendingstaffreview') return 'Pending Staff Review';
  if (key === 'pendingadmindecision') return 'Pending Admin Decision';
  if (key === 'approved') return 'Approved';
  if (key === 'rejected') return 'Rejected';
  if (key === 'appealed') return 'Appealed';
  if (key === 'withdrawn') return 'Withdrawn';
  if (key === 'closed') return 'Closed';
  return value || 'N/A';
}

function statusPillClass(value) {
  const key = normalizeStatus(value);
  if (key === 'pendingstaffreview') return 'border border-amber-200 bg-amber-50 text-amber-700';
  if (key === 'pendingadmindecision') return 'border border-sky-200 bg-sky-50 text-sky-700';
  if (key === 'approved') return 'border border-emerald-200 bg-emerald-50 text-emerald-700';
  if (key === 'rejected') return 'border border-rose-200 bg-rose-50 text-rose-700';
  if (key === 'appealed') return 'border border-violet-200 bg-violet-50 text-violet-700';
  return 'border border-slate-200 bg-slate-100 text-slate-700';
}

function normalizeEventVisibility(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (key === 'private') return 'Private';
  return 'Public';
}

function preferredContactMethodLabel(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return ['phone', 'call', 'phonecall', 'sms'].includes(key) ? 'Phone' : 'Email';
}

function validIdTypeLabel(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const labels = {
    philsys: 'PhilSys National ID',
    driverslicense: "Driver's License",
    passport: 'Philippine Passport',
    umid: 'UMID',
    prc: 'PRC ID',
    postal: 'Postal ID',
    voters: "Voter's ID",
    seniorcitizen: 'Senior Citizen ID',
    othergovernment: 'Other Government ID',
  };
  return labels[key] || value || 'N/A';
}

function ContactLink({ type, value }) {
  const normalized = String(value || '').trim();
  if (!normalized) return <span className="text-slate-500">Not provided</span>;
  const href = type === 'Phone'
    ? `tel:${normalized.replace(/[^+\d]/g, '')}`
    : `mailto:${normalized}`;
  return <a href={href} className="font-semibold text-teal-700 hover:underline">{normalized}</a>;
}

function applicantFullName(row) {
  return [row?.Applicant_First_Name, row?.Applicant_Middle_Name, row?.Applicant_Last_Name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ') || 'Unknown applicant';
}

function applicantInitials(row) {
  const name = applicantFullName(row);
  if (!name || name === 'Unknown applicant') return '?';
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || '?';
}

function extractVenueName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'N/A';
  const firstSegment = raw.split(',')[0]?.trim();
  return firstSegment || raw;
}

function toIsoOrNull(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
  return normalized.replace('T', ' ');
}

function toDateTimeLocalInput(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function toNumberOrNull(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getUtc8SqlNow() {
  const now = new Date();
  const utcMilliseconds = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  const utc8 = new Date(utcMilliseconds + (8 * 60 * 60 * 1000));
  return utc8.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeNote(value) {
  return String(value || '').trim();
}

function toProgramDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const sqlDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (sqlDateMatch && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return `${sqlDateMatch[1]}-${sqlDateMatch[2]}-${sqlDateMatch[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateKeyFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayProgramDateKey() {
  return toProgramDateKey(new Date().toISOString());
}

function formatProgramDateLabel(dateKey, options = {}) {
  if (!dateKey) return 'No date selected';
  const parsed = new Date(`${dateKey}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return dateKey;
  return parsed.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: options.short ? 'short' : 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function applicationProgramDateKeys(row) {
  const startKey = toProgramDateKey(row?.Proposed_Start_At);
  const endKey = toProgramDateKey(row?.Proposed_End_At) || startKey;
  if (!startKey) return [];
  if (!endKey || endKey < startKey) return [startKey];

  const keys = [];
  const cursor = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  while (cursor <= end && keys.length < 370) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function calendarStatusDotClass(status) {
  const key = normalizeStatus(status);
  if (key === 'pendingstaffreview') return 'bg-amber-500';
  if (key === 'pendingadmindecision') return 'bg-sky-500';
  if (key === 'approved') return 'bg-emerald-500';
  if (key === 'rejected') return 'bg-rose-500';
  if (key === 'appealed') return 'bg-violet-500';
  return 'bg-slate-400';
}

function ApplicationQueueCalendar({
  month,
  selectedDate,
  applicationsByDate,
  onMonthChange,
  onSelectDate,
  primaryColor,
}) {
  const todayKey = todayProgramDateKey();
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, monthIndex, 1);
    const gridStart = new Date(year, monthIndex, 1 - firstDay.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [monthIndex, year]);

  const selectedApplications = selectedDate ? (applicationsByDate.get(selectedDate) || []) : [];
  const selectedHasReservedProgram = selectedApplications.some(
    (row) => normalizeStatus(row.Status) !== 'rejected',
  );
  const selectedIsAvailable = Boolean(
    selectedDate
    && selectedDate >= todayKey
    && !selectedHasReservedProgram,
  );

  const moveMonth = (amount) => {
    onMonthChange(new Date(year, monthIndex + amount, 1));
  };

  const goToToday = () => {
    const [todayYear, todayMonth] = todayKey.split('-').map(Number);
    onMonthChange(new Date(todayYear, todayMonth - 1, 1));
    onSelectDate(todayKey);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-500" />
          <p className="text-xs font-bold text-slate-800">
            {month.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => moveMonth(-1)}
            className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-100"
            aria-label="Previous month"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={goToToday}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => moveMonth(1)}
            className="rounded-md border border-slate-200 bg-white p-1 text-slate-600 hover:bg-slate-100"
            aria-label="Next month"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-7 text-center text-[9px] font-bold uppercase tracking-wide text-slate-400">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1">
        {calendarDays.map((date) => {
          const dateKey = dateKeyFromDate(date);
          const dateApplications = applicationsByDate.get(dateKey) || [];
          const isCurrentMonth = date.getMonth() === monthIndex;
          const isSelected = selectedDate === dateKey;
          const isToday = todayKey === dateKey;
          const hasReservedProgram = dateApplications.some(
            (row) => normalizeStatus(row.Status) !== 'rejected',
          );
          const isAvailable = dateKey >= todayKey && !hasReservedProgram;
          const statusKeys = [...new Set(dateApplications.map((row) => normalizeStatus(row.Status)))].slice(0, 3);
          const statusSummary = dateApplications.length > 0
            ? `${dateApplications.length} application${dateApplications.length === 1 ? '' : 's'}`
            : (isAvailable ? 'Open date' : 'No applications');

          return (
            <button
              key={dateKey}
              type="button"
              onClick={() => {
                onSelectDate(dateKey);
                if (!isCurrentMonth) onMonthChange(new Date(date.getFullYear(), date.getMonth(), 1));
              }}
              className={`relative flex h-10 flex-col items-center justify-center rounded-lg border text-[11px] font-semibold transition ${
                isSelected
                  ? 'border-transparent text-white shadow-sm'
                  : isAvailable
                    ? 'border-dashed border-slate-300 bg-white text-slate-700 hover:border-slate-500'
                    : 'border-transparent bg-white text-slate-700 hover:border-slate-300'
              } ${isCurrentMonth ? '' : 'opacity-40'} ${isToday && !isSelected ? 'ring-1 ring-slate-400' : ''}`}
              style={isSelected ? { backgroundColor: primaryColor } : undefined}
              title={`${formatProgramDateLabel(dateKey, { short: true })}: ${statusSummary}`}
              aria-label={`${formatProgramDateLabel(dateKey)}. ${statusSummary}`}
            >
              <span>{date.getDate()}</span>
              {dateApplications.length > 0 ? (
                <span className="mt-0.5 flex items-center gap-0.5">
                  {statusKeys.map((statusKey) => (
                    <span
                      key={statusKey}
                      className={`h-1.5 w-1.5 rounded-full ${calendarStatusDotClass(statusKey)} ${isSelected ? 'ring-1 ring-white/70' : ''}`}
                    />
                  ))}
                </span>
              ) : isAvailable ? (
                <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${isSelected ? 'bg-white' : 'border border-slate-400 bg-white'}`} />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-semibold text-slate-500">
        {[
          ['border border-slate-400 bg-white', 'Open date'],
          ['bg-amber-500', 'Pending Staff'],
          ['bg-sky-500', 'Pending Admin'],
          ['bg-emerald-600', 'Approved'],
          ['bg-rose-500', 'Rejected'],
          ['bg-violet-500', 'Appealed'],
        ].map(([dotClass, label]) => (
          <span key={label} className="inline-flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
            {label}
          </span>
        ))}
      </div>

      {selectedDate && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div>
            <p className="text-[11px] font-bold text-slate-800">{formatProgramDateLabel(selectedDate)}</p>
            <p className="text-[10px] text-slate-500">
              {selectedApplications.length > 0
                ? `${selectedApplications.length} application${selectedApplications.length === 1 ? '' : 's'} on this date${selectedIsAvailable ? ' â€” open for a new application' : ''}`
                : (selectedIsAvailable ? 'Open date â€” no active program scheduled' : 'No program scheduled')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onSelectDate('')}
            className="rounded-md border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function createRequestDraftFromApplication(row) {
  const posterPhotoUrl = String(row?.Event_Poster_Photo_URL || '').trim();
  const placePhotoUrl = String(row?.Event_Place_Photo_URL || '').trim();

  return {
    eventName: String(row?.Event_Name || '').trim(),
    startDate: toDateTimeLocalInput(row?.Proposed_Start_At),
    endDate: toDateTimeLocalInput(row?.Proposed_End_At),
    venueName: extractVenueName(row?.Venue_Address),
    country: String(row?.Country || 'Philippines').trim() || 'Philippines',
    region: String(row?.Region || '').trim(),
    province: String(row?.Province || '').trim(),
    cityMunicipality: String(row?.City || '').trim(),
    barangay: String(row?.Barangay || '').trim(),
    street: String(row?.Street || '').trim(),
    latitude: row?.Latitude ?? '',
    longitude: row?.Longitude ?? '',
    eventPhotoUrl: posterPhotoUrl || placePhotoUrl,
    eventVisibility: normalizeEventVisibility(row?.Event_Visibility),
    eventBy: applicantFullName(row),
    partneredWith: String(row?.Social_Page_Name || '').trim(),
    partnerSocialMediaLink: String(row?.Social_Page_URL || '').trim(),
  };
}

function Modal({ open, onClose, title, description, icon: Icon, accentColor, children, footer, maxWidth = '2xl' }) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setVisible(true));
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        cancelAnimationFrame(id);
        document.body.style.overflow = previousOverflow;
      };
    }
    setVisible(false);
    const timeout = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!mounted || typeof document === 'undefined') return null;

  const widthClass = {
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
    '3xl': 'max-w-3xl',
  }[maxWidth] || 'max-w-2xl';

  const overlay = (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6 transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ pointerEvents: visible ? 'auto' : 'none' }}
    >
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className="absolute inset-0 h-full w-full bg-slate-900/60 backdrop-blur-sm"
      />
      <div
        className={`relative flex w-full ${widthClass} max-h-[92vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-200 ease-out ${
          visible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.98] opacity-0'
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start gap-3">
            {Icon && (
              <div
                className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-white"
                style={{ backgroundColor: accentColor || '#0f766e' }}
              >
                <Icon size={18} />
              </div>
            )}
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-900">{title}</h3>
              {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

function MapPreview({ latitude, longitude, label }) {
  const [mapType, setMapType] = useState('m');
  const lat = Number(latitude);
  const lng = Number(longitude);
  const hasCoords = latitude !== null
    && latitude !== undefined
    && longitude !== null
    && longitude !== undefined
    && String(latitude).trim() !== ''
    && String(longitude).trim() !== ''
    && Number.isFinite(lat)
    && Number.isFinite(lng);

  if (!hasCoords) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
        <MapPin size={20} className="text-slate-400" />
        <p className="mt-1.5 text-sm font-semibold text-slate-700">Pin location unavailable</p>
        <p className="text-xs text-slate-500">No latitude / longitude was provided in this application.</p>
      </div>
    );
  }

  const embedSrc = `https://maps.google.com/maps?q=${lat},${lng}&z=17&t=${mapType}&output=embed&hl=en`;
  const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  const openMapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            onClick={() => setMapType('m')}
            className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold transition ${
              mapType === 'm' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <MapPin size={11} /> Map
          </button>
          <button
            type="button"
            onClick={() => setMapType('k')}
            className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold transition ${
              mapType === 'k' ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Satellite size={11} /> Satellite
          </button>
        </div>
        <div className="flex items-center gap-1">
          <a
            href={streetViewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-teal-700 transition hover:bg-slate-100"
          >
            Street View <ExternalLink size={10} />
          </a>
          <a
            href={openMapUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Open <ExternalLink size={10} />
          </a>
        </div>
      </div>
      <iframe
        title={label || 'Event venue map'}
        src={embedSrc}
        className="block w-full"
        style={{ height: '280px', border: 0 }}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        allowFullScreen
      />
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <MapPin size={11} />
          Pin: {lat.toFixed(6)}, {lng.toFixed(6)}
        </span>
        <span className="font-semibold uppercase tracking-wide text-slate-400">
          {mapType === 'k' ? 'Satellite view' : 'Map view'}
        </span>
      </div>
    </div>
  );
}

function InfoItem({ icon: Icon, label, children, span }) {
  return (
    <div className={`flex items-start gap-2.5 ${span === 2 ? 'md:col-span-2' : ''}`}>
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-slate-100 text-slate-500">
        <Icon size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <div className="text-sm text-slate-800 break-words">{children}</div>
      </div>
    </div>
  );
}

function AttachmentTile({ url, label }) {
  if (!url) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center">
        <ImageIcon size={18} className="text-slate-400" />
        <p className="mt-1.5 text-xs font-semibold text-slate-600">{label}</p>
        <p className="text-[11px] text-slate-400">Not provided</p>
      </div>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="group block overflow-hidden rounded-lg border border-slate-200 bg-slate-50 transition hover:border-slate-400 hover:shadow-md"
    >
      <div className="aspect-[4/3] w-full overflow-hidden bg-slate-100">
        <img
          src={url}
          alt={label}
          className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-3 py-1.5">
        <span className="text-xs font-semibold text-slate-700">{label}</span>
        <ExternalLink size={12} className="text-slate-400 group-hover:text-slate-700" />
      </div>
    </a>
  );
}

export default function EventApplicationIntakePage({ userProfile, isActivePage = true }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [rows, setRows] = useState([]);
  const [eventRequestsById, setEventRequestsById] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [privateIdUrl, setPrivateIdUrl] = useState('');
  const [staffUserId, setStaffUserId] = useState(userProfile?.user_id || null);
  const [staffNotes, setStaffNotes] = useState('');
  const [contactNotes, setContactNotes] = useState('');
  const [savedStaffNotes, setSavedStaffNotes] = useState('');
  const [savedContactNotes, setSavedContactNotes] = useState('');
  const [staffRejectionReason, setStaffRejectionReason] = useState('');
  const [requestDraft, setRequestDraft] = useState(createRequestDraftFromApplication(null));
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitStep, setSubmitStep] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedCalendarDate, setSelectedCalendarDate] = useState('');
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const [year, month] = todayProgramDateKey().split('-').map(Number);
    return new Date(year, month - 1, 1);
  });
  const initializedApplicationIdRef = useRef(null);

  const resolveStaffUserId = useCallback(async () => {
    if (staffUserId) return staffUserId;
    if (!supabase) return null;

    const { data: sessionData } = await supabase.auth.getSession();
    const authUserId = sessionData?.session?.user?.id || null;
    if (!authUserId) return null;

    const profileResult = await supabase
      .from(USERS_TABLE)
      .select('user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    const resolvedId = profileResult?.data?.user_id || null;
    setStaffUserId(resolvedId);
    return resolvedId;
  }, [staffUserId]);

  const loadRows = useCallback(async ({ silent = false } = {}) => {
    if (!isSupabaseConfigured || !supabase) {
      setRows([]);
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }

    if (!silent) {
      setIsLoading(true);
      setNotice({ kind: '', text: '' });
    }

    try {
      const result = await supabase
        .from(EVENT_APPLICATIONS_TABLE)
        .select('*')
        .order('Created_At', { ascending: true })
        .limit(400);

      if (result.error) throw result.error;

      const nextRows = result.data || [];
      setRows(nextRows);

      const linkedRequestIds = [...new Set(
        nextRows
          .map((row) => Number(row.Linked_Event_Request_ID || 0))
          .filter((value) => value > 0),
      )];

      if (linkedRequestIds.length > 0) {
        const requestResult = await supabase
          .from(EVENT_REQUESTS_TABLE)
          .select('Event_Request_ID, Status, Admin_Decision_Reason, Admin_Reviewed_At, Updated_At')
          .in('Event_Request_ID', linkedRequestIds);

        if (requestResult.error) throw requestResult.error;

        const map = {};
        (requestResult.data || []).forEach((requestRow) => {
          map[Number(requestRow.Event_Request_ID || 0)] = requestRow;
        });
        setEventRequestsById(map);
      } else {
        setEventRequestsById({});
      }
    } catch (error) {
      if (!silent) setRows([]);
      setNotice({ kind: 'error', text: error.message || 'Unable to load program applications.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  // Realtime: keep applications + linked requests in sync without refetching
  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase) return undefined;

    const applicationsChannel = supabase
      .channel('event-applications-intake-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: EVENT_APPLICATIONS_TABLE },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setRows((prev) => {
              const newRow = payload.new;
              if (!newRow) return prev;
              const exists = prev.some((row) => Number(row.Event_Application_ID) === Number(newRow.Event_Application_ID));
              return exists ? prev : [...prev, newRow];
            });
          } else if (payload.eventType === 'UPDATE') {
            setRows((prev) => prev.map((row) => (
              Number(row.Event_Application_ID) === Number(payload.new?.Event_Application_ID)
                ? payload.new
                : row
            )));
          } else if (payload.eventType === 'DELETE') {
            setRows((prev) => prev.filter((row) => (
              Number(row.Event_Application_ID) !== Number(payload.old?.Event_Application_ID)
            )));
          }
        },
      )
      .subscribe();

    const requestsChannel = supabase
      .channel('event-requests-intake-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: EVENT_REQUESTS_TABLE },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            setEventRequestsById((prev) => {
              const next = { ...prev };
              delete next[Number(payload.old?.Event_Request_ID)];
              return next;
            });
          } else if (payload.new) {
            setEventRequestsById((prev) => ({
              ...prev,
              [Number(payload.new.Event_Request_ID)]: payload.new,
            }));
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(applicationsChannel);
      supabase.removeChannel(requestsChannel);
    };
  }, [isActivePage, loadRows]);

  const selectedRow = useMemo(() => {
    return rows.find((row) => Number(row.Event_Application_ID || 0) === Number(selectedId || 0)) || null;
  }, [rows, selectedId]);

  useEffect(() => {
    let cancelled = false;
    setPrivateIdUrl('');
    const path = normalizePrivateIdObjectPath(selectedRow?.Applicant_Valid_ID_Path);
    const legacyUrl = resolveLegacyApplicantIdUrl(path, selectedRow?.Applicant_Valid_ID_URL);
    if (legacyUrl) {
      setPrivateIdUrl(legacyUrl);
      return undefined;
    }
    if (!path.startsWith('verified-sessions/') || !supabase) return undefined;

    supabase.storage.from(PRIVATE_ID_BUCKET).createSignedUrl(path, 10 * 60)
      .then(({ data, error }) => {
        if (!cancelled && !error) setPrivateIdUrl(data?.signedUrl || '');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedRow?.Applicant_Valid_ID_Path, selectedRow?.Applicant_Valid_ID_URL]);

  const selectedLinkedRequest = useMemo(() => {
    const requestId = Number(selectedRow?.Linked_Event_Request_ID || 0);
    if (requestId <= 0) return null;
    return eventRequestsById[requestId] || null;
  }, [eventRequestsById, selectedRow]);

  const linkedRequestStatusKey = useMemo(
    () => normalizeStatus(selectedLinkedRequest?.Status),
    [selectedLinkedRequest],
  );

  const isLinkedToAdmin = Boolean(selectedRow?.Linked_Event_Request_ID);
  const applicationStatusKey = normalizeStatus(selectedRow?.Status);
  const isAutomaticallyRejectedApplication = applicationStatusKey === 'rejected'
    && Boolean(selectedRow?.Auto_Rejected_At);
  const isStaffRejectedApplication = applicationStatusKey === 'rejected'
    && Number(selectedRow?.Staff_Rejected_By_User_ID || 0) > 0;
  const isFinalRejectedApplication = isStaffRejectedApplication || isAutomaticallyRejectedApplication;
  const canAppealRejectedRequest = Boolean(
    isLinkedToAdmin
    && linkedRequestStatusKey === 'rejected'
    && !isFinalRejectedApplication,
  );
  const canRejectByStaff = (
    applicationStatusKey === 'pendingstaffreview'
    && !isLinkedToAdmin
  ) || canAppealRejectedRequest;
  const isLockedFromActions = isFinalRejectedApplication
    || (isLinkedToAdmin && !canAppealRejectedRequest);
  const notesHaveUnsavedChanges = normalizeNote(staffNotes) !== normalizeNote(savedStaffNotes)
    || normalizeNote(contactNotes) !== normalizeNote(savedContactNotes);

  useEffect(() => {
    const nextApplicationId = selectedRow?.Event_Application_ID || null;
    if (initializedApplicationIdRef.current === nextApplicationId) return;
    initializedApplicationIdRef.current = nextApplicationId;

    if (!selectedRow) {
      setStaffNotes('');
      setContactNotes('');
      setSavedStaffNotes('');
      setSavedContactNotes('');
      setStaffRejectionReason('');
      setRequestDraft(createRequestDraftFromApplication(null));
      return;
    }

    const nextStaffNotes = selectedRow.Staff_Review_Notes || '';
    const nextContactNotes = selectedRow.Staff_Contact_Notes || '';
    setStaffNotes(nextStaffNotes);
    setContactNotes(nextContactNotes);
    setSavedStaffNotes(nextStaffNotes);
    setSavedContactNotes(nextContactNotes);
    setStaffRejectionReason(selectedRow.Staff_Rejection_Reason || '');
    setRequestDraft(createRequestDraftFromApplication(selectedRow));
    // Realtime refreshes replace the row object, but the ID guard above
    // prevents them from erasing text currently being typed into staff forms.
  }, [selectedRow]);

  useEffect(() => {
    setShowRejectModal(false);
    setShowSubmitModal(false);
  }, [selectedId]);

  const queueRows = useMemo(() => {
    const ALLOWED = ['pendingstaffreview', 'pendingadmindecision', 'rejected', 'appealed', 'approved'];
    return rows
      .filter((row) => ALLOWED.includes(normalizeStatus(row.Status)))
      .slice()
      .sort((a, b) => {
        const aTime = new Date(a.Created_At || 0).getTime();
        const bTime = new Date(b.Created_At || 0).getTime();
        return aTime - bTime;
      });
  }, [rows]);

  // Keep selection valid as realtime inserts/deletes change the queue.
  useEffect(() => {
    const selectionCandidates = selectedCalendarDate
      ? queueRows.filter((row) => applicationProgramDateKeys(row).includes(selectedCalendarDate))
      : queueRows;
    const selectionStillExists = selectionCandidates.some(
      (row) => Number(row.Event_Application_ID) === Number(selectedId),
    );
    if (!selectionStillExists) {
      setSelectedId(selectionCandidates[0]?.Event_Application_ID || null);
    }
  }, [queueRows, selectedCalendarDate, selectedId]);

  const applicationsByDate = useMemo(() => {
    const byDate = new Map();
    queueRows.forEach((row) => {
      applicationProgramDateKeys(row).forEach((dateKey) => {
        const dateRows = byDate.get(dateKey) || [];
        dateRows.push(row);
        byDate.set(dateKey, dateRows);
      });
    });
    return byDate;
  }, [queueRows]);

  const statusCounts = useMemo(() => {
    const counts = { all: queueRows.length };
    queueRows.forEach((row) => {
      const key = normalizeStatus(row.Status);
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }, [queueRows]);

  const visibleRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return queueRows.filter((row) => {
      if (statusFilter !== 'all' && normalizeStatus(row.Status) !== statusFilter) return false;
      if (
        selectedCalendarDate
        && !applicationProgramDateKeys(row).includes(selectedCalendarDate)
      ) return false;
      if (!term) return true;
      const haystack = [
        `ea-${row.Event_Application_ID}`,
        row.Event_Name,
        applicantFullName(row),
        row.Applicant_Email,
        row.Applicant_Contact_Number,
        row.City,
        row.Province,
        row.Venue_Address,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [queueRows, searchTerm, selectedCalendarDate, statusFilter]);

  const handleSaveNotes = async () => {
    if (!selectedRow) return { ok: false };

    const nextContactNotes = normalizeNote(contactNotes);
    const nextStaffNotes = normalizeNote(staffNotes);
    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      let updated = null;
      const rpcResult = await supabase
        .rpc('save_event_application_staff_notes', {
          p_event_application_id: Number(selectedRow.Event_Application_ID),
          p_contact_notes: nextContactNotes || null,
          p_review_notes: nextStaffNotes || null,
        })
        .maybeSingle();

      const rpcUnavailable = rpcResult.error
        && (
          rpcResult.error.code === 'PGRST202'
          || String(rpcResult.error.message || '').toLowerCase().includes('save_event_application_staff_notes')
        );

      if (rpcUnavailable) {
        const resolvedStaffId = await resolveStaffUserId();
        const fallbackResult = await supabase
          .from(EVENT_APPLICATIONS_TABLE)
          .update({
            Staff_Contact_Notes: nextContactNotes || null,
            Staff_Review_Notes: nextStaffNotes || null,
            Staff_Contacted_At: nextContactNotes ? getUtc8SqlNow() : selectedRow.Staff_Contacted_At,
            Staff_Reviewer_User_ID: resolvedStaffId || selectedRow.Staff_Reviewer_User_ID || null,
          })
          .eq('Event_Application_ID', selectedRow.Event_Application_ID)
          .select('*')
          .maybeSingle();

        if (fallbackResult.error) throw fallbackResult.error;
        if (!fallbackResult.data) {
          throw new Error('The database did not save the notes. Apply the latest Supabase migration, then retry.');
        }
        updated = fallbackResult.data;
      } else {
        if (rpcResult.error) throw rpcResult.error;
        if (!rpcResult.data) throw new Error('The database did not return the saved notes.');
        updated = {
          ...selectedRow,
          Staff_Contact_Notes: rpcResult.data.staff_contact_notes,
          Staff_Review_Notes: rpcResult.data.staff_review_notes,
          Staff_Contacted_At: rpcResult.data.staff_contacted_at,
          Staff_Reviewer_User_ID: rpcResult.data.staff_reviewer_user_id,
          Updated_At: rpcResult.data.updated_at,
        };
      }

      setRows((current) => current.map((row) => (
        Number(row.Event_Application_ID) === Number(selectedRow.Event_Application_ID)
          ? updated
          : row
      )));
      setContactNotes(updated.Staff_Contact_Notes || '');
      setStaffNotes(updated.Staff_Review_Notes || '');
      setSavedContactNotes(updated.Staff_Contact_Notes || '');
      setSavedStaffNotes(updated.Staff_Review_Notes || '');
      setNotice({ kind: 'success', text: 'Staff contact summary and review notes saved.' });
      return { ok: true };
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to save staff notes.' });
      return { ok: false };
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmSubmitToAdmin = async () => {
    if (!selectedRow) return;
    if (notesHaveUnsavedChanges) {
      setSubmitStep(4);
      setNotice({
        kind: 'error',
        text: 'Save your staff notes before submitting so they are included in the record.',
      });
      return;
    }
    const linkedRequestId = Number(selectedRow.Linked_Event_Request_ID || 0);
    if (linkedRequestId > 0 && !canAppealRejectedRequest) {
      setNotice({ kind: 'success', text: 'This application was already submitted to admin.' });
      setShowSubmitModal(false);
      return;
    }

    const resolvedStaffId = await resolveStaffUserId();
    if (!resolvedStaffId) {
      setNotice({ kind: 'error', text: 'Unable to resolve staff profile.' });
      return;
    }

    const payload = {
      Event_Application_ID: selectedRow.Event_Application_ID,
      Event_Name: requestDraft.eventName.trim() || selectedRow.Event_Name || null,
      Start_Date: toIsoOrNull(requestDraft.startDate),
      End_Date: toIsoOrNull(requestDraft.endDate),
      Venue_Name: requestDraft.venueName.trim() || null,
      Country: requestDraft.country.trim() || 'Philippines',
      Region: requestDraft.region.trim() || null,
      Province: requestDraft.province.trim() || null,
      City_Municipality: requestDraft.cityMunicipality.trim() || null,
      Barangay: requestDraft.barangay.trim() || null,
      Street: requestDraft.street.trim() || null,
      Longitude: toNumberOrNull(requestDraft.longitude),
      Latitude: toNumberOrNull(requestDraft.latitude),
      Event_Photo_URL: requestDraft.eventPhotoUrl.trim() || null,
      Event_Visibility: normalizeEventVisibility(requestDraft.eventVisibility),
      Event_By: requestDraft.eventBy.trim() || null,
      Partnered_With: requestDraft.partneredWith.trim() || null,
      Partner_Social_Media_Link: requestDraft.partnerSocialMediaLink.trim() || null,
      Status: 'Pending Admin Approval',
      Staff_Prepared_By_User_ID: resolvedStaffId,
      Staff_Contact_Notes: contactNotes.trim() || null,
    };

    if (!payload.Event_Name) {
      setNotice({ kind: 'error', text: 'Program name is required before forwarding to admin.' });
      return;
    }
    if (!payload.Start_Date || !payload.End_Date) {
      setNotice({ kind: 'error', text: 'Start and end schedule are required before forwarding to admin.' });
      return;
    }
    if (!payload.Event_Photo_URL) {
      setNotice({ kind: 'error', text: 'Program poster photo is required before forwarding to admin.' });
      return;
    }

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      if (linkedRequestId > 0 && canAppealRejectedRequest) {
        const baseAppealPayload = {
          ...payload,
          Admin_Decision_Reason: null,
          Admin_Reviewer_User_ID: null,
          Admin_Reviewed_At: null,
        };

        const appealRpcResult = await supabase
          .rpc('staff_resubmit_event_request', {
            p_event_request_id: linkedRequestId,
            p_event_application_id: Number(selectedRow.Event_Application_ID),
            p_request_data: baseAppealPayload,
            p_contact_notes: normalizeNote(contactNotes) || null,
            p_review_notes: normalizeNote(staffNotes) || null,
          })
          .maybeSingle();

        const appealRpcUnavailable = appealRpcResult.error
          && (
            appealRpcResult.error.code === 'PGRST202'
            || String(appealRpcResult.error.message || '').toLowerCase().includes('staff_resubmit_event_request')
          );

        if (appealRpcUnavailable) {
          const updateRequestResult = await supabase
            .from(EVENT_REQUESTS_TABLE)
            .update({
              ...baseAppealPayload,
              Status: 'Appealed',
            })
            .eq('Event_Request_ID', linkedRequestId);
          if (updateRequestResult.error) {
            const retryResult = await supabase
              .from(EVENT_REQUESTS_TABLE)
              .update({
                ...baseAppealPayload,
                Status: 'Pending Admin Approval',
              })
              .eq('Event_Request_ID', linkedRequestId);

            if (retryResult.error) throw retryResult.error;
          }

          const updateApplicationResult = await supabase
            .from(EVENT_APPLICATIONS_TABLE)
            .update({
              Status: 'Appealed',
              Staff_Contact_Notes: normalizeNote(contactNotes) || null,
              Staff_Review_Notes: normalizeNote(staffNotes) || null,
              Staff_Contacted_At: normalizeNote(contactNotes) ? getUtc8SqlNow() : selectedRow.Staff_Contacted_At,
              Resubmission_Count: Number(selectedRow.Resubmission_Count || 0) + 1,
            })
            .eq('Event_Application_ID', selectedRow.Event_Application_ID)
            .select('Event_Application_ID')
            .maybeSingle();

          if (updateApplicationResult.error) throw updateApplicationResult.error;
          if (!updateApplicationResult.data) {
            throw new Error('The appeal was not recorded on the application. Apply the latest Supabase migration, then retry.');
          }
        } else {
          if (appealRpcResult.error) throw appealRpcResult.error;
          if (!appealRpcResult.data) throw new Error('The database did not return the resubmitted request.');
        }

        await loadRows();
        const smtpKickResult = await triggerSmtpNow('staff_resubmitted_event_request');
        if (!smtpKickResult.ok) {
          console.warn('[SMTP] Trigger after staff appeal submit failed:', smtpKickResult.message || smtpKickResult);
        }
        setNotice({ kind: 'success', text: 'Appeal submitted for a new admin decision.' });
      } else {
        const insertResult = await supabase
          .from(EVENT_REQUESTS_TABLE)
          .insert(payload)
          .select('Event_Request_ID')
          .maybeSingle();

        if (insertResult.error) throw insertResult.error;

        await loadRows();
        const smtpKickResult = await triggerSmtpNow('staff_submitted_event_request');
        if (!smtpKickResult.ok) {
          console.warn('[SMTP] Trigger after staff request submit failed:', smtpKickResult.message || smtpKickResult);
        }
        setNotice({
          kind: 'success',
          text: 'Request submitted to admin successfully.',
        });
      }
      setShowSubmitModal(false);
    } catch (error) {
      const raw = String(error?.message || '').trim();
      if (raw.toLowerCase().includes('new row violates row-level security policy for table "event_requests"')) {
        setNotice({
          kind: 'error',
          text: 'Program request submission is blocked by database RLS. Apply the latest Supabase migrations, then retry.',
        });
      } else {
        setNotice({ kind: 'error', text: raw || 'Unable to create program request.' });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmReject = async () => {
    if (!selectedRow) return;
    if (!canRejectByStaff) {
      setShowRejectModal(false);
      setNotice({
        kind: 'error',
        text: 'This application is no longer available for a staff rejection or appeal rejection.',
      });
      return;
    }

    const isRejectingAppeal = canAppealRejectedRequest;
    const rejectionReason = normalizeNote(staffRejectionReason);
    if (!rejectionReason) {
      setNotice({ kind: 'error', text: 'Staff rejection reason is required.' });
      return;
    }

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const result = await supabase
        .rpc('staff_reject_event_application', {
          p_event_application_id: Number(selectedRow.Event_Application_ID),
          p_rejection_reason: rejectionReason,
          p_contact_notes: normalizeNote(contactNotes) || null,
          p_review_notes: normalizeNote(staffNotes) || null,
        })
        .maybeSingle();

      if (result.error) throw result.error;
      if (!result.data) {
        throw new Error('The database did not return the rejected application.');
      }

      const updated = result.data;
      setRows((current) => current.map((row) => (
        Number(row.Event_Application_ID) === Number(updated.Event_Application_ID)
          ? updated
          : row
      )));
      setContactNotes(updated.Staff_Contact_Notes || '');
      setStaffNotes(updated.Staff_Review_Notes || '');
      setSavedContactNotes(updated.Staff_Contact_Notes || '');
      setSavedStaffNotes(updated.Staff_Review_Notes || '');
      setNotice({
        kind: 'success',
        text: isRejectingAppeal
          ? 'Appeal rejected permanently. The applicant will be notified by email.'
          : 'Application rejected permanently. The applicant will be notified by email.',
      });

      const smtpKickResult = await triggerSmtpNow('staff_rejected_event_application');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after staff rejection failed:', smtpKickResult.message || smtpKickResult);
      }
      setShowRejectModal(false);
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error.message || 'Unable to reject this application.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const updateRequestDraftField = (key) => (event) => {
    setRequestDraft((previous) => ({ ...previous, [key]: event.target.value }));
  };

  const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';
  const fieldLabel = 'flex flex-col gap-1.5';
  const fieldLabelText = 'text-[11px] font-bold uppercase tracking-wide text-slate-600';

  const renderApplicationDetails = () => {
    const preferredMethod = preferredContactMethodLabel(selectedRow.Preferred_Contact_Method);
    const secondaryMethod = preferredMethod === 'Email' ? 'Phone' : 'Email';
    const email = String(selectedRow.Applicant_Email || '').trim();
    const phone = String(selectedRow.Applicant_Contact_Number || '').trim();
    const preferredFallback = String(selectedRow.Preferred_Contact_Detail || '').trim();
    const primaryContact = preferredMethod === 'Email' ? (email || preferredFallback) : (phone || preferredFallback);
    const secondaryContact = secondaryMethod === 'Email' ? email : phone;
    const venueAddress = [selectedRow.Street, selectedRow.Barangay, selectedRow.City, selectedRow.Province, selectedRow.Region, selectedRow.Country]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(', ');
    const socialUrl = String(selectedRow.Social_Page_URL || '').trim();
    const safeSocialUrl = socialUrl && /^https?:\/\//i.test(socialUrl) ? socialUrl : socialUrl ? `https://${socialUrl}` : '';

    return (
      <div className="space-y-5">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Applicant & Identity</p>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <InfoItem icon={User} label="Full Name" span={2}>{applicantFullName(selectedRow)}</InfoItem>
                  <InfoItem icon={User} label="Gender">{selectedRow.Applicant_Gender || 'Not provided'}</InfoItem>
                  <InfoItem icon={FileText} label="Verified ID Type">{validIdTypeLabel(selectedRow.Applicant_Valid_ID_Type)}</InfoItem>
                  <InfoItem icon={CheckCircle2} label="ID Verification">{selectedRow.Didit_Verification_Status || 'Legacy application'}</InfoItem>
                  <InfoItem icon={FileText} label="ID Number">{selectedRow.Applicant_ID_Document_Number || 'Not provided'}</InfoItem>
                  <InfoItem icon={MapPin} label="Address on ID" span={2}>{selectedRow.Applicant_ID_Address || 'Not provided'}</InfoItem>
                </div>
                <AttachmentTile url={privateIdUrl || selectedRow.Applicant_Valid_ID_URL} label="Verified ID Front" />
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Contact Priority</p>
              <div className="grid grid-cols-1 gap-4">
                <InfoItem icon={CheckCircle2} label="Preferred Method">{preferredMethod}</InfoItem>
                <InfoItem icon={preferredMethod === 'Email' ? Mail : Phone} label={`Primary Â· ${preferredMethod}`}>
                  <ContactLink type={preferredMethod} value={primaryContact} />
                </InfoItem>
                <InfoItem icon={secondaryMethod === 'Email' ? Mail : Phone} label={`Secondary Â· ${secondaryMethod}`}>
                  <ContactLink type={secondaryMethod} value={secondaryContact} />
                </InfoItem>
                <p className="rounded-md border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-700">
                  Contact the primary option first. Use the secondary option if the applicant cannot be reached.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Program Details</p>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <InfoItem icon={FileText} label="Program Name" span={2}>{selectedRow.Event_Name || 'Untitled program'}</InfoItem>
                <InfoItem icon={Info} label="Program Type">{normalizeEventVisibility(selectedRow.Event_Visibility)}</InfoItem>
                <InfoItem icon={Users} label="Expected Attendees">
                  {String(selectedRow.Expected_Attendees ?? '').trim()
                    ? Number(selectedRow.Expected_Attendees).toLocaleString('en-PH')
                    : 'Not provided'}
                </InfoItem>
                <InfoItem icon={FileText} label="Program Overview" span={2}>{selectedRow.Event_Overview || 'Not provided'}</InfoItem>
                <InfoItem icon={Globe2} label="Organization / Social Page">{selectedRow.Social_Page_Name || 'Not provided'}</InfoItem>
                <InfoItem icon={ExternalLink} label="Social Page Link">
                  {safeSocialUrl ? (
                    <a href={safeSocialUrl} target="_blank" rel="noreferrer" className="font-semibold text-teal-700 hover:underline">Open social page</a>
                  ) : 'Not provided'}
                </InfoItem>
              </div>
            </div>
            <AttachmentTile url={selectedRow.Event_Poster_Photo_URL} label="Program Poster" />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Schedule & Venue</p>
          <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
            <InfoItem icon={Calendar} label="Proposed Start">{formatDateTime(selectedRow.Proposed_Start_At)}</InfoItem>
            <InfoItem icon={Calendar} label="Proposed End">{formatDateTime(selectedRow.Proposed_End_At)}</InfoItem>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <InfoItem icon={MapPin} label="Venue Name" span={2}>{extractVenueName(selectedRow.Venue_Address)}</InfoItem>
                <InfoItem icon={MapPin} label="Street">{selectedRow.Street || 'Not provided'}</InfoItem>
                <InfoItem icon={MapPin} label="Barangay">{selectedRow.Barangay || 'Not provided'}</InfoItem>
                <InfoItem icon={MapPin} label="City / Municipality">{selectedRow.City || 'Not provided'}</InfoItem>
                <InfoItem icon={MapPin} label="Province">{selectedRow.Province || 'Not provided'}</InfoItem>
                <InfoItem icon={MapPin} label="Region">{selectedRow.Region || 'Not provided'}</InfoItem>
                <InfoItem icon={MapPin} label="Country">{selectedRow.Country || 'Philippines'}</InfoItem>
                <InfoItem icon={MapPin} label="Complete Address" span={2}>{venueAddress || selectedRow.Venue_Address || 'Not provided'}</InfoItem>
              </div>
            </div>
            <AttachmentTile url={selectedRow.Event_Place_Photo_URL} label="Program Place" />
          </div>
          <div className="mt-4">
            <MapPreview latitude={selectedRow.Latitude} longitude={selectedRow.Longitude} label={`${selectedRow.Event_Name || 'Program'} venue`} />
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Application Progress</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <InfoItem icon={Info} label="Application Status">{statusLabel(selectedRow.Status)}</InfoItem>
            <InfoItem icon={Clock3} label="Submitted">{formatDateTime(selectedRow.Created_At)}</InfoItem>
            <InfoItem icon={Clock3} label="Last Updated">{formatDateTime(selectedRow.Updated_At)}</InfoItem>
            <InfoItem icon={FileText} label="Resubmissions">{Number(selectedRow.Resubmission_Count || 0)}</InfoItem>
            <InfoItem icon={Phone} label="Staff Contacted">{formatDateTime(selectedRow.Staff_Contacted_At)}</InfoItem>
            <InfoItem icon={CheckCircle2} label="Staff Reviewed">{formatDateTime(selectedRow.Staff_Reviewed_At)}</InfoItem>
            <InfoItem icon={Send} label="Admin Review">{isLinkedToAdmin ? statusLabel(selectedLinkedRequest?.Status || 'Pending Admin Approval') : 'Not submitted yet'}</InfoItem>
            {selectedRow.Staff_Rejection_Reason && (
              <InfoItem icon={ShieldAlert} label="Staff Rejection Reason" span={2}>{selectedRow.Staff_Rejection_Reason}</InfoItem>
            )}
            {canAppealRejectedRequest && (
              <InfoItem icon={ShieldAlert} label="Admin Rejection Reason" span={2}>
                {selectedLinkedRequest?.Admin_Decision_Reason || 'No reason provided by admin.'}
              </InfoItem>
            )}
          </div>
        </section>
      </div>
    );
  };

  return (
    <>
      <style>{`
        @keyframes intake-fade-up {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .intake-fade-up { animation: intake-fade-up 220ms ease-out both; }
        @keyframes intake-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .intake-fade-in { animation: intake-fade-in 180ms ease-out both; }
      `}</style>
      <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
            <h1 className="role-page-title text-2xl font-bold text-slate-900">Manage Program Applications</h1>
            <p className="text-sm text-slate-600">Review submissions, contact requestors, then forward to admin or reject.</p>
        </div>
        <PageHeaderActions
          onRefresh={() => loadRows()}
          refreshLoading={isLoading}
          helpTitle="Program application workflow"
          helpContent={(
            <ol className="space-y-3">
              {[
                { step: 1, title: 'Review Intake', body: 'Check the applicant identity, supporting files, contact details, and proposed program.' },
                { step: 2, title: 'Contact + Notes', body: 'Contact the requestor using the preferred method, then record and save the relevant notes.' },
                { step: 3, title: 'Decision', body: 'Reject an ineligible application or submit a complete application to admin for final approval.' },
              ].map((stepRow) => (
                <li key={stepRow.step} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: primaryColor }}>
                    {stepRow.step}
                  </span>
                  <div>
                    <p className="font-semibold text-slate-900">{stepRow.title}</p>
                    <p className="mt-0.5 text-sm leading-5 text-slate-600">{stepRow.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        />
        </div>

      {notice.text && createPortal(
        <div
          className={`fixed bottom-4 right-4 z-[10000] flex w-[calc(100vw-2rem)] max-w-md items-start gap-3 rounded-xl border px-4 py-3.5 text-sm shadow-2xl intake-fade-up ${
            notice.kind === 'error'
              ? 'border-rose-300 bg-rose-50 text-rose-800'
              : 'border-emerald-300 bg-emerald-50 text-emerald-800'
          }`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
        >
          {notice.kind === 'error'
            ? <AlertTriangle size={19} className="mt-0.5 flex-none" />
            : <CheckCircle2 size={19} className="mt-0.5 flex-none" />}
          <div className="min-w-0 flex-1">
            <p className="font-bold">
              {notice.kind === 'error' ? 'Action not completed' : 'Success'}
            </p>
            <p className="mt-0.5 leading-relaxed">{notice.text}</p>
          </div>
          <button
            type="button"
            onClick={() => setNotice({ kind: '', text: '' })}
            className="-mr-1 -mt-1 rounded-md p-1 opacity-70 transition hover:bg-black/5 hover:opacity-100"
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>,
        document.body,
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px,1fr]">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="space-y-3 border-b border-slate-200 px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <Inbox size={14} />
                Applications Queue
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowCalendarModal(true)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold transition ${
                    selectedCalendarDate
                      ? 'border-sky-200 bg-sky-50 text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Calendar size={12} />
                  {selectedCalendarDate ? formatProgramDateLabel(selectedCalendarDate, { short: true }) : 'Calendar'}
                </button>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                  {visibleRows.length}
                </span>
              </div>
            </div>

            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search applicant, program, or contact..."
                className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-8 text-sm placeholder:text-slate-400 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[
                { key: 'all', label: 'All' },
                { key: 'pendingstaffreview', label: 'Pending Staff' },
                { key: 'pendingadmindecision', label: 'Pending Admin' },
                { key: 'approved', label: 'Approved' },
                { key: 'rejected', label: 'Rejected' },
                { key: 'appealed', label: 'Appealed' },
              ].map((filter) => {
                const isActive = statusFilter === filter.key;
                const count = statusCounts[filter.key] || 0;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    onClick={() => setStatusFilter(filter.key)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                      isActive
                        ? 'border-transparent text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                    style={isActive ? { backgroundColor: primaryColor } : undefined}
                  >
                    {filter.label}
                    <span className={`rounded-full px-1.5 py-px text-[10px] ${isActive ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-600'}`}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {selectedCalendarDate && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-sky-600">Date filter</p>
                  <p className="truncate text-xs font-semibold text-sky-800">
                    {formatProgramDateLabel(selectedCalendarDate)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCalendarDate('')}
                  className="rounded-md p-1 text-sky-600 hover:bg-sky-100"
                  aria-label="Clear selected date"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
          <div className="max-h-[640px] overflow-auto">
            {isLoading && visibleRows.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-5 text-sm text-slate-600"><Loader2 size={15} className="animate-spin" />Loading...</div>
            ) : visibleRows.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                  <Inbox size={20} />
                </div>
                <p className="mt-2.5 text-sm font-semibold text-slate-700">
                  {queueRows.length === 0 ? 'No applications' : 'No matches'}
                </p>
                <p className="text-xs text-slate-500">
                  {queueRows.length === 0
                    ? 'New submissions will appear here.'
                    : selectedCalendarDate
                      ? 'No applications match the selected date and filters.'
                      : 'Try a different filter or clear the search.'}
                </p>
                {queueRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchTerm('');
                      setStatusFilter('all');
                      setSelectedCalendarDate('');
                    }}
                    className="mt-3 rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {visibleRows.map((row) => {
                  const isActive = Number(row.Event_Application_ID || 0) === Number(selectedId || 0);
                  return (
                    <li key={row.Event_Application_ID}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(row.Event_Application_ID)}
                        className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition ${
                          isActive ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                        }`}
                        style={isActive ? { boxShadow: `inset 3px 0 0 ${primaryColor}` } : undefined}
                      >
                        <div
                          className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-xs font-bold text-white"
                          style={{ backgroundColor: primaryColor }}
                        >
                          {applicantInitials(row)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold text-slate-900">
                              {row.Event_Name || 'Untitled Program'}
                            </p>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-slate-600">{applicantFullName(row)}</p>
                          <p className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                            <Calendar size={11} />
                            {formatProgramDateLabel(toProgramDateKey(row.Proposed_Start_At), { short: true })}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusPillClass(row.Status)}`}>
                              {statusLabel(row.Status)}
                            </span>
                            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                              {normalizeEventVisibility(row.Event_Visibility)}
                            </span>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="space-y-4">
          {!selectedRow ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-20 text-center shadow-sm">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <Inbox size={26} />
              </div>
              <h2 className="mt-4 text-base font-bold text-slate-800">Select a program application</h2>
              <p className="mt-1 max-w-sm text-sm text-slate-500">
                Choose a submission from the queue on the left to review applicant details.
              </p>
            </div>
          ) : (
            <div key={selectedRow.Event_Application_ID} className="intake-fade-up space-y-4">
              {/* Hero */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${primaryColor}, ${primaryColor}99)` }} />
                <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-12 w-12 flex-none items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {applicantInitials(selectedRow)}
                    </div>
                    <div>
                      <h2 className="mt-0.5 text-xl font-bold text-slate-900">{selectedRow.Event_Name || 'Untitled Program'}</h2>
                      <p className="text-sm text-slate-600">by {applicantFullName(selectedRow)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusPillClass(selectedRow.Status)}`}>
                      {statusLabel(selectedRow.Status)}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {normalizeEventVisibility(selectedRow.Event_Visibility)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Status banner */}
              {isAutomaticallyRejectedApplication && (
                <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-800">
                  <Clock3 size={20} className="mt-0.5 flex-none" />
                  <div>
                    <p className="font-bold">Application automatically rejected</p>
                    <p className="mt-1">
                      The proposed event start date passed before staff review was completed. This application is now permanently closed.
                    </p>
                  </div>
                </div>
              )}
              {isStaffRejectedApplication && (
                <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-800">
                  <XCircle size={20} className="mt-0.5 flex-none" />
                  <div>
                    <p className="font-bold">Application rejected by staff</p>
                    <p className="mt-1">
                      This application is permanently closed and cannot be edited, reopened, or submitted to admin.
                      The applicant was emailed the reason and may submit a new corrected application.
                    </p>
                  </div>
                </div>
              )}
              {isLockedFromActions && !isFinalRejectedApplication && (
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-800">
                  <CheckCircle2 size={20} className="mt-0.5 flex-none" />
                  <div>
                    <p className="font-bold">Already submitted to admin</p>
                    <p className="mt-1">No further action is needed unless admin rejects the request. This application is now locked from further staff edits.</p>
                  </div>
                </div>
              )}
              {canAppealRejectedRequest && (
                <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800">
                  <AlertTriangle size={20} className="mt-0.5 flex-none" />
                  <div>
                    <p className="font-bold">Admin rejected this request</p>
                    <p className="mt-1">Review the admin&apos;s feedback below, update the details, then submit appeal.</p>
                  </div>
                </div>
              )}

              {renderApplicationDetails()}

              {/* Staff Notes â€” editable when not locked, read-only otherwise */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <FileText size={15} className="text-slate-500" />
                    <h3 className="text-sm font-bold text-slate-800">Staff Notes</h3>
                    {isLockedFromActions && (
                      <span className="ml-1 rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                        Read-only
                      </span>
                    )}
                  </div>
                  {!isLockedFromActions && (
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                      notesHaveUnsavedChanges
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    }`}>
                      {notesHaveUnsavedChanges ? 'Unsaved changes' : 'Notes saved'}
                    </span>
                  )}
                </div>
                {!isLockedFromActions && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                    <Info size={14} className="mt-0.5 flex-none" />
                    <p>
                      Enter the contact summary and review notes, then click <strong>Save Notes</strong>.
                      Changes are only recorded after the save succeeds.
                    </p>
                  </div>
                )}
                <div className="mt-4 grid grid-cols-1 gap-4">
                  {isLockedFromActions ? (
                    <>
                      <div>
                        <p className={fieldLabelText}>Staff Contact Summary</p>
                        <p className="mt-1.5 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 min-h-[60px]">
                          {contactNotes || <span className="text-slate-400">No contact summary recorded.</span>}
                        </p>
                      </div>
                      <div>
                        <p className={fieldLabelText}>Staff Review Notes</p>
                        <p className="mt-1.5 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 min-h-[60px]">
                          {staffNotes || <span className="text-slate-400">No review notes recorded.</span>}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className={fieldLabel}>
                        <span className={fieldLabelText}>Staff Contact Summary</span>
                        <textarea
                          value={contactNotes}
                          onChange={(event) => setContactNotes(event.target.value)}
                          rows={3}
                          className={`${inputClass} resize-y leading-relaxed`}
                          placeholder="How you contacted the requestor and what was discussed"
                        />
                      </label>
                      <label className={fieldLabel}>
                        <span className={fieldLabelText}>Staff Review Notes</span>
                        <textarea
                          value={staffNotes}
                          onChange={(event) => setStaffNotes(event.target.value)}
                          rows={3}
                          className={`${inputClass} resize-y leading-relaxed`}
                          placeholder="Recommended logistics, schedule, and internal remarks"
                        />
                      </label>
                    </>
                  )}
                </div>
              </div>

              {/* Action buttons â€” hidden when locked */}
              {!isLockedFromActions && (
                <div className="flex flex-wrap items-center justify-end gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <button
                    type="button"
                    onClick={handleSaveNotes}
                    disabled={isSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                  >
                    {isSaving ? <Loader2 size={15} className="animate-spin" /> : <FileText size={15} />}
                    Save Notes
                  </button>
                  {canRejectByStaff && (
                    <button
                      type="button"
                      onClick={() => {
                        setStaffRejectionReason(selectedRow.Staff_Rejection_Reason || '');
                        setShowRejectModal(true);
                      }}
                      disabled={isSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-60"
                    >
                      <XCircle size={15} />
                      {canAppealRejectedRequest ? 'Reject Appeal' : 'Reject Application'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setRequestDraft(createRequestDraftFromApplication(selectedRow));
                      setSubmitStep(1);
                      setShowSubmitModal(true);
                    }}
                    disabled={isSaving}
                    className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                    {canAppealRejectedRequest ? 'Submit Appeal to Admin' : 'Submit Request to Admin'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Program Calendar Modal */}
      <Modal
        open={showCalendarModal}
        onClose={() => setShowCalendarModal(false)}
        title="Program Schedule Calendar"
        description="Choose a date to filter the applications queue."
        icon={Calendar}
        accentColor={primaryColor}
        maxWidth="xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => setSelectedCalendarDate('')}
              disabled={!selectedCalendarDate}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear Date Filter
            </button>
            <button
              type="button"
              onClick={() => setShowCalendarModal(false)}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
              style={{ backgroundColor: primaryColor }}
            >
              {selectedCalendarDate
                ? `Show ${visibleRows.length} Application${visibleRows.length === 1 ? '' : 's'}`
                : 'Close Calendar'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed text-slate-600">
            <strong className="text-slate-800">Open dates</strong> use a neutral dashed border and have no active program.
            <strong className="ml-1 text-emerald-700">Approved programs</strong> use a solid green status dot.
          </div>
          <ApplicationQueueCalendar
            month={calendarMonth}
            selectedDate={selectedCalendarDate}
            applicationsByDate={applicationsByDate}
            onMonthChange={setCalendarMonth}
            onSelectDate={setSelectedCalendarDate}
            primaryColor={primaryColor}
          />
        </div>
      </Modal>

      {/* Reject Modal */}
      <Modal
        open={showRejectModal}
        onClose={() => !isSaving && setShowRejectModal(false)}
        title={canAppealRejectedRequest ? 'Reject Appeal Permanently' : 'Reject Program Application'}
        description={canAppealRejectedRequest
          ? 'This closes the appeal permanently and notifies the applicant by email.'
          : 'The applicant will be notified by email of this decision.'}
        icon={ShieldAlert}
        accentColor="#e11d48"
        maxWidth="lg"
        footer={
          <>
            <button
              type="button"
              onClick={() => setShowRejectModal(false)}
              disabled={isSaving}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmReject}
              disabled={isSaving || !staffRejectionReason.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
            >
              {isSaving ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
              {canAppealRejectedRequest ? 'Confirm Appeal Rejection' : 'Confirm Rejection'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
            <AlertTriangle size={16} className="mt-0.5 flex-none" />
             <span>
               <strong>This action cannot be undone.</strong> Once rejected, the applicant will receive
               an email with your reason, this application will be permanently closed, and the applicant
               may submit a new corrected application.
             </span>
          </div>
          <label className={fieldLabel}>
            <span className={fieldLabelText}>
              Rejection Reason
              <span className="ml-1 text-rose-600">*</span>
            </span>
            <textarea
              value={staffRejectionReason}
              onChange={(event) => setStaffRejectionReason(event.target.value)}
              rows={5}
              className={`${inputClass} resize-y leading-relaxed focus:border-rose-400 focus:ring-rose-100`}
              placeholder="Explain why this application cannot proceed. This message will be sent to the applicant."
              autoFocus
            />
             <span className="text-[11px] font-normal normal-case text-slate-500">
               This exact reason is sent by email. Include every issue and correction the applicant needs before submitting a new application.
             </span>
          </label>
        </div>
      </Modal>

      {/* Submit to Admin Modal (4-step wizard) */}
      {(() => {
        const STEPS = [
          { id: 1, label: 'Program Details' },
          { id: 2, label: 'Location & Map' },
          { id: 3, label: 'Media & Partners' },
          { id: 4, label: 'Review & Confirm' },
        ];

        const canGoNext = (() => {
          if (submitStep === 1) {
            return Boolean(requestDraft.eventName.trim() && requestDraft.startDate && requestDraft.endDate);
          }
          if (submitStep === 3) {
            return Boolean(requestDraft.eventPhotoUrl.trim());
          }
          return true;
        })();

        const goNext = () => setSubmitStep((s) => Math.min(STEPS.length, s + 1));
        const goBack = () => setSubmitStep((s) => Math.max(1, s - 1));

        return (
          <Modal
            open={showSubmitModal}
            onClose={() => !isSaving && setShowSubmitModal(false)}
            title={canAppealRejectedRequest ? 'Submit Appeal to Admin' : 'Submit Event Request to Admin'}
            description={`Step ${submitStep} of ${STEPS.length} Â· ${STEPS[submitStep - 1].label}`}
            icon={Send}
            accentColor={primaryColor}
            maxWidth="3xl"
            footer={
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowSubmitModal(false)}
                  disabled={isSaving}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-2">
                  {submitStep > 1 && (
                    <button
                      type="button"
                      onClick={goBack}
                      disabled={isSaving}
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                    >
                      Back
                    </button>
                  )}
                  {submitStep < STEPS.length ? (
                    <button
                      type="button"
                      onClick={goNext}
                      disabled={isSaving || !canGoNext}
                      className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
                      style={{ backgroundColor: primaryColor }}
                    >
                      Next Step
                    </button>
                  ) : (
                     <button
                       type="button"
                       onClick={handleConfirmSubmitToAdmin}
                       disabled={isSaving || notesHaveUnsavedChanges}
                       title={notesHaveUnsavedChanges ? 'Save staff notes before submitting.' : undefined}
                       className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
                       style={{ backgroundColor: primaryColor }}
                     >
                       {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                       {notesHaveUnsavedChanges ? 'Save Notes Before Submitting' : 'Confirm & Submit to Admin'}
                     </button>
                  )}
                </div>
              </div>
            }
          >
            <div className="space-y-5">
              {/* Step indicator */}
              <div className="flex items-center gap-2">
                {STEPS.map((step, index) => {
                  const isActive = submitStep === step.id;
                  const isDone = submitStep > step.id;
                  return (
                    <React.Fragment key={step.id}>
                      <div className="flex flex-1 items-center gap-2 min-w-0">
                        <div
                          className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold transition ${
                            isActive ? 'text-white shadow-sm' : isDone ? 'text-white' : 'border border-slate-300 bg-white text-slate-500'
                          }`}
                          style={(isActive || isDone) ? { backgroundColor: primaryColor } : undefined}
                        >
                          {isDone ? <CheckCircle2 size={14} /> : step.id}
                        </div>
                        <div className="min-w-0">
                          <p className={`truncate text-[11px] font-bold uppercase tracking-wide ${isActive ? 'text-slate-900' : 'text-slate-500'}`}>
                            {step.label}
                          </p>
                        </div>
                      </div>
                      {index < STEPS.length - 1 && (
                        <div className={`h-px flex-1 ${isDone ? '' : 'bg-slate-200'}`} style={isDone ? { backgroundColor: primaryColor } : undefined} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Step body */}
              {submitStep === 1 && (
                <div className="intake-fade-in space-y-3">
                  <div className="flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-800">
                    <Info size={16} className="mt-0.5 flex-none" />
                    <span>Review the core event details. Event name, schedule, and visibility are required.</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className={`${fieldLabel} md:col-span-2`}>
                      <span className="text-xs font-semibold text-slate-700">Event Name <span className="text-rose-600">*</span></span>
                      <input value={requestDraft.eventName} onChange={updateRequestDraftField('eventName')} placeholder="Event name" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Start Date & Time <span className="text-rose-600">*</span></span>
                      <input type="datetime-local" value={requestDraft.startDate} onChange={updateRequestDraftField('startDate')} className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">End Date & Time <span className="text-rose-600">*</span></span>
                      <input type="datetime-local" value={requestDraft.endDate} onChange={updateRequestDraftField('endDate')} className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Event Type</span>
                      <select value={normalizeEventVisibility(requestDraft.eventVisibility)} onChange={updateRequestDraftField('eventVisibility')} className={inputClass}>
                        <option value="Public">Public</option>
                        <option value="Private">Private</option>
                      </select>
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Event By</span>
                      <input value={requestDraft.eventBy} onChange={updateRequestDraftField('eventBy')} placeholder="Event by" className={inputClass} />
                    </label>
                  </div>
                </div>
              )}

              {submitStep === 2 && (
                <div className="intake-fade-in space-y-3">
                  <div className="flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-800">
                    <MapPin size={16} className="mt-0.5 flex-none" />
                    <span>Confirm the venue address and verify the pinned location on the map.</span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className={`${fieldLabel} md:col-span-2`}>
                      <span className="text-xs font-semibold text-slate-700">Venue Name</span>
                      <input value={requestDraft.venueName} onChange={updateRequestDraftField('venueName')} placeholder="Venue name" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Country</span>
                      <input value={requestDraft.country} onChange={updateRequestDraftField('country')} placeholder="Country" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Region</span>
                      <input value={requestDraft.region} onChange={updateRequestDraftField('region')} placeholder="Region" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Province</span>
                      <input value={requestDraft.province} onChange={updateRequestDraftField('province')} placeholder="Province" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">City / Municipality</span>
                      <input value={requestDraft.cityMunicipality} onChange={updateRequestDraftField('cityMunicipality')} placeholder="City / Municipality" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Barangay</span>
                      <input value={requestDraft.barangay} onChange={updateRequestDraftField('barangay')} placeholder="Barangay" className={inputClass} />
                    </label>
                    <label className={`${fieldLabel} md:col-span-2`}>
                      <span className="text-xs font-semibold text-slate-700">Street</span>
                      <input value={requestDraft.street} onChange={updateRequestDraftField('street')} placeholder="Street" className={inputClass} />
                    </label>
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-slate-700">Pinned Location</p>
                    <MapPreview
                      latitude={requestDraft.latitude}
                      longitude={requestDraft.longitude}
                      label={requestDraft.venueName || requestDraft.eventName || 'Event venue'}
                    />
                  </div>
                </div>
              )}

              {submitStep === 3 && (
                <div className="intake-fade-in space-y-3">
                  <div className="flex items-start gap-2.5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-800">
                    <ImageIcon size={16} className="mt-0.5 flex-none" />
                    <span>The event poster is required. Review the poster and add partner info if applicable.</span>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-700">
                      Event Poster Preview <span className="text-rose-600">*</span>
                    </p>
                    <div className="mt-1.5 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                      {requestDraft.eventPhotoUrl ? (
                        <a
                          href={requestDraft.eventPhotoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="group block"
                        >
                          <div className="flex items-center justify-center bg-slate-100" style={{ maxHeight: '320px' }}>
                            <img
                              src={requestDraft.eventPhotoUrl}
                              alt="Event poster preview"
                              className="max-h-[320px] w-auto max-w-full object-contain transition group-hover:opacity-95"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none';
                                event.currentTarget.parentElement.innerHTML = '<div class="flex flex-col items-center justify-center px-4 py-10 text-center text-slate-500"><p class="text-sm font-semibold">Preview unavailable</p><p class="mt-1 text-xs">The poster URL could not be loaded.</p></div>';
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-3 py-2">
                            <span className="text-xs font-semibold text-slate-700">Event Poster</span>
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 group-hover:underline">
                              Open full size <ExternalLink size={11} />
                            </span>
                          </div>
                        </a>
                      ) : (
                        <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
                          <ImageIcon size={22} className="text-slate-400" />
                          <p className="mt-2 text-sm font-semibold text-slate-700">No poster uploaded</p>
                          <p className="mt-0.5 text-xs text-slate-500">An event poster image is required before submitting to admin.</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Partnered With</span>
                      <input value={requestDraft.partneredWith} onChange={updateRequestDraftField('partneredWith')} placeholder="Partnered with" className={inputClass} />
                    </label>
                    <label className={fieldLabel}>
                      <span className="text-xs font-semibold text-slate-700">Partner Social Media Link</span>
                      <input value={requestDraft.partnerSocialMediaLink} onChange={updateRequestDraftField('partnerSocialMediaLink')} placeholder="https://..." className={inputClass} />
                    </label>
                  </div>
                </div>
              )}

              {submitStep === 4 && (
                <div className="intake-fade-in space-y-4">
                   <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                     <AlertTriangle size={16} className="mt-0.5 flex-none" />
                     <span>
                       <strong>Final review.</strong> Once submitted, this application is locked and cannot be rejected by staff.
                     </span>
                   </div>

                   <div className={`overflow-hidden rounded-lg border ${
                     notesHaveUnsavedChanges ? 'border-amber-300' : 'border-emerald-200'
                   }`}>
                     <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 ${
                       notesHaveUnsavedChanges
                         ? 'border-amber-200 bg-amber-50'
                         : 'border-emerald-200 bg-emerald-50'
                     }`}>
                       <div>
                         <p className="text-[11px] font-bold uppercase tracking-wide text-slate-700">Staff Notes</p>
                         <p className={`mt-0.5 text-[11px] ${
                           notesHaveUnsavedChanges ? 'text-amber-800' : 'text-emerald-700'
                         }`}>
                           {notesHaveUnsavedChanges
                             ? 'These changes are not recorded yet. Click Save Notes before submitting.'
                             : 'The contact summary and review notes are saved in the application record.'}
                         </p>
                       </div>
                       {notesHaveUnsavedChanges && (
                         <button
                           type="button"
                           onClick={handleSaveNotes}
                           disabled={isSaving}
                           className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-800 transition hover:bg-amber-100 disabled:opacity-60"
                         >
                           {isSaving ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                           Save Notes
                         </button>
                       )}
                     </div>
                     <div className="grid grid-cols-1 gap-3 px-4 py-3 text-sm md:grid-cols-2">
                       <label className={fieldLabel}>
                         <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                           Staff Contact Summary
                         </span>
                         <textarea
                           value={contactNotes}
                           onChange={(event) => setContactNotes(event.target.value)}
                           rows={3}
                           className={`${inputClass} resize-y leading-relaxed`}
                           placeholder="How you contacted the requestor and what was discussed"
                         />
                       </label>
                       <label className={fieldLabel}>
                         <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                           Staff Review Notes
                         </span>
                         <textarea
                           value={staffNotes}
                           onChange={(event) => setStaffNotes(event.target.value)}
                           rows={3}
                           className={`${inputClass} resize-y leading-relaxed`}
                           placeholder="Recommended logistics, schedule, and internal remarks"
                         />
                       </label>
                     </div>
                   </div>

                   <div className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Event Details</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 px-4 py-3 text-sm md:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event Name</p>
                        <p className="text-slate-900">{requestDraft.eventName || <span className="text-slate-400">â€”</span>}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event Type</p>
                        <p className="text-slate-900">{normalizeEventVisibility(requestDraft.eventVisibility)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Start</p>
                        <p className="text-slate-900">{requestDraft.startDate ? formatDateTime(requestDraft.startDate) : <span className="text-slate-400">â€”</span>}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">End</p>
                        <p className="text-slate-900">{requestDraft.endDate ? formatDateTime(requestDraft.endDate) : <span className="text-slate-400">â€”</span>}</p>
                      </div>
                      <div className="md:col-span-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event By</p>
                        <p className="text-slate-900">{requestDraft.eventBy || <span className="text-slate-400">â€”</span>}</p>
                      </div>
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Location</p>
                    </div>
                    <div className="space-y-3 px-4 py-3 text-sm">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Venue</p>
                        <p className="text-slate-900">{requestDraft.venueName || <span className="text-slate-400">â€”</span>}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Address</p>
                        <p className="text-slate-900">
                          {[requestDraft.street, requestDraft.barangay, requestDraft.cityMunicipality, requestDraft.province, requestDraft.region, requestDraft.country]
                            .filter((part) => String(part || '').trim())
                            .join(', ') || <span className="text-slate-400">â€”</span>}
                        </p>
                      </div>
                      <MapPreview
                        latitude={requestDraft.latitude}
                        longitude={requestDraft.longitude}
                        label={requestDraft.venueName || requestDraft.eventName || 'Event venue'}
                      />
                    </div>
                  </div>

                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Media & Partners</p>
                    </div>
                    <div className="space-y-3 px-4 py-3 text-sm">
                      {requestDraft.eventPhotoUrl ? (
                        <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                          <div className="flex items-center justify-center bg-slate-100" style={{ maxHeight: '220px' }}>
                            <img
                              src={requestDraft.eventPhotoUrl}
                              alt="Event poster"
                              className="max-h-[220px] w-auto max-w-full object-contain"
                              onError={(event) => { event.currentTarget.style.display = 'none'; }}
                            />
                          </div>
                          <div className="border-t border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700">
                            Event Poster
                          </div>
                        </div>
                      ) : (
                        <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                          Event poster is missing. Go back to Step 3 to add it.
                        </p>
                      )}
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Partnered With</p>
                          <p className="text-slate-900">{requestDraft.partneredWith || <span className="text-slate-400">â€”</span>}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Partner Social Media</p>
                          <p className="break-all text-slate-900">{requestDraft.partnerSocialMediaLink || <span className="text-slate-400">â€”</span>}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        );
      })()}
      </div>
    </>
  );
}
