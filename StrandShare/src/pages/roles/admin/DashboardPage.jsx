import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Settings2,
  Users,
  XCircle,
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
import PageHeaderActions from '../../../components/PageHeaderActions';

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
  weekly: { label: 'Weekly' },
  monthly: { label: 'Monthly' },
  yearly: { label: 'Yearly' },
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

function periodKey(rangeId, selectedMonth, selectedYear, value) {
  const parts = toManilaParts(value);
  if (!parts) return null;
  const currentYear = new Date().getFullYear();
  const year = Number(selectedYear) || currentYear;
  const [monthYear, month] = String(selectedMonth || '').split('-').map(Number);
  const partYear = Number(parts.year);
  const partMonth = Number(parts.month);
  const partDay = Number(parts.day);
  if (rangeId === 'weekly') {
    return partYear === monthYear && partMonth === month
      ? `${monthYear}-${month}-${Math.floor((partDay - 1) / 7) + 1}`
      : null;
  }
  if (rangeId === 'monthly') return partYear === year ? `${year}-${partMonth}` : null;
  return partYear >= currentYear - 4 && partYear <= currentYear ? String(partYear) : null;
}

function addLifecycleMilestones(counts, status) {
  const currentStatus = normalizeKey(status);
  if (currentStatus === 'successful') {
    counts.approved += 1;
    counts.ended += 1;
    counts.successful += 1;
    return;
  }
  if (currentStatus === 'ended') {
    counts.approved += 1;
    counts.ended += 1;
    return;
  }
  if (currentStatus === 'approved') {
    counts.approved += 1;
    return;
  }
  if (currentStatus === 'rejected') {
    counts.rejected += 1;
    return;
  }
  if (currentStatus === 'cancelled') {
    counts.cancelled += 1;
    return;
  }
  counts.pending += 1;
}

function buildPerformanceSeries(rangeId, selectedMonth, selectedYear, applicationRows, requestRows, hospitalRows) {
  const currentYear = new Date().getFullYear();
  const year = Number(selectedYear) || currentYear;
  const [monthYear, month] = String(selectedMonth || '').split('-').map(Number);
  const createBucket = (label, key) => ({ label, key, applications: 0, pending: 0, approved: 0, rejected: 0, ended: 0, successful: 0, cancelled: 0, hospitalApplications: 0 });
  let rows;

  if (rangeId === 'weekly') {
    const weeks = Math.ceil(new Date(monthYear, month, 0).getDate() / 7);
    rows = Array.from({ length: weeks }, (_, index) => createBucket(`Week ${index + 1}`, `${monthYear}-${month}-${index + 1}`));
  } else if (rangeId === 'monthly') {
    rows = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((label, index) => createBucket(label, `${year}-${index + 1}`));
  } else {
    rows = Array.from({ length: 5 }, (_, index) => currentYear - 4 + index).map((item) => createBucket(String(item), String(item)));
  }

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const requestByApplicationId = new Map(
    requestRows
      .map((row) => [safeNumber(row?.Event_Application_ID), row])
      .filter(([applicationId]) => applicationId > 0),
  );
  applicationRows.forEach((row) => {
    const bucket = byKey.get(periodKey(rangeId, selectedMonth, selectedYear, row?.Created_At));
    const applicationId = safeNumber(row?.Event_Application_ID);
    const request = requestByApplicationId.get(applicationId);
    const currentStatus = normalizeKey(request?.Status || row?.Status);
    if (bucket) {
      bucket.applications += 1;
      addLifecycleMilestones(bucket, currentStatus);
    }
  });
  hospitalRows.forEach((row) => {
    const bucket = byKey.get(periodKey(rangeId, selectedMonth, selectedYear, row?.Created_At));
    if (bucket) bucket.hospitalApplications += 1;
  });
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

export default function DashboardPage({ onNavigate, onInitialDataReady }) {
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
  const initialDataReportedRef = useRef(false);
  const reportInitialDataReady = useCallback(() => {
    if (initialDataReportedRef.current) return;
    initialDataReportedRef.current = true;
    onInitialDataReady?.();
  }, [onInitialDataReady]);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [warnings, setWarnings] = useState([]);
  const [activePerformanceTab, setActivePerformanceTab] = useState('events');
  const [performanceRange, setPerformanceRange] = useState('weekly');
  const [performanceMonth, setPerformanceMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [performanceYear, setPerformanceYear] = useState(() => String(new Date().getFullYear()));
  const [dashboard, setDashboard] = useState({
    kpis: {
      pendingAdminDecision: 0,
      pendingHospitalApplications: 0,
      approvedRequests: 0,
      acceptedRequests: 0,
      totalEventApplications: 0,
      rejectedRequests: 0,
      cancelledRequests: 0,
      endedRequests: 0,
      successfulRequests: 0,
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
          .select('Event_Request_ID,Event_Application_ID,Event_Name,Status,Created_At,Updated_At,Start_Date,End_Date,Ended_At,Successful_At,Assigned_Staff_User_ID,Event_Visibility')
          .order('Updated_At', { ascending: false })
          .limit(1000),
        supabase
          .from(EVENT_APPLICATIONS_TABLE)
          .select('Event_Application_ID,Linked_Event_Request_ID,Event_Name,Status,Created_At,Updated_At,Applicant_First_Name,Applicant_Middle_Name,Applicant_Last_Name,Proposed_Start_At')
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
        ended: 0,
        successful: 0,
      };
      requestRows.forEach((row) => {
        const status = normalizeKey(row.Status);
        if (status in statusBreakdown) statusBreakdown[status] += 1;
      });
      const requestApplicationIds = new Set(
        requestRows.map((row) => safeNumber(row.Event_Application_ID)).filter(Boolean),
      );
      applicationRows.forEach((row) => {
        const applicationId = safeNumber(row.Event_Application_ID);
        const hasLinkedRequest = safeNumber(row.Linked_Event_Request_ID) > 0 || requestApplicationIds.has(applicationId);
        const status = normalizeKey(row.Status);
        if (!hasLinkedRequest && ['rejected', 'cancelled'].includes(status)) {
          statusBreakdown[status] += 1;
        }
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
          title: 'Program requests waiting for admin decision',
          count: pendingAdminRows.length,
          detail: 'Approve or reject pending program requests.',
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
          title: 'Approved programs without assigned staff',
          count: approvedWithoutAssignedStaff.length,
          detail: 'Assign one staff member per approved program request.',
          page: 'manage-event-applications',
        });
      }
      if (statusBreakdown.ended > 0) {
        actionItems.push({
          title: 'Ended programs awaiting staff confirmation',
          count: statusBreakdown.ended,
          detail: 'Assigned staff must finish pending hair reviews and mark each program successful.',
          page: 'reports',
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
          approvedRequests: statusBreakdown.approved + statusBreakdown.ended + statusBreakdown.successful,
          acceptedRequests: statusBreakdown.approved + statusBreakdown.ended + statusBreakdown.successful,
          totalEventApplications: applicationRows.length,
          rejectedRequests: statusBreakdown.rejected,
          cancelledRequests: statusBreakdown.cancelled,
          endedRequests: statusBreakdown.ended + statusBreakdown.successful,
          successfulRequests: statusBreakdown.successful,
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
      reportInitialDataReady();
    }
  }, [reportInitialDataReady]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const chartSecondaryColor = rotateHue(primaryColor, 165, secondaryColor);
  const chartTertiaryColor = rotateHue(primaryColor, 215, secondaryColor);

  const topMetrics = useMemo(() => ([
    {
      key: 'applications',
      label: 'Applications',
      value: dashboard.kpis.totalEventApplications,
      accentColor: primaryColor,
      helper: 'All submitted',
      page: 'manage-event-applications',
      icon: ClipboardList,
    },
    {
      key: 'approved',
      label: 'Approved Programs',
      value: dashboard.kpis.approvedRequests,
      accentColor: '#2563eb',
      helper: 'Reached approval',
      page: 'manage-event-applications',
      icon: BadgeCheck,
    },
    {
      key: 'rejected',
      label: 'Rejected Applications',
      value: dashboard.kpis.rejectedRequests,
      accentColor: DANGER_COLOR,
      helper: 'Across staff and admin review',
      page: 'reports',
      icon: XCircle,
    },
    {
      key: 'ended',
      label: 'Ended Programs',
      value: dashboard.kpis.endedRequests,
      accentColor: secondaryColor,
      helper: 'Reached program end',
      page: 'reports',
      icon: CalendarClock,
    },
    {
      key: 'successful',
      label: 'Successful Programs',
      value: dashboard.kpis.successfulRequests,
      accentColor: '#0d9488',
      helper: 'Finalized by Staff',
      page: 'reports',
      icon: CheckCircle2,
    },
  ]), [dashboard.kpis, primaryColor, secondaryColor]);

  const overviewData = useMemo(() => {
    const filteredApplications = dashboard.sourceRows.applications.filter((row) => periodKey(performanceRange, performanceMonth, performanceYear, row?.Created_At));
    const filteredHospitals = dashboard.sourceRows.hospitals.filter((row) => periodKey(performanceRange, performanceMonth, performanceYear, row?.Created_At));
    const requestCounts = { pending: 0, approved: 0, rejected: 0, cancelled: 0, ended: 0, successful: 0 };
    const hospitalCounts = { pending: 0, approved: 0, rejected: 0 };

    const requestByApplicationId = new Map();
    dashboard.sourceRows.requests.forEach((row) => {
      const applicationId = safeNumber(row.Event_Application_ID);
      if (applicationId > 0) requestByApplicationId.set(applicationId, row);
    });
    filteredApplications.forEach((row) => {
      const applicationId = safeNumber(row.Event_Application_ID);
      const request = requestByApplicationId.get(applicationId);
      const currentStatus = normalizeKey(request?.Status || row.Status);
      addLifecycleMilestones(requestCounts, currentStatus);
    });
    filteredHospitals.forEach((row) => {
      const status = formatHospitalStatus(row);
      if (status in hospitalCounts) hospitalCounts[status] += 1;
    });

    return {
      trendData: buildPerformanceSeries(
        performanceRange,
        performanceMonth,
        performanceYear,
        dashboard.sourceRows.applications,
        dashboard.sourceRows.requests,
        dashboard.sourceRows.hospitals,
      ),
      eventLifecycleData: [
        { name: 'Total Applications', key: 'applications', value: filteredApplications.length, color: primaryColor },
        { name: 'Pending', key: 'pending', value: requestCounts.pending, color: '#d97706' },
        { name: 'Approved', key: 'approved', value: requestCounts.approved, color: '#2563eb' },
        { name: 'Rejected', key: 'rejected', value: requestCounts.rejected, color: '#dc2626' },
        { name: 'Ended', key: 'ended', value: requestCounts.ended, color: '#64748b' },
        { name: 'Successful', key: 'successful', value: requestCounts.successful, color: '#059669' },
        { name: 'Cancelled', key: 'cancelled', value: requestCounts.cancelled, color: '#f59e0b' },
      ],
      hospitalStatusData: [
        { name: 'Pending', value: hospitalCounts.pending, color: secondaryColor },
        { name: 'Approved', value: hospitalCounts.approved, color: SUCCESS_COLOR },
        { name: 'Rejected', value: hospitalCounts.rejected, color: DANGER_COLOR },
      ],
    };
  }, [dashboard.sourceRows, performanceMonth, performanceRange, performanceYear, primaryColor, secondaryColor]);

  const performanceYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 10 }, (_, index) => String(currentYear - index));
  }, []);

  const totalEventApplications = useMemo(
    () => overviewData.eventLifecycleData.find((entry) => entry.key === 'applications')?.value || 0,
    [overviewData.eventLifecycleData],
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
  const performanceTabs = [
    { id: 'events', label: 'Programs' },
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

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="role-page-title text-2xl font-bold leading-tight"
            style={{ color: palette.heading, fontFamily: `${headingFontFamily}, sans-serif` }}
          >
            Admin Dashboard
          </h1>
          <p className="text-xs sm:text-sm" style={{ color: palette.bodyText }}>
            Approvals, activity, and system readiness at a glance.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <PageHeaderActions
            onRefresh={loadDashboard}
            refreshLoading={isLoading}
            autoRefreshOnChanges={false}
            helpTitle="About the Admin Dashboard"
            helpContent={(
              <>
                <p>Metrics summarize program, hospital, user, and configuration records. Green means approved or healthy; red means rejected, missing, or requiring attention.</p>
                <p>Use the Performance Overview tabs to compare each operational area.</p>
              </>
            )}
          />
        </div>
      </div>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {topMetrics.map(({ key, ...metric }) => (
          <MetricTile
            key={key}
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
              <>
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
                {performanceRange === 'weekly' && <input type="month" value={performanceMonth} onChange={(event) => setPerformanceMonth(event.target.value)} className="rounded-lg border bg-white px-2.5 py-1.5 text-[10px]" style={{ borderColor: palette.divider, color: palette.bodyText }} />}
                {performanceRange === 'monthly' && (
                  <select value={performanceYear} onChange={(event) => setPerformanceYear(event.target.value)} className="rounded-lg border bg-white px-2.5 py-1.5 text-[10px]" style={{ borderColor: palette.divider, color: palette.bodyText }}>
                    {performanceYears.map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                )}
                {performanceRange === 'yearly' && <span className="rounded-lg px-2.5 py-1.5 text-[10px] font-semibold" style={{ backgroundColor: palette.subtleSurface, color: palette.bodyText }}>Past 5 years</span>}
              </>
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
            <div className="flex min-h-[260px] flex-col border-b p-4 xl:border-b-0 xl:border-r" style={{ borderColor: palette.divider }}>
              <div>
                <h3 className="text-xs font-bold" style={{ color: palette.heading }}>{PERFORMANCE_RANGES[performanceRange].label} program lifecycle</h3>
                <p className="text-[10px]" style={{ color: palette.mutedText }}>{performanceRange === 'weekly' ? 'Cumulative milestones for applications submitted each week' : performanceRange === 'monthly' ? 'Cumulative milestones for applications submitted each month' : 'Cumulative milestones for applications submitted each year'}</p>
              </div>
              <div className="mt-2 min-h-[190px] flex-1">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={overviewData.trendData} margin={{ top: 8, right: 12, left: -24, bottom: 4 }} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.divider} vertical={false} />
                    <XAxis dataKey="label" interval={0} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: withAlpha(secondaryColor, 0.08) }} contentStyle={{ backgroundColor: palette.surface, borderColor: palette.border, borderRadius: 8, color: palette.heading, fontSize: 11 }} />
                    <Bar dataKey="applications" name="Total Applications" fill={primaryColor} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="pending" name="Pending" fill="#d97706" radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="approved" name="Approved" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="rejected" name="Rejected" fill="#dc2626" radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="ended" name="Ended" fill="#64748b" radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="successful" name="Successful" fill="#059669" radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="cancelled" name="Cancelled" fill="#d97706" radius={[4, 4, 0, 0]} maxBarSize={34} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="p-4">
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>Program Counts</h3>
              <p className="mb-2 text-[10px]" style={{ color: palette.mutedText }}>Milestones are cumulative; successful programs also remain counted as approved and ended.</p>
              <StatusTable data={overviewData.eventLifecycleData} total={totalEventApplications} palette={palette} />
            </div>
          </div>
        )}

        {activePerformanceTab === 'hospitals' && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
            <div className="border-b p-4 xl:border-b-0 xl:border-r" style={{ borderColor: palette.divider }}>
              <h3 className="text-xs font-bold" style={{ color: palette.heading }}>{PERFORMANCE_RANGES[performanceRange].label} hospital applications</h3>
              <p className="text-[10px]" style={{ color: palette.mutedText }}>{performanceRange === 'weekly' ? 'All weeks in the selected month' : performanceRange === 'monthly' ? 'All months in the selected year' : 'Annual totals for the past five years'}</p>
              <div className="mt-2 h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overviewData.trendData} margin={{ top: 8, right: 12, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={palette.divider} vertical={false} />
                    <XAxis dataKey="label" interval={0} minTickGap={12} tick={{ fontSize: 9, fill: palette.bodyText }} tickLine={false} axisLine={false} />
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
                      <span className="block truncate text-[11px] font-semibold" style={{ color: palette.heading }}>{row.Event_Name || 'Untitled Program'}</span>
                      <span className="block truncate text-[10px]" style={{ color: palette.bodyText }}>
                        ER-{row.Event_Request_ID} | {applicantName(row.application)}
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
                    <p className="truncate text-[8px]" style={{ color: palette.mutedText }}>Approved programs unassigned</p>
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
