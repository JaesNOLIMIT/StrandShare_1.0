import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  HelpCircle,
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
  User,
  UserCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { triggerSmtpNow } from '../../../lib/smtpTriggerClient';
import ProgramScheduleCalendarModal, {
  formatScheduleDateLabel,
  toScheduleDateKey,
} from '../../../components/events/ProgramScheduleCalendarModal';

const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const USERS_TABLE = 'users';
const SMTP_OUTBOX_TABLE = 'SMTP_Email_Outbox';
const PRIVATE_ID_BUCKET = 'event_application_private_ids';

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
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
  if (key === 'pendingadminapproval') return 'Pending Admin Approval';
  if (key === 'appealed') return 'Appealed';
  if (key === 'approved') return 'Approved';
  if (key === 'rejected') return 'Rejected';
  if (key === 'cancelled') return 'Cancelled';
  return value || 'N/A';
}

function statusPillClass(value) {
  const key = normalizeStatus(value);
  if (key === 'pendingadminapproval') return 'border border-amber-200 bg-amber-50 text-amber-700';
  if (key === 'appealed') return 'border border-violet-200 bg-violet-50 text-violet-700';
  if (key === 'approved') return 'border border-emerald-200 bg-emerald-50 text-emerald-700';
  if (key === 'rejected') return 'border border-rose-200 bg-rose-50 text-rose-700';
  if (key === 'cancelled') return 'border border-slate-300 bg-slate-100 text-slate-700';
  return 'border border-slate-200 bg-slate-100 text-slate-700';
}

function eventVisibilityLabel(value) {
  const key = normalizeStatus(value);
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

function applicantFullName(applicationRow) {
  return [
    applicationRow?.Applicant_First_Name,
    applicationRow?.Applicant_Middle_Name,
    applicationRow?.Applicant_Last_Name,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ') || 'N/A';
}

function extractVenueName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'N/A';
  const firstSegment = raw.split(',')[0]?.trim();
  return firstSegment || raw;
}

function applicantInitials(applicationRow) {
  const full = applicantFullName(applicationRow);
  if (full === 'N/A') return 'NA';
  const parts = full.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : '';
  return `${first}${last}`.toUpperCase() || 'NA';
}

function staffLabel(staff) {
  const email = String(staff?.email || '').trim();
  if (email) return email;
  return 'Staff member';
}

function InfoItem({ icon: Icon, label, children, span }) {
  return (
    <div className={`flex items-start gap-2.5 ${span === 2 ? 'sm:col-span-2' : ''}`}>
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-md bg-slate-100 text-slate-500">
        <Icon size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <div className="break-words text-sm text-slate-800">{children}</div>
      </div>
    </div>
  );
}

function ContactLink({ type, value }) {
  const normalized = String(value || '').trim();
  if (!normalized) return <span className="text-slate-500">Not provided</span>;
  const href = type === 'Phone' ? `tel:${normalized.replace(/[^+\d]/g, '')}` : `mailto:${normalized}`;
  return <a href={href} className="font-semibold text-teal-700 hover:underline">{normalized}</a>;
}

function AttachmentTile({ url, label }) {
  if (!url) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center">
        <ImageIcon size={20} className="text-slate-400" />
        <p className="mt-1.5 text-xs font-semibold text-slate-600">{label}</p>
        <p className="text-[11px] text-slate-400">Not provided</p>
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="group block overflow-hidden rounded-lg border border-slate-200 bg-slate-50 transition hover:border-slate-400 hover:shadow-md">
      <div className="aspect-[4/3] w-full overflow-hidden bg-slate-100">
        <img src={url} alt={label} className="h-full w-full object-cover transition group-hover:scale-[1.02]" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-3 py-1.5">
        <span className="text-xs font-semibold text-slate-700">{label}</span>
        <ExternalLink size={12} className="text-slate-400 group-hover:text-slate-700" />
      </div>
    </a>
  );
}

function MapPreview({ latitude, longitude, label }) {
  const [mapType, setMapType] = useState('m');
  const lat = Number(latitude);
  const lng = Number(longitude);
  const hasCoords = latitude !== null && latitude !== undefined
    && longitude !== null && longitude !== undefined
    && String(latitude).trim() !== '' && String(longitude).trim() !== ''
    && Number.isFinite(lat) && Number.isFinite(lng);

  if (!hasCoords) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
        <MapPin size={20} className="text-slate-400" />
        <p className="mt-1.5 text-sm font-semibold text-slate-700">Pin location unavailable</p>
        <p className="text-xs text-slate-500">No map coordinates were provided.</p>
      </div>
    );
  }

  const embedSrc = `https://maps.google.com/maps?q=${lat},${lng}&z=17&t=${mapType}&output=embed&hl=en`;
  const openMapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
          <button type="button" onClick={() => setMapType('m')} className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold ${mapType === 'm' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}><MapPin size={11} /> Map</button>
          <button type="button" onClick={() => setMapType('k')} className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold ${mapType === 'k' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}><Satellite size={11} /> Satellite</button>
        </div>
        <a href={openMapUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:underline">Open map <ExternalLink size={11} /></a>
      </div>
      <iframe title={label || 'Program venue map'} src={embedSrc} className="block h-72 w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen />
      <div className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500">Pin: {lat.toFixed(6)}, {lng.toFixed(6)}</div>
    </div>
  );
}

function AdminRequestDetails({ row, privateIdUrl, assignedStaffLabel }) {
  const application = row?.Application || {};
  const preferredMethod = preferredContactMethodLabel(application.Preferred_Contact_Method);
  const secondaryMethod = preferredMethod === 'Email' ? 'Phone' : 'Email';
  const email = String(application.Applicant_Email || '').trim();
  const phone = String(application.Applicant_Contact_Number || '').trim();
  const preferredFallback = String(application.Preferred_Contact_Detail || '').trim();
  const primaryContact = preferredMethod === 'Email' ? (email || preferredFallback) : (phone || preferredFallback);
  const secondaryContact = secondaryMethod === 'Email' ? email : phone;
  const completeAddress = [row.Street, row.Barangay, row.City_Municipality, row.Province, row.Region, row.Country]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
  const socialName = row.Partnered_With || application.Social_Page_Name || '';
  const socialUrl = String(row.Partner_Social_Media_Link || application.Social_Page_URL || '').trim();
  const safeSocialUrl = socialUrl && /^https?:\/\//i.test(socialUrl) ? socialUrl : socialUrl ? `https://${socialUrl}` : '';
  const posterUrl = row.Event_Photo_URL || application.Event_Poster_Photo_URL || '';

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Applicant & Identity</p>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <InfoItem icon={User} label="Full Name" span={2}>{applicantFullName(application)}</InfoItem>
                <InfoItem icon={User} label="Gender">{application.Applicant_Gender || 'Not provided'}</InfoItem>
                <InfoItem icon={FileText} label="Verified ID Type">{validIdTypeLabel(application.Applicant_Valid_ID_Type)}</InfoItem>
                <InfoItem icon={CheckCircle2} label="ID Verification">{application.Didit_Verification_Status || 'Legacy application'}</InfoItem>
                <InfoItem icon={FileText} label="ID Number">{application.Applicant_ID_Document_Number || 'Not provided'}</InfoItem>
                <InfoItem icon={MapPin} label="Address on ID" span={2}>{application.Applicant_ID_Address || 'Not provided'}</InfoItem>
              </div>
              <AttachmentTile url={privateIdUrl || application.Applicant_Valid_ID_URL} label="Verified ID Front" />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Contact Priority</p>
            <div className="grid grid-cols-1 gap-4">
              <InfoItem icon={CheckCircle2} label="Preferred Method">{preferredMethod}</InfoItem>
              <InfoItem icon={preferredMethod === 'Email' ? Mail : Phone} label={`Primary · ${preferredMethod}`}><ContactLink type={preferredMethod} value={primaryContact} /></InfoItem>
              <InfoItem icon={secondaryMethod === 'Email' ? Mail : Phone} label={`Secondary · ${secondaryMethod}`}><ContactLink type={secondaryMethod} value={secondaryContact} /></InfoItem>
              <p className="rounded-md border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-700">Use the primary contact first and the secondary option as backup.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Program Details</p>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <InfoItem icon={FileText} label="Program Name" span={2}>{row.Event_Name || application.Event_Name || 'Untitled program'}</InfoItem>
              <InfoItem icon={Info} label="Program Type">{eventVisibilityLabel(row.Event_Visibility || application.Event_Visibility)}</InfoItem>
              <InfoItem icon={Users} label="Expected Attendees">
                {String(application.Expected_Attendees ?? '').trim() ? Number(application.Expected_Attendees).toLocaleString('en-PH') : 'Not provided'}
              </InfoItem>
              <InfoItem icon={User} label="Program Organizer">{row.Event_By || applicantFullName(application)}</InfoItem>
              <InfoItem icon={FileText} label="Program Overview" span={2}>{application.Event_Overview || 'Not provided'}</InfoItem>
              <InfoItem icon={Globe2} label="Organization / Social Page">{socialName || 'Not provided'}</InfoItem>
              <InfoItem icon={ExternalLink} label="Social Page Link">
                {safeSocialUrl ? <a href={safeSocialUrl} target="_blank" rel="noreferrer" className="font-semibold text-teal-700 hover:underline">Open social page</a> : 'Not provided'}
              </InfoItem>
            </div>
          </div>
          <AttachmentTile url={posterUrl} label="Program Poster" />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Schedule & Venue</p>
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
          <InfoItem icon={Calendar} label="Program Start">{formatDateTime(row.Start_Date)}</InfoItem>
          <InfoItem icon={Calendar} label="Program End">{formatDateTime(row.End_Date)}</InfoItem>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <InfoItem icon={MapPin} label="Venue Name" span={2}>{extractVenueName(row.Venue_Name || application.Venue_Address)}</InfoItem>
              <InfoItem icon={MapPin} label="Street">{row.Street || 'Not provided'}</InfoItem>
              <InfoItem icon={MapPin} label="Barangay">{row.Barangay || 'Not provided'}</InfoItem>
              <InfoItem icon={MapPin} label="City / Municipality">{row.City_Municipality || 'Not provided'}</InfoItem>
              <InfoItem icon={MapPin} label="Province">{row.Province || 'Not provided'}</InfoItem>
              <InfoItem icon={MapPin} label="Region">{row.Region || 'Not provided'}</InfoItem>
              <InfoItem icon={MapPin} label="Country">{row.Country || 'Philippines'}</InfoItem>
              <InfoItem icon={MapPin} label="Complete Address" span={2}>{completeAddress || 'Not provided'}</InfoItem>
            </div>
          </div>
          <AttachmentTile url={application.Event_Place_Photo_URL} label="Program Place" />
        </div>
        <div className="mt-4"><MapPreview latitude={row.Latitude} longitude={row.Longitude} label={`${row.Event_Name || 'Program'} venue`} /></div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Staff Review & Admin Progress</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <InfoItem icon={Info} label="Request Status">{statusLabel(row.Status)}</InfoItem>
          <InfoItem icon={Clock3} label="Application Submitted">{formatDateTime(application.Created_At)}</InfoItem>
          <InfoItem icon={Clock3} label="Staff Prepared">{formatDateTime(row.Staff_Prepared_At)}</InfoItem>
          <InfoItem icon={UserCheck} label="Assigned Staff">{assignedStaffLabel}</InfoItem>
          <InfoItem icon={Clock3} label="Admin Reviewed">{formatDateTime(row.Admin_Reviewed_At)}</InfoItem>
          <InfoItem icon={FileText} label="Application Resubmissions">{Number(application.Resubmission_Count || 0)}</InfoItem>
          <InfoItem icon={Users} label="Hair Collected">{Number(row.Hair_Collected_Count || 0).toLocaleString('en-PH')}</InfoItem>
          {row.Private_Event_Code && <InfoItem icon={FileText} label="Private Program Code">{row.Private_Event_Code}</InfoItem>}
          {row.Admin_Decision_Reason && <InfoItem icon={AlertTriangle} label="Admin Decision Reason" span={2}>{row.Admin_Decision_Reason}</InfoItem>}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Staff Contact Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{row.Staff_Contact_Notes || application.Staff_Contact_Notes || 'Not provided'}</p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Staff Review Notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{application.Staff_Review_Notes || 'Not provided'}</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function PortalModal({ open, children }) {
  if (!open) return null;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-[2px]">
      {children}
    </div>,
    document.body,
  );
}

export default function ManageEventRequestsPage({ isActivePage = false }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';

  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingStaff, setIsLoadingStaff] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [rows, setRows] = useState([]);
  const [staffOptions, setStaffOptions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [privateIdUrl, setPrivateIdUrl] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCalendarDate, setSelectedCalendarDate] = useState('');
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
  const [isWorkflowModalOpen, setIsWorkflowModalOpen] = useState(false);

  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [assignedStaffId, setAssignedStaffId] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [resultModalData, setResultModalData] = useState({ title: '', lines: [] });

  const loadRows = useCallback(async ({ silent = false } = {}) => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      setRows([]);
      return;
    }

    if (!silent) {
      setIsLoading(true);
      setNotice({ kind: '', text: '' });
    }

    try {
      const requestsResult = await supabase
        .from(EVENT_REQUESTS_TABLE)
        .select('*')
        .order('Created_At', { ascending: true })
        .limit(400);

      if (requestsResult.error) throw requestsResult.error;

      const requestRows = requestsResult.data || [];
      const applicationIds = [...new Set(requestRows.map((row) => Number(row.Event_Application_ID || 0)).filter((value) => value > 0))];

      let applicationRows = [];
      if (applicationIds.length > 0) {
        const applicationsResult = await supabase
          .from(EVENT_APPLICATIONS_TABLE)
          .select('*')
          .in('Event_Application_ID', applicationIds);
        if (applicationsResult.error) throw applicationsResult.error;
        applicationRows = applicationsResult.data || [];
      }

      const applicationById = new Map(
        applicationRows.map((row) => [Number(row.Event_Application_ID || 0), row]),
      );

      const mergedRows = requestRows.map((requestRow) => ({
        ...requestRow,
        Application: applicationById.get(Number(requestRow.Event_Application_ID || 0)) || null,
      }));

      setRows(mergedRows);
      setSelectedId((current) => (
        mergedRows.some((row) => Number(row.Event_Request_ID) === Number(current))
          ? current
          : null
      ));
    } catch (error) {
      if (!silent) {
        setRows([]);
        setNotice({ kind: 'error', text: error.message || 'Unable to load event requests.' });
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  const loadStaffOptions = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setStaffOptions([]);
      return;
    }

    setIsLoadingStaff(true);
    try {
      const staffResult = await supabase
        .from(USERS_TABLE)
        .select('user_id, email, role, is_active')
        .order('user_id', { ascending: true });

      if (staffResult.error) throw staffResult.error;

      const options = (staffResult.data || []).filter((row) => normalizeRole(row.role) === 'staff' && row.is_active !== false);
      setStaffOptions(options);
    } catch (error) {
      setStaffOptions([]);
      setNotice({ kind: 'error', text: error.message || 'Unable to load staff accounts for assignment.' });
    } finally {
      setIsLoadingStaff(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
    loadStaffOptions();
  }, [loadRows, loadStaffOptions]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

    let refreshTimer = null;
    const scheduleRealtimeRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        loadRows({ silent: true });
        refreshTimer = null;
      }, 120);
    };

    const requestsChannel = supabase
      .channel('admin-event-requests-management-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: EVENT_REQUESTS_TABLE },
        scheduleRealtimeRefresh,
      )
      .subscribe();

    const applicationsChannel = supabase
      .channel('admin-event-applications-management-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: EVENT_APPLICATIONS_TABLE },
        scheduleRealtimeRefresh,
      )
      .subscribe();

    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      supabase.removeChannel(requestsChannel);
      supabase.removeChannel(applicationsChannel);
    };
  }, [loadRows]);

  const queueRows = useMemo(() => {
    return rows.filter((row) => {
      const key = normalizeStatus(row.Status);
      if (statusFilter === 'pendingadminapproval') return key === 'pendingadminapproval';
      if (statusFilter === 'appealed') return key === 'appealed';
      if (statusFilter === 'approved') return key === 'approved';
      if (statusFilter === 'rejected') return key === 'rejected';
      if (statusFilter === 'cancelled') return key === 'cancelled';
      return true;
    });
  }, [rows, statusFilter]);

  const visibleRows = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const dateFilteredRows = selectedCalendarDate
      ? queueRows.filter((row) => (
        toScheduleDateKey(row.Start_Date) === selectedCalendarDate
      ))
      : queueRows;
    if (!query) return dateFilteredRows;
    return dateFilteredRows.filter((row) => {
      const requestId = String(row.Event_Request_ID || '').toLowerCase();
      const eventName = String(row.Event_Name || '').toLowerCase();
      const applicantName = applicantFullName(row.Application).toLowerCase();
      const venue = String(row.Venue_Name || '').toLowerCase();
      return requestId.includes(query)
        || eventName.includes(query)
        || applicantName.includes(query)
        || venue.includes(query);
    });
  }, [queueRows, searchTerm, selectedCalendarDate]);

  const statusCounts = useMemo(() => {
    return rows.reduce((acc, row) => {
      const statusKey = normalizeStatus(row.Status);
      acc.all += 1;
      if (statusKey === 'pendingadminapproval') acc.pendingadminapproval += 1;
      if (statusKey === 'appealed') acc.appealed += 1;
      if (statusKey === 'approved') acc.approved += 1;
      if (statusKey === 'rejected') acc.rejected += 1;
      if (statusKey === 'cancelled') acc.cancelled += 1;
      return acc;
    }, {
      all: 0,
      pendingadminapproval: 0,
      appealed: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
    });
  }, [rows]);

  const selectedRow = useMemo(() => (
    rows.find((row) => Number(row.Event_Request_ID || 0) === Number(selectedId || 0)) || null
  ), [rows, selectedId]);

  useEffect(() => {
    const selectedIsVisible = visibleRows.some(
      (row) => Number(row.Event_Request_ID || 0) === Number(selectedId || 0),
    );
    if (!selectedIsVisible) {
      setSelectedId(null);
    }
  }, [selectedId, visibleRows]);

  useEffect(() => {
    if (isActivePage) {
      setSelectedId(null);
      setPrivateIdUrl('');
      setIsApproveModalOpen(false);
      setIsRejectModalOpen(false);
      setIsResultModalOpen(false);
      setIsWorkflowModalOpen(false);
      setIsCalendarModalOpen(false);
    }
  }, [isActivePage]);

  useEffect(() => {
    let cancelled = false;
    setPrivateIdUrl('');
    const path = String(selectedRow?.Application?.Applicant_Valid_ID_Path || '').trim();
    if (!path || !supabase) return undefined;

    supabase.storage.from(PRIVATE_ID_BUCKET).createSignedUrl(path, 10 * 60)
      .then(({ data, error }) => {
        if (!cancelled && !error) setPrivateIdUrl(data?.signedUrl || '');
      });
    return () => { cancelled = true; };
  }, [selectedRow?.Application?.Applicant_Valid_ID_Path]);

  const selectedStatusKey = useMemo(() => normalizeStatus(selectedRow?.Status), [selectedRow]);
  const canDecide = selectedStatusKey === 'pendingadminapproval' || selectedStatusKey === 'appealed';

  const assignedStaffLabel = useMemo(() => {
    const id = Number(selectedRow?.Assigned_Staff_User_ID || 0);
    if (id <= 0) return 'Not assigned';
    const row = staffOptions.find((staff) => Number(staff.user_id || 0) === id);
    return row ? staffLabel(row) : 'Assigned staff account';
  }, [selectedRow, staffOptions]);

  const nextActionCard = useMemo(() => {
    if (!selectedRow) {
      return {
        icon: Clock3,
        tone: 'border-slate-200 bg-slate-50 text-slate-700',
        title: 'Select an application',
        body: 'Choose a staff-endorsed program application to review and decide.',
      };
    }
    if (selectedStatusKey === 'pendingadminapproval' || selectedStatusKey === 'appealed') {
      return {
        icon: AlertTriangle,
        tone: 'border-amber-200 bg-amber-50 text-amber-800',
        title: 'Admin decision required',
        body: 'Approve with assigned staff, or reject with reason in modal.',
      };
    }
    if (selectedStatusKey === 'approved') {
      return {
        icon: CheckCircle2,
        tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
        title: 'Request already approved',
        body: 'Staff assignment and approval decision were already recorded.',
      };
    }
    if (selectedStatusKey === 'rejected') {
      return {
        icon: XCircle,
        tone: 'border-rose-200 bg-rose-50 text-rose-700',
        title: 'Request rejected',
        body: 'The applicant was advised to wait for staff contact or email Donivra directly. Staff can revise and resubmit this request as an appeal.',
      };
    }
    return {
      icon: Clock3,
      tone: 'border-slate-200 bg-slate-50 text-slate-700',
      title: 'Request state',
      body: 'Review details and proceed based on current request status.',
    };
  }, [selectedRow, selectedStatusKey]);
  const NextActionIcon = nextActionCard.icon;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const checkLatestEmailQueue = useCallback(async (requestId, notificationType) => {
    if (!supabase) {
      return { ok: false, text: 'Email status check unavailable.' };
    }
    try {
      let latest = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await supabase
          .from(SMTP_OUTBOX_TABLE)
          .select('Status, Recipient_Email, Created_At, Sent_At, Last_Error')
          .eq('Source_Table', EVENT_REQUESTS_TABLE)
          .eq('Source_ID', requestId)
          .eq('Notification_Type', notificationType)
          .order('Created_At', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (result.error) {
          return { ok: false, text: `Email status check failed: ${result.error.message}` };
        }

        latest = result.data || null;
        const statusKey = normalizeStatus(latest?.Status || '');
        if (statusKey === 'sent') {
          return {
            ok: true,
            text: `Email sent to ${latest.Recipient_Email || 'recipient'} at ${formatDateTime(latest.Sent_At || latest.Created_At)}.`,
          };
        }
        if (statusKey === 'failed' || statusKey === 'cancelled') {
          return {
            ok: false,
            text: `Email failed for ${latest.Recipient_Email || 'recipient'}: ${latest.Last_Error || 'Unknown SMTP error'}`,
          };
        }

        await wait(1000);
      }

      if (!latest) {
        return { ok: false, text: 'No email row found (missing recipient email or trigger issue).' };
      }

      return {
        ok: true,
        text: `Email is processing and will send shortly to ${latest.Recipient_Email || 'recipient'}.`,
      };
    } catch (error) {
      return { ok: false, text: `Email status check failed: ${error.message || 'Unknown error'}` };
    }
  }, []);

  const openApproveModal = () => {
    if (!selectedRow) return;
    if (!canDecide) {
      setNotice({ kind: 'error', text: 'Only pending or appealed requests can be approved.' });
      return;
    }
    setAssignedStaffId(String(selectedRow.Assigned_Staff_User_ID || ''));
    setIsApproveModalOpen(true);
  };

  const openRejectModal = () => {
    if (!selectedRow) return;
    if (!canDecide) {
      setNotice({ kind: 'error', text: 'Only pending or appealed requests can be rejected.' });
      return;
    }
    setRejectReason('');
    setIsRejectModalOpen(true);
  };

  const closeAllModals = () => {
    if (isSaving) return;
    setIsApproveModalOpen(false);
    setIsRejectModalOpen(false);
    setIsResultModalOpen(false);
  };

  const applyApproveDecision = async () => {
    if (!selectedRow?.Event_Request_ID) return;

    const staffIdNumber = Number(assignedStaffId || 0);
    if (!staffIdNumber) {
      setNotice({ kind: 'error', text: 'Please select one staff member to assign before approval.' });
      return;
    }

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const payload = {
        Status: 'Approved',
        Assigned_Staff_User_ID: staffIdNumber,
        Admin_Decision_Reason: null,
      };

      const result = await supabase
        .from(EVENT_REQUESTS_TABLE)
        .update(payload)
        .eq('Event_Request_ID', selectedRow.Event_Request_ID)
        .select('*')
        .single();

      if (result.error) throw result.error;

      const updated = result.data;
      setRows((current) => current.map((row) => (
        Number(row.Event_Request_ID || 0) === Number(updated.Event_Request_ID || 0)
          ? { ...updated, Application: row.Application || null }
          : row
      )));
      await loadRows({ silent: true });

      const smtpKickResult = await triggerSmtpNow('admin_approved_event_request');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after admin approval failed:', smtpKickResult.message || smtpKickResult);
      }
      const emailStatus = await checkLatestEmailQueue(updated.Event_Request_ID, 'admin_approved');
      setResultModalData({
        title: 'Program Approved',
        lines: [
          `Assigned Staff: ${staffOptions.find((staff) => Number(staff.user_id || 0) === staffIdNumber) ? staffLabel(staffOptions.find((staff) => Number(staff.user_id || 0) === staffIdNumber)) : 'Assigned staff account'}`,
          emailStatus.text,
        ],
      });
      setIsApproveModalOpen(false);
      setSelectedId(null);
      setIsResultModalOpen(true);
    } catch (error) {
      const raw = String(error?.message || '').trim();
      if (raw.toLowerCase().includes('admin cannot change event application status directly')) {
        setNotice({
          kind: 'error',
          text: 'Appealed approval is blocked by older DB workflow logic. Apply migration 136_allow_appealed_application_to_sync_approved.sql, then retry.',
        });
      } else {
        setNotice({ kind: 'error', text: raw || 'Unable to approve event request.' });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const applyRejectDecision = async () => {
    if (!selectedRow?.Event_Request_ID) return;
    if (!rejectReason.trim()) {
      setNotice({ kind: 'error', text: 'Rejection reason is required.' });
      return;
    }

    setIsSaving(true);
    setNotice({ kind: '', text: '' });

    try {
      const payload = {
        Status: 'Rejected',
        Admin_Decision_Reason: rejectReason.trim(),
      };

      const result = await supabase
        .from(EVENT_REQUESTS_TABLE)
        .update(payload)
        .eq('Event_Request_ID', selectedRow.Event_Request_ID)
        .select('*')
        .single();

      if (result.error) throw result.error;

      const updated = result.data;
      setRows((current) => current.map((row) => (
        Number(row.Event_Request_ID || 0) === Number(updated.Event_Request_ID || 0)
          ? { ...updated, Application: row.Application || null }
          : row
      )));
      await loadRows({ silent: true });

      const smtpKickResult = await triggerSmtpNow('admin_rejected_event_request');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after admin rejection failed:', smtpKickResult.message || smtpKickResult);
      }
      const emailStatus = await checkLatestEmailQueue(updated.Event_Request_ID, 'admin_rejected');
      setResultModalData({
        title: 'Program Rejected',
        lines: [
          `Reason: ${rejectReason.trim()}`,
          emailStatus.text,
        ],
      });
      setIsRejectModalOpen(false);
      setSelectedId(null);
      setIsResultModalOpen(true);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to reject event request.' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="role-page-title text-2xl font-bold text-slate-900">Manage Program Applications</h1>
          <p className="text-sm text-slate-600">Review complete staff-endorsed applications, assign one staff member, and finalize the admin decision.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setIsWorkflowModalOpen(true)} aria-label="Open workflow guide" title="Workflow guide" className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"><HelpCircle size={17} /></button>
          <button type="button" onClick={loadRows} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" disabled={isLoading}><RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />Refresh</button>
        </div>
      </div>

      {notice.text && (
        <div className={`flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {notice.kind === 'error' ? <AlertTriangle size={16} className="mt-0.5 flex-none" /> : <CheckCircle2 size={16} className="mt-0.5 flex-none" />}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px,1fr]">
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="space-y-3 border-b border-slate-200 px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-800">
                <Inbox size={14} />
                Admin Review Queue
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsCalendarModalOpen(true)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-bold transition ${
                    selectedCalendarDate
                      ? 'border-sky-200 bg-sky-50 text-sky-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Calendar size={12} />
                  {selectedCalendarDate ? formatScheduleDateLabel(selectedCalendarDate, true) : 'Calendar'}
                </button>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">{visibleRows.length}</span>
              </div>
            </div>

            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search applicant, program, or venue..."
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
                { key: 'pendingadminapproval', label: 'Pending Admin' },
                { key: 'appealed', label: 'Appealed' },
                { key: 'approved', label: 'Approved' },
                { key: 'rejected', label: 'Rejected' },
                { key: 'cancelled', label: 'Cancelled' },
              ].map((filter) => {
                const isActive = statusFilter === filter.key;
                const count = statusCounts[filter.key] || 0;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    onClick={() => setStatusFilter(filter.key)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                      isActive ? 'border-transparent text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
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
                    {formatScheduleDateLabel(selectedCalendarDate)}
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
                  {queueRows.length === 0 ? 'No program applications' : 'No matches'}
                </p>
                <p className="text-xs text-slate-500">
                  {queueRows.length === 0 ? 'Staff-submitted requests will appear here.' : 'Try another filter or clear your search.'}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {visibleRows.map((row) => {
                  const active = Number(row.Event_Request_ID || 0) === Number(selectedId || 0);
                  return (
                    <li key={row.Event_Request_ID}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(row.Event_Request_ID)}
                        className={`flex w-full items-start gap-3 px-4 py-3.5 text-left transition ${active ? 'bg-teal-50/60' : 'hover:bg-slate-50'}`}
                        style={active ? { boxShadow: `inset 3px 0 0 ${primaryColor}` } : undefined}
                      >
                        <div
                          className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-xs font-bold text-white"
                          style={{ backgroundColor: primaryColor }}
                        >
                          {applicantInitials(row.Application)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold text-slate-900">{row.Event_Name || 'Untitled Program'}</p>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-slate-600">{applicantFullName(row.Application)}</p>
                          <p className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
                            <Calendar size={11} />
                            {formatScheduleDateLabel(toScheduleDateKey(row.Start_Date), true)}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusPillClass(row.Status)}`}>
                              {statusLabel(row.Status)}
                            </span>
                            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                              {eventVisibilityLabel(row.Event_Visibility)}
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
                Choose a request from the queue on the left to review details and decide.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${primaryColor}, ${primaryColor}99)` }} />
                <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-12 w-12 flex-none items-center justify-center rounded-full text-sm font-bold text-white"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {applicantInitials(selectedRow.Application)}
                    </div>
                    <div>
                      <h2 className="mt-0.5 text-xl font-bold text-slate-900">{selectedRow.Event_Name || 'Untitled Program'}</h2>
                      <p className="text-sm text-slate-600">by {applicantFullName(selectedRow.Application)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusPillClass(selectedRow.Status)}`}>
                      {statusLabel(selectedRow.Status)}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700">
                      {eventVisibilityLabel(selectedRow.Event_Visibility)}
                    </span>
                  </div>
                </div>
              </div>

              <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${nextActionCard.tone}`}>
                <NextActionIcon size={18} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">{nextActionCard.title}</p>
                  <p className="mt-1">{nextActionCard.body}</p>
                </div>
              </div>

              <AdminRequestDetails row={selectedRow} privateIdUrl={privateIdUrl} assignedStaffLabel={assignedStaffLabel} />

              <div className="flex flex-wrap items-center justify-end gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <button
                  type="button"
                  onClick={openRejectModal}
                  disabled={!canDecide || isSaving}
                  className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
                >
                  <XCircle size={14} />
                  Reject
                </button>
                <button
                  type="button"
                  onClick={openApproveModal}
                  disabled={!canDecide || isSaving}
                  className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ backgroundColor: primaryColor }}
                >
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Approve
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <ProgramScheduleCalendarModal
        open={isCalendarModalOpen}
        onClose={() => setIsCalendarModalOpen(false)}
        records={rows}
        selectedDate={selectedCalendarDate}
        onSelectDate={setSelectedCalendarDate}
        primaryColor={primaryColor}
        title="Admin Program Calendar"
        description="Review program dates and filter the admin applications queue."
        recordNoun="application"
        resultCount={visibleRows.length}
        getStartDate={(row) => row.Start_Date}
        getEndDate={(row) => row.Start_Date}
        getStatus={(row) => row.Status}
        statusItems={[
          { key: 'pendingadminapproval', label: 'Pending Admin', dotClass: 'bg-amber-500', reserved: true },
          { key: 'appealed', label: 'Appealed', dotClass: 'bg-violet-500', reserved: true },
          { key: 'approved', label: 'Approved', dotClass: 'bg-emerald-500', reserved: true },
          { key: 'rejected', label: 'Rejected', dotClass: 'bg-rose-500', reserved: false },
          { key: 'cancelled', label: 'Cancelled', dotClass: 'bg-slate-400', reserved: false },
        ]}
        showOpenDates
      />

      <PortalModal open={isWorkflowModalOpen}>
        <section role="dialog" aria-modal="true" aria-labelledby="admin-workflow-title" className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
            <div><p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500">Workflow</p><h2 id="admin-workflow-title" className="mt-1 text-xl font-bold text-slate-900">Manage Program Applications</h2></div>
            <button type="button" onClick={() => setIsWorkflowModalOpen(false)} aria-label="Close workflow guide" className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 hover:bg-slate-50"><X size={17} /></button>
          </header>
          <div className="space-y-3 bg-white p-6">
            {[
              { step: 1, title: 'Review Request', body: 'Select a program from the queue and check the applicant, venue, schedule, valid ID, contact information, and staff notes.' },
              { step: 2, title: 'Make a Decision', body: 'Approve the program after assigning one Staff account, or reject it with a clear reason for the applicant and staff.' },
              { step: 3, title: 'Confirm Delivery', body: 'The result popup confirms the saved decision and reports the applicant email delivery status.' },
            ].map((item) => <div key={item.step} className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><span className="grid h-7 w-7 flex-none place-items-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: primaryColor }}>{item.step}</span><div><h3 className="text-sm font-bold text-slate-900">{item.title}</h3><p className="mt-1 text-sm leading-6 text-slate-600">{item.body}</p></div></div>)}
          </div>
        </section>
      </PortalModal>

      <PortalModal open={isApproveModalOpen}>
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 opacity-100 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Approve Program</h3>
              <button type="button" onClick={closeAllModals} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-slate-600">
              Assign one staff member before approving this program.
            </p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">Assigned Staff *</span>
              <select
                value={assignedStaffId}
                onChange={(event) => setAssignedStaffId(event.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                disabled={isLoadingStaff}
              >
                <option value="">{isLoadingStaff ? 'Loading staff...' : 'Select one staff'}</option>
                {staffOptions.map((staff) => (
                  <option key={staff.user_id} value={staff.user_id}>{staffLabel(staff)}</option>
                ))}
              </select>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeAllModals} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
              <button
                type="button"
                onClick={applyApproveDecision}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: primaryColor }}
              >
                {isSaving && <Loader2 size={14} className="animate-spin" />}
                <UserCheck size={14} />
                Confirm Approve
              </button>
            </div>
          </div>
      </PortalModal>

      <PortalModal open={isRejectModalOpen}>
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 opacity-100 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Reject Program</h3>
              <button type="button" onClick={closeAllModals} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-slate-600">
              Provide a clear reason for staff revision or final rejection.
            </p>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-700">Admin Decision Reason *</span>
              <textarea
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                rows={4}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                placeholder="What should staff change, or why this request is rejected"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeAllModals} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
              <button
                type="button"
                onClick={applyRejectDecision}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
              >
                {isSaving && <Loader2 size={14} className="animate-spin" />}
                <Send size={14} />
                Confirm Reject
              </button>
            </div>
          </div>
      </PortalModal>

      <PortalModal open={isResultModalOpen}>
          <div className="w-full max-w-lg rounded-xl border border-emerald-200 bg-white p-5 opacity-100 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="inline-flex items-center gap-2 text-lg font-semibold text-slate-900">
                <CheckCircle2 size={18} className="text-emerald-600" />
                {resultModalData.title || 'Decision Saved'}
              </h3>
              <button type="button" onClick={closeAllModals} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-2 text-sm text-slate-700">
              {(resultModalData.lines || []).map((line, index) => (
                <p key={`${line}-${index}`}>{line}</p>
              ))}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={closeAllModals}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: primaryColor }}
              >
                Close
              </button>
            </div>
          </div>
      </PortalModal>
    </div>
  );
}
