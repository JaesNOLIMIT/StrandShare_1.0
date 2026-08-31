import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
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
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const HOSPITALS_TABLE = 'Hospitals';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
const RELEASE_SCHEDULES_TABLE = 'Release_Schedules';

const SCHEDULES_STORAGE_KEY = 'Donivra.hrep.report.schedules';
const HISTORY_STORAGE_KEY = 'Donivra.hrep.report.history';

const tabs = [
  { id: 'quick', label: 'Quick Generate' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'history', label: 'History' },
];

const STATUS_OPTIONS = [
  { id: 'all', label: 'All Statuses' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted_allocated', label: 'Accepted - Wig Allocated' },
  { id: 'accepted_no_wig', label: 'Accepted - No Wig Available' },
  { id: 'in_production', label: 'In Production' },
  { id: 'to_be_release', label: 'To Be Release' },
  { id: 'releasing', label: 'Releasing' },
  { id: 'completed', label: 'Completed' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'cancelled', label: 'Cancelled' },
];

const REPORT_TEMPLATES = [
  {
    id: 'patient_registry',
    name: 'Patient Registry',
    description: 'Export the hospital patient directory and medical intake summary.',
    defaultFormat: 'csv',
    availableFormats: ['csv', 'pdf'],
    cadenceHint: 'Weekly or Monthly',
  },
  {
    id: 'request_intake',
    name: 'Request Intake Summary',
    description: 'Track request volume and per-case status movement.',
    defaultFormat: 'csv',
    availableFormats: ['csv', 'pdf'],
    cadenceHint: 'Daily or Weekly',
  },
  {
    id: 'status_distribution',
    name: 'Patient Status Distribution',
    description: 'See current status mix and concentration of active cases.',
    defaultFormat: 'csv',
    availableFormats: ['csv', 'pdf'],
    cadenceHint: 'Weekly',
  },
  {
    id: 'release_pipeline',
    name: 'Release Pipeline Report',
    description: 'Monitor approval queue, release readiness, and decision notes.',
    defaultFormat: 'pdf',
    availableFormats: ['csv', 'pdf'],
    cadenceHint: 'Daily',
  },
  {
    id: 'turnaround_sla',
    name: 'Turnaround & SLA Report',
    description: 'Measure completion speed, overdue items, and aging requests.',
    defaultFormat: 'pdf',
    availableFormats: ['csv', 'pdf'],
    cadenceHint: 'Monthly',
  },
];

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

function readLocalJson(key, fallbackValue) {
  if (typeof window === 'undefined') {
    return fallbackValue;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallbackValue;
    }

    const parsed = JSON.parse(raw);
    return parsed ?? fallbackValue;
  } catch {
    return fallbackValue;
  }
}

function writeLocalJson(key, value) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore persistence failures.
  }
}

function createDefaultSchedules() {
  return [];
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function parseRecipientEmails(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
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

function getDecisionLabel(decisionKey) {
  if (decisionKey === 'pending_hospital_approval') return 'Pending H-Representative Approval';
  if (decisionKey === 'hospital_approved') return 'H-Representative Approved';
  if (decisionKey === 'hospital_reschedule_requested') return 'H-Representative Reschedule Requested';
  return 'N/A';
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

function getPatientUserDetails(userRow) {
  if (!userRow) return null;
  return Array.isArray(userRow.user_details) ? userRow.user_details[0] : userRow.user_details;
}

function computeAge(birthdateValue) {
  if (!birthdateValue) return 'N/A';
  const birthdate = new Date(birthdateValue);
  if (Number.isNaN(birthdate.getTime())) return 'N/A';

  const today = new Date();
  let age = today.getFullYear() - birthdate.getFullYear();
  const monthDifference = today.getMonth() - birthdate.getMonth();
  if (monthDifference < 0 || (monthDifference === 0 && today.getDate() < birthdate.getDate())) age -= 1;
  return age >= 0 && age <= 130 ? String(age) : 'N/A';
}

function formatDateOnly(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
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

function isMissingRelationError(rawMessage) {
  const message = String(rawMessage || '').toLowerCase();
  return message.includes('relation') && message.includes('does not exist');
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

function dateDiffInDays(startValue, endValue) {
  if (!startValue || !endValue) {
    return null;
  }

  const start = new Date(startValue);
  const end = new Date(endValue);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  return Math.max(0, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function createCsvContent(payload) {
  const lines = [];

  lines.push(csvEscape(payload.title));
  lines.push(csvEscape(payload.subtitle));
  lines.push('');
  lines.push('Summary');

  payload.summary.forEach((item) => {
    lines.push(`${csvEscape(item.label)},${csvEscape(item.value)}`);
  });

  lines.push('');
  lines.push(payload.columns.map((column) => csvEscape(column.label)).join(','));

  payload.rows.forEach((row) => {
    lines.push(payload.columns.map((column) => csvEscape(row[column.key] ?? '')).join(','));
  });

  return lines.join('\n');
}

function downloadTextFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function createFileName(prefix, extension) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}_${stamp}.${extension}`;
}

function computeNextRun(cadence, timeValue) {
  const now = new Date();
  const [hourRaw, minuteRaw] = String(timeValue || '07:00').split(':');
  const hour = Number(hourRaw || 7);
  const minute = Number(minuteRaw || 0);

  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (cadence === 'daily') {
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  if (cadence === 'weekly') {
    const day = next.getDay();
    const offset = (1 - day + 7) % 7;
    next.setDate(next.getDate() + offset);
    if (offset === 0 && next <= now) {
      next.setDate(next.getDate() + 7);
    }
    return next;
  }

  next.setDate(1);
  if (next <= now) {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

function cadenceLabel(cadence) {
  if (cadence === 'daily') return 'Daily';
  if (cadence === 'weekly') return 'Weekly (Mon)';
  return 'Monthly (1st day)';
}

function tabClass(isActive) {
  return isActive
    ? 'rounded-lg border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white'
    : 'rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50';
}

function scheduleStatusClass(status) {
  if (status === 'Active') return 'bg-emerald-100 text-emerald-700';
  if (status === 'Paused') return 'bg-amber-100 text-amber-700';
  return 'bg-slate-100 text-slate-700';
}

export default function GenerateReportsPage({ userProfile }) {
  const [activeTab, setActiveTab] = useState('quick');

  const [hospitalId, setHospitalId] = useState(null);
  const [hospitalName, setHospitalName] = useState('');

  const [requests, setRequests] = useState([]);
  const [patients, setPatients] = useState([]);
  const [patientUsersById, setPatientUsersById] = useState({});
  const [schedules, setSchedules] = useState([]);

  const [isResolvingHospital, setIsResolvingHospital] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isReleaseWorkflowAvailable, setIsReleaseWorkflowAvailable] = useState(true);

  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  const [selectedTemplateId, setSelectedTemplateId] = useState(REPORT_TEMPLATES[0].id);

  const storageScope = String(userProfile?.user_id || 'anonymous');
  const schedulesStorageKey = `${SCHEDULES_STORAGE_KEY}.${storageScope}`;
  const historyStorageKey = `${HISTORY_STORAGE_KEY}.${storageScope}`;
  const [scheduledReports, setScheduledReports] = useState(() => readLocalJson(schedulesStorageKey, createDefaultSchedules()));
  const [generatedHistory, setGeneratedHistory] = useState(() => readLocalJson(historyStorageKey, []));

  const [scheduleForm, setScheduleForm] = useState({
    title: '',
    templateId: REPORT_TEMPLATES[0].id,
    cadence: 'weekly',
    time: '07:00',
    format: REPORT_TEMPLATES[0].defaultFormat,
    recipients: '',
  });

  useEffect(() => {
    writeLocalJson(schedulesStorageKey, scheduledReports);
  }, [scheduledReports, schedulesStorageKey]);

  useEffect(() => {
    writeLocalJson(historyStorageKey, generatedHistory);
  }, [generatedHistory, historyStorageKey]);

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

      if (staffError) throw staffError;

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

  const loadReportData = useCallback(async () => {
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
          .select('Patient_ID,Patient_Code,Medical_Condition,User_ID,Date_of_Diagnosis,Guardian,Guardian_Contact_Number,Created_At')
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
              suffix,
              birthdate,
              gender,
              contact_number
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

      let releaseWorkflowAvailable = true;
      let fetchedSchedules = [];

      if (schedulesRes.error) {
        if (isMissingRelationError(schedulesRes.error.message)) {
          releaseWorkflowAvailable = false;
        } else {
          throw schedulesRes.error;
        }
      } else {
        fetchedSchedules = schedulesRes.data || [];
      }

      setRequests(requestsRes.data || []);
      setPatients(patientsRes.data || []);
      setPatientUsersById(nextPatientUsersById);
      setSchedules(fetchedSchedules);
      setIsReleaseWorkflowAvailable(releaseWorkflowAvailable);
      setLastRefreshedAt(new Date().toISOString());

      if (!releaseWorkflowAvailable) {
        setNotice({
          kind: 'warning',
          text: 'Release_Schedules table is not available. Approval-specific report fields are limited.',
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load report data.' });
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

    loadReportData();
  }, [hospitalId, loadReportData]);

  const patientById = useMemo(() => {
    return new Map(patients.map((row) => [Number(row.Patient_ID || 0), row]));
  }, [patients]);

  const patientReportRows = useMemo(() => {
    return patients.map((patient) => {
      const linkedUser = patientUsersById[Number(patient.User_ID || 0)] || null;
      const details = getPatientUserDetails(linkedUser);

      return {
        patientId: Number(patient.Patient_ID || 0),
        patientCode: String(patient.Patient_Code || `Patient #${patient.Patient_ID}`).trim(),
        patientName: getPatientFullName(patient, linkedUser),
        email: String(linkedUser?.email || '').trim() || 'N/A',
        age: computeAge(details?.birthdate),
        gender: String(details?.gender || '').trim() || 'N/A',
        contactNumber: String(details?.contact_number || '').trim() || 'N/A',
        medicalCondition: String(patient.Medical_Condition || '').trim() || 'N/A',
        diagnosisDate: patient.Date_of_Diagnosis || null,
        guardian: String(patient.Guardian || '').trim() || 'N/A',
        guardianContact: String(patient.Guardian_Contact_Number || '').trim() || 'N/A',
        registeredAt: patient.Created_At || null,
      };
    });
  }, [patients, patientUsersById]);

  const currentScheduleByReqId = useMemo(() => {
    const map = new Map();

    schedules
      .filter((row) => Boolean(row.Is_Current) && Number(row.Req_ID || 0) > 0)
      .forEach((row) => {
        map.set(Number(row.Req_ID), row);
      });

    return map;
  }, [schedules]);

  const reportRows = useMemo(() => {
    return requests.map((requestRow) => {
      const reqId = Number(requestRow.Req_ID || 0);
      const patient = patientById.get(Number(requestRow.Patient_ID || 0)) || null;
      const linkedPatientUser = patient ? patientUsersById[Number(patient.User_ID || 0)] : null;
      const statusKey = getCanonicalStatusKey(requestRow.Status);
      const currentSchedule = currentScheduleByReqId.get(reqId) || null;
      const decisionKey = normalizeDecisionKey(currentSchedule?.Hospital_Decision);

      return {
        reqId,
        requestId: formatRequestCode(reqId),
        patientName: getPatientFullName(patient, linkedPatientUser),
        patientCode: String(patient?.Patient_Code || '').trim(),
        medicalCondition: String(patient?.Medical_Condition || '').trim() || 'N/A',
        statusKey,
        statusLabel: STATUS_LABELS[statusKey] || STATUS_LABELS.pending,
        requestDate: requestRow.Request_Date,
        updatedAt: requestRow.Updated_At || requestRow.Request_Date,
        releaseDate: currentSchedule?.Proposed_Release_Date || null,
        statusReason: String(requestRow.Status_Reason || '').trim(),
        releaseDecisionKey: decisionKey,
        releaseDecisionLabel: getDecisionLabel(decisionKey),
        releaseDecisionReason: String(currentSchedule?.Hospital_Decision_Reason || '').trim(),
      };
    });
  }, [requests, patientById, patientUsersById, currentScheduleByReqId]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = normalizeText(searchTerm);

    return reportRows.filter((row) => {
      if (statusFilter !== 'all' && row.statusKey !== statusFilter) {
        return false;
      }

      if (dateFrom) {
        const fromDate = new Date(`${dateFrom}T00:00:00`);
        const requestDate = row.requestDate ? new Date(row.requestDate) : null;
        if (!requestDate || requestDate < fromDate) {
          return false;
        }
      }

      if (dateTo) {
        const toDate = new Date(`${dateTo}T23:59:59`);
        const requestDate = row.requestDate ? new Date(row.requestDate) : null;
        if (!requestDate || requestDate > toDate) {
          return false;
        }
      }

      if (!normalizedQuery) {
        return true;
      }

      const blob = [
        row.requestId,
        row.patientName,
        row.patientCode,
        row.medicalCondition,
        row.statusLabel,
        row.releaseDecisionLabel,
        row.statusReason,
        row.releaseDecisionReason,
      ]
        .map(normalizeText)
        .filter(Boolean)
        .join(' ');

      return blob.includes(normalizedQuery);
    });
  }, [reportRows, statusFilter, dateFrom, dateTo, searchTerm]);

  const filteredPatientRows = useMemo(() => {
    const normalizedQuery = normalizeText(searchTerm);

    return patientReportRows.filter((row) => {
      if (dateFrom) {
        const fromDate = new Date(`${dateFrom}T00:00:00`);
        const registeredAt = row.registeredAt ? new Date(row.registeredAt) : null;
        if (!registeredAt || registeredAt < fromDate) return false;
      }

      if (dateTo) {
        const toDate = new Date(`${dateTo}T23:59:59`);
        const registeredAt = row.registeredAt ? new Date(row.registeredAt) : null;
        if (!registeredAt || registeredAt > toDate) return false;
      }

      if (!normalizedQuery) return true;

      return [
        row.patientCode,
        row.patientName,
        row.email,
        row.gender,
        row.contactNumber,
        row.medicalCondition,
        row.guardian,
      ]
        .map(normalizeText)
        .filter(Boolean)
        .join(' ')
        .includes(normalizedQuery);
    });
  }, [patientReportRows, dateFrom, dateTo, searchTerm]);

  const statusDistribution = useMemo(() => {
    return STATUS_OPTIONS
      .filter((option) => option.id !== 'all')
      .map((option) => ({
        key: option.id,
        name: option.label,
        value: filteredRows.filter((row) => row.statusKey === option.id).length,
      }))
      .filter((row) => row.value > 0);
  }, [filteredRows]);

  const trendSeries = useMemo(() => {
    const now = new Date();
    const buckets = [];
    const start = toWeekStart(now);
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

    const byKey = new Map(buckets.map((row) => [row.key, row]));

    filteredRows.forEach((row) => {
      if (row.requestDate) {
        const requestedKey = toWeekKey(row.requestDate);
        const requestedBucket = byKey.get(requestedKey);
        if (requestedBucket) {
          requestedBucket.requested += 1;
        }
      }

      if (row.statusKey === 'completed' && row.updatedAt) {
        const completedKey = toWeekKey(row.updatedAt);
        const completedBucket = byKey.get(completedKey);
        if (completedBucket) {
          completedBucket.completed += 1;
        }
      }
    });

    return buckets;
  }, [filteredRows]);

  const reportSummary = useMemo(() => {
    const pendingReview = filteredRows.filter((row) => row.statusKey === 'pending').length;

    return [
      { label: 'Hospital Patients', value: String(patients.length) },
      { label: 'Wig Requests', value: String(reportRows.length) },
      { label: 'Pending Review', value: String(pendingReview) },
      { label: 'Exports', value: String(generatedHistory.length) },
    ];
  }, [generatedHistory, filteredRows, patients.length, reportRows.length]);

  const activeTemplate = useMemo(() => {
    return REPORT_TEMPLATES.find((template) => template.id === selectedTemplateId) || REPORT_TEMPLATES[0];
  }, [selectedTemplateId]);

  const buildReportPayload = useCallback((templateId, sourceRows) => {
    const generatedAt = new Date();
    const baseSubtitle = `Scope: ${hospitalName || (hospitalId ? `H-Representative #${hospitalId}` : 'Not assigned')} | Generated: ${formatDateTime(generatedAt.toISOString())}`;

    if (templateId === 'patient_registry') {
      const withMedicalCondition = sourceRows.filter((row) => row.medicalCondition !== 'N/A').length;
      const withGuardian = sourceRows.filter((row) => row.guardian !== 'N/A').length;

      return {
        filePrefix: 'Patient_Registry',
        title: 'Hospital Patient Registry',
        subtitle: baseSubtitle,
        summary: [
          { label: 'Total Patients', value: String(sourceRows.length) },
          { label: 'With Medical Condition', value: String(withMedicalCondition) },
          { label: 'With Guardian Details', value: String(withGuardian) },
        ],
        columns: [
          { key: 'patientCode', label: 'Patient Code' },
          { key: 'patientName', label: 'Patient Name' },
          { key: 'age', label: 'Age' },
          { key: 'gender', label: 'Gender' },
          { key: 'medicalCondition', label: 'Medical Condition' },
          { key: 'diagnosisDateLabel', label: 'Diagnosis Date' },
          { key: 'contactNumber', label: 'Contact' },
          { key: 'registeredAtLabel', label: 'Registered' },
        ],
        rows: sourceRows.map((row) => ({
          patientCode: row.patientCode,
          patientName: row.patientName,
          age: row.age,
          gender: row.gender,
          medicalCondition: row.medicalCondition,
          diagnosisDateLabel: formatDateOnly(row.diagnosisDate),
          contactNumber: row.contactNumber,
          registeredAtLabel: formatDateTime(row.registeredAt),
        })),
      };
    }

    if (templateId === 'status_distribution') {
      const grouped = STATUS_OPTIONS
        .filter((option) => option.id !== 'all')
        .map((option) => {
          const count = sourceRows.filter((row) => row.statusKey === option.id).length;
          const share = sourceRows.length ? ((count / sourceRows.length) * 100).toFixed(1) : '0.0';
          return {
            status: option.label,
            count,
            share: `${share}%`,
          };
        })
        .filter((row) => row.count > 0);

      return {
        filePrefix: 'Status_Distribution',
        title: 'Patient Status Distribution',
        subtitle: baseSubtitle,
        summary: [
          { label: 'Total Requests', value: String(sourceRows.length) },
          { label: 'Distinct Statuses', value: String(grouped.length) },
          {
            label: 'Most Common Status',
            value: grouped.sort((a, b) => b.count - a.count)[0]?.status || 'N/A',
          },
        ],
        columns: [
          { key: 'status', label: 'Status' },
          { key: 'count', label: 'Request Count' },
          { key: 'share', label: 'Share' },
        ],
        rows: grouped,
      };
    }

    if (templateId === 'release_pipeline') {
      const pendingApprovals = sourceRows.filter(
        (row) => row.releaseDecisionKey === 'pending_hospital_approval' || (row.statusKey === 'to_be_release' && !row.releaseDecisionKey),
      ).length;

      return {
        filePrefix: 'Release_Pipeline',
        title: 'Release Pipeline Report',
        subtitle: baseSubtitle,
        summary: [
          { label: 'Pending Approval', value: String(pendingApprovals) },
          { label: 'Releasing', value: String(sourceRows.filter((row) => row.statusKey === 'releasing').length) },
          { label: 'Completed', value: String(sourceRows.filter((row) => row.statusKey === 'completed').length) },
        ],
        columns: [
          { key: 'requestId', label: 'Request ID' },
          { key: 'patientName', label: 'Patient' },
          { key: 'statusLabel', label: 'Status' },
          { key: 'releaseDecisionLabel', label: 'Release Decision' },
          { key: 'releaseDateLabel', label: 'Release Date' },
          { key: 'releaseDecisionReason', label: 'Decision Reason' },
        ],
        rows: sourceRows.map((row) => ({
          requestId: row.requestId,
          patientName: row.patientName,
          statusLabel: row.statusLabel,
          releaseDecisionLabel: row.releaseDecisionLabel,
          releaseDateLabel: formatDateTime(row.releaseDate),
          releaseDecisionReason: row.releaseDecisionReason || '-',
        })),
      };
    }

    if (templateId === 'turnaround_sla') {
      const completedRows = sourceRows.filter((row) => row.statusKey === 'completed');
      const completedDays = completedRows
        .map((row) => dateDiffInDays(row.requestDate, row.updatedAt))
        .filter((value) => Number.isFinite(value));

      const avgTurnaround = completedDays.length
        ? (completedDays.reduce((sum, item) => sum + item, 0) / completedDays.length).toFixed(1)
        : '0.0';

      const now = new Date();
      const overdueRows = sourceRows.filter((row) => {
        if (!row.releaseDate) return false;
        const releaseDate = new Date(row.releaseDate);
        const stillOpen = row.statusKey !== 'completed' && row.statusKey !== 'rejected' && row.statusKey !== 'cancelled';
        return stillOpen && releaseDate < now;
      });

      return {
        filePrefix: 'Turnaround_SLA',
        title: 'Turnaround & SLA Report',
        subtitle: baseSubtitle,
        summary: [
          { label: 'Completed Cases', value: String(completedRows.length) },
          { label: 'Average Turnaround (Days)', value: String(avgTurnaround) },
          { label: 'Overdue Releases', value: String(overdueRows.length) },
        ],
        columns: [
          { key: 'requestId', label: 'Request ID' },
          { key: 'patientName', label: 'Patient' },
          { key: 'statusLabel', label: 'Status' },
          { key: 'ageDays', label: 'Age (Days)' },
          { key: 'releaseDateLabel', label: 'Release Date' },
          { key: 'overdueFlag', label: 'Overdue' },
        ],
        rows: sourceRows.map((row) => {
          const ageDays = dateDiffInDays(row.requestDate, row.updatedAt);
          const isOverdue = overdueRows.some((item) => item.reqId === row.reqId);
          return {
            requestId: row.requestId,
            patientName: row.patientName,
            statusLabel: row.statusLabel,
            ageDays: Number.isFinite(ageDays) ? String(ageDays) : 'N/A',
            releaseDateLabel: formatDateTime(row.releaseDate),
            overdueFlag: isOverdue ? 'YES' : 'NO',
          };
        }),
      };
    }

    return {
      filePrefix: 'Request_Intake',
      title: 'Request Intake Summary',
      subtitle: baseSubtitle,
      summary: [
        { label: 'Total Requests', value: String(sourceRows.length) },
        { label: 'Unique Patients', value: String(new Set(sourceRows.map((row) => row.patientCode || row.patientName)).size) },
        {
          label: 'Requested This Week',
          value: String(
            sourceRows.filter((row) => {
              if (!row.requestDate) return false;
              return new Date(row.requestDate) >= toWeekStart(new Date());
            }).length,
          ),
        },
      ],
      columns: [
        { key: 'requestId', label: 'Request ID' },
        { key: 'patientName', label: 'Patient' },
        { key: 'patientCode', label: 'Patient Code' },
        { key: 'statusLabel', label: 'Status' },
        { key: 'requestDateLabel', label: 'Requested At' },
        { key: 'releaseDateLabel', label: 'Release Date' },
      ],
      rows: sourceRows.map((row) => ({
        requestId: row.requestId,
        patientName: row.patientName,
        patientCode: row.patientCode || '-',
        statusLabel: row.statusLabel,
        requestDateLabel: formatDateTime(row.requestDate),
        releaseDateLabel: formatDateTime(row.releaseDate),
      })),
    };
  }, [hospitalName, hospitalId]);

  const activeSourceRows = useMemo(
    () => (activeTemplate.id === 'patient_registry' ? filteredPatientRows : filteredRows),
    [activeTemplate.id, filteredPatientRows, filteredRows],
  );

  const activePayload = useMemo(() => {
    return buildReportPayload(activeTemplate.id, activeSourceRows);
  }, [activeTemplate.id, activeSourceRows, buildReportPayload]);

  const pieColors = ['#0f766e', '#0ea5e9', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6', '#6366f1', '#64748b', '#22c55e'];

  const addHistoryEntry = useCallback((entry) => {
    setGeneratedHistory((previous) => {
      const next = [entry, ...previous];
      return next.slice(0, 120);
    });
  }, []);

  const getDisplayName = useCallback(() => {
    const fullName = [userProfile?.first_name, userProfile?.middle_name, userProfile?.last_name, userProfile?.suffix]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return fullName || userProfile?.email || `User #${userProfile?.user_id || 'N/A'}`;
  }, [userProfile]);

  const handleGenerate = useCallback(async ({ templateId, format, sourceRows, sourceType = 'manual', scheduleId = null }) => {
    if (!sourceRows.length) {
      setNotice({ kind: 'warning', text: 'No records to include for this report. Adjust filters or refresh data.' });
      return;
    }

    const payload = buildReportPayload(templateId, sourceRows);
    const extension = format.toLowerCase();
    const fileName = createFileName(payload.filePrefix, extension);

    try {
      setIsGenerating(true);

      if (extension === 'csv') {
        const csvContent = createCsvContent(payload);
        downloadTextFile(csvContent, fileName, 'text/csv;charset=utf-8;');
      } else {
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });
        let y = 14;

        doc.setFontSize(14);
        doc.text(payload.title, 14, y);
        y += 7;

        doc.setFontSize(9);
        doc.text(payload.subtitle, 14, y);
        y += 7;

        doc.setFontSize(10);
        doc.text('Summary', 14, y);
        y += 5;

        payload.summary.forEach((item) => {
          doc.setFontSize(9);
          doc.text(`- ${item.label}: ${item.value}`, 14, y);
          y += 4.5;
        });

        y += 2;
        doc.setFontSize(10);
        doc.text('Data Preview', 14, y);
        y += 5;

        const header = payload.columns.map((column) => column.label).join(' | ');
        doc.setFontSize(8.5);
        const headerLines = doc.splitTextToSize(header, 182);
        doc.text(headerLines, 14, y);
        y += headerLines.length * 4.2 + 1;

        payload.rows.forEach((row) => {
          const lineRaw = payload.columns.map((column) => String(row[column.key] ?? '')).join(' | ');
          const wrapped = doc.splitTextToSize(lineRaw, 182);

          if (y + wrapped.length * 4.2 > 285) {
            doc.addPage();
            y = 14;
          }

          doc.text(wrapped, 14, y);
          y += wrapped.length * 4.2 + 0.5;
        });

        doc.save(fileName);
      }

      addHistoryEntry({
        id: `HST-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        fileName,
        templateId,
        templateName: payload.title,
        format: extension.toUpperCase(),
        rowCount: payload.rows.length,
        generatedAt: new Date().toISOString(),
        generatedBy: getDisplayName(),
        sourceType,
      });

      if (scheduleId) {
        setScheduledReports((previous) => previous.map((schedule) => {
          if (schedule.id !== scheduleId) return schedule;
          return {
            ...schedule,
            lastRunAt: new Date().toISOString(),
            runCount: Number(schedule.runCount || 0) + 1,
          };
        }));
      }

      setNotice({ kind: 'success', text: `${payload.title} exported as ${extension.toUpperCase()} successfully.` });
      setActiveTab('history');
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to generate report.' });
    } finally {
      setIsGenerating(false);
    }
  }, [buildReportPayload, addHistoryEntry, getDisplayName]);

  const handleAddSchedule = () => {
    const template = REPORT_TEMPLATES.find((item) => item.id === scheduleForm.templateId);
    const recipientEmails = parseRecipientEmails(scheduleForm.recipients);

    if (!scheduleForm.title.trim()) {
      setNotice({ kind: 'error', text: 'Schedule title is required.' });
      return;
    }

    if (recipientEmails.length === 0) {
      setNotice({ kind: 'error', text: 'At least one recipient email is required.' });
      return;
    }

    if (recipientEmails.some((email) => !isValidEmail(email))) {
      setNotice({ kind: 'error', text: 'Enter valid recipient emails separated by commas.' });
      return;
    }

    const nextSchedule = {
      id: `SCH-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      title: scheduleForm.title.trim(),
      templateId: scheduleForm.templateId,
      cadence: scheduleForm.cadence,
      time: scheduleForm.time,
      format: scheduleForm.format,
      recipients: recipientEmails.join(', '),
      status: 'Active',
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      runCount: 0,
    };

    setScheduledReports((previous) => [nextSchedule, ...previous]);
    setScheduleForm({
      title: '',
      templateId: template?.id || REPORT_TEMPLATES[0].id,
      cadence: 'weekly',
      time: '07:00',
      format: template?.defaultFormat || 'csv',
      recipients: '',
    });

    setNotice({ kind: 'success', text: 'Scheduled report added successfully.' });
  };

  const handleRunScheduleNow = async (schedule) => {
    const sourceRows = schedule.templateId === 'patient_registry' ? patientReportRows : reportRows;
    await handleGenerate({
      templateId: schedule.templateId,
      format: schedule.format,
      sourceRows,
      sourceType: 'scheduled',
      scheduleId: schedule.id,
    });
  };

  const handleToggleSchedule = (scheduleId) => {
    setScheduledReports((previous) => previous.map((schedule) => {
      if (schedule.id !== scheduleId) return schedule;
      return {
        ...schedule,
        status: schedule.status === 'Active' ? 'Paused' : 'Active',
      };
    }));
  };

  const handleDeleteSchedule = (scheduleId) => {
    setScheduledReports((previous) => previous.filter((schedule) => schedule.id !== scheduleId));
  };

  const handleQuickGenerate = async (format) => {
    if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
      setNotice({ kind: 'error', text: 'Date From cannot be later than Date To.' });
      return;
    }

    await handleGenerate({
      templateId: selectedTemplateId,
      format,
      sourceRows: activeSourceRows,
      sourceType: 'manual',
    });
  };

  const handleRegenerateHistory = async (historyRow) => {
    const sourceRows = historyRow.templateId === 'patient_registry' ? patientReportRows : reportRows;
    await handleGenerate({
      templateId: historyRow.templateId,
      format: String(historyRow.format || 'CSV').toLowerCase(),
      sourceRows,
      sourceType: 'history',
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="role-page-title mb-2 text-3xl font-bold text-gray-900">Reports</h1>
        <p className="text-gray-600">
          Build operational, approval, and turnaround reports with live H-Representative data and export-ready outputs.
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Scope: {hospitalName || (hospitalId ? `H-Representative #${hospitalId}` : 'Not assigned')} | Updated: {formatDateTime(lastRefreshedAt)}
        </p>
      </div>

      {notice.text && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm font-medium ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : notice.kind === 'warning'
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {reportSummary.map((item) => (
            <article key={item.label} className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">{item.label}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{item.value}</p>
            </article>
          ))}
        </div>

        <button
          type="button"
          onClick={loadReportData}
          disabled={isResolvingHospital || isLoading || !hospitalId}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {(isResolvingHospital || isLoading) ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh Data
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={tabClass(activeTab === tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'quick' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-gray-900">Filter Builder</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Date From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Date To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Status</label>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  disabled={activeTemplate.id === 'patient_registry'}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Search</label>
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Request, patient, notes"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500">
                Current scope rows: <span className="font-semibold text-gray-700">{activeSourceRows.length}</span>
                {activeTemplate.id === 'patient_registry' ? ' patients' : ' requests'}
              </p>
              {(dateFrom || dateTo || statusFilter !== 'all' || searchTerm) ? (
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                    setStatusFilter('all');
                    setSearchTerm('');
                  }}
                  className="text-xs font-semibold text-blue-700 hover:text-blue-800"
                >
                  Clear all filters
                </button>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-gray-900">Quick Report Templates</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {REPORT_TEMPLATES.map((template) => {
                const isActive = selectedTemplateId === template.id;
                return (
                  <article
                    key={template.id}
                    className={`rounded-lg border p-3 transition ${
                      isActive
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-gray-200 bg-gray-50 text-gray-900'
                    }`}
                  >
                    <p className="text-sm font-semibold">{template.name}</p>
                    <p className={`mt-1 text-xs ${isActive ? 'text-slate-200' : 'text-gray-500'}`}>{template.description}</p>
                    <p className={`mt-1 text-[11px] font-medium ${isActive ? 'text-slate-300' : 'text-gray-500'}`}>
                      Suggested cadence: {template.cadenceHint}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTemplateId(template.id);
                        if (template.id === 'patient_registry') setStatusFilter('all');
                      }}
                      className={`mt-3 rounded-md px-3 py-1.5 text-xs font-semibold ${
                        isActive
                          ? 'bg-white text-slate-900'
                          : 'border border-gray-300 bg-white text-gray-700'
                      }`}
                    >
                      {isActive ? 'Selected' : 'Use Template'}
                    </button>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
            <article className="rounded-xl border border-gray-200 bg-white p-3 xl:col-span-7">
              <h3 className="text-sm font-semibold text-gray-900">6-Week Request vs Completed Trend</h3>
              <div className="mt-2 h-64 w-full">
                <ResponsiveContainer>
                  <LineChart data={trendSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#cbd5e1" />
                    <XAxis dataKey="week" stroke="#64748b" fontSize={11} />
                    <YAxis stroke="#64748b" fontSize={11} />
                    <Tooltip />
                    <Line type="monotone" dataKey="requested" name="Requested" stroke="#0f172a" strokeWidth={2.5} dot={false} />
                    <Line type="monotone" dataKey="completed" name="Completed" stroke="#0ea5e9" strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="rounded-xl border border-gray-200 bg-white p-3 xl:col-span-5">
              <h3 className="text-sm font-semibold text-gray-900">Status Distribution</h3>
              {statusDistribution.length === 0 ? (
                <div className="mt-8 rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
                  No data for current filters.
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
                            <Cell key={item.key} fill={pieColors[index % pieColors.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>

                  <ul className="space-y-1.5 text-[11px]">
                    {statusDistribution.map((item, index) => (
                      <li key={item.key} className="flex items-center justify-between text-gray-600">
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: pieColors[index % pieColors.length] }} />
                          {item.name}
                        </span>
                        <span className="font-semibold text-gray-900">{item.value}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </article>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Preview: {activePayload.title}</h3>
                <p className="text-xs text-gray-500">{activePayload.subtitle}</p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleQuickGenerate('csv')}
                  disabled={isGenerating || isLoading || isResolvingHospital}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  Export CSV
                </button>

                <button
                  type="button"
                  onClick={() => handleQuickGenerate('pdf')}
                  disabled={isGenerating || isLoading || isResolvingHospital}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                  Export PDF
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
              {activePayload.summary.map((item) => (
                <article key={item.label} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">{item.label}</p>
                  <p className="text-lg font-bold text-gray-900">{item.value}</p>
                </article>
              ))}
            </div>

            <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {activePayload.columns.map((column) => (
                      <th key={column.key} className="px-3 py-2 text-left font-semibold text-gray-700">{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activePayload.rows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-gray-500" colSpan={activePayload.columns.length}>
                        No rows available for selected template and filters.
                      </td>
                    </tr>
                  ) : (
                    activePayload.rows.slice(0, 14).map((row, rowIndex) => (
                      <tr key={`${rowIndex}-${row.requestId || row.status || 'row'}`} className="border-t border-gray-200">
                        {activePayload.columns.map((column) => (
                          <td key={`${rowIndex}-${column.key}`} className="px-3 py-2 text-gray-700">
                            {String(row[column.key] ?? '-')}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {activeTab === 'scheduled' && (
        <div className="space-y-4">
          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-gray-900">Create Scheduled Report</h2>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Title</label>
                <input
                  value={scheduleForm.title}
                  onChange={(event) => setScheduleForm((previous) => ({ ...previous, title: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                  placeholder="e.g. Weekly Queue Summary"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Template</label>
                <select
                  value={scheduleForm.templateId}
                  onChange={(event) => {
                    const nextTemplateId = event.target.value;
                    const nextTemplate = REPORT_TEMPLATES.find((item) => item.id === nextTemplateId) || REPORT_TEMPLATES[0];
                    setScheduleForm((previous) => ({
                      ...previous,
                      templateId: nextTemplateId,
                      format: nextTemplate.defaultFormat,
                    }));
                  }}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                >
                  {REPORT_TEMPLATES.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Recipients</label>
                <input
                  value={scheduleForm.recipients}
                  onChange={(event) => setScheduleForm((previous) => ({ ...previous, recipients: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                  placeholder="email1@domain.com, email2@domain.com"
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Cadence</label>
                <select
                  value={scheduleForm.cadence}
                  onChange={(event) => setScheduleForm((previous) => ({ ...previous, cadence: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly (Monday)</option>
                  <option value="monthly">Monthly (1st Day)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Time</label>
                <input
                  type="time"
                  value={scheduleForm.time}
                  onChange={(event) => setScheduleForm((previous) => ({ ...previous, time: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Format</label>
                <select
                  value={scheduleForm.format}
                  onChange={(event) => setScheduleForm((previous) => ({ ...previous, format: event.target.value }))}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800"
                >
                  <option value="csv">CSV</option>
                  <option value="pdf">PDF</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleAddSchedule}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  <Plus size={14} />
                  Add Schedule
                </button>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="border-b border-gray-200 px-4 py-3">
              <h2 className="text-lg font-semibold text-gray-900">Scheduled Reports</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Title</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Template</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Schedule</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Recipients</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Last Run</th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduledReports.length === 0 ? (
                    <tr className="border-t border-gray-200">
                      <td className="px-4 py-4 text-gray-500" colSpan={7}>No scheduled reports configured.</td>
                    </tr>
                  ) : (
                    scheduledReports.map((row) => {
                      const template = REPORT_TEMPLATES.find((item) => item.id === row.templateId);
                      const nextRun = computeNextRun(row.cadence, row.time);

                      return (
                        <tr key={row.id} className="border-t border-gray-200">
                          <td className="px-4 py-3 text-gray-800">{row.title}</td>
                          <td className="px-4 py-3 text-gray-700">{template?.name || row.templateId}</td>
                          <td className="px-4 py-3 text-gray-700">
                            <p>{cadenceLabel(row.cadence)} at {row.time}</p>
                            <p className="text-xs text-gray-500">Next: {formatDateTime(nextRun)}</p>
                          </td>
                          <td className="px-4 py-3 text-gray-700">{row.recipients}</td>
                          <td className="px-4 py-3">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${scheduleStatusClass(row.status)}`}>
                              {row.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-700">
                            {row.lastRunAt ? formatDateTime(row.lastRunAt) : 'Not yet run'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleRunScheduleNow(row)}
                                disabled={isGenerating || isLoading || isResolvingHospital}
                                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                              >
                                {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />}
                                Run Now
                              </button>

                              <button
                                type="button"
                                onClick={() => handleToggleSchedule(row.id)}
                                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                              >
                                {row.status === 'Active' ? <PauseCircle size={12} /> : <CheckCircle2 size={12} />}
                                {row.status === 'Active' ? 'Pause' : 'Activate'}
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDeleteSchedule(row.id)}
                                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                              >
                                <Trash2 size={12} /> Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {activeTab === 'history' && (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Generated Files</h2>
            {generatedHistory.length > 0 ? (
              <button
                type="button"
                onClick={() => setGeneratedHistory([])}
                className="text-xs font-semibold text-red-700 hover:text-red-800"
              >
                Clear history
              </button>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">File</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Template</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Format</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Rows</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Generated By</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Generated At</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {generatedHistory.length === 0 ? (
                  <tr className="border-t border-gray-200">
                    <td className="px-4 py-4 text-gray-500" colSpan={7}>No generated reports yet.</td>
                  </tr>
                ) : (
                  generatedHistory.map((row) => (
                    <tr key={row.id} className="border-t border-gray-200">
                      <td className="px-4 py-3 text-gray-800">{row.fileName}</td>
                      <td className="px-4 py-3 text-gray-700">{row.templateName}</td>
                      <td className="px-4 py-3 text-gray-700">{row.format}</td>
                      <td className="px-4 py-3 text-gray-700">{row.rowCount}</td>
                      <td className="px-4 py-3 text-gray-700">{row.generatedBy}</td>
                      <td className="px-4 py-3 text-gray-700">{formatDateTime(row.generatedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleRegenerateHistory(row)}
                            disabled={isGenerating || isLoading || isResolvingHospital}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                          >
                            <Download size={12} /> Generate Again
                          </button>
                          <button
                            type="button"
                            onClick={() => setGeneratedHistory((previous) => previous.filter((item) => item.id !== row.id))}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                          >
                            <Trash2 size={12} /> Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-500">
        <p className="inline-flex items-center gap-2">
          <CalendarClock size={14} />
          Saved report schedules and export history are private to this signed-in browser profile. Use Run Now to generate a scheduled export; automatic email delivery requires a server-side mail scheduler.
        </p>
        {!isReleaseWorkflowAvailable && (
          <p className="mt-1 text-amber-700">
            Release workflow data is partially unavailable. Ensure Release_Schedules exists and refresh Supabase schema cache.
          </p>
        )}
      </div>
    </div>
  );
}
