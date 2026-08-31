import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Package,
  Settings2,
  Users,
} from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts';
import { supabase, isSupabaseConfigured } from '../../../lib/supabaseClient';
import PageHeaderActions from '../../../components/PageHeaderActions';
import { useTheme } from '../../../context/ThemeContext';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_ATTENDEES_TABLE = 'Event_Attendees';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const USERS_TABLE = 'users';
const WIG_REQUIREMENTS_TABLE = 'wig_requirements';
const LOGISTICS_SETTINGS_TABLE = 'Logistics_Settings';
const LEGAL_DOCUMENTS_TABLE = 'legal_documents';

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
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

function toManilaDayKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildSevenDayWindow() {
  const rows = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    rows.push({
      dayKey: toManilaDayKey(date),
      label: formatShortDate(date),
      assignedEvents: 0,
    });
  }
  return rows;
}

function canonicalWigStatus(statusValue) {
  const key = normalizeKey(statusValue);
  if (['pending', 'pendingreview', 'pendingvalidation', 'pendingconfirmation'].includes(key)) return 'pending';
  if (['acceptedallocatedwig', 'acceptedwithallocatedwig', 'acceptedwigallocated', 'allocated', 'allocatedwig'].includes(key)) return 'accepted_allocated';
  if (['acceptednowigavailable', 'acceptedbutnowigavailable', 'nowigavailable', 'findingmatchingwig', 'matching'].includes(key)) return 'accepted_no_wig';
  if (['inproduction', 'production', 'inprocess'].includes(key)) return 'in_production';
  if (key === 'readyforpickup') return 'ready_for_pickup';
  if (['toberelease', 'readyforrelease', 'readyforevent'].includes(key)) return 'to_be_release';
  if (['releasing', 'forrelease'].includes(key)) return 'releasing';
  if (['released', 'completed', 'done'].includes(key)) return 'released';
  if (['rejected', 'declined', 'denied'].includes(key)) return 'rejected';
  if (['cancelled', 'canceled', 'cancel'].includes(key)) return 'cancelled';
  return 'pending';
}

function wigStatusLabel(statusKey) {
  if (statusKey === 'pending') return 'Pending';
  if (statusKey === 'accepted_allocated') return 'Allocated';
  if (statusKey === 'accepted_no_wig') return 'No Wig';
  if (statusKey === 'in_production') return 'Production';
  if (statusKey === 'ready_for_pickup') return 'Ready for Pick-up';
  if (statusKey === 'to_be_release') return 'Ready';
  if (statusKey === 'releasing') return 'Releasing';
  if (statusKey === 'released') return 'Released';
  if (statusKey === 'rejected') return 'Rejected';
  if (statusKey === 'cancelled') return 'Cancelled';
  return 'Pending';
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

function MetricTile({ label, value, accentColor, helper, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow"
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 flex-none rounded-full" style={{ backgroundColor: accentColor }} />
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      </div>
      <p className="mt-2 text-3xl font-bold leading-none text-slate-900">{value}</p>
      <p className="mt-auto pt-2 text-[11px] text-slate-500">{helper}</p>
    </button>
  );
}

function ProgressRow({ label, value, total, accentColor }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-semibold text-slate-700">{label}</span>
        <span className="font-bold text-slate-900">{value}<span className="ml-1 font-normal text-slate-400">Â· {pct}%</span></span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%`, backgroundColor: accentColor }} />
      </div>
    </div>
  );
}

export default function DashboardPage({ onNavigate, userProfile, onInitialDataReady }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#475569';
  const fontFamily = theme?.fontFamily || 'Poppins';
  const headingFontFamily = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';

  const [isLoading, setIsLoading] = useState(false);
  const initialDataReportedRef = useRef(false);
  const reportInitialDataReady = useCallback(() => {
    if (initialDataReportedRef.current) return;
    initialDataReportedRef.current = true;
    onInitialDataReady?.();
  }, [onInitialDataReady]);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [warnings, setWarnings] = useState([]);
  const [staffUserId, setStaffUserId] = useState(userProfile?.user_id || null);
  const [dashboard, setDashboard] = useState({
    kpis: {
      pendingStaffReview: 0,
      appealedNeedsResubmit: 0,
      pendingAdminDecision: 0,
      myAssignedEvents: 0,
      myUpcomingWeekEvents: 0,
      attendeesWithoutWaybill: 0,
      wigReviewQueue: 0,
      systemAlerts: 0,
    },
    applicationStatusData: [],
    upcomingAssignedTrend: buildSevenDayWindow(),
    wigQueueData: [],
    actionItems: [],
    pendingStaffRows: [],
    appealedRows: [],
    assignedRows: [],
    systemChecks: {
      wigRequirementsReady: false,
      logisticsReady: false,
      legalReady: false,
      legalVersion: '',
    },
  });

  const resolveStaffUserId = useCallback(async () => {
    if (staffUserId) return safeNumber(staffUserId) || null;
    if (!supabase) return null;

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData?.session?.user?.id) return null;

    const authUserId = sessionData.session.user.id;
    const profileResult = await supabase
      .from(USERS_TABLE)
      .select('user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    const resolvedId = profileResult?.data?.user_id || null;
    if (resolvedId) setStaffUserId(resolvedId);
    return resolvedId;
  }, [staffUserId]);

  const loadDashboard = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });
    setWarnings([]);

    try {
      const resolvedStaffId = await resolveStaffUserId();
      const settled = await Promise.allSettled([
        supabase
          .from(EVENT_APPLICATIONS_TABLE)
          .select('Event_Application_ID,Event_Name,Status,Created_At,Updated_At,Linked_Event_Request_ID,Applicant_First_Name,Applicant_Middle_Name,Applicant_Last_Name,Proposed_Start_At')
          .order('Created_At', { ascending: false })
          .limit(1000),
        supabase
          .from(EVENT_REQUESTS_TABLE)
          .select('Event_Request_ID,Event_Application_ID,Event_Name,Status,Created_At,Updated_At,Start_Date,End_Date,Assigned_Staff_User_ID,Event_Visibility')
          .order('Updated_At', { ascending: false })
          .limit(1000),
        supabase
          .from(WIG_REQUESTS_TABLE)
          .select('Req_ID,Status,Updated_At')
          .order('Updated_At', { ascending: false })
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
          .select('legal_document_id,version,is_active,created_at')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      const applicationResult = extractQueryResult(settled[0]);
      const requestResult = extractQueryResult(settled[1]);
      const wigRequestResult = extractQueryResult(settled[2]);
      const wigRequirementsResult = extractQueryResult(settled[3]);
      const logisticsResult = extractQueryResult(settled[4]);
      const legalResult = extractQueryResult(settled[5]);

      const nextWarnings = [];
      if (wigRequestResult.error) nextWarnings.push(`Wig request queue: ${wigRequestResult.error.message}`);
      if (wigRequirementsResult.error) nextWarnings.push(`Wig requirements: ${wigRequirementsResult.error.message}`);
      if (logisticsResult.error) nextWarnings.push(`Logistics destination: ${logisticsResult.error.message}`);
      if (legalResult.error) nextWarnings.push(`Legal documents: ${legalResult.error.message}`);
      setWarnings(nextWarnings);

      if (applicationResult.error || requestResult.error) {
        const raw = applicationResult.error?.message || requestResult.error?.message || 'Unable to load staff dashboard data.';
        setNotice({ kind: 'error', text: raw });
      }

      const applicationRows = applicationResult.data;
      const requestRows = requestResult.data;
      const wigRows = wigRequestResult.data;

      const pendingStaffRows = applicationRows
        .filter((row) => normalizeKey(row.Status) === 'pendingstaffreview')
        .slice()
        .sort((a, b) => new Date(a.Created_At || 0).getTime() - new Date(b.Created_At || 0).getTime());

      const appealedRows = applicationRows
        .filter((row) => normalizeKey(row.Status) === 'appealed')
        .slice()
        .sort((a, b) => new Date(a.Updated_At || 0).getTime() - new Date(b.Updated_At || 0).getTime());

      const pendingAdminDecisionRows = applicationRows.filter(
        (row) => normalizeKey(row.Status) === 'pendingadmindecision',
      );

      const myAssignedRows = requestRows
        .filter((row) => {
          if (!resolvedStaffId) return false;
          return safeNumber(row.Assigned_Staff_User_ID) === safeNumber(resolvedStaffId)
            && normalizeKey(row.Status) === 'approved';
        })
        .slice()
        .sort((a, b) => new Date(a.Start_Date || a.Created_At || 0).getTime() - new Date(b.Start_Date || b.Created_At || 0).getTime());

      const upcomingWindowData = buildSevenDayWindow();
      const upcomingMap = new Map(upcomingWindowData.map((row) => [row.dayKey, row]));
      let myUpcomingWeekEvents = 0;
      myAssignedRows.forEach((row) => {
        const key = toManilaDayKey(row.Start_Date || row.Created_At);
        if (upcomingMap.has(key)) {
          upcomingMap.get(key).assignedEvents += 1;
          myUpcomingWeekEvents += 1;
        }
      });

      const assignedRequestIds = [...new Set(
        myAssignedRows.map((row) => safeNumber(row.Event_Request_ID)).filter((value) => value > 0),
      )];

      let attendeeRows = [];
      if (assignedRequestIds.length > 0) {
        const attendeeResult = await supabase
          .from(EVENT_ATTENDEES_TABLE)
          .select('Event_Attendee_ID,Event_Request_ID,Waybill_Printed_At,Attendance_Status')
          .in('Event_Request_ID', assignedRequestIds)
          .limit(2000);
        if (attendeeResult.error) {
          nextWarnings.push(`Assigned attendees: ${attendeeResult.error.message}`);
          setWarnings([...nextWarnings]);
        } else {
          attendeeRows = attendeeResult.data || [];
        }
      }

      const attendeeCountByRequestId = attendeeRows.reduce((acc, row) => {
        const key = safeNumber(row.Event_Request_ID);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      const attendeesWithoutWaybill = attendeeRows.filter((row) => !row.Waybill_Printed_At).length;

      const wigQueueCounts = {
        pending: 0,
        accepted_allocated: 0,
        accepted_no_wig: 0,
        in_production: 0,
        ready_for_pickup: 0,
        to_be_release: 0,
        releasing: 0,
      };
      wigRows.forEach((row) => {
        const key = canonicalWigStatus(row.Status);
        if (key in wigQueueCounts) wigQueueCounts[key] += 1;
      });

      const wigQueueData = Object.entries(wigQueueCounts).map(([statusKey, value]) => ({
        name: wigStatusLabel(statusKey),
        value,
      }));

      const reviewQueueSet = new Set(['pending', 'accepted_allocated', 'accepted_no_wig', 'in_production']);
      const wigReviewQueue = Object.entries(wigQueueCounts).reduce((sum, [key, value]) => (
        reviewQueueSet.has(key) ? sum + value : sum
      ), 0);

      const appStatusCounts = {
        pendingstaffreview: 0,
        pendingadmindecision: 0,
        appealed: 0,
        rejected: 0,
      };
      applicationRows.forEach((row) => {
        const key = normalizeKey(row.Status);
        if (key in appStatusCounts) appStatusCounts[key] += 1;
      });
      const applicationStatusData = [
        { name: 'Pending Staff', value: appStatusCounts.pendingstaffreview, color: '#f59e0b' },
        { name: 'Pending Admin', value: appStatusCounts.pendingadmindecision, color: '#0ea5e9' },
        { name: 'Appealed', value: appStatusCounts.appealed, color: '#8b5cf6' },
        { name: 'Rejected', value: appStatusCounts.rejected, color: '#e11d48' },
      ];

      const activeLegal = legalResult.data.find((row) => Boolean(row.is_active)) || null;
      const systemChecks = {
        wigRequirementsReady: wigRequirementsResult.data.length > 0,
        logisticsReady: logisticsResult.data.length > 0,
        legalReady: Boolean(activeLegal),
        legalVersion: String(activeLegal?.version || ''),
      };

      const actionItems = [];
      if (pendingStaffRows.length > 0) {
        actionItems.push({
          title: 'Pending event applications to review',
          count: pendingStaffRows.length,
          detail: 'Contact requestors and validate details.',
          page: 'event-application-intake',
        });
      }
      if (appealedRows.length > 0) {
        actionItems.push({
          title: 'Appealed applications to resubmit',
          count: appealedRows.length,
          detail: 'Update details and resubmit to admin.',
          page: 'event-application-intake',
        });
      }
      if (attendeesWithoutWaybill > 0) {
        actionItems.push({
          title: 'Attendees without waybill',
          count: attendeesWithoutWaybill,
          detail: 'Print waybills before event operations.',
          page: 'assigned-event-operations',
        });
      }
      if (wigReviewQueue > 0) {
        actionItems.push({
          title: 'Wig requests need action',
          count: wigReviewQueue,
          detail: 'Move wig requests through workflow.',
          page: 'update-wig-request-status',
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
          detail: `Setup: ${missing}.`,
          page: 'manage-requirements',
        });
      }

      setDashboard({
        kpis: {
          pendingStaffReview: pendingStaffRows.length,
          appealedNeedsResubmit: appealedRows.length,
          pendingAdminDecision: pendingAdminDecisionRows.length,
          myAssignedEvents: myAssignedRows.length,
          myUpcomingWeekEvents,
          attendeesWithoutWaybill,
          wigReviewQueue,
          systemAlerts: (!systemChecks.wigRequirementsReady ? 1 : 0)
            + (!systemChecks.logisticsReady ? 1 : 0)
            + (!systemChecks.legalReady ? 1 : 0),
        },
        applicationStatusData,
        upcomingAssignedTrend: upcomingWindowData,
        wigQueueData,
        actionItems,
        pendingStaffRows: pendingStaffRows.slice(0, 5),
        appealedRows: appealedRows.slice(0, 5),
        assignedRows: myAssignedRows.slice(0, 5).map((row) => ({
          ...row,
          attendeeCount: attendeeCountByRequestId[safeNumber(row.Event_Request_ID)] || 0,
        })),
        systemChecks,
      });

    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load staff dashboard data.' });
    } finally {
      setIsLoading(false);
      reportInitialDataReady();
    }
  }, [reportInitialDataReady, resolveStaffUserId]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const topMetrics = useMemo(() => ([
    {
      key: 'staffReview',
      label: 'Pending Staff Review',
      value: dashboard.kpis.pendingStaffReview,
      accentColor: '#f59e0b',
      helper: 'Applications awaiting your intake',
      page: 'event-application-intake',
    },
    {
      key: 'myEvents',
      label: 'My Assigned Events',
      value: dashboard.kpis.myAssignedEvents,
      accentColor: tertiaryColor,
      helper: 'Approved events assigned to you',
      page: 'assigned-event-operations',
    },
    {
      key: 'wigQueue',
      label: 'Wig Queue',
      value: dashboard.kpis.wigReviewQueue,
      accentColor: primaryColor,
      helper: 'Wig requests needing workflow action',
      page: 'update-wig-request-status',
    },
    {
      key: 'noWaybill',
      label: 'No Waybill',
      value: dashboard.kpis.attendeesWithoutWaybill,
      accentColor: '#e11d48',
      helper: 'Attendees still needing waybill printed',
      page: 'assigned-event-operations',
    },
  ]), [dashboard.kpis, primaryColor, tertiaryColor]);

  const totalApplications = useMemo(
    () => dashboard.applicationStatusData.reduce((sum, entry) => sum + safeNumber(entry.value), 0),
    [dashboard.applicationStatusData],
  );

  return (
    <div
      className="space-y-4"
      style={{ fontFamily: `${fontFamily}, sans-serif`, color: primaryTextColor }}
    >
      {/* Plain title row */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1
            className="role-page-title text-2xl font-bold"
            style={{ fontFamily: `${headingFontFamily}, sans-serif`, color: primaryTextColor }}
          >
            Staff Dashboard
          </h1>
          <p className="text-sm" style={{ color: secondaryTextColor }}>
            Intake workload, assigned operations, and wig workflow at a glance.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="hidden items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-semibold text-slate-600 sm:inline-flex">
            <span className="h-2 w-2 rounded-full bg-slate-400" />
            Cached
          </span>
          <PageHeaderActions
            onRefresh={loadDashboard}
            refreshLoading={isLoading}
            autoRefreshOnChanges={false}
            helpTitle="About the Staff Dashboard"
            helpContent={<p>Review event intake, assigned operations, attendee waybills, and wig-request stages from this overview.</p>}
          />
        </div>
      </div>

      {notice.text && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {notice.kind === 'error' ? <AlertTriangle size={14} className="mt-0.5 flex-none" /> : <CheckCircle2 size={14} className="mt-0.5 flex-none" />}
          <span>{notice.text}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-semibold">Partial data warnings</p>
          <div className="mt-1 space-y-0.5">
            {warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        </div>
      )}

      {/* Top metric tiles */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {topMetrics.map((metric) => (
          <MetricTile
            key={metric.key}
            label={metric.label}
            value={metric.value}
            accentColor={metric.accentColor}
            helper={metric.helper}
            onClick={() => typeof onNavigate === 'function' && onNavigate(metric.page)}
          />
        ))}
      </section>

      {/* Row: Donut + Bar + Progress bars */}
      <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-4">
          <h3 className="text-sm font-bold text-slate-800">Application Status Mix</h3>
          <p className="text-xs text-slate-500">Lifetime distribution</p>
          <div className="relative mt-2 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={dashboard.applicationStatusData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={82}
                  innerRadius={58}
                  paddingAngle={2}
                  stroke="none"
                >
                  {dashboard.applicationStatusData.map((entry, index) => (
                    <Cell key={`${entry.name}-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-4xl font-bold leading-none text-slate-900">{totalApplications}</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Total</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            {dashboard.applicationStatusData.map((entry) => (
              <div key={entry.name} className="flex items-center gap-1.5">
                <span className="h-2 w-2 flex-none rounded-full" style={{ backgroundColor: entry.color }} />
                <span className="flex-1 truncate text-slate-600">{entry.name}</span>
                <span className="font-bold text-slate-800">{entry.value}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-800">Wig Workflow Queue</h3>
              <p className="text-xs text-slate-500">Requests grouped by stage</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px]">
              <Package size={11} style={{ color: primaryColor }} />
              <span className="text-slate-600">Requests</span>
            </span>
          </div>
          <div className="mt-2 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dashboard.wigQueueData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={48} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="value" name="Requests" fill={primaryColor} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-3">
          <h3 className="text-sm font-bold text-slate-800">Status Breakdown</h3>
          <p className="text-xs text-slate-500">Share of all applications</p>
          <div className="mt-4 space-y-3">
            {dashboard.applicationStatusData.map((entry) => (
              <ProgressRow
                key={entry.name}
                label={entry.name}
                value={entry.value}
                total={totalApplications}
                accentColor={entry.color}
              />
            ))}
          </div>
        </article>
      </section>

      {/* Row: Action items + intake (left); assigned + system (right) */}
      <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <div className="space-y-3 xl:col-span-7">
          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-1.5">
              <CalendarClock size={14} style={{ color: primaryColor }} />
              <h2 className="text-sm font-bold text-slate-800">Needs Action Now</h2>
              <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                {dashboard.actionItems.length}
              </span>
            </div>
            {dashboard.actionItems.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <CheckCircle2 size={13} />
                No immediate staff blockers right now.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {dashboard.actionItems.map((item) => (
                  <li key={`${item.title}-${item.page}`}>
                    <button
                      type="button"
                      onClick={() => typeof onNavigate === 'function' && onNavigate(item.page)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-left transition hover:border-slate-300 hover:bg-white"
                    >
                      <span
                        className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-xs font-bold text-white"
                        style={{ backgroundColor: primaryColor }}
                      >
                        {item.count}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-bold text-slate-900">{item.title}</p>
                        <p className="truncate text-[11px] text-slate-500">{item.detail}</p>
                      </div>
                      <ArrowRight size={13} className="text-slate-400" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Oldest Pending Intake</h3>
                <p className="text-xs text-slate-500">First-in-first-out review</p>
              </div>
              <button
                type="button"
                onClick={() => typeof onNavigate === 'function' && onNavigate('event-application-intake')}
                className="inline-flex items-center gap-1 text-[11px] font-semibold hover:underline"
                style={{ color: primaryColor }}
              >
                Open intake <ArrowRight size={11} />
              </button>
            </div>
            {dashboard.pendingStaffRows.length === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                No pending staff intake applications.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {dashboard.pendingStaffRows.map((row) => (
                  <li key={row.Event_Application_ID} className="flex items-center justify-between gap-2 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-900">{row.Event_Name || 'Untitled Event'}</p>
                      <p className="truncate text-[11px] text-slate-500">
                        EA-{row.Event_Application_ID} Â· {applicantName(row)}
                      </p>
                    </div>
                    <span className="flex-none rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                      {formatShortDate(row.Created_At)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>

        <div className="space-y-3 xl:col-span-5">
          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-800">My Assigned Events</h3>
                <p className="text-xs text-slate-500">Approved + assigned to you</p>
              </div>
              <button
                type="button"
                onClick={() => typeof onNavigate === 'function' && onNavigate('assigned-event-operations')}
                className="inline-flex items-center gap-1 text-[11px] font-semibold hover:underline"
                style={{ color: primaryColor }}
              >
                Open <ArrowRight size={11} />
              </button>
            </div>
            {dashboard.assignedRows.length === 0 ? (
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                No assigned events yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {dashboard.assignedRows.map((row) => (
                  <li key={row.Event_Request_ID} className="flex items-center justify-between gap-2 py-2 text-xs">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                        <Users size={13} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-slate-900">{row.Event_Name || 'Untitled Event'}</p>
                        <p className="truncate text-[11px] text-slate-500">
                          ER-{row.Event_Request_ID} Â· {formatShortDate(row.Start_Date)}
                        </p>
                      </div>
                    </div>
                    <span className="flex-none rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                      {row.attendeeCount} att.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-1.5">
                <Settings2 size={13} style={{ color: primaryColor }} />
                <h3 className="text-sm font-bold text-slate-800">System Health</h3>
              </div>
              <div className="space-y-1.5">
                {[
                  { label: 'Wig Requirements', ready: dashboard.systemChecks.wigRequirementsReady },
                  { label: 'Logistics', ready: dashboard.systemChecks.logisticsReady },
                  { label: 'Legal PDF', ready: dashboard.systemChecks.legalReady, detail: dashboard.systemChecks.legalVersion ? `v${dashboard.systemChecks.legalVersion}` : undefined },
                ].map((item) => (
                  <div
                    key={item.label}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${
                      item.ready
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-rose-200 bg-rose-50 text-rose-800'
                    }`}
                  >
                    {item.ready ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                    <span className="flex-1 truncate">{item.label}</span>
                    <span className="text-[10px] font-bold uppercase">
                      {item.ready ? (item.detail || 'OK') : 'Missing'}
                    </span>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-bold text-slate-800">My Workload</h3>
              <div className="space-y-2">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Upcoming 7 Days</p>
                  <p className="text-xl font-bold leading-tight text-slate-900">{dashboard.kpis.myUpcomingWeekEvents}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">With Admin</p>
                  <p className="text-xl font-bold leading-tight text-slate-900">{dashboard.kpis.pendingAdminDecision}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Appealed</p>
                  <p className="text-xl font-bold leading-tight text-slate-900">{dashboard.kpis.appealedNeedsResubmit}</p>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>
    </div>
  );
}
