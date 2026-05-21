import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Inbox,
  Info,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Satellite,
  Search,
  Send,
  ShieldAlert,
  User,
  X,
  XCircle,
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import { useTheme } from '../../../context/ThemeContext';
import { triggerSmtpNow } from '../../../lib/smtpTriggerClient';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const EVENT_REQUESTS_TABLE = 'Event_Requests';
const USERS_TABLE = 'users';

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
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

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

export default function EventApplicationIntakePage({ userProfile }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [rows, setRows] = useState([]);
  const [eventRequestsById, setEventRequestsById] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [staffUserId, setStaffUserId] = useState(userProfile?.user_id || null);
  const [staffNotes, setStaffNotes] = useState('');
  const [contactNotes, setContactNotes] = useState('');
  const [staffRejectionReason, setStaffRejectionReason] = useState('');
  const [requestDraft, setRequestDraft] = useState(createRequestDraftFromApplication(null));
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitStep, setSubmitStep] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

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

    if (!silent) setIsLoading(true);
    setNotice({ kind: '', text: '' });

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
      setNotice({ kind: 'error', text: error.message || 'Unable to load event applications.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  // Realtime: keep applications + linked requests in sync without refetching
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

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
  }, []);

  const selectedRow = useMemo(() => {
    return rows.find((row) => Number(row.Event_Application_ID || 0) === Number(selectedId || 0)) || null;
  }, [rows, selectedId]);

  const selectedLinkedRequest = useMemo(() => {
    const requestId = Number(selectedRow?.Linked_Event_Request_ID || 0);
    if (requestId <= 0) return null;
    return eventRequestsById[requestId] || null;
  }, [eventRequestsById, selectedRow]);

  const linkedRequestStatusKey = useMemo(
    () => normalizeStatus(selectedLinkedRequest?.Status),
    [selectedLinkedRequest],
  );

  const canAppealRejectedRequest = Boolean(
    selectedRow?.Linked_Event_Request_ID
    && linkedRequestStatusKey === 'rejected',
  );

  const isLinkedToAdmin = Boolean(selectedRow?.Linked_Event_Request_ID);
  const isLockedFromActions = isLinkedToAdmin && !canAppealRejectedRequest;

  useEffect(() => {
    if (!selectedRow) {
      setStaffNotes('');
      setContactNotes('');
      setStaffRejectionReason('');
      setRequestDraft(createRequestDraftFromApplication(null));
      return;
    }

    setStaffNotes(selectedRow.Staff_Review_Notes || '');
    setContactNotes(selectedRow.Staff_Contact_Notes || '');
    setStaffRejectionReason(selectedRow.Staff_Rejection_Reason || '');
    setRequestDraft(createRequestDraftFromApplication(selectedRow));
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

  // Auto-select first row when nothing is selected yet (oldest first)
  useEffect(() => {
    if (selectedId == null && queueRows.length > 0) {
      setSelectedId(queueRows[0].Event_Application_ID);
    }
  }, [queueRows, selectedId]);

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
  }, [queueRows, searchTerm, statusFilter]);

  const updateSelected = async (nextValues) => {
    if (!selectedRow?.Event_Application_ID) return { ok: false };

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const result = await supabase
        .from(EVENT_APPLICATIONS_TABLE)
        .update(nextValues)
        .eq('Event_Application_ID', selectedRow.Event_Application_ID)
        .select('*')
        .maybeSingle();

      if (result.error) throw result.error;

      const updated = result.data || {
        ...selectedRow,
        ...nextValues,
      };
      setRows((current) => current.map((row) => (
        Number(row.Event_Application_ID || 0) === Number(updated.Event_Application_ID || 0)
          ? updated
          : row
      )));
      setNotice({ kind: 'success', text: 'Application updated.' });
      return { ok: true };
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to update application.' });
      return { ok: false };
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNotes = async () => {
    if (!selectedRow) return;

    await updateSelected({
      Staff_Contact_Notes: contactNotes.trim() || null,
      Staff_Review_Notes: staffNotes.trim() || null,
      Staff_Contacted_At: contactNotes.trim() ? getUtc8SqlNow() : selectedRow.Staff_Contacted_At,
      Staff_Reviewer_User_ID: staffUserId || selectedRow.Staff_Reviewer_User_ID || null,
    });
  };

  const handleConfirmSubmitToAdmin = async () => {
    if (!selectedRow) return;
    const linkedRequestId = Number(selectedRow.Linked_Event_Request_ID || 0);
    if (linkedRequestId > 0 && !canAppealRejectedRequest) {
      setNotice({ kind: 'success', text: `Request to admin already submitted (ER-${selectedRow.Linked_Event_Request_ID}).` });
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
      setNotice({ kind: 'error', text: 'Event name is required before forwarding to admin.' });
      return;
    }
    if (!payload.Start_Date || !payload.End_Date) {
      setNotice({ kind: 'error', text: 'Start and end schedule are required before forwarding to admin.' });
      return;
    }
    if (!payload.Event_Photo_URL) {
      setNotice({ kind: 'error', text: 'Event poster photo URL is required before forwarding to admin.' });
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

        const updateRequestResult = await supabase
          .from(EVENT_REQUESTS_TABLE)
          .update({
            ...baseAppealPayload,
            Status: 'Appealed',
          })
          .eq('Event_Request_ID', linkedRequestId);
        if (updateRequestResult.error) {
          const appealErrorText = String(updateRequestResult.error?.message || '').toLowerCase();
          const blockedRejectedToAppealed = appealErrorText.includes('staff cannot change event request status from rejected to appealed');
          if (!blockedRejectedToAppealed) throw updateRequestResult.error;

          // Backward compatibility for DBs still running older trigger logic:
          // allow resubmission using Pending Admin Approval.
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
            Staff_Contact_Notes: contactNotes.trim() || null,
            Staff_Review_Notes: staffNotes.trim() || null,
            Staff_Contacted_At: contactNotes.trim() ? getUtc8SqlNow() : selectedRow.Staff_Contacted_At,
          })
          .eq('Event_Application_ID', selectedRow.Event_Application_ID);

        if (updateApplicationResult.error) throw updateApplicationResult.error;

        await loadRows();
        const smtpKickResult = await triggerSmtpNow('staff_resubmitted_event_request');
        if (!smtpKickResult.ok) {
          console.warn('[SMTP] Trigger after staff appeal submit failed:', smtpKickResult.message || smtpKickResult);
        }
        setNotice({ kind: 'success', text: `Appeal submitted. Request ER-${linkedRequestId} is now marked as Appealed for admin re-decision.` });
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
        const createdRequestId = Number(insertResult.data?.Event_Request_ID || 0);
        setNotice({
          kind: 'success',
          text: createdRequestId > 0
            ? `Request submitted to admin (ER-${createdRequestId}).`
            : 'Request submitted to admin.',
        });
      }
      setShowSubmitModal(false);
    } catch (error) {
      const raw = String(error?.message || '').trim();
      if (raw.toLowerCase().includes('new row violates row-level security policy for table "event_requests"')) {
        setNotice({
          kind: 'error',
          text: 'Event request submit is blocked by database RLS. Apply the latest Supabase migrations, then retry.',
        });
      } else {
        setNotice({ kind: 'error', text: raw || 'Unable to create event request.' });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleConfirmReject = async () => {
    if (!selectedRow) return;
    if (!staffRejectionReason.trim()) {
      setNotice({ kind: 'error', text: 'Staff rejection reason is required.' });
      return;
    }
    const result = await updateSelected({
      Status: 'Rejected',
      Staff_Rejection_Reason: staffRejectionReason.trim(),
      Staff_Contact_Notes: contactNotes.trim() || null,
      Staff_Review_Notes: staffNotes.trim() || null,
      Staff_Contacted_At: contactNotes.trim() ? getUtc8SqlNow() : selectedRow.Staff_Contacted_At,
    });
    if (result?.ok) {
      const smtpKickResult = await triggerSmtpNow('staff_rejected_event_application');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after staff rejection failed:', smtpKickResult.message || smtpKickResult);
      }
      setShowRejectModal(false);
    }
  };

  const updateRequestDraftField = (key) => (event) => {
    setRequestDraft((previous) => ({ ...previous, [key]: event.target.value }));
  };

  const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';
  const fieldLabel = 'flex flex-col gap-1.5';
  const fieldLabelText = 'text-[11px] font-bold uppercase tracking-wide text-slate-600';

  const renderApplicationDetails = () => (
    <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5">
      <div>
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Applicant</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Applicant Profile</p>
            <div className="grid grid-cols-1 gap-3">
              <InfoItem icon={User} label="Full Name">{applicantFullName(selectedRow)}</InfoItem>
              <InfoItem icon={User} label="Gender">{selectedRow.Applicant_Gender || 'N/A'}</InfoItem>
              <InfoItem icon={FileText} label="Valid ID Type">{selectedRow.Applicant_Valid_ID_Type || 'N/A'}</InfoItem>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Preferred Contact</p>
            <div className="grid grid-cols-1 gap-3">
              <InfoItem icon={Phone} label="Contact Method">
                <span className="capitalize">{selectedRow.Preferred_Contact_Method || 'N/A'}</span>
              </InfoItem>
              <InfoItem icon={Mail} label="Contact Email">
                {selectedRow.Applicant_Email ? (
                  <a href={`mailto:${selectedRow.Applicant_Email}`} className="text-teal-700 hover:underline">
                    {selectedRow.Applicant_Email}
                  </a>
                ) : 'N/A'}
              </InfoItem>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Event Schedule & Venue</p>
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          <InfoItem icon={Calendar} label="Proposed Start">{formatDateTime(selectedRow.Proposed_Start_At)}</InfoItem>
          <InfoItem icon={Calendar} label="Proposed End">{formatDateTime(selectedRow.Proposed_End_At)}</InfoItem>
          <InfoItem icon={Info} label="Event Type">{normalizeEventVisibility(selectedRow.Event_Visibility)}</InfoItem>
          <InfoItem icon={MapPin} label="Venue" span={2}>{extractVenueName(selectedRow.Venue_Address)}</InfoItem>
          <InfoItem icon={MapPin} label="Address" span={2}>
            {[selectedRow.Street, selectedRow.Barangay, selectedRow.City, selectedRow.Province, selectedRow.Region, selectedRow.Country]
              .filter(Boolean)
              .join(', ') || 'N/A'}
          </InfoItem>
          {selectedRow.Event_Overview && (
            <InfoItem icon={FileText} label="Overview" span={2}>{selectedRow.Event_Overview}</InfoItem>
          )}
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Attachments</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <AttachmentTile url={selectedRow.Applicant_Valid_ID_URL} label="Valid ID" />
          <AttachmentTile url={selectedRow.Event_Place_Photo_URL} label="Event Place" />
          <AttachmentTile url={selectedRow.Event_Poster_Photo_URL} label="Event Poster" />
        </div>
      </div>

      {(isLinkedToAdmin || canAppealRejectedRequest) && (
        <div className="border-t border-slate-100 pt-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Linked Admin Request</p>
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
            <InfoItem icon={Send} label="Event Request">
              ER-{selectedRow.Linked_Event_Request_ID}
              {selectedLinkedRequest?.Status && (
                <span className="text-slate-500"> · {statusLabel(selectedLinkedRequest.Status)}</span>
              )}
            </InfoItem>
            {canAppealRejectedRequest && (
              <InfoItem icon={ShieldAlert} label="Admin Rejection Reason" span={2}>
                {selectedLinkedRequest?.Admin_Decision_Reason || 'No reason provided by admin.'}
              </InfoItem>
            )}
          </div>
        </div>
      )}
    </div>
  );

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
        <div className="flex items-start gap-3">
          <div
            className="flex h-11 w-11 flex-none items-center justify-center rounded-xl text-white shadow-sm"
            style={{ backgroundColor: primaryColor }}
          >
            <Inbox size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Manage Event Application</h1>
            <p className="text-sm text-slate-600">Review submissions, contact requestors, then forward to admin or reject.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => loadRows()}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isLoading}
        >
          <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
        </div>

      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Workflow</p>
        <div className="grid grid-cols-1 gap-y-3 sm:grid-cols-3 sm:gap-y-0">
          {[
            { step: 1, title: 'Review Intake', body: 'Check applicant details, files, and proposed event.' },
            { step: 2, title: 'Contact + Notes', body: 'Contact requestor using preferred method and save notes.' },
            { step: 3, title: 'Decision', body: 'Reject by staff or submit to admin for approval.' },
          ].map((stepRow, index) => (
            <div
              key={stepRow.step}
              className={`flex items-start gap-2.5 ${index > 0 ? 'sm:border-l sm:border-slate-100 sm:pl-5' : ''} ${index < 2 ? 'sm:pr-5' : ''}`}
            >
              <span
                className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
                style={{ backgroundColor: primaryColor }}
                aria-hidden
              >
                {stepRow.step}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800">{stepRow.title}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{stepRow.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {notice.text && (
        <div className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-sm ${
          notice.kind === 'error'
            ? 'border-rose-200 bg-rose-50 text-rose-700'
            : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}>
          {notice.kind === 'error'
            ? <AlertTriangle size={16} className="mt-0.5 flex-none" />
            : <CheckCircle2 size={16} className="mt-0.5 flex-none" />}
          <span>{notice.text}</span>
        </div>
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
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">
                  {visibleRows.length}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Oldest first
                </span>
              </div>
            </div>

            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search name, event, EA-ID..."
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
                    : 'Try a different filter or clear the search.'}
                </p>
                {queueRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setSearchTerm(''); setStatusFilter('all'); }}
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
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-semibold text-slate-900">
                              {row.Event_Name || 'Untitled Event'}
                            </p>
                            <span className="flex-none text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              EA-{row.Event_Application_ID}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-slate-600">{applicantFullName(row)}</p>
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
              <h2 className="mt-4 text-base font-bold text-slate-800">Select an event application</h2>
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
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">EA-{selectedRow.Event_Application_ID}</p>
                      <h2 className="mt-0.5 text-xl font-bold text-slate-900">{selectedRow.Event_Name || 'Untitled Event'}</h2>
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
              {isLockedFromActions && (
                <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-800">
                  <CheckCircle2 size={20} className="mt-0.5 flex-none" />
                  <div>
                    <p className="font-bold">Already submitted to admin (ER-{selectedRow.Linked_Event_Request_ID})</p>
                    <p className="mt-1">No further action is needed unless admin rejects the request. This application is now locked from further staff edits.</p>
                  </div>
                </div>
              )}
              {canAppealRejectedRequest && (
                <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-800">
                  <AlertTriangle size={20} className="mt-0.5 flex-none" />
                  <div>
                    <p className="font-bold">Admin rejected ER-{selectedRow.Linked_Event_Request_ID}</p>
                    <p className="mt-1">Review the admin&apos;s feedback below, update the details, then submit appeal.</p>
                  </div>
                </div>
              )}

              {renderApplicationDetails()}

              {/* Staff Notes — editable when not locked, read-only otherwise */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center gap-2">
                  <FileText size={15} className="text-slate-500" />
                  <h3 className="text-sm font-bold text-slate-800">Staff Notes</h3>
                  {isLockedFromActions && (
                    <span className="ml-1 rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                      Read-only
                    </span>
                  )}
                </div>
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

              {/* Action buttons — hidden when locked */}
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
                    Reject Application
                  </button>
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

      {/* Reject Modal */}
      <Modal
        open={showRejectModal}
        onClose={() => !isSaving && setShowRejectModal(false)}
        title="Reject Event Application"
        description="The applicant will be notified by email of this decision."
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
              Confirm Rejection
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
            <AlertTriangle size={16} className="mt-0.5 flex-none" />
            <span>
              <strong>This action cannot be undone.</strong> Once rejected, the applicant will receive
              an email with your reason and the application will be closed.
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
              Be specific so the applicant understands what to fix if they resubmit.
            </span>
          </label>
        </div>
      </Modal>

      {/* Submit to Admin Modal (4-step wizard) */}
      {(() => {
        const STEPS = [
          { id: 1, label: 'Event Details' },
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
            description={`Step ${submitStep} of ${STEPS.length} · ${STEPS[submitStep - 1].label}`}
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
                      disabled={isSaving}
                      className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                      Confirm & Submit to Admin
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

                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="border-b border-slate-200 bg-slate-50 px-4 py-2">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Event Details</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 px-4 py-3 text-sm md:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event Name</p>
                        <p className="text-slate-900">{requestDraft.eventName || <span className="text-slate-400">—</span>}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event Type</p>
                        <p className="text-slate-900">{normalizeEventVisibility(requestDraft.eventVisibility)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Start</p>
                        <p className="text-slate-900">{requestDraft.startDate ? formatDateTime(requestDraft.startDate) : <span className="text-slate-400">—</span>}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">End</p>
                        <p className="text-slate-900">{requestDraft.endDate ? formatDateTime(requestDraft.endDate) : <span className="text-slate-400">—</span>}</p>
                      </div>
                      <div className="md:col-span-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Event By</p>
                        <p className="text-slate-900">{requestDraft.eventBy || <span className="text-slate-400">—</span>}</p>
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
                        <p className="text-slate-900">{requestDraft.venueName || <span className="text-slate-400">—</span>}</p>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Address</p>
                        <p className="text-slate-900">
                          {[requestDraft.street, requestDraft.barangay, requestDraft.cityMunicipality, requestDraft.province, requestDraft.region, requestDraft.country]
                            .filter((part) => String(part || '').trim())
                            .join(', ') || <span className="text-slate-400">—</span>}
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
                          <p className="text-slate-900">{requestDraft.partneredWith || <span className="text-slate-400">—</span>}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Partner Social Media</p>
                          <p className="break-all text-slate-900">{requestDraft.partnerSocialMediaLink || <span className="text-slate-400">—</span>}</p>
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
