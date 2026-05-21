import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  Boxes,
  Calendar,
  CheckCircle2,
  Download,
  FileText,
  Filter,
  Loader2,
  Package,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
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
import { logAuditAction } from '../../../lib/auditLogger';
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

const REPORT_TEMPLATES = [
  {
    id: 'qa_decisions',
    name: 'QA Decisions Report',
    description: 'Per-submission approve/reject log with donor and drive context.',
    icon: ShieldCheck,
    columns: [
      { key: 'code', label: 'Submission Code' },
      { key: 'donor', label: 'Donor' },
      { key: 'drive', label: 'Donation Drive' },
      { key: 'status', label: 'Status' },
      { key: 'created', label: 'Created' },
      { key: 'updated', label: 'Last Updated' },
    ],
  },
  {
    id: 'bundle_production',
    name: 'Bundle Production Report',
    description: 'Bundle lifecycle from draft to wig completion.',
    icon: Package,
    columns: [
      { key: 'code', label: 'Bundle Code' },
      { key: 'status', label: 'Status' },
      { key: 'members', label: 'Hairs in Bundle' },
      { key: 'notes', label: 'Notes' },
      { key: 'created', label: 'Created' },
      { key: 'completed', label: 'Wig Created' },
    ],
  },
  {
    id: 'wig_inventory',
    name: 'Wig Inventory Report',
    description: 'All wigs produced with status, specs, and completion dates.',
    icon: Boxes,
    columns: [
      { key: 'code', label: 'Wig Code' },
      { key: 'name', label: 'Name' },
      { key: 'status', label: 'Status' },
      { key: 'bundleCode', label: 'Bundle' },
      { key: 'donatedHairs', label: 'Hairs Used' },
      { key: 'completed', label: 'Completed' },
    ],
  },
  {
    id: 'donor_throughput',
    name: 'Donor Throughput by Drive',
    description: 'Per-drive donor count, approval rate, and rejection rate.',
    icon: BarChart3,
    columns: [
      { key: 'drive', label: 'Donation Drive' },
      { key: 'donors', label: 'Unique Donors' },
      { key: 'submitted', label: 'Submissions' },
      { key: 'approved', label: 'Approved' },
      { key: 'rejected', label: 'Rejected' },
      { key: 'approvalRate', label: 'Approval Rate %' },
    ],
  },
];

const HISTORY_STORAGE_KEY = 'strandshare.qastylist.report.history';
const HISTORY_LIMIT = 25;

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

function statusKey(value) {
  return String(value || '').trim().toLowerCase();
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function downloadBlob(content, fileName, mimeType) {
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

function buildFileName(templateId, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `qa_${templateId}_${stamp}.${ext}`;
}

function readHistory() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeHistory(entries) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Ignore.
  }
}

function isWithinRange(value, fromDate, toDate) {
  if (!value) return false;
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return false;
  if (fromDate) {
    const fromTs = new Date(fromDate).setHours(0, 0, 0, 0);
    if (ts < fromTs) return false;
  }
  if (toDate) {
    const toTs = new Date(toDate).setHours(23, 59, 59, 999);
    if (ts > toTs) return false;
  }
  return true;
}

export default function GenerateReportsPage({ userProfile }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0275d8';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const tertiaryTextColor = theme?.tertiaryTextColor || '#94a3b8';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const rootStyle = { color: primaryTextColor, fontFamily: `${bodyFont}, sans-serif` };
  const headingStyle = { color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` };

  const [selectedTemplateId, setSelectedTemplateId] = useState(REPORT_TEMPLATES[0].id);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [driveFilter, setDriveFilter] = useState('all');

  const [submissions, setSubmissions] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [bundleMembers, setBundleMembers] = useState({});
  const [wigs, setWigs] = useState([]);
  const [donorsById, setDonorsById] = useState({});
  const [drivesById, setDrivesById] = useState({});

  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [history, setHistory] = useState(() => readHistory());

  useEffect(() => {
    writeHistory(history);
  }, [history]);

  const loadAll = useCallback(async () => {
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
          .limit(2000),
        supabase
          .from(HAIR_SUBMISSION_BUNDLES_TABLE)
          .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At, Wig_Completed_At')
          .order('Created_At', { ascending: false })
          .limit(500),
        supabase
          .from(WIGS_TABLE)
          .select('Wig_ID, Wig_Code, Wig_Name, Bundle_ID, Wig_Status, Completed_At, Total_Donated_Hairs, Total_Bundles_Used, Production_Notes')
          .order('Completed_At', { ascending: false, nullsFirst: false })
          .limit(500),
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

      const bundlesByMembers = submissionRows.reduce((acc, row) => {
        const bid = Number(row.Bundle_ID || 0);
        if (!bid) return acc;
        acc[bid] = (acc[bid] || 0) + 1;
        return acc;
      }, {});
      setBundleMembers(bundlesByMembers);

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
          .select('Event_Request_ID, Event_Name, Start_Date, End_Date')
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

      setLastRefreshedAt(new Date());
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load report data.' });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;
    let isMounted = true;
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (!isMounted) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (isMounted) void loadAll();
      }, 300);
    };
    const channel = supabase
      .channel('public:qa-stylist-reports-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: HAIR_SUBMISSIONS_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: HAIR_SUBMISSION_BUNDLES_TABLE }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: WIGS_TABLE }, scheduleRefresh)
      .subscribe();
    return () => {
      isMounted = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, [loadAll]);

  const selectedTemplate = REPORT_TEMPLATES.find((t) => t.id === selectedTemplateId) || REPORT_TEMPLATES[0];

  const driveOptions = useMemo(() => {
    const options = Object.values(drivesById)
      .map((row) => ({ id: Number(row.Event_Request_ID), title: row.Event_Name || `Event #${row.Event_Request_ID}` }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return [{ id: 'all', title: 'All Events' }, ...options];
  }, [drivesById]);

  const filteredRows = useMemo(() => {
    if (selectedTemplateId === 'qa_decisions') {
      return submissions
        .filter((row) => {
          if (statusFilter !== 'all' && statusKey(row.Status) !== statusFilter) return false;
          if (driveFilter !== 'all' && Number(row._resolvedEventRequestId || 0) !== Number(driveFilter)) return false;
          if ((dateFrom || dateTo) && !isWithinRange(row.Updated_At || row.Created_At, dateFrom, dateTo)) return false;
          return true;
        })
        .map((row) => {
          const donor = donorsById[Number(row.User_ID || 0)];
          const resolvedEventRequestId = Number(row._resolvedEventRequestId || row.Event_Request_ID || 0);
          const drive = drivesById[resolvedEventRequestId];
          return {
            code: row._resolvedWaybillCode || `#${Number(row.Submission_ID || 0)}`,
            donor: donor ? buildFullName(donor.first_name, donor.middle_name, donor.last_name, donor.suffix) : `User #${row.User_ID || 0}`,
            drive: drive?.Event_Name || (resolvedEventRequestId ? `Event #${resolvedEventRequestId}` : '-'),
            status: row.Status || '-',
            created: formatDateTime(row.Created_At),
            updated: formatDateTime(row.Updated_At),
          };
        });
    }

    if (selectedTemplateId === 'bundle_production') {
      return bundles
        .filter((row) => {
          if (statusFilter !== 'all' && statusKey(row.Status) !== statusFilter) return false;
          if ((dateFrom || dateTo) && !isWithinRange(row.Created_At, dateFrom, dateTo)) return false;
          return true;
        })
        .map((row) => {
          const memberCount = bundleMembers[Number(row.Bundle_ID)] || 0;
          return {
            code: row.Bundle_Waybill_Code || `WB${String(Number(row.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`,
            status: row.Status || '-',
            members: memberCount,
            notes: row.Notes || '-',
            created: formatDateTime(row.Created_At),
            completed: row.Wig_Completed_At ? formatDateTime(row.Wig_Completed_At) : '-',
          };
        });
    }

    if (selectedTemplateId === 'wig_inventory') {
      const bundleCodeById = bundles.reduce((acc, b) => {
        acc[Number(b.Bundle_ID)] = b.Bundle_Waybill_Code || `WB${String(Number(b.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;
        return acc;
      }, {});
      return wigs
        .filter((row) => {
          if (statusFilter !== 'all' && statusKey(row.Wig_Status) !== statusFilter) return false;
          if ((dateFrom || dateTo) && !isWithinRange(row.Completed_At, dateFrom, dateTo)) return false;
          return true;
        })
        .map((row) => ({
          code: row.Wig_Code || `WIG-${row.Wig_ID}`,
          name: row.Wig_Name || '-',
          status: row.Wig_Status || '-',
          bundleCode: bundleCodeById[Number(row.Bundle_ID)] || (row.Bundle_ID ? `WB${String(Number(row.Bundle_ID || 0)).padStart(6, '0').slice(-6)}` : '-'),
          donatedHairs: Number(row.Total_Donated_Hairs || 0),
          completed: row.Completed_At ? formatDateTime(row.Completed_At) : '-',
        }));
    }

    if (selectedTemplateId === 'donor_throughput') {
      const grouped = new Map();
      submissions.forEach((row) => {
        const driveId = Number(row._resolvedEventRequestId || row.Event_Request_ID || 0);
        if (driveFilter !== 'all' && driveId !== Number(driveFilter)) return;
        if ((dateFrom || dateTo) && !isWithinRange(row.Created_At, dateFrom, dateTo)) return;
        if (!grouped.has(driveId)) {
          grouped.set(driveId, {
            driveId,
            title: drivesById[driveId]?.Event_Name || (driveId ? `Event #${driveId}` : 'Unassigned'),
            donors: new Set(),
            submitted: 0,
            approved: 0,
            rejected: 0,
          });
        }
        const bucket = grouped.get(driveId);
        bucket.submitted += 1;
        if (row.User_ID) bucket.donors.add(Number(row.User_ID));
        const sk = statusKey(row.Status);
        if (sk === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase()) bucket.approved += 1;
        if (sk === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()) bucket.rejected += 1;
      });
      return Array.from(grouped.values())
        .sort((a, b) => b.submitted - a.submitted)
        .map((bucket) => {
          const decided = bucket.approved + bucket.rejected;
          const rate = decided > 0 ? Math.round((bucket.approved / decided) * 100) : 0;
          return {
            drive: bucket.title,
            donors: bucket.donors.size,
            submitted: bucket.submitted,
            approved: bucket.approved,
            rejected: bucket.rejected,
            approvalRate: `${rate}%`,
          };
        });
    }

    return [];
  }, [
    selectedTemplateId,
    submissions,
    bundles,
    wigs,
    donorsById,
    drivesById,
    bundleMembers,
    statusFilter,
    driveFilter,
    dateFrom,
    dateTo,
  ]);

  const summary = useMemo(() => {
    if (selectedTemplateId === 'qa_decisions') {
      const total = filteredRows.length;
      const approved = filteredRows.filter((r) => statusKey(r.status) === HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase()).length;
      const rejected = filteredRows.filter((r) => statusKey(r.status) === HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase()).length;
      const received = filteredRows.filter((r) => statusKey(r.status) === HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase()).length;
      const decided = approved + rejected;
      const rate = decided > 0 ? Math.round((approved / decided) * 100) : 0;
      return [
        { label: 'Total submissions', value: total },
        { label: 'Approved', value: approved },
        { label: 'Rejected', value: rejected },
        { label: 'Approval rate', value: `${rate}%` },
        { label: 'Awaiting decision', value: received },
      ];
    }
    if (selectedTemplateId === 'bundle_production') {
      const total = filteredRows.length;
      const drafts = filteredRows.filter((r) => statusKey(r.status) === HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()).length;
      const inProd = filteredRows.filter((r) => statusKey(r.status) === HAIR_BUNDLE_STATUS.IN_PRODUCTION.toLowerCase()).length;
      const done = filteredRows.filter((r) => statusKey(r.status) === HAIR_BUNDLE_STATUS.WIG_COMPLETED.toLowerCase()).length;
      const totalHairs = filteredRows.reduce((sum, r) => sum + Number(r.members || 0), 0);
      return [
        { label: 'Total bundles', value: total },
        { label: 'Draft', value: drafts },
        { label: 'In production', value: inProd },
        { label: 'Wig completed', value: done },
        { label: 'Hairs used', value: totalHairs },
      ];
    }
    if (selectedTemplateId === 'wig_inventory') {
      const total = filteredRows.length;
      const ready = filteredRows.filter((r) => statusKey(r.status) === 'ready for release').length;
      const allocated = filteredRows.filter((r) => statusKey(r.status) === 'wig allocated').length;
      const released = filteredRows.filter((r) => statusKey(r.status) === 'released').length;
      const hairsUsed = filteredRows.reduce((sum, r) => sum + Number(r.donatedHairs || 0), 0);
      return [
        { label: 'Total wigs', value: total },
        { label: 'Ready for release', value: ready },
        { label: 'Wig allocated', value: allocated },
        { label: 'Released', value: released },
        { label: 'Hairs used', value: hairsUsed },
      ];
    }
    const drives = filteredRows.length;
    const totalDonors = filteredRows.reduce((sum, r) => sum + Number(r.donors || 0), 0);
    const totalSubmitted = filteredRows.reduce((sum, r) => sum + Number(r.submitted || 0), 0);
    const totalApproved = filteredRows.reduce((sum, r) => sum + Number(r.approved || 0), 0);
    const totalRejected = filteredRows.reduce((sum, r) => sum + Number(r.rejected || 0), 0);
    const decided = totalApproved + totalRejected;
    const rate = decided > 0 ? Math.round((totalApproved / decided) * 100) : 0;
    return [
      { label: 'Drives covered', value: drives },
      { label: 'Unique donors', value: totalDonors },
      { label: 'Submissions', value: totalSubmitted },
      { label: 'Approval rate', value: `${rate}%` },
    ];
  }, [filteredRows, selectedTemplateId]);

  const previewChartData = useMemo(() => {
    if (selectedTemplateId === 'qa_decisions') {
      const buckets = [
        { name: HAIR_SUBMISSION_STATUS.CUT_SHIPPED, color: '#b45309' },
        { name: HAIR_SUBMISSION_STATUS.RECEIVED, color: primaryColor },
        { name: HAIR_SUBMISSION_STATUS.APPROVED, color: tertiaryColor },
        { name: HAIR_SUBMISSION_STATUS.REJECTED, color: '#dc2626' },
      ].map((b) => ({
        ...b,
        value: filteredRows.filter((r) => statusKey(r.status) === b.name.toLowerCase()).length,
      })).filter((b) => b.value > 0);
      return { type: 'pie', data: buckets };
    }
    if (selectedTemplateId === 'bundle_production') {
      return {
        type: 'pie',
        data: [
          { name: HAIR_BUNDLE_STATUS.DRAFT, color: '#b45309' },
          { name: HAIR_BUNDLE_STATUS.IN_PRODUCTION, color: primaryColor },
          { name: HAIR_BUNDLE_STATUS.WIG_COMPLETED, color: tertiaryColor },
        ].map((b) => ({
          ...b,
          value: filteredRows.filter((r) => statusKey(r.status) === b.name.toLowerCase()).length,
        })).filter((b) => b.value > 0),
      };
    }
    if (selectedTemplateId === 'wig_inventory') {
      const map = new Map();
      filteredRows.forEach((row) => {
        const key = row.status || 'Unknown';
        map.set(key, (map.get(key) || 0) + 1);
      });
      const palette = [primaryColor, tertiaryColor, '#b45309', '#dc2626', '#7c3aed', '#0891b2'];
      const data = Array.from(map.entries()).map(([name, value], idx) => ({ name, value, color: palette[idx % palette.length] }));
      return { type: 'pie', data };
    }
    return {
      type: 'bar',
      data: filteredRows.slice(0, 8).map((row) => ({
        name: String(row.drive).length > 16 ? `${String(row.drive).slice(0, 14)}...` : row.drive,
        Approved: Number(row.approved || 0),
        Rejected: Number(row.rejected || 0),
      })),
    };
  }, [selectedTemplateId, filteredRows, primaryColor, tertiaryColor]);

  const recordHistoryEntry = (entry) => {
    const next = [
      { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, generatedAt: new Date().toISOString() },
      ...history,
    ].slice(0, HISTORY_LIMIT);
    setHistory(next);
  };

  const handleGenerateCsv = () => {
    setIsGenerating(true);
    try {
      const columns = selectedTemplate.columns;
      const lines = [];
      lines.push(csvEscape(selectedTemplate.name));
      lines.push(csvEscape(`Generated on ${formatDateTime(new Date())}`));
      lines.push('');
      lines.push('Summary');
      summary.forEach((item) => lines.push(`${csvEscape(item.label)},${csvEscape(item.value)}`));
      lines.push('');
      lines.push(columns.map((c) => csvEscape(c.label)).join(','));
      filteredRows.forEach((row) => {
        lines.push(columns.map((c) => csvEscape(row[c.key] ?? '')).join(','));
      });
      const fileName = buildFileName(selectedTemplate.id, 'csv');
      downloadBlob(lines.join('\n'), fileName, 'text/csv;charset=utf-8');
      recordHistoryEntry({
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
        format: 'csv',
        rows: filteredRows.length,
        fileName,
      });
      setNotice({ kind: 'success', text: `Generated ${fileName} with ${filteredRows.length} row${filteredRows.length === 1 ? '' : 's'}.` });
      void logAuditAction({
        action: 'reports.qa_stylist.generate',
        description: `Generated ${selectedTemplate.name} (CSV, ${filteredRows.length} rows).`,
        resource: 'qa_stylist_reports',
        status: 'success',
        userProfile,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to generate CSV.' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGeneratePdf = () => {
    setIsGenerating(true);
    try {
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(16);
      pdf.text('StrandShare - QA Stylist Report', margin, margin + 4);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(11);
      pdf.text(selectedTemplate.name, margin, margin + 11);

      pdf.setFontSize(9);
      pdf.setTextColor(110);
      pdf.text(`Generated ${formatDateTime(new Date())}`, margin, margin + 17);
      if (dateFrom || dateTo) {
        pdf.text(`Date range: ${dateFrom || 'start'} to ${dateTo || 'today'}`, margin, margin + 22);
      }
      if (statusFilter !== 'all') pdf.text(`Status filter: ${statusFilter}`, margin, margin + 27);

      pdf.setTextColor(0);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text('Summary', margin, margin + 35);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      let yOffset = margin + 40;
      summary.forEach((item) => {
        pdf.text(`${item.label}: ${item.value}`, margin, yOffset);
        yOffset += 5;
      });

      yOffset += 4;
      const columns = selectedTemplate.columns;
      const tableWidth = pageWidth - margin * 2;
      const colWidth = tableWidth / columns.length;

      pdf.setFont('helvetica', 'bold');
      pdf.setFillColor(15, 23, 42);
      pdf.setTextColor(255);
      pdf.rect(margin, yOffset, tableWidth, 7, 'F');
      columns.forEach((col, idx) => {
        pdf.text(String(col.label), margin + idx * colWidth + 1.5, yOffset + 5);
      });
      yOffset += 7;

      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(0);

      filteredRows.forEach((row, rowIdx) => {
        if (yOffset > pageHeight - margin - 7) {
          pdf.addPage();
          yOffset = margin + 4;
          pdf.setFont('helvetica', 'bold');
          pdf.setFillColor(15, 23, 42);
          pdf.setTextColor(255);
          pdf.rect(margin, yOffset, tableWidth, 7, 'F');
          columns.forEach((col, idx) => {
            pdf.text(String(col.label), margin + idx * colWidth + 1.5, yOffset + 5);
          });
          yOffset += 7;
          pdf.setFont('helvetica', 'normal');
          pdf.setTextColor(0);
        }

        if (rowIdx % 2 === 1) {
          pdf.setFillColor(243, 244, 246);
          pdf.rect(margin, yOffset, tableWidth, 6.5, 'F');
        }
        columns.forEach((col, idx) => {
          const cell = String(row[col.key] ?? '');
          const truncated = cell.length > Math.max(8, Math.floor(colWidth * 1.4))
            ? `${cell.slice(0, Math.max(8, Math.floor(colWidth * 1.4)) - 1)}...`
            : cell;
          pdf.text(truncated, margin + idx * colWidth + 1.5, yOffset + 4.5);
        });
        yOffset += 6.5;
      });

      pdf.setFontSize(8);
      pdf.setTextColor(120);
      const totalPages = pdf.internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i += 1) {
        pdf.setPage(i);
        pdf.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - margin / 2, { align: 'right' });
        pdf.text('Confidential - StrandShare QA Report', margin, pageHeight - margin / 2);
      }

      const fileName = buildFileName(selectedTemplate.id, 'pdf');
      pdf.save(fileName);
      recordHistoryEntry({
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
        format: 'pdf',
        rows: filteredRows.length,
        fileName,
      });
      setNotice({ kind: 'success', text: `Generated ${fileName} with ${filteredRows.length} row${filteredRows.length === 1 ? '' : 's'}.` });
      void logAuditAction({
        action: 'reports.qa_stylist.generate',
        description: `Generated ${selectedTemplate.name} (PDF, ${filteredRows.length} rows).`,
        resource: 'qa_stylist_reports',
        status: 'success',
        userProfile,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to generate PDF.' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClearHistory = () => {
    if (typeof window === 'undefined') return;
    if (!window.confirm('Clear local report history?')) return;
    setHistory([]);
  };

  const statusOptions = useMemo(() => {
    if (selectedTemplateId === 'qa_decisions' || selectedTemplateId === 'donor_throughput') {
      return [
        { id: 'all', label: 'All statuses' },
        { id: HAIR_SUBMISSION_STATUS.CUT_SHIPPED.toLowerCase(), label: 'Cut & Shipped' },
        { id: HAIR_SUBMISSION_STATUS.RECEIVED.toLowerCase(), label: 'Received' },
        { id: HAIR_SUBMISSION_STATUS.APPROVED.toLowerCase(), label: 'Approved' },
        { id: HAIR_SUBMISSION_STATUS.REJECTED.toLowerCase(), label: 'Rejected' },
      ];
    }
    if (selectedTemplateId === 'bundle_production') {
      return [
        { id: 'all', label: 'All statuses' },
        { id: HAIR_BUNDLE_STATUS.DRAFT.toLowerCase(), label: 'Draft' },
        { id: HAIR_BUNDLE_STATUS.IN_PRODUCTION.toLowerCase(), label: 'In Production' },
        { id: HAIR_BUNDLE_STATUS.WIG_COMPLETED.toLowerCase(), label: 'Wig Created' },
      ];
    }
    return [
      { id: 'all', label: 'All statuses' },
      { id: 'in production', label: 'In Production' },
      { id: 'ready for release', label: 'Ready for Release' },
      { id: 'wig allocated', label: 'Wig Allocated' },
      { id: 'releasing', label: 'Releasing' },
      { id: 'released', label: 'Released' },
    ];
  }, [selectedTemplateId]);

  return (
    <div className="space-y-6" style={rootStyle}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold mb-2" style={headingStyle}>Reports</h1>
          <p style={{ color: secondaryTextColor }}>
            Generate QA, bundling, and wig inventory reports. Filter by date, status, or event, then export to CSV or PDF.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadAll()}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-xl border bg-white px-3.5 py-2 text-sm font-semibold disabled:opacity-60"
            style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Refresh data
          </button>
        </div>
      </header>

      {notice.text ? (
        <div
          className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
          style={
            notice.kind === 'error' ? { borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c' }
              : notice.kind === 'success' ? { borderColor: '#a7f3d0', backgroundColor: '#ecfdf5', color: '#047857' }
                : { borderColor: '#fde68a', backgroundColor: '#fffbeb', color: '#b45309' }
          }
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{notice.text}</span>
        </div>
      ) : null}

      {lastRefreshedAt ? (
        <p className="text-xs" style={{ color: tertiaryTextColor }}>
          Data last synced {formatDateTime(lastRefreshedAt)} - {submissions.length} submissions, {bundles.length} bundles, {wigs.length} wigs loaded.
        </p>
      ) : null}

      <section className="rounded-2xl border bg-white p-4" style={{ borderColor: '#e2e8f0' }}>
        <div className="mb-3 flex items-center gap-2">
          <FileText size={16} style={{ color: primaryColor }} />
          <h2 className="text-base font-semibold" style={headingStyle}>1. Pick a report template</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {REPORT_TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            const isActive = tpl.id === selectedTemplateId;
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => {
                  setSelectedTemplateId(tpl.id);
                  setStatusFilter('all');
                }}
                className="rounded-xl border p-3 text-left transition"
                style={
                  isActive
                    ? { borderColor: primaryColor, backgroundColor: withColorAlpha(primaryColor, 0.06) }
                    : { borderColor: '#e2e8f0', backgroundColor: '#fff' }
                }
              >
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg"
                    style={{ backgroundColor: withColorAlpha(primaryColor, 0.12), color: primaryColor }}
                  >
                    <Icon size={16} />
                  </span>
                  <p className="text-sm font-semibold" style={{ color: primaryTextColor }}>{tpl.name}</p>
                </div>
                <p className="mt-2 text-xs" style={{ color: secondaryTextColor }}>{tpl.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border bg-white p-4" style={{ borderColor: '#e2e8f0' }}>
        <div className="mb-3 flex items-center gap-2">
          <Filter size={16} style={{ color: primaryColor }} />
          <h2 className="text-base font-semibold" style={headingStyle}>2. Apply filters</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-semibold" style={{ color: secondaryTextColor }}>
              <Calendar size={11} className="mr-1 inline-block" /> From
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
              style={{ color: primaryTextColor }}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold" style={{ color: secondaryTextColor }}>
              <Calendar size={11} className="mr-1 inline-block" /> To
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
              style={{ color: primaryTextColor }}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold" style={{ color: secondaryTextColor }}>Status</label>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
              style={{ color: primaryTextColor }}
            >
              {statusOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>
          {(selectedTemplateId === 'qa_decisions' || selectedTemplateId === 'donor_throughput') ? (
            <div>
              <label className="mb-1 block text-xs font-semibold" style={{ color: secondaryTextColor }}>Event</label>
              <select
                value={driveFilter}
                onChange={(event) => setDriveFilter(event.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                style={{ color: primaryTextColor }}
              >
                {driveOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.title}</option>
                ))}
              </select>
            </div>
          ) : <div />}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2 rounded-2xl border bg-white p-4" style={{ borderColor: '#e2e8f0' }}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold" style={headingStyle}>3. Preview</h2>
              <p className="text-xs" style={{ color: tertiaryTextColor }}>
                {filteredRows.length} row{filteredRows.length === 1 ? '' : 's'} ready to export.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleGenerateCsv}
                disabled={isGenerating || !filteredRows.length}
                className="inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm font-semibold disabled:opacity-60"
                style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
              >
                {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Export CSV
              </button>
              <button
                type="button"
                onClick={handleGeneratePdf}
                disabled={isGenerating || !filteredRows.length}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: primaryColor }}
              >
                {isGenerating ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                Export PDF
              </button>
            </div>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            {summary.map((item) => (
              <div key={item.label} className="rounded-lg border p-2" style={{ borderColor: '#e2e8f0' }}>
                <p className="text-[10px] uppercase tracking-wide" style={{ color: tertiaryTextColor }}>{item.label}</p>
                <p className="text-lg font-bold" style={{ color: primaryTextColor }}>{item.value}</p>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border" style={{ borderColor: '#e2e8f0' }}>
            <div className="max-h-[360px] overflow-auto">
              <table className="min-w-full text-sm">
                <thead style={{ backgroundColor: withColorAlpha(primaryColor, 0.08) }}>
                  <tr>
                    {selectedTemplate.columns.map((col) => (
                      <th key={col.key} className="px-3 py-2 text-left font-semibold" style={{ color: primaryTextColor }}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={selectedTemplate.columns.length} className="px-3 py-6 text-center text-sm" style={{ color: secondaryTextColor }}>
                        No rows match the current filters.
                      </td>
                    </tr>
                  ) : (
                    filteredRows.slice(0, 200).map((row, idx) => (
                      <tr key={`${row.code || row.drive || idx}-${idx}`} className="border-t" style={{ borderColor: '#e2e8f0' }}>
                        {selectedTemplate.columns.map((col) => (
                          <td key={col.key} className="px-3 py-2 text-xs" style={{ color: secondaryTextColor }}>
                            {row[col.key] ?? '-'}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {filteredRows.length > 200 ? (
                <div className="px-3 py-2 text-center text-[11px]" style={{ color: tertiaryTextColor }}>
                  Showing first 200 rows in preview. Export to see all {filteredRows.length}.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-4" style={{ borderColor: '#e2e8f0' }}>
          <h2 className="text-base font-semibold mb-3" style={headingStyle}>At a glance</h2>
          {previewChartData.type === 'pie' && previewChartData.data.length ? (
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={previewChartData.data} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2}>
                    {previewChartData.data.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : previewChartData.type === 'bar' && previewChartData.data.length ? (
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={previewChartData.data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" stroke={tertiaryTextColor} fontSize={10} interval={0} angle={-15} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} stroke={tertiaryTextColor} fontSize={11} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="Approved" fill={tertiaryColor} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Rejected" fill="#dc2626" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[200px] items-center justify-center text-sm" style={{ color: secondaryTextColor }}>
              No data to chart for the current filters.
            </div>
          )}

          <div className="mt-3 rounded-lg border bg-slate-50 p-3 text-xs" style={{ borderColor: '#e2e8f0', color: secondaryTextColor }}>
            <p className="font-semibold mb-1" style={{ color: primaryTextColor }}>Tip</p>
            <p>
              Reports respect the filters above. Adjust the date range or status to focus on a specific period, then export to share with the Super Admin or print for compliance review.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border bg-white" style={{ borderColor: '#e2e8f0' }}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: '#e2e8f0' }}>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} style={{ color: tertiaryColor }} />
            <h2 className="text-base font-semibold" style={headingStyle}>Generated Reports History</h2>
            <span className="text-xs" style={{ color: tertiaryTextColor }}>(stored locally on this device)</span>
          </div>
          {history.length ? (
            <button
              type="button"
              onClick={handleClearHistory}
              className="text-xs font-semibold underline"
              style={{ color: '#b91c1c' }}
            >
              Clear history
            </button>
          ) : null}
        </div>
        {!history.length ? (
          <div className="px-4 py-6 text-center text-sm" style={{ color: secondaryTextColor }}>
            No reports generated yet. Pick a template above and export to create your first report.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead style={{ backgroundColor: withColorAlpha(tertiaryColor, 0.08) }}>
                <tr>
                  <th className="px-4 py-2 text-left font-semibold" style={{ color: primaryTextColor }}>Generated</th>
                  <th className="px-4 py-2 text-left font-semibold" style={{ color: primaryTextColor }}>Report</th>
                  <th className="px-4 py-2 text-left font-semibold" style={{ color: primaryTextColor }}>Format</th>
                  <th className="px-4 py-2 text-left font-semibold" style={{ color: primaryTextColor }}>Rows</th>
                  <th className="px-4 py-2 text-left font-semibold" style={{ color: primaryTextColor }}>File</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id} className="border-t" style={{ borderColor: '#e2e8f0' }}>
                    <td className="px-4 py-2 text-xs" style={{ color: tertiaryTextColor }}>{formatDateTime(entry.generatedAt)}</td>
                    <td className="px-4 py-2 text-xs" style={{ color: primaryTextColor }}>{entry.templateName}</td>
                    <td className="px-4 py-2 text-xs uppercase" style={{ color: secondaryTextColor }}>{entry.format}</td>
                    <td className="px-4 py-2 text-xs" style={{ color: secondaryTextColor }}>{entry.rows}</td>
                    <td className="px-4 py-2 text-xs font-mono" style={{ color: secondaryTextColor }}>{entry.fileName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
