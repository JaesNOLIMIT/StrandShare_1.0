import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  HelpCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const HOSPITALS_TABLE = 'Hospitals';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
const RELEASE_SCHEDULES_TABLE = 'Release_Schedules';

const STATUS_LABELS = {
  pending: 'Pending',
  accepted_allocated: 'Accepted - Wig Allocated',
  accepted_no_wig: 'Accepted - No Wig Available',
  in_production: 'In Production',
  to_be_release: 'To Be Release',
  releasing: 'Releasing',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatusKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

function normalizeDecisionKey(value) {
  const key = normalizeStatusKey(value);

  if (['pending', 'pendinghospitalapproval', 'pendingapproval'].includes(key)) {
    return 'pending_hospital_approval';
  }

  if (['approved', 'hospitalapproved', 'hospitalapproval'].includes(key)) {
    return 'hospital_approved';
  }

  if (['reschedulerequested', 'hospitalreschedulerequested', 'reschedule'].includes(key)) {
    return 'hospital_reschedule_requested';
  }

  return '';
}

function getCanonicalStatusKey(statusValue) {
  const key = normalizeStatusKey(statusValue);

  if (['pendingreview', 'pending', 'pendingvalidation', 'pendingconfirmation'].includes(key)) {
    return 'pending';
  }

  if (['acceptedwithallocatedwig', 'acceptedallocatedwig', 'acceptedwigallocated', 'allocated', 'allocatedwig'].includes(key)) {
    return 'accepted_allocated';
  }

  if (['acceptedbutnowigavailable', 'acceptednowigavailable', 'nowigavailable', 'findingmatchingwig', 'formatching', 'matching', 'findingallocatingwig', 'findingandallocatingwig'].includes(key)) {
    return 'accepted_no_wig';
  }

  if (['inproduction', 'production', 'inprocess'].includes(key)) {
    return 'in_production';
  }

  if (['readyforevent', 'readyforrelease', 'readyforfitting', 'readyforhandingover', 'toberelease'].includes(key)) {
    return 'to_be_release';
  }

  if (['releasing', 'forrelease', 'releaseongoing'].includes(key)) {
    return 'releasing';
  }

  if (['completed', 'complete', 'released', 'releasecompleted', 'done'].includes(key)) {
    return 'completed';
  }

  if (['rejected', 'declined', 'denied'].includes(key)) {
    return 'rejected';
  }

  if (['cancelled', 'canceled', 'cancel'].includes(key)) {
    return 'cancelled';
  }

  return 'pending';
}

function getPatientUserName(userRow) {
  if (!userRow) {
    return '';
  }

  const details = Array.isArray(userRow.user_details)
    ? userRow.user_details[0]
    : userRow.user_details;

  const fullName = [details?.first_name, details?.middle_name, details?.last_name, details?.suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return fullName || String(userRow.email || '').trim() || '';
}

function getPatientFullName(patientRow, linkedUserRow = null) {
  if (!patientRow) {
    return 'Unknown Patient';
  }

  const linkedUserName = getPatientUserName(linkedUserRow);
  if (linkedUserName) {
    return linkedUserName;
  }

  return patientRow.Patient_Code || (patientRow.User_ID ? `User #${patientRow.User_ID}` : `Patient #${patientRow.Patient_ID}`);
}

function formatRequestCode(reqIdValue) {
  const reqId = Number(reqIdValue || 0);
  if (!reqId) {
    return 'WR-0000';
  }
  return `WR-${String(reqId).padStart(4, '0')}`;
}

function formatDateTime(value) {
  if (!value) {
    return 'N/A';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortDate(value) {
  if (!value) {
    return 'N/A';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  return parsed.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: '2-digit',
  });
}

function toWeekStart(dateValue) {
  const date = new Date(dateValue);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

function toWeekKey(dateValue) {
  const start = toWeekStart(dateValue);
  return start.toISOString().slice(0, 10);
}

function isMissingRelationError(rawMessage) {
  const message = String(rawMessage || '').toLowerCase();
  return message.includes('relation') && message.includes('does not exist');
}

function hexToRgba(hexValue, alpha = 1) {
  const safeHex = String(hexValue || '').trim();
  const hexMatch = safeHex.match(/^#([0-9a-f]{6})$/i);
  if (!hexMatch) {
    return `rgba(15, 23, 42, ${alpha})`;
  }

  const raw = hexMatch[1];
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function statusBadgeClass(statusKey) {
  if (statusKey === 'completed') return 'bg-emerald-100 text-emerald-700';
  if (statusKey === 'releasing') return 'bg-teal-100 text-teal-700';
  if (statusKey === 'to_be_release') return 'bg-indigo-100 text-indigo-700';
  if (statusKey === 'in_production') return 'bg-sky-100 text-sky-700';
  if (statusKey === 'accepted_allocated') return 'bg-green-100 text-green-700';
  if (statusKey === 'accepted_no_wig') return 'bg-lime-100 text-lime-700';
  if (statusKey === 'rejected') return 'bg-red-100 text-red-700';
  if (statusKey === 'cancelled') return 'bg-slate-200 text-slate-700';
  return 'bg-amber-100 text-amber-700';
}

export default function DashboardPage({ userProfile }) {
  const { theme } = useTheme();

  const [hospitalId, setHospitalId] = useState(null);
  const [hospitalName, setHospitalName] = useState('');
  const [requests, setRequests] = useState([]);
  const [patients, setPatients] = useState([]);
  const [patientUsersById, setPatientUsersById] = useState({});
  const [schedules, setSchedules] = useState([]);
  const [isResolvingHospital, setIsResolvingHospital] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isReleaseWorkflowAvailable, setIsReleaseWorkflowAvailable] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);

  const panelBorder = hexToRgba(theme.secondaryColor, 0.24);

  const resolveAssignedHospital = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      return;
    }

    const activeUserId = Number(userProfile?.user_id || 0);
    if (!activeUserId) {
      setHospitalId(null);
      setHospitalName('');
      setNotice({ kind: 'error', text: 'Unable to resolve your account ID. Please sign in again.' });
      return;
    }

    try {
      setIsResolvingHospital(true);
      const { data: staffRow, error: staffError } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .select('Hospital_ID')
        .eq('User_ID', activeUserId)
        .maybeSingle();

      if (staffError) {
        throw staffError;
      }

      const assignedHospitalId = Number(staffRow?.Hospital_ID || 0) || null;
      setHospitalId(assignedHospitalId);

      if (!assignedHospitalId) {
        setHospitalName('');
        setNotice({
          kind: 'error',
          text: 'No H-Representative assignment found for your account. Ask Admin to assign your account first.',
        });
        return;
      }

      const { data: hospitalRow } = await supabase
        .from(HOSPITALS_TABLE)
        .select('Hospital_Name')
        .eq('Hospital_ID', assignedHospitalId)
        .maybeSingle();

      setHospitalName(String(hospitalRow?.Hospital_Name || '').trim());
    } catch (error) {
      setHospitalId(null);
      setHospitalName('');
      setNotice({ kind: 'error', text: error.message || 'Unable to resolve your H-Representative assignment.' });
    } finally {
      setIsResolvingHospital(false);
    }
  }, [userProfile?.user_id]);

  const loadDashboard = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) {
      setRequests([]);
      setPatients([]);
      setPatientUsersById({});
      setSchedules([]);
      return;
    }

    try {
      setIsLoading(true);
      setNotice({ kind: '', text: '' });

      const [requestsRes, patientsRes] = await Promise.all([
        supabase
          .from(WIG_REQUESTS_TABLE)
          .select('Req_ID,Patient_ID,Status,Request_Date,Updated_At,Status_Reason')
          .eq('Hospital_ID', hospitalId)
          .order('Request_Date', { ascending: false }),
        supabase
          .from(PATIENTS_TABLE)
          .select('Patient_ID,Patient_Code,Medical_Condition,User_ID')
          .eq('Hospital_ID', hospitalId),
      ]);

      if (requestsRes.error) throw requestsRes.error;
      if (patientsRes.error) throw patientsRes.error;

      const linkedUserIds = Array.from(
        new Set(
          (patientsRes.data || [])
            .map((row) => Number(row.User_ID || 0))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      let nextPatientUsersById = {};

      if (linkedUserIds.length > 0) {
        const { data: patientUsers, error: patientUsersError } = await supabase
          .from(USERS_TABLE)
          .select(`
            user_id,
            email,
            user_details:user_details (
              first_name,
              middle_name,
              last_name,
              suffix
            )
          `)
          .in('user_id', linkedUserIds);

        if (patientUsersError) throw patientUsersError;

        nextPatientUsersById = (patientUsers || []).reduce((accumulator, row) => {
          accumulator[Number(row.user_id)] = row;
          return accumulator;
        }, {});
      }

      const requestIds = Array.from(
        new Set(
          (requestsRes.data || [])
            .map((row) => Number(row.Req_ID || 0))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      const schedulesRes = requestIds.length > 0
        ? await supabase
            .from(RELEASE_SCHEDULES_TABLE)
            .select('Release_Schedule_ID,Req_ID,Proposed_Release_Date,Hospital_Decision,Hospital_Decision_Reason,Is_Current,Created_At,Updated_At')
            .in('Req_ID', requestIds)
            .order('Created_At', { ascending: false })
        : { data: [], error: null };

      let fetchedSchedules = [];
      let releaseWorkflowAvailable = true;

      if (schedulesRes.error) {
        if (isMissingRelationError(schedulesRes.error.message)) {
          releaseWorkflowAvailable = false;
        } else {
          throw schedulesRes.error;
        }
      } else {
        fetchedSchedules = schedulesRes.data || [];
      }

      setIsReleaseWorkflowAvailable(releaseWorkflowAvailable);
      setRequests(requestsRes.data || []);
      setPatients(patientsRes.data || []);
      setPatientUsersById(nextPatientUsersById);
      setSchedules(fetchedSchedules);
      setLastRefreshedAt(new Date().toISOString());

      if (!releaseWorkflowAvailable) {
        setNotice({
          kind: 'warning',
          text: 'Release scheduling data is unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.',
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load dashboard data.' });
    } finally {
      setIsLoading(false);
    }
  }, [hospitalId]);

  useEffect(() => {
    resolveAssignedHospital();
  }, [resolveAssignedHospital]);

  useEffect(() => {
    if (!hospitalId) {
      setRequests([]);
      setPatients([]);
      setPatientUsersById({});
      setSchedules([]);
      return;
    }

    loadDashboard();
  }, [hospitalId, loadDashboard]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) return undefined;

    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void loadDashboard(), 250);
    };
    const fallbackInterval = setInterval(() => void loadDashboard(), 30000);
    const channel = supabase
      .channel(`public:h-representative-dashboard-live:${hospitalId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIG_REQUESTS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: PATIENTS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: RELEASE_SCHEDULES_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: HOSPITAL_STAFF_TABLE }, scheduleRefresh)
      .subscribe((status) => setIsRealtimeActive(status === 'SUBSCRIBED'));

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(fallbackInterval);
      setIsRealtimeActive(false);
      supabase.removeChannel(channel);
    };
  }, [hospitalId, loadDashboard]);

  const patientById = useMemo(() => {
    return new Map(patients.map((row) => [Number(row.Patient_ID || 0), row]));
  }, [patients]);

  const currentScheduleByReqId = useMemo(() => {
    const map = new Map();

    schedules
      .filter((row) => Boolean(row.Is_Current) && Number(row.Req_ID || 0) > 0)
      .forEach((row) => {
        map.set(Number(row.Req_ID), row);
      });

    return map;
  }, [schedules]);

  const requestRows = useMemo(() => {
    return requests.map((row) => {
      const reqId = Number(row.Req_ID || 0);
      const patient = patientById.get(Number(row.Patient_ID || 0)) || null;
      const linkedPatientUser = patient ? patientUsersById[Number(patient.User_ID || 0)] : null;
      const statusKey = getCanonicalStatusKey(row.Status);
      const currentSchedule = currentScheduleByReqId.get(reqId) || null;
      const decisionKey = normalizeDecisionKey(currentSchedule?.Hospital_Decision);
      const releaseDate = currentSchedule?.Proposed_Release_Date || null;

      return {
        reqId,
        requestId: formatRequestCode(reqId),
        patientName: getPatientFullName(patient, linkedPatientUser),
        patientCode: String(patient?.Patient_Code || '').trim(),
        medicalCondition: String(patient?.Medical_Condition || '').trim() || 'N/A',
        statusKey,
        statusLabel: STATUS_LABELS[statusKey] || STATUS_LABELS.pending,
        requestDate: row.Request_Date,
        updatedAt: row.Updated_At || row.Request_Date,
        statusReason: String(row.Status_Reason || '').trim(),
        releaseDate,
        releaseDecisionKey: decisionKey,
        releaseDecisionReason: String(currentSchedule?.Hospital_Decision_Reason || '').trim(),
      };
    });
  }, [requests, patientById, patientUsersById, currentScheduleByReqId]);

  const nowDate = useMemo(() => {
    if (!lastRefreshedAt) {
      return new Date();
    }

    const parsed = new Date(lastRefreshedAt);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [lastRefreshedAt]);

  const kpiCards = useMemo(() => {
    const startOfCurrentWeek = toWeekStart(nowDate);

    const requestedThisWeek = requestRows.filter((row) => {
      if (!row.requestDate) return false;
      const requestDate = new Date(row.requestDate);
      return requestDate >= startOfCurrentWeek;
    }).length;

    const pendingApproval = requestRows.filter(
      (row) => row.releaseDecisionKey === 'pending_hospital_approval' || (row.statusKey === 'to_be_release' && !row.releaseDecisionKey),
    ).length;
    const activeReleasing = requestRows.filter((row) => row.statusKey === 'releasing').length;
    const overdueReleases = requestRows.filter((row) => {
      if (!row.releaseDate) return false;
      const releaseDate = new Date(row.releaseDate);
      const stillOpen = row.statusKey !== 'completed' && row.statusKey !== 'rejected' && row.statusKey !== 'cancelled';
      return stillOpen && releaseDate < nowDate;
    }).length;

    return [
      { label: 'Total Patients', value: String(patients.length), helper: `${requestRows.length} wig requests`, accent: theme.primaryColor },
      { label: 'Pending Review', value: String(requestRows.filter((row) => row.statusKey === 'pending').length), helper: `${requestedThisWeek} requested this week`, accent: '#f59e0b' },
      { label: 'Pending Approval', value: String(pendingApproval), helper: 'Release decisions needed', accent: theme.secondaryColor },
      { label: 'Ready For Release', value: String(requestRows.filter((row) => row.statusKey === 'to_be_release').length), helper: `${activeReleasing} currently releasing`, accent: theme.primaryColor },
      { label: 'Completed', value: String(requestRows.filter((row) => row.statusKey === 'completed').length), helper: overdueReleases > 0 ? `${overdueReleases} overdue releases` : 'No overdue releases', accent: overdueReleases > 0 ? '#dc2626' : '#15803d' },
    ];
  }, [requestRows, patients.length, nowDate, theme.primaryColor, theme.secondaryColor]);

  const weeklyTrend = useMemo(() => {
    const buckets = [];
    const start = toWeekStart(nowDate);
    start.setDate(start.getDate() - 35);

    for (let i = 0; i < 6; i += 1) {
      const bucketDate = new Date(start);
      bucketDate.setDate(start.getDate() + i * 7);
      const key = bucketDate.toISOString().slice(0, 10);
      buckets.push({
        key,
        week: bucketDate.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit' }),
        requested: 0,
        completed: 0,
      });
    }

    const bucketByKey = new Map(buckets.map((item) => [item.key, item]));

    requestRows.forEach((row) => {
      if (row.requestDate) {
        const requestedWeek = toWeekKey(row.requestDate);
        const requestedBucket = bucketByKey.get(requestedWeek);
        if (requestedBucket) {
          requestedBucket.requested += 1;
        }
      }

      if (row.statusKey === 'completed' && row.updatedAt) {
        const completedWeek = toWeekKey(row.updatedAt);
        const completedBucket = bucketByKey.get(completedWeek);
        if (completedBucket) {
          completedBucket.completed += 1;
        }
      }
    });

    return buckets;
  }, [requestRows, nowDate]);

  const statusDistribution = useMemo(() => {
    const order = [
      'pending',
      'accepted_allocated',
      'accepted_no_wig',
      'in_production',
      'to_be_release',
      'releasing',
      'completed',
      'rejected',
      'cancelled',
    ];

    return order
      .map((key) => ({
        key,
        name: STATUS_LABELS[key],
        value: requestRows.filter((row) => row.statusKey === key).length,
      }))
      .filter((item) => item.value > 0);
  }, [requestRows]);

  const pendingApprovals = useMemo(() => {
    return requestRows
      .filter(
        (row) => row.releaseDecisionKey === 'pending_hospital_approval' || (row.statusKey === 'to_be_release' && !row.releaseDecisionKey),
      )
      .sort((a, b) => {
        const left = a.releaseDate ? new Date(a.releaseDate).getTime() : Number.MAX_SAFE_INTEGER;
        const right = b.releaseDate ? new Date(b.releaseDate).getTime() : Number.MAX_SAFE_INTEGER;
        return left - right;
      })
      .slice(0, 6);
  }, [requestRows]);

  const upcomingReleases = useMemo(() => {
    return requestRows
      .filter((row) => {
        if (!row.releaseDate) return false;
        const releaseDate = new Date(row.releaseDate);
        const isInPipeline = row.statusKey === 'to_be_release' || row.statusKey === 'releasing';
        return isInPipeline && releaseDate >= toWeekStart(nowDate);
      })
      .sort((a, b) => new Date(a.releaseDate).getTime() - new Date(b.releaseDate).getTime())
      .slice(0, 6);
  }, [requestRows, nowDate]);

  const recentUpdates = useMemo(() => {
    const requestEvents = requestRows.map((row) => ({
      time: row.updatedAt || row.requestDate,
      title: `${row.requestId} Â· ${row.statusLabel}`,
      subtitle: row.patientName,
      source: 'Request Status',
    }));

    const scheduleEvents = schedules
      .filter((row) => Number(row.Req_ID || 0) > 0)
      .map((row) => {
        const reqId = Number(row.Req_ID || 0);
        const decisionKey = normalizeDecisionKey(row.Hospital_Decision);
        const requestRow = requestRows.find((item) => item.reqId === reqId);

        return {
          time: row.Updated_At || row.Created_At,
          title: `${formatRequestCode(reqId)} Â· ${decisionKey ? decisionKey.replace(/_/g, ' ') : 'decision updated'}`,
          subtitle: requestRow?.patientName || 'Release workflow activity',
          source: 'Release Approval',
        };
      });

    return [...requestEvents, ...scheduleEvents]
      .filter((item) => item.time)
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 8);
  }, [requestRows, schedules]);

  const stageColors = [
    hexToRgba(theme.primaryColor, 0.86),
    hexToRgba(theme.secondaryColor, 0.84),
    hexToRgba(theme.tertiaryColor, 0.88),
    hexToRgba(theme.primaryColor, 0.6),
    hexToRgba(theme.secondaryColor, 0.62),
    hexToRgba(theme.tertiaryColor, 0.62),
    hexToRgba(theme.primaryColor, 0.42),
    hexToRgba(theme.secondaryColor, 0.42),
    hexToRgba(theme.tertiaryColor, 0.42),
  ];

  return (
    <div className="space-y-4">
      <header>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="role-page-title text-2xl font-bold" style={{ color: theme.primaryTextColor }}>
              H-Representative Dashboard
            </h1>
            <p className="text-sm" style={{ color: theme.secondaryTextColor }}>
              Patient requests, hospital approvals, and wig releases at a glance.
            </p>
            <p className="mt-1 text-xs" style={{ color: theme.tertiaryTextColor }}>
              {hospitalName || (hospitalId ? `Hospital #${hospitalId}` : 'No hospital assigned')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold sm:inline-flex" style={{ borderColor: hexToRgba(isRealtimeActive ? '#15803d' : theme.secondaryColor, 0.3), color: isRealtimeActive ? '#15803d' : theme.secondaryTextColor }}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: isRealtimeActive ? '#15803d' : theme.secondaryColor }} />
              {isRealtimeActive ? 'Live' : 'Connecting'}
            </span>
            <div className="relative">
              <button
                type="button"
                aria-label="About the H-Representative dashboard"
                aria-expanded={isInfoOpen}
                onClick={() => setIsInfoOpen((open) => !open)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border bg-white transition hover:shadow-sm"
                style={{ borderColor: panelBorder, color: theme.primaryColor }}
              >
                <HelpCircle size={16} />
              </button>
              {isInfoOpen && (
                <div className="absolute right-0 top-11 z-30 w-72 rounded-xl border bg-white p-3 text-left shadow-xl" style={{ borderColor: panelBorder }}>
                  <p className="text-xs font-bold" style={{ color: theme.primaryTextColor }}>About this dashboard</p>
                  <p className="mt-1 text-[10px] leading-relaxed" style={{ color: theme.secondaryTextColor }}>
                    Live data for your assigned hospital only: patients, wig requests, release approvals, and schedules.
                  </p>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={loadDashboard}
              disabled={isResolvingHospital || isLoading || !hospitalId}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {(isResolvingHospital || isLoading) ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>
        </div>

        {notice.text && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-sm font-medium ${
              notice.kind === 'error'
                ? 'border-red-200 bg-red-50 text-red-800'
                : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            {notice.text}
          </div>
        )}
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {kpiCards.map((card) => (
          <article key={card.label} className="flex min-h-[124px] flex-col rounded-xl border bg-white p-4" style={{ borderColor: panelBorder }}>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: card.accent }} />
              <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: theme.tertiaryTextColor }}>{card.label}</p>
            </div>
            <p className="mt-3 text-3xl font-bold leading-none" style={{ color: theme.primaryTextColor }}>{card.value}</p>
            <p className="mt-auto pt-3 text-[11px]" style={{ color: theme.secondaryTextColor }}>{card.helper}</p>
          </article>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <article className="rounded-xl border bg-white p-3 xl:col-span-7" style={{ borderColor: panelBorder }}>
          <h2 className="text-sm font-semibold" style={{ color: theme.primaryTextColor }}>6-Week Request vs Completed Trend</h2>
          <div className="mt-2 h-64 w-full">
            <ResponsiveContainer>
              <LineChart data={weeklyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke={hexToRgba(theme.secondaryColor, 0.24)} />
                <XAxis dataKey="week" stroke={theme.secondaryTextColor} fontSize={11} />
                <YAxis stroke={theme.secondaryTextColor} fontSize={11} />
                <Tooltip />
                <Line type="monotone" dataKey="requested" name="Requested" stroke={theme.primaryColor} strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="completed" name="Completed" stroke={theme.tertiaryColor} strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="rounded-xl border bg-white p-3 xl:col-span-5" style={{ borderColor: panelBorder }}>
          <h2 className="text-sm font-semibold" style={{ color: theme.primaryTextColor }}>Current Status Distribution</h2>
          {statusDistribution.length === 0 ? (
            <div className="mt-8 rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
              No request data yet.
            </div>
          ) : (
            <>
              <div className="mt-1 h-44 w-full">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={statusDistribution}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={42}
                      outerRadius={66}
                      paddingAngle={2}
                    >
                      {statusDistribution.map((item, index) => (
                        <Cell key={item.key} fill={stageColors[index % stageColors.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <ul className="space-y-1.5 text-[11px]">
                {statusDistribution.map((item, index) => (
                  <li key={item.key} className="flex items-center justify-between" style={{ color: theme.secondaryTextColor }}>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: stageColors[index % stageColors.length] }} />
                      {item.name}
                    </span>
                    <span className="font-semibold" style={{ color: theme.primaryTextColor }}>{item.value}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      </section>

      <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <article className="rounded-xl border bg-white p-3 xl:col-span-4" style={{ borderColor: panelBorder }}>
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: theme.primaryTextColor }}>
            <AlertTriangle size={15} /> Needs Action
          </h2>
          <ul className="mt-2 space-y-2">
            {pendingApprovals.length === 0 ? (
              <li className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500">
                No pending release approvals.
              </li>
            ) : (
              pendingApprovals.map((row) => (
                <li key={`pending-${row.reqId}`} className="rounded-lg border px-3 py-2" style={{ borderColor: hexToRgba(theme.secondaryColor, 0.25), backgroundColor: hexToRgba(theme.secondaryColor, 0.06) }}>
                  <p className="text-xs font-semibold" style={{ color: theme.primaryTextColor }}>{row.requestId} Â· {row.patientName}</p>
                  <p className="mt-0.5 text-[11px]" style={{ color: theme.secondaryTextColor }}>
                    Proposed release: {formatDateTime(row.releaseDate)}
                  </p>
                </li>
              ))
            )}
          </ul>

          {!isReleaseWorkflowAvailable && (
            <p className="mt-2 text-[11px] text-amber-700">
              Release workflow table not available in this environment.
            </p>
          )}
        </article>

        <article className="rounded-xl border bg-white p-3 xl:col-span-4" style={{ borderColor: panelBorder }}>
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: theme.primaryTextColor }}>
            <CalendarClock size={15} /> Upcoming Releases
          </h2>
          <ul className="mt-2 space-y-2">
            {upcomingReleases.length === 0 ? (
              <li className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500">
                No upcoming release schedule in queue.
              </li>
            ) : (
              upcomingReleases.map((row) => (
                <li key={`release-${row.reqId}`} className="rounded-lg border px-3 py-2" style={{ borderColor: hexToRgba(theme.primaryColor, 0.22), backgroundColor: hexToRgba(theme.primaryColor, 0.05) }}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold" style={{ color: theme.primaryTextColor }}>{row.requestId}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(row.statusKey)}`}>
                      {row.statusLabel}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px]" style={{ color: theme.secondaryTextColor }}>
                    {row.patientName} Â· {formatShortDate(row.releaseDate)}
                  </p>
                </li>
              ))
            )}
          </ul>
        </article>

        <article className="rounded-xl border bg-white p-3 xl:col-span-4" style={{ borderColor: panelBorder }}>
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: theme.primaryTextColor }}>
            <ClipboardList size={15} /> Recent Activity
          </h2>
          <ul className="mt-2 space-y-2">
            {recentUpdates.length === 0 ? (
              <li className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500">
                No recent updates yet.
              </li>
            ) : (
              recentUpdates.map((item) => (
                <li key={`${item.time}-${item.title}`} className="rounded-lg border px-3 py-2" style={{ borderColor: hexToRgba(theme.tertiaryColor, 0.25), backgroundColor: hexToRgba(theme.tertiaryColor, 0.07) }}>
                  <p className="text-[10px] font-semibold uppercase" style={{ color: theme.secondaryTextColor }}>
                    {formatDateTime(item.time)} Â· {item.source}
                  </p>
                  <p className="mt-0.5 text-[11px] font-semibold" style={{ color: theme.primaryTextColor }}>{item.title}</p>
                  <p className="text-[11px]" style={{ color: theme.tertiaryTextColor }}>{item.subtitle}</p>
                </li>
              ))
            )}
          </ul>
        </article>
      </section>
    </div>
  );
}
