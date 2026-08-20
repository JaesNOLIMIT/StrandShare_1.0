import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  HelpCircle,
  Loader2,
  Package,
  PackagePlus,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import {
  HAIR_BUNDLE_STATUS,
  HAIR_SUBMISSION_STATUS,
} from '../../../lib/hairSubmissionWorkflow';

const HAIR_SUBMISSIONS_TABLE = 'Hair_Submissions';
const HAIR_SUBMISSION_BUNDLES_TABLE = 'Hair_Submission_Bundles';
const WIGS_TABLE = 'Wigs';
const USER_DETAILS_TABLE = 'user_details';
const EVENT_ATTENDEES_TABLE = 'Event_Attendees';
const EVENT_REQUESTS_TABLE = 'Event_Requests';

const REALTIME_DEBOUNCE_MS = 250;
const RECENT_LIMIT = 8;

function withColorAlpha(colorValue, alpha, fallback = '#0275d8') {
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  const input = String(colorValue || '').trim();
  const hexMatch = input.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const r = parseInt(hexMatch[1].slice(0, 2), 16);
    const g = parseInt(hexMatch[1].slice(2, 4), 16);
    const b = parseInt(hexMatch[1].slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
  }
  return withColorAlpha(fallback, safeAlpha, '#0275d8');
}

function buildFullName(first, middle, last, suffix) {
  return [first, middle, last, suffix]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function isSameDay(dateValue, anchor) {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getFullYear() === anchor.getFullYear()
    && parsed.getMonth() === anchor.getMonth()
    && parsed.getDate() === anchor.getDate()
  );
}

function formatRelative(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  const diff = Date.now() - parsed.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit' });
}

function statusKey(value) {
  return String(value || '').trim().toLowerCase();
}

function statusBadgeStyle(value, primaryColor, tertiaryColor) {
  const key = statusKey(value);
  if (key === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase() || key.includes('approved')) {
    return { backgroundColor: withColorAlpha(tertiaryColor, 0.16), color: tertiaryColor, borderColor: withColorAlpha(tertiaryColor, 0.4) };
  }
  if (key === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()) {
    return { backgroundColor: '#fef2f2', color: '#b91c1c', borderColor: '#fecaca' };
  }
  if (key === HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase()) {
    return { backgroundColor: withColorAlpha(primaryColor, 0.14), color: primaryColor, borderColor: withColorAlpha(primaryColor, 0.4) };
  }
  if (key === HAIR_SUBMISSION_STATUS.CUT_SHIPPED.toLowerCase()) {
    return { backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' };
  }
  if (key === HAIR_BUNDLE_STATUS.IN_PRODUCTION.toLowerCase()) {
    return { backgroundColor: withColorAlpha(primaryColor, 0.14), color: primaryColor, borderColor: withColorAlpha(primaryColor, 0.4) };
  }
  if (key === HAIR_BUNDLE_STATUS.WIG_COMPLETED.toLowerCase()) {
    return { backgroundColor: withColorAlpha(tertiaryColor, 0.16), color: tertiaryColor, borderColor: withColorAlpha(tertiaryColor, 0.4) };
  }
  if (key === HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()) {
    return { backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' };
  }
  return { backgroundColor: '#f1f5f9', color: '#475569', borderColor: '#cbd5e1' };
}

function actionLabelFor(submission) {
  const key = statusKey(submission.Status);
  if (key === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase()) return 'Approved';
  if (key === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()) return 'Rejected';
  if (key === HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase()) return 'Received';
  if (key === HAIR_SUBMISSION_STATUS.CUT_SHIPPED.toLowerCase()) return 'Cut & Shipped';
  return submission.Status || 'Updated';
}

export default function DashboardPage({ onNavigate }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0275d8';
  const secondaryColor = theme?.secondaryColor || '#64748b';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const tertiaryTextColor = theme?.tertiaryTextColor || '#94a3b8';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const rootStyle = { color: primaryTextColor, fontFamily: `${bodyFont}, sans-serif` };
  const headingStyle = { color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` };
  const panelBorder = withColorAlpha(secondaryColor, 0.24);

  const [submissions, setSubmissions] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [wigs, setWigs] = useState([]);
  const [donorsById, setDonorsById] = useState({});
  const [drivesById, setDrivesById] = useState({});

  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const loadData = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.' });
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });

    try {
      const [submissionsRes, bundlesRes, wigsRes] = await Promise.all([
        supabase
          .from(HAIR_SUBMISSIONS_TABLE)
          .select('Submission_ID, User_ID, Event_Attendee_ID, Event_Request_ID, Status, Created_At, Updated_At, Bundle_ID')
          .order('Updated_At', { ascending: false })
          .limit(400),
        supabase
          .from(HAIR_SUBMISSION_BUNDLES_TABLE)
          .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At, Wig_Completed_At')
          .order('Created_At', { ascending: false })
          .limit(200),
        supabase
          .from(WIGS_TABLE)
          .select('Wig_ID, Wig_Code, Wig_Name, Wig_Status, Completed_At, Bundle_ID')
          .order('Completed_At', { ascending: false, nullsFirst: false })
          .limit(200),
      ]);

      if (submissionsRes.error) throw submissionsRes.error;
      if (bundlesRes.error) throw bundlesRes.error;
      if (wigsRes.error) throw wigsRes.error;

      const submissionRowsRaw = submissionsRes.data || [];
      const bundleRows = bundlesRes.data || [];
      const wigRows = wigsRes.data || [];

      const attendeeIds = Array.from(new Set(submissionRowsRaw.map((r) => Number(r.Event_Attendee_ID || 0)).filter(Boolean)));
      let attendeeToRequestId = {};
      let attendeeToWaybillCode = {};
      if (attendeeIds.length) {
        const { data, error } = await supabase
          .from(EVENT_ATTENDEES_TABLE)
          .select('Event_Attendee_ID, Event_Request_ID, Waybill_Code')
          .in('Event_Attendee_ID', attendeeIds);
        if (error) throw error;
        attendeeToRequestId = (data || []).reduce((acc, row) => {
          const attendeeId = Number(row.Event_Attendee_ID || 0);
          if (!attendeeId) return acc;
          acc[attendeeId] = Number(row.Event_Request_ID || 0) || null;
          return acc;
        }, {});
        attendeeToWaybillCode = (data || []).reduce((acc, row) => {
          const attendeeId = Number(row.Event_Attendee_ID || 0);
          if (!attendeeId) return acc;
          acc[attendeeId] = String(row.Waybill_Code || '').trim() || null;
          return acc;
        }, {});
      }

      const submissionRows = submissionRowsRaw.map((row) => {
        const attendeeId = Number(row.Event_Attendee_ID || 0);
        const resolvedEventRequestId = Number(attendeeToRequestId[attendeeId] || row.Event_Request_ID || 0) || null;
        return {
          ...row,
          _resolvedEventRequestId: resolvedEventRequestId,
          _resolvedWaybillCode: String(attendeeToWaybillCode[attendeeId] || '').trim() || '',
        };
      });

      setSubmissions(submissionRows);
      setBundles(bundleRows);
      setWigs(wigRows);

      const userIds = Array.from(new Set(submissionRows.map((r) => Number(r.User_ID || 0)).filter(Boolean)));
      const driveIds = Array.from(new Set(submissionRows.map((r) => Number(r._resolvedEventRequestId || 0)).filter(Boolean)));

      if (userIds.length) {
        const { data, error } = await supabase
          .from(USER_DETAILS_TABLE)
          .select('user_id, first_name, middle_name, last_name, suffix')
          .in('user_id', userIds);
        if (!error) {
          setDonorsById((data || []).reduce((acc, row) => {
            acc[Number(row.user_id)] = row;
            return acc;
          }, {}));
        }
      } else {
        setDonorsById({});
      }

      if (driveIds.length) {
        const { data, error } = await supabase
          .from(EVENT_REQUESTS_TABLE)
          .select('Event_Request_ID, Event_Name')
          .in('Event_Request_ID', driveIds);
        if (!error) {
          setDrivesById((data || []).reduce((acc, row) => {
            acc[Number(row.Event_Request_ID)] = row;
            return acc;
          }, {}));
        }
      } else {
        setDrivesById({});
      }

    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load dashboard data.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;

    let isMounted = true;
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (!isMounted) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (isMounted) void loadData();
      }, REALTIME_DEBOUNCE_MS);
    };

    const channel = supabase
      .channel('public:qa-stylist-dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: HAIR_SUBMISSIONS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: HAIR_SUBMISSION_BUNDLES_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIGS_TABLE }, scheduleRefresh)
      .subscribe((status) => {
        if (!isMounted) return;
        setIsRealtimeActive(status === 'SUBSCRIBED');
      });

    return () => {
      isMounted = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, [loadData]);

  const todayAnchor = useMemo(() => startOfToday(), []);

  const stats = useMemo(() => {
    let pendingQa = 0;
    let approvedToday = 0;
    let rejectedToday = 0;
    let approvedTotal = 0;
    let rejectedTotal = 0;
    let receivedTotal = 0;
    let awaitingIntake = 0;

    submissions.forEach((row) => {
      const key = statusKey(row.Status);
      const updated = row.Updated_At || row.Created_At;
      if (key === HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase()) {
        pendingQa += 1;
        receivedTotal += 1;
      }
      if (key === HAIR_SUBMISSION_STATUS.CUT_SHIPPED.toLowerCase()) {
        awaitingIntake += 1;
      }
      if (key === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase()) {
        approvedTotal += 1;
        if (isSameDay(updated, todayAnchor)) approvedToday += 1;
      }
      if (key === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()) {
        rejectedTotal += 1;
        if (isSameDay(updated, todayAnchor)) rejectedToday += 1;
      }
    });

    const draftBundles = bundles.filter((b) => statusKey(b.Status) === HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()).length;
    const inProductionBundles = bundles.filter((b) => statusKey(b.Status) === HAIR_BUNDLE_STATUS.IN_PRODUCTION.toLowerCase()).length;
    const completedBundles = bundles.filter((b) => statusKey(b.Status) === HAIR_BUNDLE_STATUS.WIG_COMPLETED.toLowerCase()).length;
    const wigsCompletedToday = wigs.filter((w) => isSameDay(w.Completed_At, todayAnchor)).length;
    const availableWigs = wigs.filter((w) => statusKey(w.Wig_Status) === 'ready for release').length;

    const totalQaDecided = approvedTotal + rejectedTotal;
    const approvalRate = totalQaDecided > 0 ? Math.round((approvedTotal / totalQaDecided) * 100) : 0;

    return {
      pendingQa,
      awaitingIntake,
      approvedToday,
      rejectedToday,
      approvedTotal,
      rejectedTotal,
      receivedTotal,
      draftBundles,
      inProductionBundles,
      completedBundles,
      wigsCompletedToday,
      availableWigs,
      approvalRate,
    };
  }, [submissions, bundles, wigs, todayAnchor]);

  const topCards = useMemo(() => ([
    {
      key: 'pending',
      label: 'Pending QA',
      value: stats.pendingQa,
      sub: `${stats.awaitingIntake} awaiting intake`,
      icon: ScanLine,
      pageId: 'quality-check',
      accent: primaryColor,
    },
    {
      key: 'approvedToday',
      label: 'Approved Today',
      value: stats.approvedToday,
      sub: `${stats.approvedTotal} total approved`,
      icon: ShieldCheck,
      pageId: 'quality-check',
      accent: tertiaryColor,
    },
    {
      key: 'rejectedToday',
      label: 'Rejected Today',
      value: stats.rejectedToday,
      sub: `${stats.rejectedTotal} total rejected`,
      icon: XCircle,
      pageId: 'quality-check',
      accent: '#dc2626',
    },
    {
      key: 'bundles',
      label: 'Bundles In Production',
      value: stats.inProductionBundles,
      sub: `${stats.draftBundles} draft${stats.draftBundles === 1 ? '' : 's'}`,
      icon: Package,
      pageId: 'bundling',
      accent: primaryColor,
    },
    {
      key: 'wigs',
      label: 'Wigs Ready',
      value: stats.availableWigs,
      sub: `${stats.wigsCompletedToday} completed today`,
      icon: PackagePlus,
      pageId: 'wig-ai-studio',
      accent: tertiaryColor,
    },
  ]), [stats, primaryColor, tertiaryColor]);

  const recentActivity = useMemo(() => {
    const submissionEvents = submissions
      .filter((row) => [
        HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase(),
        HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase(),
        HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase(),
        HAIR_SUBMISSION_STATUS.CUT_SHIPPED.toLowerCase(),
      ].includes(statusKey(row.Status)))
      .map((row) => {
        const donor = donorsById[Number(row.User_ID || 0)];
        const resolvedEventRequestId = Number(row._resolvedEventRequestId || row.Event_Request_ID || 0);
        const drive = drivesById[resolvedEventRequestId];
        return {
          id: `submission-${row.Submission_ID}`,
          ts: new Date(row.Updated_At || row.Created_At || 0).getTime(),
          code: row._resolvedWaybillCode || `#${Number(row.Submission_ID || 0)}`,
          action: actionLabelFor(row),
          status: row.Status,
          detail: [
            donor ? buildFullName(donor.first_name, donor.middle_name, donor.last_name, donor.suffix) : `User #${row.User_ID || 0}`,
            drive?.Event_Name || (resolvedEventRequestId ? `Event #${resolvedEventRequestId}` : ''),
          ].filter(Boolean).join(' - '),
          updated: row.Updated_At || row.Created_At,
        };
      });

    const bundleEvents = bundles.map((row) => ({
      id: `bundle-${row.Bundle_ID}`,
      ts: new Date(row.Wig_Completed_At || row.Created_At || 0).getTime(),
      code: row.Bundle_Waybill_Code || `WB${String(Number(row.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`,
      action: row.Status,
      status: row.Status,
      detail: row.Notes || `Bundle workflow`,
      updated: row.Wig_Completed_At || row.Created_At,
    }));

    const wigEvents = wigs
      .filter((row) => row.Completed_At)
      .map((row) => ({
        id: `wig-${row.Wig_ID}`,
        ts: new Date(row.Completed_At).getTime(),
        code: row.Wig_Code || `WIG-${row.Wig_ID}`,
        action: 'Wig Created',
        status: HAIR_BUNDLE_STATUS.WIG_COMPLETED,
        detail: row.Wig_Name || 'Wig produced from bundle',
        updated: row.Completed_At,
      }));

    return [...submissionEvents, ...bundleEvents, ...wigEvents]
      .filter((e) => Number.isFinite(e.ts) && e.ts > 0)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, RECENT_LIMIT);
  }, [submissions, bundles, wigs, donorsById, drivesById]);

  const weeklyChartData = useMemo(() => {
    const buckets = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      buckets.push({
        key: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short' }),
        anchor: d,
        approved: 0,
        rejected: 0,
      });
    }

    submissions.forEach((row) => {
      const key = statusKey(row.Status);
      const ts = new Date(row.Updated_At || row.Created_At || 0);
      if (Number.isNaN(ts.getTime())) return;
      const bucket = buckets.find((b) => isSameDay(ts, b.anchor));
      if (!bucket) return;
      if (key === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase()) bucket.approved += 1;
      if (key === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()) bucket.rejected += 1;
    });

    return buckets.map(({ label, approved, rejected }) => ({ label, Approved: approved, Rejected: rejected }));
  }, [submissions]);

  const queueBreakdown = useMemo(() => {
    const data = [
      { name: 'Cut & Shipped', value: 0, color: '#b45309' },
      { name: 'Received', value: 0, color: primaryColor },
      { name: 'Approved', value: 0, color: tertiaryColor },
      { name: 'Rejected', value: 0, color: '#dc2626' },
    ];
    submissions.forEach((row) => {
      const key = statusKey(row.Status);
      if (key === HAIR_SUBMISSION_STATUS.CUT_SHIPPED.toLowerCase()) data[0].value += 1;
      else if (key === HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase()) data[1].value += 1;
      else if (key === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase()) data[2].value += 1;
      else if (key === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()) data[3].value += 1;
    });
    return data.filter((d) => d.value > 0);
  }, [submissions, primaryColor, tertiaryColor]);

  const queueTotal = queueBreakdown.reduce((sum, item) => sum + item.value, 0);

  const handleNavigate = (pageId) => {
    if (!pageId) return;
    if (typeof onNavigate === 'function') onNavigate(pageId);
  };

  return (
    <div className="space-y-4" style={rootStyle}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="role-page-title mb-1 text-2xl font-bold" style={headingStyle}>Specialist Dashboard</h1>
          <p style={{ color: secondaryTextColor }}>
            Live QA queue, bundling progress, and finished wig output - synced in realtime from the database.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs font-semibold"
            style={
              isRealtimeActive
                ? { borderColor: withColorAlpha(tertiaryColor, 0.4), color: tertiaryColor }
                : { borderColor: '#fde68a', color: '#b45309' }
            }
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: isRealtimeActive ? tertiaryColor : '#b45309' }}
            />
            {isRealtimeActive ? 'Live' : 'Offline'}
          </span>
          <div className="relative">
            <button
              type="button"
              aria-label="About the specialist dashboard"
              aria-expanded={isInfoOpen}
              onClick={() => setIsInfoOpen((open) => !open)}
              className="flex h-9 w-9 items-center justify-center rounded-xl border bg-white"
              style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
            >
              <HelpCircle size={16} />
            </button>
            {isInfoOpen && (
              <div className="absolute right-0 top-11 z-30 w-72 rounded-xl border bg-white p-3 text-left shadow-xl" style={{ borderColor: withColorAlpha(primaryColor, 0.25) }}>
                <p className="text-xs font-bold" style={headingStyle}>About this dashboard</p>
                <p className="mt-1 text-[10px] leading-relaxed" style={{ color: secondaryTextColor }}>
                  Live specialist-only workflow: hair quality review, production bundles, and completed wig inventory.
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => loadData()}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-xl border bg-white px-3.5 py-2 text-sm font-semibold disabled:opacity-60"
            style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>
      </header>

      {notice.text ? (
        <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c' }}>
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{notice.text}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {topCards.map(({ key, label, value, sub, pageId, accent }) => (
          <button
            key={key}
            type="button"
            onClick={() => handleNavigate(pageId)}
            className="flex min-h-[124px] flex-col rounded-xl border bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-sm"
            style={{ borderColor: panelBorder }}
          >
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
              <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: tertiaryTextColor }}>{label}</p>
            </div>
            <p className="mt-3 text-3xl font-bold leading-none" style={{ color: primaryTextColor }}>{value}</p>
            <p className="mt-auto pt-3 text-[11px]" style={{ color: secondaryTextColor }}>{sub}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2 rounded-xl border bg-white p-5" style={{ borderColor: panelBorder }}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="text-lg font-semibold" style={headingStyle}>QA Throughput (Last 7 days)</h2>
              <p className="text-xs" style={{ color: tertiaryTextColor }}>Approved vs Rejected hair submissions per day</p>
            </div>
            <div className="flex items-center gap-3 text-xs" style={{ color: secondaryTextColor }}>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: tertiaryColor }} />
                Approved
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: '#dc2626' }} />
                Rejected
              </span>
            </div>
          </div>
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={weeklyChartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" stroke={tertiaryTextColor} fontSize={12} />
                <YAxis allowDecimals={false} stroke={tertiaryTextColor} fontSize={12} />
                <Tooltip cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
                <Bar dataKey="Approved" fill={tertiaryColor} radius={[4, 4, 0, 0]} />
                <Bar dataKey="Rejected" fill="#dc2626" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl border bg-white p-5" style={{ borderColor: panelBorder }}>
          <h2 className="text-lg font-semibold mb-1" style={headingStyle}>QA Queue Mix</h2>
          <p className="text-xs mb-3" style={{ color: tertiaryTextColor }}>Current hair submissions by status</p>

          {queueTotal === 0 ? (
            <div className="flex h-[220px] items-center justify-center text-sm" style={{ color: secondaryTextColor }}>
              No submissions in flight.
            </div>
          ) : (
            <>
              <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={queueBreakdown} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                      {queueBreakdown.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border p-2" style={{ borderColor: panelBorder }}>
                  <p style={{ color: secondaryTextColor }}>Approval rate</p>
                  <p className="text-lg font-bold" style={{ color: tertiaryColor }}>{stats.approvalRate}%</p>
                </div>
                <div className="rounded-lg border p-2" style={{ borderColor: panelBorder }}>
                  <p style={{ color: secondaryTextColor }}>Total processed</p>
                  <p className="text-lg font-bold" style={{ color: primaryTextColor }}>{stats.approvedTotal + stats.rejectedTotal}</p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2 rounded-xl border bg-white overflow-hidden" style={{ borderColor: panelBorder }}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: panelBorder }}>
            <div className="flex items-center gap-2">
              <Clock3 size={16} style={{ color: primaryColor }} />
              <h2 className="text-lg font-semibold" style={headingStyle}>Recent Activity</h2>
              {isRealtimeActive ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{ backgroundColor: withColorAlpha(tertiaryColor, 0.12), color: tertiaryColor }}
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse" style={{ backgroundColor: tertiaryColor }} />
                  Live feed
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => handleNavigate('quality-check')}
              className="inline-flex items-center gap-1 text-xs font-semibold"
              style={{ color: primaryColor }}
            >
              Go to Quality Check <ArrowRight size={12} />
            </button>
          </div>
          {!recentActivity.length ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: secondaryTextColor }}>
              No recent activity yet. Approvals, rejections, and finished wigs will appear here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead style={{ backgroundColor: withColorAlpha(primaryColor, 0.08) }}>
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Reference</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Action</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Detail</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recentActivity.map((row) => (
                    <tr key={row.id} className="border-t" style={{ borderColor: panelBorder }}>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: primaryTextColor }}>{row.code}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={statusBadgeStyle(row.status, primaryColor, tertiaryColor)}>
                          {row.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs" style={{ color: secondaryTextColor }}>{row.detail || '-'}</td>
                      <td className="px-4 py-3 text-xs" style={{ color: tertiaryTextColor }}>{formatRelative(row.updated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-xl border bg-white p-5 space-y-4" style={{ borderColor: panelBorder }}>
          <h2 className="text-lg font-semibold" style={headingStyle}>Quick Jump</h2>
          {[
            { id: 'quality-check', label: 'Quality Check', icon: ScanLine, accent: primaryColor, hint: `${stats.pendingQa + stats.awaitingIntake} in queue` },
            { id: 'bundling', label: 'Bundling', icon: Package, accent: primaryColor, hint: `${stats.draftBundles} drafts, ${stats.inProductionBundles} in production` },
            { id: 'wig-ai-studio', label: 'Wig Catalog Studio', icon: PackagePlus, accent: tertiaryColor, hint: `${stats.availableWigs} ready` },
            { id: 'reports', label: 'Reports', icon: CheckCircle2, accent: primaryColor, hint: 'Generate QA reports' },
          ].map(({ id, label, icon: Icon, accent, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => handleNavigate(id)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border bg-white px-3 py-2.5 text-left text-sm transition hover:bg-slate-50"
              style={{ borderColor: panelBorder }}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: withColorAlpha(accent, 0.12), color: accent }}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <p className="font-semibold" style={{ color: primaryTextColor }}>{label}</p>
                  <p className="truncate text-xs" style={{ color: tertiaryTextColor }}>{hint}</p>
                </div>
              </div>
              <ArrowRight size={14} style={{ color: tertiaryTextColor }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
