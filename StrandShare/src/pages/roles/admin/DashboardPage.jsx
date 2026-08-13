import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock3,
  HelpCircle,
  RefreshCw,
  Settings2,
  Users,
} from 'lucide-react';
import {
  ResponsiveContainer,
  Tooltip,
  LineChart,
  Line,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts';
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import { useTheme } from '../../../context/ThemeContext';

const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const HOSPITALS_TABLE = 'Hospitals';
const USERS_TABLE = 'users';
const WIG_REQUIREMENTS_TABLE = 'wig_requirements';
const LOGISTICS_SETTINGS_TABLE = 'Logistics_Settings';
const LEGAL_DOCUMENTS_TABLE = 'legal_documents';
const SUCCESS_COLOR = '#15803d';
const DANGER_COLOR = '#dc2626';
const PERFORMANCE_RANGES = {
  weekly: { label: 'Weekly', days: 7, bucket: 'day' },
  monthly: { label: 'Monthly', days: 30, bucket: 'day' },
  threeMonths: { label: '3 Months', days: 91, bucket: 'week' },
};

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function toManilaParts(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return formatter.formatToParts(date).reduce((parts, part) => {
    if (part.type !== 'literal') parts[part.type] = part.value;
    return parts;
  }, {});
}

function toManilaDayKey(value) {
  const parts = toManilaParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
}

function formatShortDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: '2-digit',
  });
}

function formatHospitalStatus(hospital) {
  const key = normalizeKey(hospital?.Approval_Status);
  if (key === 'approved' || key === 'rejected' || key === 'pending') return key;
  return hospital?.Is_Approved ? 'approved' : 'pending';
}

function applicantName(row) {
  return [
    row?.Applicant_First_Name,
    row?.Applicant_Middle_Name,
    row?.Applicant_Last_Name,
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' ') || 'Unknown applicant';
}

function formatRoleLabel(value) {
  const key = normalizeKey(value);
  const labels = {
    admin: 'Admins',
    staff: 'Staff',
    specialist: 'Specialists',
    hrepresentative: 'H-Reps',
    hospitalrepresentative: 'H-Reps',
    patient: 'Patients',
  };
  return labels[key] || String(value || 'Other').replace(/[_-]+/g, ' ');
}

function getRangeStart(rangeId) {
  const range = PERFORMANCE_RANGES[rangeId] || PERFORMANCE_RANGES.weekly;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range.days - 1));
  return start;
}

function filterRowsByRange(rows, rangeId) {
  const startTime = getRangeStart(rangeId).getTime();
  return rows.filter((row) => {
    const createdAt = new Date(row?.Created_At || 0).getTime();
    return Number.isFinite(createdAt) && createdAt >= startTime;
  });
}

function buildPerformanceSeries(rangeId, applicationRows, requestRows, hospitalRows) {
  const range = PERFORMANCE_RANGES[rangeId] || PERFORMANCE_RANGES.weekly;
  const start = getRangeStart(rangeId);
  const rows = [];

  if (range.bucket === 'week') {
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < 13; index += 1) {
      const bucketStart = new Date(start.getTime() + (index * weekMs));
      rows.push({
        bucketStart: bucketStart.getTime(),
        label: formatShortDate(bucketStart),
        applications: 0,
        requests: 0,
        hospitalApplications: 0,
      });
    }

    const addToWeeklyBucket = (sourceRows, key) => {
      sourceRows.forEach((row) => {
        const timestamp = new Date(row?.Created_At || 0).getTime();
        const index = Math.floor((timestamp - start.getTime()) / weekMs);
        if (index >= 0 && index < rows.length) rows[index][key] += 1;
      });
    };
    addToWeeklyBucket(applicationRows, 'applications');
    addToWeeklyBucket(requestRows, 'requests');
    addToWeeklyBucket(hospitalRows, 'hospitalApplications');
    return rows;
  }

  for (let offset = 0; offset < range.days; offset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    rows.push({
      dayKey: toManilaDayKey(date),
      label: formatShortDate(date),
      applications: 0,
      requests: 0,
      hospitalApplications: 0,
    });
  }

  const byDay = new Map(rows.map((row) => [row.dayKey, row]));
  const addToDailyBucket = (sourceRows, key) => {
    sourceRows.forEach((row) => {
      const bucket = byDay.get(toManilaDayKey(row?.Created_At));
      if (bucket) bucket[key] += 1;
    });
  };
  addToDailyBucket(applicationRows, 'applications');
  addToDailyBucket(requestRows, 'requests');
  addToDailyBucket(hospitalRows, 'hospitalApplications');
  return rows;
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractQueryResult(result) {
  if (result.status !== 'fulfilled') {
    return { data: [], error: new Error('Query request failed before completion.') };
  }
  if (result.value?.error) {
    return { data: [], error: result.value.error };
  }
  return { data: result.value?.data || [], error: null };
}

function hexToRgb(value) {
  const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  return {
    r: parseInt(match[1].slice(0, 2), 16),
    g: parseInt(match[1].slice(2, 4), 16),
    b: parseInt(match[1].slice(4, 6), 16),
  };
}

function withAlpha(value, alpha, fallback = '#64748b') {
  const rgb = hexToRgb(value) || hexToRgb(fallback);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function rotateHue(value, degrees, fallback = '#2563eb') {
  const rgb = hexToRgb(value) || hexToRgb(fallback);
  const red = rgb.r / 255;
  const green = rgb.g / 255;
  const blue = rgb.b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
  }

  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs((2 * lightness) - 1));
  const nextHue = (hue + degrees + 360) % 360;
  return `hsl(${Math.round(nextHue)} ${Math.round(Math.max(saturation, 0.45) * 100)}% ${Math.round(Math.max(lightness, 0.34) * 100)}%)`;
}

function MetricTile({ label, value, accentColor, helper, onClick, palette }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[136px] w-full flex-col rounded-xl border p-5 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-sm focus:outline-none focus-visible:ring-2"
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.border,
        '--tw-ring-color': accentColor,
      }}
    >
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ backgroundColor: accentColor }} />
        <span className="block truncate text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: palette.mutedText }}>
          {label}
        </span>
      </span>
      <span className="mt-3 block text-3xl font-bold leading-none" style={{ color: palette.heading }}>{value}</span>
      <span className="mt-auto block truncate pt-3 text-xs" style={{ color: palette.mutedText }}>{helper}</span>
    </button>
  );
}

function StatusPill({ label, color }) {
  return (
    <span
      className="inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: withAlpha(color, 0.1), borderColor: withAlpha(color, 0.28), color }}
    >
      {label}
    </span>
  );
}

function StatusRow({ entry, total, palette }) {
  const percentage = total > 0 ? Math.round((entry.value / total) * 100) : 0;
  return (
    <div className="grid grid-cols-[1fr_48px_60px] items-center gap-2 border-b py-1.5 last:border-b-0" style={{ borderColor: palette.divider }}>
      <StatusPill label={entry.name} color={entry.color} />
      <span className="text-right text-xs font-semibold" style={{ color: palette.heading }}>{entry.value}</span>
      <span className="text-right text-[11px]" style={{ color: palette.bodyText }}>{percentage}%</span>
    </div>
  );
}

function StatusTable({ data, total, palette }) {
  return (
    <div>
      <div className="grid grid-cols-[1fr_48px_60px] gap-2 border-b pb-1.5 text-[9px] font-bold uppercase tracking-wide" style={{ borderColor: palette.divider, color: palette.mutedText }}>
        <span>Status</span>
        <span className="text-right">Count</span>
        <span className="text-right">Percent</span>
      </div>
      {data.map((entry) => (
        <StatusRow key={entry.name} entry={entry} total={total} palette={palette} />
      ))}
    </div>
  );
}

function Panel({ children, palette, className = '' }) {
  return (
    <section
      className={`overflow-hidden rounded-2xl border ${className}`}
      style={{ backgroundColor: palette.surface, borderColor: palette.border }}
    >
      {children}
    </section>
  );
}

export default function DashboardPage({ onNavigate }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const secondaryColor = theme?.secondaryColor || '#64748b';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#475569';
  const tertiaryTextColor = theme?.tertiaryTextColor || '#94a3b8';
  const fontFamily = theme?.fontFamily || 'Poppins';
  const headingFontFamily = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';

  // The ThemeProvider maps these values from the latest UI_Settings row.
  const palette = useMemo(() => ({
    surface: 'var(--color-surface)',
    subtleSurface: 'var(--color-card-background)',
    border: withAlpha(secondaryColor, 0.26),
    divider: withAlpha(secondaryColor, 0.16),
    heading: primaryTextColor,
    bodyText: secondaryTextColor,
    mutedText: tertiaryTextColor,
  }), [primaryTextColor, secondaryColor, secondaryTextColor, tertiaryTextColor]);

  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [warnings, setWarnings] = useState([]);
  const [activePerformanceTab, setActivePerformanceTab] = useState('events');
  const [performanceRange, setPerformanceRange] = useState('weekly');
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);
  const [dashboard, setDashboard] = useState({
    kpis: {
      pendingAdminDecision: 0,
      pendingHospitalApplications: 0,
      approvedRequests: 0,
      approvedWithoutAssignedStaff: 0,
      pendingStaffReview: 0,
      appealedApplications: 0,
      systemAlerts: 0,
      adminUsers: 0,
      staffUsers: 0,
      totalActiveUsers: 0,
    },
    userRoleData: [],
    sourceRows: {
      requests: [],
      applications: [],
      hospitals: [],
    },
    actionItems: [],
    pendingAdminRows: [],
    pendingHospitalRows: [],
    systemChecks: {
      wigRequirementsReady: false,
      logisticsReady: false,
      legalReady: false,
      legalVersion: '',
    },
  });

  const loadDashboard = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });
    setWarnings([]);

    try {
      const settled = await Promise.allSettled([
        supabase
          .from(EVENT_REQUESTS_TABLE)
          .select('Event_Request_ID,Event_Application_ID,Event_Name,Status,Created_At,Updated_At,Start_Date,End_Date,Assigned_Staff_User_ID,Event_Visibility')
          .order('Updated_At', { ascending: false })
          .limit(1000),
        supabase
          .from(EVENT_APPLICATIONS_TABLE)
          .select('Event_Application_ID,Event_Name,Status,Created_At,Updated_At,Applicant_First_Name,Applicant_Middle_Name,Applicant_Last_Name,Proposed_Start_At')
          .order('Created_At', { ascending: false })
          .limit(1000),
        supabase
          .from(HOSPITALS_TABLE)
          .select('Hospital_ID,Hospital_Name,Approval_Status,Is_Approved,Created_At,Updated_At,Hospital_Head_Name')
          .order('Updated_At', { ascending: false })
          .limit(1000),
        supabase
          .from(USERS_TABLE)
          .select('role,is_active')
          .limit(1000),
        supabase
          .from(WIG_REQUIREMENTS_TABLE)
          .select('Wig_Requirement_ID,Updated_At')
          .order('Wig_Requirement_ID', { ascending: true })
          .limit(1),
        supabase
          .from(LOGISTICS_SETTINGS_TABLE)
          .select('Logistics_Settings_ID,Destination_Name,Updated_At')
          .order('Logistics_Settings_ID', { ascending: false })
          .limit(1),
        supabase
          .from(LEGAL_DOCUMENTS_TABLE)
          .select('legal_document_id,version,is_active,effective_at,created_at')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      const requestResult = extractQueryResult(settled[0]);
      const applicationResult = extractQueryResult(settled[1]);
      const hospitalResult = extractQueryResult(settled[2]);
      const usersResult = extractQueryResult(settled[3]);
      const wigResult = extractQueryResult(settled[4]);
      const logisticsResult = extractQueryResult(settled[5]);
      const legalResult = extractQueryResult(settled[6]);

      const nextWarnings = [];
      if (hospitalResult.error) nextWarnings.push(`Hospital applications: ${hospitalResult.error.message}`);
      if (usersResult.error) nextWarnings.push(`User roles: ${usersResult.error.message}`);
      if (wigResult.error) nextWarnings.push(`Wig requirements: ${wigResult.error.message}`);
      if (logisticsResult.error) nextWarnings.push(`Logistics destination: ${logisticsResult.error.message}`);
      if (legalResult.error) nextWarnings.push(`Legal documents: ${legalResult.error.message}`);
      setWarnings(nextWarnings);

      if (requestResult.error || applicationResult.error) {
        const rawError = requestResult.error?.message || applicationResult.error?.message || 'Unable to load dashboard data.';
        setNotice({ kind: 'error', text: rawError });
      }

      const requestRows = requestResult.data;
      const applicationRows = applicationResult.data;
      const hospitalRows = hospitalResult.data;
      const userRows = usersResult.data;
      const applicationById = new Map(
        applicationRows.map((row) => [safeNumber(row.Event_Application_ID), row]),
      );

      const pendingAdminRows = requestRows
        .filter((row) => normalizeKey(row.Status) === 'pendingadminapproval')
        .slice()
        .sort((a, b) => new Date(a.Created_At || 0).getTime() - new Date(b.Created_At || 0).getTime());
      const approvedWithoutAssignedStaff = requestRows.filter(
        (row) => normalizeKey(row.Status) === 'approved' && !safeNumber(row.Assigned_Staff_User_ID),
      );
      const pendingStaffReviewRows = applicationRows.filter(
        (row) => normalizeKey(row.Status) === 'pendingstaffreview',
      );
      const appealedRows = applicationRows.filter(
        (row) => normalizeKey(row.Status) === 'appealed',
      );
      const pendingHospitalRows = hospitalRows
        .filter((row) => formatHospitalStatus(row) === 'pending')
        .slice()
        .sort((a, b) => new Date(a.Created_At || 0).getTime() - new Date(b.Created_At || 0).getTime());

      const roleCounts = userRows.reduce((counts, row) => {
        if (row?.is_active === false) return counts;
        const role = normalizeKey(row.role);
        if (role === 'admin') counts.admin += 1;
        if (role === 'staff') counts.staff += 1;
        return counts;
      }, { admin: 0, staff: 0 });

      const userRolesByName = userRows.reduce((counts, row) => {
        if (row?.is_active === false) return counts;
        const key = normalizeKey(row.role) || 'other';
        const current = counts.get(key) || { name: formatRoleLabel(row.role), value: 0 };
        current.value += 1;
        counts.set(key, current);
        return counts;
      }, new Map());
      const userRoleData = Array.from(userRolesByName.values())
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

      const statusBreakdown = {
        pendingadminapproval: 0,
        approved: 0,
        rejected: 0,
        cancelled: 0,
      };
      requestRows.forEach((row) => {
        const status = normalizeKey(row.Status);
        if (status in statusBreakdown) statusBreakdown[status] += 1;
      });

      const activeLegalRow = legalResult.data.find((row) => Boolean(row.is_active)) || null;
      const systemChecks = {
        wigRequirementsReady: wigResult.data.length > 0,
        logisticsReady: logisticsResult.data.length > 0,
        legalReady: Boolean(activeLegalRow),
        legalVersion: String(activeLegalRow?.version || ''),
      };

      const actionItems = [];
      if (pendingAdminRows.length > 0) {
        actionItems.push({
          title: 'Event requests waiting for admin decision',
          count: pendingAdminRows.length,
          detail: 'Approve or reject pending event requests.',
          page: 'manage-event-applications',
        });
      }
      if (pendingHospitalRows.length > 0) {
        actionItems.push({
          title: 'Hospital applications pending review',
          count: pendingHospitalRows.length,
          detail: 'Approve or reject hospital partnership applications.',
          page: 'manage-hospital-accounts',
        });
      }
      if (approvedWithoutAssignedStaff.length > 0) {
        actionItems.push({
          title: 'Approved events without assigned staff',
          count: approvedWithoutAssignedStaff.length,
          detail: 'Assign one staff per approved event request.',
          page: 'manage-event-applications',
        });
      }
      if (!systemChecks.wigRequirementsReady || !systemChecks.logisticsReady || !systemChecks.legalReady) {
        const missing = [
          !systemChecks.wigRequirementsReady ? 'wig requirements' : null,
          !systemChecks.logisticsReady ? 'logistics destination' : null,
          !systemChecks.legalReady ? 'active legal consent PDF' : null,
        ].filter(Boolean).join(', ');
        actionItems.push({
          title: 'Requirement configuration missing',
          count: 1,
          detail: `Review setup for: ${missing}.`,
          page: 'manage-requirements',
        });
      }
      if (appealedRows.length > 0) {
        actionItems.push({
          title: 'Appealed applications in pipeline',
          count: appealedRows.length,
          detail: 'Track staff resubmissions after admin rejection.',
          page: 'manage-event-applications',
        });
      }

      setDashboard({
        kpis: {
          pendingAdminDecision: pendingAdminRows.length,
          pendingHospitalApplications: pendingHospitalRows.length,
          approvedRequests: statusBreakdown.approved,
          approvedWithoutAssignedStaff: approvedWithoutAssignedStaff.length,
          pendingStaffReview: pendingStaffReviewRows.length,
          appealedApplications: appealedRows.length,
          systemAlerts: (!systemChecks.wigRequirementsReady ? 1 : 0)
            + (!systemChecks.logisticsReady ? 1 : 0)
            + (!systemChecks.legalReady ? 1 : 0),
          adminUsers: roleCounts.admin,
          staffUsers: roleCounts.staff,
          totalActiveUsers: userRows.filter((row) => row?.is_active !== false).length,
        },
        userRoleData,
        sourceRows: {
          requests: requestRows,
          applications: applicationRows,
          hospitals: hospitalRows,
        },
        actionItems,
        pendingAdminRows: pendingAdminRows.slice(0, 5).map((row) => ({
          ...row,
          application: applicationById.get(safeNumber(row.Event_Application_ID)) || null,
        })),
        pendingHospitalRows: pendingHospitalRows.slice(0, 5),
        systemChecks,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load dashboard data.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void loadDashboard(), 250);
    };
    const fallbackInterval = setInterval(() => void loadDashboard(), 30000);
    const channel = supabase
      .channel('public:admin-dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: EVENT_REQUESTS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: EVENT_APPLICATIONS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: HOSPITALS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: USERS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIG_REQUIREMENTS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: LOGISTICS_SETTINGS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: LEGAL_DOCUMENTS_TABLE }, scheduleRefresh)
      .subscribe((status) => setIsRealtimeActive(status === 'SUBSCRIBED'));

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(fallbackInterval);
      setIsRealtimeActive(false);
      supabase.removeChannel(channel);
    };
  }, [loadDashboard]);

  const topMetrics = useMemo(() => ([
    {
      key: 'pendingAdmin',
      label: 'Pending Admin',
      value: dashboard.kpis.pendingAdminDecision,
      accentColor: secondaryColor,
      helper: 'Requests waiting',
      page: 'manage-event-applications',
      icon: Clock3,
    },
    {
      key: 'approved',
      label: 'Approved Events',
      value: dashboard.kpis.approvedRequests,
      accentColor: SUCCESS_COLOR,
      helper: 'Approved requests',
      page: 'manage-event-applications',
      icon: BadgeCheck,
    },
    {
      key: 'hospitals',
      label: 'Hospital Apps',
      value: dashboard.kpis.pendingHospitalApplications,
      accentColor: primaryColor,
      helper: 'Pending review',
      page: 'manage-hospital-accounts',
      icon: Building2,
    },
    {
      key: 'alerts',
      label: 'System Alerts',
      value: dashboard.kpis.systemAlerts,
      accentColor: DANGER_COLOR,
      helper: 'Items needing attention',
      page: 'manage-requirements',
      icon: AlertTriangle,
    },
  ]), [dashboard.kpis, primaryColor, secondaryColor]);

  const overviewData = useMemo(() => {
    const filteredRequests = filterRowsByRange(dashboard.sourceRows.requests, performanceRange);
    const filteredApplications = filterRowsByRange(dashboard.sourceRows.applications, performanceRange);
    const filteredHospitals = filterRowsByRange(dashboard.sourceRows.hospitals, performanceRange);
    const requestCounts = { pendingadminapproval: 0, approved: 0, rejected: 0, cancelled: 0 };
    const hospitalCounts = { pending: 0, approved: 0, rejected: 0 };

    filteredRequests.forEach((row) => {
      const status = normalizeKey(row.Status);
      if (status in requestCounts) requestCounts[status] += 1;
    });
    filteredHospitals.forEach((row) => {
      const status = formatHospitalStatus(row);
      if (status in hospitalCounts) hospitalCounts[status] += 1;
    });

    return {
      trendData: buildPerformanceSeries(
        performanceRange,
        filteredApplications,
        filteredRequests,
        filteredHospitals,
      ),
      requestStatusData: [
        { name: 'Pending Admin', value: requestCounts.pendingadminapproval, color: secondaryColor },
        { name: 'Approved', value: requestCounts.approved, color: SUCCESS_COLOR },
        { name: 'Rejected', value: requestCounts.rejected, color: DANGER_COLOR },
        { name: 'Cancelled', value: requestCounts.cancelled, color: tertiaryTextColor },
      ],
      hospitalStatusData: [
        { name: 'Pending', value: hospitalCounts.pending, color: secondaryColor },
        { name: 'Approved', value: hospitalCounts.approved, color: SUCCESS_COLOR },
        { name: 'Rejected', value: hospitalCounts.rejected, color: DANGER_COLOR },
      ],
    };
  }, [dashboard.sourceRows, performanceRange, secondaryColor, tertiaryTextColor]);

  const totalRequests = useMemo(
    () => overviewData.requestStatusData.reduce((sum, entry) => sum + safeNumber(entry.value), 0),
    [overviewData.requestStatusData],
  );

  const totalHospitals = useMemo(
    () => overviewData.hospitalStatusData.reduce((sum, entry) => sum + safeNumber(entry.value), 0),
    [overviewData.hospitalStatusData],
  );

  const activeUsers = useMemo(
    () => dashboard.userRoleData.reduce((sum, entry) => sum + safeNumber(entry.value), 0),
    [dashboard.userRoleData],
  );

  const systemHealthItems = [
    { label: 'Wig Requirements', ready: dashboard.systemChecks.wigRequirementsReady },
    { label: 'Logistics Destination', ready: dashboard.systemChecks.logisticsReady },
    {
      label: 'Legal Consent PDF',
      ready: dashboard.systemChecks.legalReady,
      detail: dashboard.systemChecks.legalVersion ? `v${dashboard.systemChecks.legalVersion}` : '',
    },
  ];

  const noticeColor = notice.kind === 'error' ? DANGER_COLOR : SUCCESS_COLOR;
  const healthySystemChecks = systemHealthItems.filter((item) => item.ready).length;
  const chartPrimaryColor = primaryColor;
  const chartSecondaryColor = rotateHue(primaryColor, 165, secondaryColor);
  const chartTertiaryColor = rotateHue(primaryColor, 215, secondaryColor);
  const performanceTabs = [
    { id: 'events', label: 'Events' },
    { id: 'hospitals', label: 'Hospital Applications' },
    { id: 'users', label: 'Users' },
    { id: 'health', label: 'System Health' },
  ];

  return (
    <div
      className="space-y-3"
      style={{ fontFamily: `${fontFamily}, sans-serif`, color: palette.bodyText }}
    >
      {notice.text && (
        <div
          className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
          style={{ backgroundColor: withAlpha(noticeColor, 0.08), borderColor: withAlpha(noticeColor, 0.25), color: noticeColor }}
        >
          {notice.kind === 'error' ? <AlertTriangle size={14} className="mt-0.5 flex-none" /> : <CheckCircle2 size={14} className="mt-0.5 flex-none" />}
          <span>{notice.text}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div
          className="rounded-lg border px-3 py-2 text-xs"
          style={{ backgroundColor: withAlpha(DANGER_COLOR, 0.07), borderColor: withAlpha(DANGER_COLOR, 0.22), color: DANGER_COLOR }}
        >
          <p className="font-semibold">Partial data warnings</p>
          {warnings.map((warning) => <p key={warning} className="mt-0.5">{warning}</p>)}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1
            className="text-2xl font-bold leading-tight"
            style={{ color: palette.heading, fontFamily: `${headingFontFamily}, sans-serif` }}
          >
            Admin Dashboard
          </h1>
          <p className="text-xs sm:text-sm" style={{ color: palette.bodyText }}>
            Approvals, activity, and system readiness at a glance.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span
            className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold sm:inline-flex"
            style={{ borderColor: withAlpha(isRealtimeActive ? SUCCESS_COLOR : secondaryColor, 0.28), color: isRealtimeActive ? SUCCESS_COLOR : palette.bodyText }}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: isRealtimeActive ? SUCCESS_COLOR : secondaryColor }} />
            {isRealtimeActive ? 'Live' : 'Connecting'}
          </span>
          <div className="relative">
            <button
              type="button"
              aria-label="About this dashboard"
              aria-expanded={isInfoOpen}
              aria-controls="admin-dashboard-info"
              onClick={() => setIsInfoOpen((open) => !open)}
              className="flex h-9 w-9 items-center justify-center rounded-lg border transition hover:shadow-sm"
              style={{ backgroundColor: palette.surface, borderColor: palette.border, color: primaryColor }}
            >
              <HelpCircle size={17} />
            </button>
            {isInfoOpen && (
              <div
                id="admin-dashboard-info"
                role="dialog"
                aria-label="Dashboard information"
                className="absolute right-0 top-11 z-30 w-72 rounded-xl border p-3 text-left shadow-xl"
                style={{ backgroundColor: palette.surface, borderColor: palette.border }}
              >
                <p className="text-xs font-bold" style={{ color: palette.heading }}>About this dashboard</p>
                <p className="mt-1 text-[10px] leading-relaxed" style={{ color: palette.bodyText }}>
                  Metrics use live event, hospital, user, and configuration records. Green means approved or healthy; red means rejected, missing, or requiring attention.
                </p>
                <p className="mt-2 text-[9px]" style={{ color: palette.mutedText }}>
                  Use the Performance Overview tabs to compare each operational area.
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={loadDashboard}
            disabled={isLoading}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: palette.surface, borderColor: palette.border, color: primaryColor }}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {topMetrics.map((metric) => (
          <MetricTile
            key={metric.key}
            {...metric}
            palette={palette}
            onClick={() => typeof onNavigate === 'function' && onNavigate(metric.page)}
          />
        ))}
      </section>

      <Panel palette={palette}>
        <div className="flex flex-col gap-2 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between" style={{ borderColor: palette.divider }}>
          <div className="flex-none">
            <h2 className="text-sm font-bold" style={{ color: palette.heading, fontFamily: `${headingFontFamily}, sans-serif` }}>
              Performance Overview
            </h2>
            <p className="text-[10px]" style={{ color: palette.mutedText }}>Switch views to compare each operational area.</p>
          </div>
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
            {(activePerformanceTab === 'events' || activePerformanceTab === 'hospitals') && (
              <div className="flex gap-1 rounded-lg border p-1" style={{ backgroundColor: palette.surface, borderColor: palette.divider }} aria-label="Performance date range">
                {Object.entries(PERFORMANCE_RANGES).map(([rangeId, range]) => {
                  const isActive = performanceRange === rangeId;
                  return (
                    <button
                      key={rangeId}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => setPerformanceRange(rangeId)}
                      className="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[10px] font-semibold transition"
                      style={{ backgroundColor: isActive ? withAlpha(primaryColor, 0.12) : 'transparent', color: isActive ? primaryColor : palette.bodyText }}
                    >
                      {range.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg p-1" style={{ backgroundColor: palette.subtleSurface }} role="tablist" aria-label="Performance views">
              {performanceTabs.map((tab) => {
                const isActive = activePerformanceTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActivePerformanceTab(tab.id)}
                    className="whitespace-nowrap rounded-md px-3 py-1.5 text-[10px] font-semibold transition"
                    style={{
                      backgroundColor: isActive ? palette.surface : 'transparent',
                      color: isActive ? primaryColor : palette.bodyText,
                      boxShadow: isActive ? `0 1px 3px ${withAlpha(secondaryColor, 0.18)}` : 'none',
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {activePerformanceTab === 'events' && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
            <div className="border-b p-4 xl:border-b-0 xl:border-r" style={{ borderColor: palette.divider }}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold" style={{ color: palette.heading }}>{PERFORMANCE_RANGES[performanceRange].label} event activity</h3>
                  <p className="text-[10px]" style={{ color: palette.mutedText }}>Applications and requests created {PERFORMANCE_RANGES[performanceRange].bucket === 'week' ? 'weekly' : 'daily'}</p>
                </div>
                <div className="flex items-center gap-3 text-[10px]" style={{ color: palette.bodyText }}>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: chartSecondaryColor }} />Applications</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ backgroundColor: chartPrimaryColor }} />Requests</span>
                </div>
              </div>
              <div className="mt-2 h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={overviewData.trendData} margin={{ top: 8, right: 12, left: -24, bottom: 0 }} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.divider} vertical={false} />
                    <XAxis dataKey="label" interval={performanceRange === 'monthly' ? 4 : performanceRange === 'threeMonths' ? 1 : 0} minTickGap={12} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: palette.surface, borderColor: palette.border, borderRadius: 8, color: palette.heading, fontSize: 11 }} />
                    <Bar dataKey="applications" name="Applications" fill={chartSecondaryColor} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="requests" name="Requests" fill={chartPrimaryColor} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="p-4">
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Event Status</h3>
              <p className="mb-3 text-[10px]" style={{ color: palette.mutedText }}>Share of all event requests</p>
              <StatusTable data={overviewData.requestStatusData} total={totalRequests} palette={palette} />
            </div>
          </div>
        )}

        {activePerformanceTab === 'hospitals' && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
            <div className="border-b p-4 xl:border-b-0 xl:border-r" style={{ borderColor: palette.divider }}>
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>{PERFORMANCE_RANGES[performanceRange].label} hospital applications</h3>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>New partnership applications created {PERFORMANCE_RANGES[performanceRange].bucket === 'week' ? 'weekly' : 'daily'}</p>
              <div className="mt-2 h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overviewData.trendData} margin={{ top: 8, right: 12, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.divider} vertical={false} />
                    <XAxis dataKey="label" interval={performanceRange === 'monthly' ? 4 : performanceRange === 'threeMonths' ? 1 : 0} minTickGap={12} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: palette.surface, borderColor: palette.border, borderRadius: 8, color: palette.heading, fontSize: 11 }} />
                    <Line type="monotone" dataKey="hospitalApplications" name="Hospital Applications" stroke={chartSecondaryColor} strokeWidth={2.75} dot={{ r: 3, fill: palette.surface, strokeWidth: 2 }} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="p-4">
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Hospital Status</h3>
              <p className="mb-3 text-[10px]" style={{ color: palette.mutedText }}>{totalHospitals} partnership applications</p>
              <StatusTable data={overviewData.hospitalStatusData} total={totalHospitals} palette={palette} />
            </div>
          </div>
        )}

        {activePerformanceTab === 'users' && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
            <div className="border-b p-4 xl:border-b-0 xl:border-r" style={{ borderColor: palette.divider }}>
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Active users by role</h3>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>Current enabled user accounts</p>
              <div className="mt-2 h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dashboard.userRoleData} margin={{ top: 8, right: 12, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.divider} vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: palette.surface, borderColor: palette.border, borderRadius: 8, color: palette.heading, fontSize: 11 }} />
                    <Bar dataKey="value" name="Active Users" fill={chartTertiaryColor} radius={[5, 5, 0, 0]} maxBarSize={48} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="p-4">
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Role Summary</h3>
              <p className="mb-3 text-[10px]" style={{ color: palette.mutedText }}>{activeUsers} active accounts</p>
              <div className="space-y-1.5">
                {dashboard.userRoleData.map((role) => (
                  <div key={role.name} className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ backgroundColor: palette.subtleSurface, borderColor: palette.divider }}>
                    <span className="text-[10px] font-semibold" style={{ color: palette.bodyText }}>{role.name}</span>
                    <span className="text-sm font-bold" style={{ color: palette.heading }}>{role.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activePerformanceTab === 'health' && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
            <div className="border-b p-4 xl:border-b-0 xl:border-r" style={{ borderColor: palette.divider }}>
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Configuration readiness</h3>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>Required services and documents</p>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {systemHealthItems.map((item) => {
                  const stateColor = item.ready ? SUCCESS_COLOR : DANGER_COLOR;
                  return (
                    <div key={item.label} className="rounded-xl border p-3" style={{ backgroundColor: withAlpha(stateColor, 0.07), borderColor: withAlpha(stateColor, 0.22) }}>
                      <div className="flex items-center gap-2" style={{ color: stateColor }}>
                        {item.ready ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                        <span className="text-[10px] font-bold">{item.ready ? 'Ready' : 'Missing'}</span>
                      </div>
                      <p className="mt-3 text-xs font-semibold" style={{ color: palette.heading }}>{item.label}</p>
                      <p className="mt-0.5 text-[9px]" style={{ color: palette.mutedText }}>{item.detail || (item.ready ? 'Configured' : 'Needs attention')}</p>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="p-4">
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Readiness Score</h3>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>Overall configuration health</p>
              <div className="mt-4 rounded-xl border p-4" style={{ backgroundColor: palette.subtleSurface, borderColor: palette.divider }}>
                <div className="flex items-end justify-between">
                  <span className="text-3xl font-bold" style={{ color: healthySystemChecks === systemHealthItems.length ? SUCCESS_COLOR : DANGER_COLOR }}>{healthySystemChecks}/{systemHealthItems.length}</span>
                  <span className="text-[10px] font-semibold" style={{ color: palette.bodyText }}>checks ready</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full" style={{ backgroundColor: withAlpha(secondaryColor, 0.14) }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${(healthySystemChecks / systemHealthItems.length) * 100}%`, backgroundColor: healthySystemChecks === systemHealthItems.length ? SUCCESS_COLOR : DANGER_COLOR }} />
                </div>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,1fr)]">
        <Panel palette={palette}>
          <div className="border-b px-3.5 py-2" style={{ borderColor: palette.divider }}>
            <h2 className="text-sm font-bold" style={{ color: palette.heading, fontFamily: `${headingFontFamily}, sans-serif` }}>Action Items</h2>
          </div>

          <div className="p-3">
            <div className="flex items-center gap-2">
              <CalendarClock size={14} style={{ color: primaryColor }} />
              <div>
                <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Needs Action Now</h3>
                <p className="text-[10px]" style={{ color: palette.mutedText }}>Awaiting your review</p>
              </div>
              <span
                className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold"
                style={{ backgroundColor: withAlpha(primaryColor, 0.1), color: primaryColor }}
              >
                {dashboard.actionItems.length}
              </span>
            </div>

            <div className="mt-2">
              {dashboard.actionItems.length === 0 ? (
                <div
                  className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                  style={{ backgroundColor: withAlpha(SUCCESS_COLOR, 0.08), borderColor: withAlpha(SUCCESS_COLOR, 0.24), color: SUCCESS_COLOR }}
                >
                  <CheckCircle2 size={13} />
                  No high-priority blockers right now.
                </div>
              ) : (
                <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {dashboard.actionItems.map((item) => (
                    <li key={`${item.title}-${item.page}`}>
                      <button
                        type="button"
                        onClick={() => typeof onNavigate === 'function' && onNavigate(item.page)}
                        className="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition hover:shadow-sm"
                        style={{ backgroundColor: withAlpha(primaryColor, 0.055), borderColor: withAlpha(primaryColor, 0.2) }}
                      >
                        <span
                          className="flex h-6 min-w-6 flex-none items-center justify-center rounded-md px-1 text-[10px] font-bold"
                          style={{ backgroundColor: withAlpha(primaryColor, 0.14), color: primaryColor }}
                        >
                          {item.count}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-bold" style={{ color: palette.heading }}>{item.title}</span>
                          <span className="block truncate text-[10px]" style={{ color: palette.bodyText }}>{item.detail}</span>
                        </span>
                        <ArrowRight size={13} style={{ color: primaryColor }} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t pt-2" style={{ borderColor: palette.divider }}>
              <div>
                <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Oldest Pending Admin Decisions</h3>
                <p className="text-[10px]" style={{ color: palette.mutedText }}>First-in-first-out review queue</p>
              </div>
              <button
                type="button"
                onClick={() => typeof onNavigate === 'function' && onNavigate('manage-event-applications')}
                className="inline-flex flex-none items-center gap-1 text-[10px] font-semibold hover:underline"
                style={{ color: primaryColor }}
              >
                Open queue <ArrowRight size={11} />
              </button>
            </div>

            {dashboard.pendingAdminRows.length === 0 ? (
              <p
                className="mt-2 rounded-lg border px-3 py-2 text-[11px]"
                style={{ backgroundColor: withAlpha(SUCCESS_COLOR, 0.06), borderColor: withAlpha(SUCCESS_COLOR, 0.2), color: SUCCESS_COLOR }}
              >
                No pending admin requests.
              </p>
            ) : (
              <>
                <ul className="mt-1 divide-y" style={{ borderColor: palette.divider }}>
                  {dashboard.pendingAdminRows.slice(0, 2).map((row) => (
                  <li key={row.Event_Request_ID} className="flex items-center gap-2 py-1.5 text-xs">
                    <span
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-md"
                      style={{ backgroundColor: withAlpha(primaryColor, 0.1), color: primaryColor }}
                    >
                      <CalendarClock size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold" style={{ color: palette.heading }}>{row.Event_Name || 'Untitled Event'}</span>
                      <span className="block truncate text-[10px]" style={{ color: palette.bodyText }}>
                        ER-{row.Event_Request_ID} · {applicantName(row.application)}
                      </span>
                    </span>
                    <span className="flex-none text-[10px] font-semibold" style={{ color: palette.bodyText }}>{formatShortDate(row.Created_At)}</span>
                    <ArrowRight size={11} style={{ color: palette.mutedText }} />
                  </li>
                  ))}
                </ul>
                {dashboard.pendingAdminRows.length > 2 && (
                  <p className="text-right text-[9px] font-semibold" style={{ color: primaryColor }}>
                    +{dashboard.pendingAdminRows.length - 2} more in the queue
                  </p>
                )}
              </>
            )}
          </div>
        </Panel>

        <Panel palette={palette}>
          <div className="flex items-center justify-between gap-3 border-b px-3.5 py-2" style={{ borderColor: palette.divider }}>
            <div>
              <h2 className="text-sm font-bold" style={{ color: palette.heading, fontFamily: `${headingFontFamily}, sans-serif` }}>System Health &amp; Active Roles</h2>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>Configuration and pending hospital reviews</p>
            </div>
            <button
              type="button"
              onClick={() => typeof onNavigate === 'function' && onNavigate('manage-hospital-accounts')}
              className="inline-flex flex-none items-center gap-1 text-[10px] font-semibold hover:underline"
              style={{ color: primaryColor }}
            >
              Open <ArrowRight size={11} />
            </button>
          </div>

          <div className="p-3">
            <div>
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Pending Hospital Apps</h3>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>Awaiting your approval</p>
            </div>

            {dashboard.pendingHospitalRows.length === 0 ? (
              <p
                className="mt-2 rounded-lg border px-3 py-2 text-[11px]"
                style={{ backgroundColor: withAlpha(SUCCESS_COLOR, 0.06), borderColor: withAlpha(SUCCESS_COLOR, 0.2), color: SUCCESS_COLOR }}
              >
                No pending hospital applications.
              </p>
            ) : (
              <>
                <ul className="mt-1 divide-y" style={{ borderColor: palette.divider }}>
                  {dashboard.pendingHospitalRows.slice(0, 2).map((row) => (
                  <li key={row.Hospital_ID} className="flex items-center gap-2 py-1.5">
                    <span
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-md"
                      style={{ backgroundColor: withAlpha(primaryColor, 0.1), color: primaryColor }}
                    >
                      <Building2 size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold" style={{ color: palette.heading }}>{row.Hospital_Name || `Hospital #${row.Hospital_ID}`}</span>
                      <span className="block truncate text-[10px]" style={{ color: palette.bodyText }}>{row.Hospital_Head_Name || 'No head information'}</span>
                    </span>
                    <span className="text-[10px]" style={{ color: palette.bodyText }}>{formatShortDate(row.Created_At)}</span>
                  </li>
                  ))}
                </ul>
                {dashboard.pendingHospitalRows.length > 2 && (
                  <p className="text-right text-[9px] font-semibold" style={{ color: primaryColor }}>
                    +{dashboard.pendingHospitalRows.length - 2} more applications
                  </p>
                )}
              </>
            )}

            <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-lg border p-2.5" style={{ backgroundColor: palette.subtleSurface, borderColor: palette.divider }}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Settings2 size={13} style={{ color: primaryColor }} />
                  <h3 className="text-xs font-bold" style={{ color: palette.heading }}>System Health</h3>
                </div>
                <div className="space-y-1.5">
                  {systemHealthItems.map((item) => {
                    const stateColor = item.ready ? SUCCESS_COLOR : DANGER_COLOR;
                    return (
                      <div
                        key={item.label}
                        className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-[9px] font-semibold"
                        style={{ backgroundColor: withAlpha(stateColor, 0.08), borderColor: withAlpha(stateColor, 0.24), color: stateColor }}
                      >
                        {item.ready ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        <span className="flex-none uppercase">{item.ready ? (item.detail || 'OK') : 'Missing'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border p-2.5" style={{ backgroundColor: palette.subtleSurface, borderColor: palette.divider }}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Users size={13} style={{ color: primaryColor }} />
                  <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Active Roles</h3>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { label: 'Admins', value: dashboard.kpis.adminUsers },
                    { label: 'Staff', value: dashboard.kpis.staffUsers },
                  ].map((role) => (
                    <div key={role.label} className="rounded-md border px-2 py-1.5" style={{ backgroundColor: withAlpha(primaryColor, 0.07), borderColor: withAlpha(primaryColor, 0.2) }}>
                      <p className="text-[8px] font-bold uppercase tracking-wide" style={{ color: palette.bodyText }}>{role.label}</p>
                      <p className="text-lg font-bold leading-tight" style={{ color: palette.heading }}>{role.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 rounded-md border px-2 py-1.5" style={{ backgroundColor: withAlpha(secondaryColor, 0.07), borderColor: withAlpha(secondaryColor, 0.2) }}>
                  <p className="text-[8px] font-bold uppercase tracking-wide" style={{ color: palette.bodyText }}>Needs Staff</p>
                  <div className="flex items-end justify-between gap-2">
                    <p className="text-lg font-bold leading-tight" style={{ color: palette.heading }}>{dashboard.kpis.approvedWithoutAssignedStaff}</p>
                    <p className="truncate text-[8px]" style={{ color: palette.mutedText }}>Approved events unassigned</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
