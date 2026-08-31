import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Boxes,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Download,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Send,
  Users,
  XCircle,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import {
  ResponsiveContainer,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  AreaChart,
  Area,
} from 'recharts';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const EVENT_REQUESTS_TABLE = 'Event_Requests';
const HOSPITALS_TABLE = 'Hospitals';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const USERS_TABLE = 'users';

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
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

function formatShortDate(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: '2-digit',
  });
}

function toDayKey(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return '';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(parsed).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildRecent7DayFrame() {
  const rows = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const current = new Date();
    current.setDate(current.getDate() - offset);
    rows.push({
      dayKey: toDayKey(current),
      label: formatShortDate(current),
      value: 0,
    });
  }
  return rows;
}

function withinDateRange(value, fromDate, toDate) {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;

  if (fromDate) {
    const from = new Date(fromDate);
    from.setHours(0, 0, 0, 0);
    if (parsed.getTime() < from.getTime()) return false;
  }

  if (toDate) {
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    if (parsed.getTime() > to.getTime()) return false;
  }

  return true;
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function downloadText(content, fileName, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildFileName(prefix, ext) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${prefix}_${stamp}.${ext}`;
}

function resolveHospitalApprovalStatus(row) {
  const statusKey = normalizeKey(row?.Approval_Status);
  if (statusKey === 'approved') return 'approved';
  if (statusKey === 'rejected') return 'rejected';
  if (statusKey === 'pending') return 'pending';
  return row?.Is_Approved ? 'approved' : 'pending';
}

function labelFromKey(key) {
  if (key === 'pendingstaffreview') return 'Pending Staff Review';
  if (key === 'pendingadmindecision') return 'Pending Admin Decision';
  if (key === 'approved') return 'Approved';
  if (key === 'rejected') return 'Rejected';
  if (key === 'appealed') return 'Appealed';
  if (key === 'cancelled') return 'Cancelled';
  if (key === 'ended') return 'Ended';
  if (key === 'cut') return 'Cut';
  if (key === 'bundling') return 'Bundling';
  if (key === 'wigcreated') return 'Wig Created';
  if (key === 'rejectedcut') return 'Rejected Cut';
  if (key === 'pendingadminapproval') return 'Pending Admin Approval';
  if (key === 'acceptedallocatedwig') return 'Accepted - Wig Allocated';
  if (key === 'acceptednowigavailable') return 'Accepted - No Wig Available';
  if (key === 'inproduction') return 'In Production';
  if (key === 'toberelease') return 'To Be Release';
  if (key === 'releasing') return 'Releasing';
  if (key === 'released' || key === 'completed') return 'Completed';
  if (key === 'withdrawn') return 'Withdrawn';
  if (key === 'closed') return 'Closed';
  if (key === 'private') return 'Private';
  if (key === 'public') return 'Public';
  return key ? key.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Unknown';
}

function pendingLikeStatus(statusKey) {
  if (!statusKey) return false;
  if (statusKey.includes('pending')) return true;
  if (statusKey.includes('appealed')) return true;
  if (statusKey.includes('inproduction')) return true;
  if (statusKey.includes('toberelease')) return true;
  if (statusKey.includes('releasing')) return true;
  return false;
}

function approvedLikeStatus(statusKey) {
  if (!statusKey) return false;
  return statusKey.includes('approved') || statusKey.includes('completed') || statusKey.includes('released');
}

function rejectedLikeStatus(statusKey) {
  if (!statusKey) return false;
  return statusKey.includes('rejected') || statusKey.includes('cancelled');
}

// Every chart / KPI color pulls from UI_Settings (theme) so the palette stays
// in lock-step with the admin's chosen brand colors. We use the 9 brand
// variants (primary / secondary / tertiary, each in base/dark/light) to give
// distinct hues to the semantic states.
function buildStatusPalette(theme) {
  return {
    pendingStaff: theme?.primaryColorLight || '#0a8ef5',     // light primary  â€” in progress
    pendingAdmin: theme?.secondaryColor || '#6B7280',         // secondary      â€” awaiting decision
    approved: theme?.tertiaryColor || '#10b981',              // tertiary       â€” success
    rejected: theme?.primaryColorDark || '#025aa3',           // dark primary   â€” halted / rejected
    appealed: theme?.tertiaryColorLight || '#34d399',         // light tertiary â€” appeal
    neutral: theme?.secondaryColorLight || '#9CA3AF',         // light secondary â€” neutral / withdrawn
    primary: theme?.primaryColor || '#0275d8',                // primary brand  â€” total / main
  };
}

function colorForStatus(statusKey, palette) {
  if (!statusKey) return palette.neutral;
  if (statusKey === 'pendingstaffreview') return palette.pendingStaff;
  if (statusKey === 'pendingadmindecision' || statusKey === 'pendingadminapproval') return palette.pendingAdmin;
  if (statusKey.includes('appealed')) return palette.appealed;
  if (approvedLikeStatus(statusKey)) return palette.approved;
  if (rejectedLikeStatus(statusKey)) return palette.rejected;
  if (pendingLikeStatus(statusKey)) return palette.pendingStaff;
  if (statusKey === 'active') return palette.approved;
  if (statusKey === 'inactive') return palette.neutral;
  return palette.neutral;
}

function statusBadgeClass(statusKey) {
  if (!statusKey) return 'border-slate-200 bg-slate-50 text-slate-700';
  if (statusKey === 'pendingstaffreview') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (statusKey === 'pendingadmindecision' || statusKey === 'pendingadminapproval') return 'border-sky-200 bg-sky-50 text-sky-700';
  if (statusKey.includes('appealed')) return 'border-violet-200 bg-violet-50 text-violet-700';
  if (approvedLikeStatus(statusKey)) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (rejectedLikeStatus(statusKey)) return 'border-rose-200 bg-rose-50 text-rose-700';
  if (pendingLikeStatus(statusKey)) return 'border-amber-200 bg-amber-50 text-amber-700';
  if (statusKey === 'active') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (statusKey === 'inactive') return 'border-slate-200 bg-slate-50 text-slate-700';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

function applicantFullName(row) {
  return [
    row?.Applicant_First_Name,
    row?.Applicant_Middle_Name,
    row?.Applicant_Last_Name,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ') || 'Unknown applicant';
}

function roleLabel(value) {
  const key = normalizeKey(value);
  if (key === 'admin') return 'Admin';
  if (key === 'staff') return 'Staff';
  if (key === 'specialist') return 'Specialist';
  if (key === 'hrepresentative' || key === 'hospital') return 'H-Representative';
  return value || 'Unknown';
}

function templateCatalogForRole(roleKey, theme) {
  const isAdmin = roleKey === 'admin';
  const primary = theme?.primaryColor || '#0275d8';
  const secondary = theme?.secondaryColor || '#6B7280';
  const secondaryLight = theme?.secondaryColorLight || '#9CA3AF';
  const tertiary = theme?.tertiaryColor || '#10b981';
  const tertiaryLight = theme?.tertiaryColorLight || '#34d399';

  const base = [
    {
      id: 'event_applications',
      name: 'Event Applications',
      shortName: 'Events',
      description: 'Public event submissions and current intake status.',
      icon: ClipboardList,
      accent: primary,
      page: isAdmin ? 'manage-event-applications' : 'event-application-intake',
      exportPrefix: 'event_applications',
      columns: [
        { key: 'recordId', label: 'Application ID' },
        { key: 'eventName', label: 'Event Name' },
        { key: 'applicant', label: 'Applicant' },
        { key: 'statusLabel', label: 'Status' },
        { key: 'preferredContact', label: 'Preferred Contact' },
        { key: 'linkedRequest', label: 'Linked Event Request' },
        { key: 'createdAtLabel', label: 'Submitted At' },
      ],
    },
    {
      id: 'event_requests',
      name: isAdmin ? 'Event Requests' : 'Assigned Event Requests',
      shortName: 'Requests',
      description: isAdmin
        ? 'Staff-submitted event requests for admin decision and assignment.'
        : 'Events currently assigned to this staff account.',
      icon: Send,
      accent: tertiary,
      page: isAdmin ? 'manage-event-applications' : 'assigned-event-operations',
      exportPrefix: 'event_requests',
      columns: [
        { key: 'recordId', label: 'Request ID' },
        { key: 'eventName', label: 'Event Name' },
        { key: 'statusLabel', label: 'Status' },
        { key: 'eventVisibility', label: 'Visibility' },
        { key: 'assignedStaff', label: 'Assigned Staff' },
        { key: 'schedule', label: 'Schedule' },
        { key: 'createdAtLabel', label: 'Created At' },
      ],
    },
    {
      id: 'wig_requests',
      name: 'Wig Requests',
      shortName: 'Wigs',
      description: 'Wig request pipeline by current status and recency.',
      icon: Package,
      accent: tertiaryLight,
      page: 'update-wig-request-status',
      exportPrefix: 'wig_requests',
      columns: [
        { key: 'recordId', label: 'Wig Request ID' },
        { key: 'statusLabel', label: 'Status' },
        { key: 'hospitalId', label: 'Hospital' },
        { key: 'patientId', label: 'Patient' },
        { key: 'statusReason', label: 'Status Reason' },
        { key: 'requestDateLabel', label: 'Request Date' },
        { key: 'updatedAtLabel', label: 'Updated At' },
      ],
    },
    {
      id: 'cut_hair_inventory',
      name: 'Cut Hair Inventory',
      shortName: 'Hair Inventory',
      description: 'Approved cut hair tracked through bundling and wig creation.',
      icon: Boxes,
      accent: tertiary,
      page: 'cut-hair-inventory',
      exportPrefix: 'cut_hair_inventory',
      columns: [
        { key: 'recordId', label: 'Inventory ID' },
        { key: 'submissionId', label: 'Submission' },
        { key: 'eventName', label: 'Event / Source' },
        { key: 'statusLabel', label: 'Inventory Status' },
        { key: 'bundleLabel', label: 'Bundle' },
        { key: 'wigLabel', label: 'Wig' },
        { key: 'createdAtLabel', label: 'Approved At' },
      ],
    },
    {
      id: 'ai_hair_accuracy',
      name: 'AI Hair Scan Accuracy',
      shortName: 'AI Accuracy',
      description: 'AI predictions compared with final staff observations and corrections.',
      icon: AlertTriangle,
      accent: secondary,
      page: 'reports',
      exportPrefix: 'ai_hair_accuracy',
      columns: [
        { key: 'recordId', label: 'Comparison ID' },
        { key: 'submissionId', label: 'Submission' },
        { key: 'eventName', label: 'Event' },
        { key: 'sourceLabel', label: 'Scan Source' },
        { key: 'statusLabel', label: 'Final Decision' },
        { key: 'accuracyLabel', label: 'AI Accuracy' },
        { key: 'criticalChanges', label: 'Critical Corrections' },
        { key: 'minorChanges', label: 'Minor Corrections' },
        { key: 'createdAtLabel', label: 'Reviewed At' },
      ],
    },
  ];

  if (isAdmin) {
    base.splice(2, 0, {
      id: 'hospital_applications',
      name: 'Hospital Applications',
      shortName: 'Hospitals',
      description: 'Hospital partnership applications and approval status.',
      icon: Building2,
      accent: secondary,
      page: 'manage-hospital-accounts',
      exportPrefix: 'hospital_applications',
      columns: [
        { key: 'recordId', label: 'Hospital ID' },
        { key: 'hospitalName', label: 'Hospital Name' },
        { key: 'headName', label: 'Head / Owner' },
        { key: 'statusLabel', label: 'Approval Status' },
        { key: 'contactNumber', label: 'Contact Number' },
        { key: 'createdAtLabel', label: 'Submitted At' },
      ],
    });

    base.splice(4, 0, {
      id: 'user_accounts',
      name: 'User Accounts',
      shortName: 'Users',
      description: 'Role and status overview for system accounts.',
      icon: Users,
      accent: secondaryLight,
      page: 'manage-user-accounts',
      exportPrefix: 'user_accounts',
      columns: [
        { key: 'recordId', label: 'User ID' },
        { key: 'email', label: 'Email' },
        { key: 'roleLabel', label: 'Role' },
        { key: 'statusLabel', label: 'Account Status' },
        { key: 'accessWindow', label: 'Access Window' },
        { key: 'createdAtLabel', label: 'Created At' },
      ],
    });
  }

  return base;
}

export default function RoleReportsPage({ userProfile, onNavigate }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#475569';
  const fontFamily = theme?.fontFamily || 'Poppins';
  const headingFontFamily = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const palette = useMemo(() => buildStatusPalette(theme), [theme]);

  const roleKey = normalizeKey(userProfile?.role);
  const isAdmin = roleKey === 'admin';
  const templates = useMemo(() => templateCatalogForRole(roleKey, theme), [roleKey, theme]);

  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id || '');
  const [rawRows, setRawRows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [staffUserId, setStaffUserId] = useState(Number(userProfile?.user_id || 0) || null);

  useEffect(() => {
    if (!selectedTemplateId && templates[0]?.id) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, selectedTemplateId]);

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId) || templates[0] || null,
    [templates, selectedTemplateId],
  );

  const resolveStaffUserId = useCallback(async () => {
    if (staffUserId) return staffUserId;
    if (!supabase) return null;

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData?.session?.user?.id) return null;

    const authUserId = sessionData.session.user.id;
    const profileResult = await supabase
      .from(USERS_TABLE)
      .select('user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    const resolved = Number(profileResult?.data?.user_id || 0) || null;
    if (resolved) setStaffUserId(resolved);
    return resolved;
  }, [staffUserId]);

  const loadTemplateRows = useCallback(async () => {
    if (!selectedTemplate) return;
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      setRawRows([]);
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });

    try {
      let mappedRows = [];

      if (selectedTemplate.id === 'event_applications') {
        const result = await supabase
          .from(EVENT_APPLICATIONS_TABLE)
          .select('Event_Application_ID,Event_Name,Status,Preferred_Contact_Method,Linked_Event_Request_ID,Created_At,Updated_At,Applicant_First_Name,Applicant_Middle_Name,Applicant_Last_Name')
          .order('Created_At', { ascending: false })
          .limit(2000);
        if (result.error) throw result.error;

        mappedRows = (result.data || []).map((row) => {
          const statusKey = normalizeKey(row.Status);
          const linked = Number(row.Linked_Event_Request_ID || 0);
          return {
            recordId: `EA-${row.Event_Application_ID}`,
            eventName: row.Event_Name || 'Untitled Event',
            applicant: applicantFullName(row),
            statusKey,
            statusLabel: labelFromKey(statusKey),
            preferredContact: row.Preferred_Contact_Method || 'N/A',
            linkedRequest: linked > 0 ? `ER-${linked}` : 'None',
            createdAt: row.Created_At || null,
            updatedAt: row.Updated_At || null,
            createdAtLabel: formatDateTime(row.Created_At),
            updatedAtLabel: formatDateTime(row.Updated_At),
            searchText: [
              `EA-${row.Event_Application_ID}`,
              row.Event_Name,
              applicantFullName(row),
              row.Status,
              row.Preferred_Contact_Method,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
          };
        });
      } else if (selectedTemplate.id === 'event_requests') {
        let query = supabase
          .from(EVENT_REQUESTS_TABLE)
          .select('Event_Request_ID,Event_Name,Status,Event_Visibility,Assigned_Staff_User_ID,Start_Date,End_Date,Created_At,Updated_At')
          .order('Created_At', { ascending: false })
          .limit(2000);

        if (!isAdmin) {
          const resolved = await resolveStaffUserId();
          if (!resolved) {
            throw new Error('Unable to resolve your staff account for assigned event reports.');
          }
          query = query.eq('Assigned_Staff_User_ID', resolved);
        }

        const result = await query;
        if (result.error) throw result.error;

        mappedRows = (result.data || []).map((row) => {
          const statusKey = normalizeKey(row.Status);
          const visibility = normalizeKey(row.Event_Visibility) === 'private' ? 'Private' : 'Public';
          return {
            recordId: `ER-${row.Event_Request_ID}`,
            eventName: row.Event_Name || 'Untitled Event',
            statusKey,
            statusLabel: labelFromKey(statusKey),
            eventVisibility: visibility,
            assignedStaff: row.Assigned_Staff_User_ID ? `User #${row.Assigned_Staff_User_ID}` : 'Not assigned',
            schedule: `${formatShortDate(row.Start_Date)} - ${formatShortDate(row.End_Date)}`,
            createdAt: row.Created_At || null,
            updatedAt: row.Updated_At || null,
            createdAtLabel: formatDateTime(row.Created_At),
            updatedAtLabel: formatDateTime(row.Updated_At),
            searchText: [
              `ER-${row.Event_Request_ID}`,
              row.Event_Name,
              row.Status,
              visibility,
              row.Assigned_Staff_User_ID,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
          };
        });
      } else if (selectedTemplate.id === 'hospital_applications') {
        const result = await supabase
          .from(HOSPITALS_TABLE)
          .select('Hospital_ID,Hospital_Name,Approval_Status,Is_Approved,Hospital_Head_Name,Contact_Number,Created_At,Updated_At')
          .order('Created_At', { ascending: false })
          .limit(2000);
        if (result.error) throw result.error;

        mappedRows = (result.data || []).map((row) => {
          const statusKey = resolveHospitalApprovalStatus(row);
          return {
            recordId: `H-${row.Hospital_ID}`,
            hospitalName: row.Hospital_Name || 'Unnamed Hospital',
            headName: row.Hospital_Head_Name || 'N/A',
            statusKey,
            statusLabel: labelFromKey(statusKey),
            contactNumber: row.Contact_Number || 'N/A',
            createdAt: row.Created_At || null,
            updatedAt: row.Updated_At || null,
            createdAtLabel: formatDateTime(row.Created_At),
            updatedAtLabel: formatDateTime(row.Updated_At),
            searchText: [
              `H-${row.Hospital_ID}`,
              row.Hospital_Name,
              row.Hospital_Head_Name,
              row.Contact_Number,
              row.Approval_Status,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
          };
        });
      } else if (selectedTemplate.id === 'wig_requests') {
        const result = await supabase
          .from(WIG_REQUESTS_TABLE)
          .select('Req_ID,Hospital_ID,Patient_ID,Status,Status_Reason,Request_Date,Updated_At')
          .order('Request_Date', { ascending: false })
          .limit(2000);
        if (result.error) throw result.error;

        mappedRows = (result.data || []).map((row) => {
          const statusKey = normalizeKey(row.Status);
          return {
            recordId: `WR-${String(row.Req_ID || '').padStart(4, '0')}`,
            statusKey,
            statusLabel: labelFromKey(statusKey),
            hospitalId: row.Hospital_ID ? `H-${row.Hospital_ID}` : 'N/A',
            patientId: row.Patient_ID ? `P-${row.Patient_ID}` : 'N/A',
            statusReason: row.Status_Reason || 'N/A',
            requestDate: row.Request_Date || null,
            requestDateLabel: formatDateTime(row.Request_Date),
            createdAt: row.Request_Date || null,
            updatedAt: row.Updated_At || null,
            createdAtLabel: formatDateTime(row.Request_Date),
            updatedAtLabel: formatDateTime(row.Updated_At),
            searchText: [
              `WR-${row.Req_ID}`,
              row.Status,
              row.Status_Reason,
              row.Hospital_ID,
              row.Patient_ID,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
          };
        });
      } else if (selectedTemplate.id === 'cut_hair_inventory') {
        const result = await supabase
          .from('Cut_Hair_Inventory')
          .select('Inventory_ID,Submission_ID,Event_Request_ID,Source_Type,Status,Bundle_ID,Wig_ID,Approved_At,Updated_At')
          .order('Approved_At', { ascending: false })
          .limit(3000);
        if (result.error) throw result.error;
        const inventoryRows = result.data || [];
        const eventIds = [...new Set(inventoryRows.map((row) => Number(row.Event_Request_ID || 0)).filter(Boolean))];
        let eventsById = new Map();
        if (eventIds.length) {
          const eventResult = await supabase
            .from(EVENT_REQUESTS_TABLE)
            .select('Event_Request_ID,Event_Name')
            .in('Event_Request_ID', eventIds);
          if (eventResult.error) throw eventResult.error;
          eventsById = new Map((eventResult.data || []).map((row) => [Number(row.Event_Request_ID), row]));
        }
        mappedRows = inventoryRows.map((row) => {
          const statusKey = normalizeKey(row.Status);
          const eventName = eventsById.get(Number(row.Event_Request_ID))?.Event_Name
            || (row.Source_Type === 'Non-Event' ? 'Non-event donation' : `Event #${row.Event_Request_ID || 'N/A'}`);
          return {
            recordId: `CHI-${String(row.Inventory_ID).padStart(6, '0')}`,
            submissionId: `Submission #${row.Submission_ID}`,
            eventName,
            statusKey,
            statusLabel: labelFromKey(statusKey),
            bundleLabel: row.Bundle_ID ? `Bundle #${row.Bundle_ID}` : 'Not bundled',
            wigLabel: row.Wig_ID ? `Wig #${row.Wig_ID}` : 'No wig yet',
            createdAt: row.Approved_At,
            updatedAt: row.Updated_At,
            createdAtLabel: formatDateTime(row.Approved_At),
            updatedAtLabel: formatDateTime(row.Updated_At),
            searchText: [row.Inventory_ID, row.Submission_ID, eventName, row.Source_Type, row.Status, row.Bundle_ID, row.Wig_ID].filter(Boolean).join(' ').toLowerCase(),
          };
        });
      } else if (selectedTemplate.id === 'ai_hair_accuracy') {
        const result = await supabase
          .from('Hair_AI_Review_Comparisons')
          .select('Comparison_ID,Submission_ID,Event_Request_ID,Is_AI_Source,Changed_Fields,Critical_Changed_Fields,Minor_Changed_Fields,AI_Accuracy_Percent,Final_Decision,Reviewed_At,Updated_At')
          .order('Reviewed_At', { ascending: false, nullsFirst: false })
          .limit(3000);
        if (result.error) throw result.error;
        const comparisonRows = result.data || [];
        const eventIds = [...new Set(comparisonRows.map((row) => Number(row.Event_Request_ID || 0)).filter(Boolean))];
        let eventsById = new Map();
        if (eventIds.length) {
          const eventResult = await supabase
            .from(EVENT_REQUESTS_TABLE)
            .select('Event_Request_ID,Event_Name')
            .in('Event_Request_ID', eventIds);
          if (eventResult.error) throw eventResult.error;
          eventsById = new Map((eventResult.data || []).map((row) => [Number(row.Event_Request_ID), row]));
        }
        mappedRows = comparisonRows.map((row) => {
          const statusKey = normalizeKey(row.Final_Decision || 'Pending');
          const eventName = eventsById.get(Number(row.Event_Request_ID))?.Event_Name || `Event #${row.Event_Request_ID || 'N/A'}`;
          const critical = Array.isArray(row.Critical_Changed_Fields) ? row.Critical_Changed_Fields : [];
          const minor = Array.isArray(row.Minor_Changed_Fields) ? row.Minor_Changed_Fields : [];
          return {
            recordId: `AI-${String(row.Comparison_ID).padStart(6, '0')}`,
            submissionId: `Submission #${row.Submission_ID}`,
            eventName,
            sourceLabel: row.Is_AI_Source ? 'AI Analysis' : 'Manual',
            statusKey,
            statusLabel: labelFromKey(statusKey),
            accuracyLabel: row.Is_AI_Source
              ? (row.AI_Accuracy_Percent == null ? 'Pending' : `${row.AI_Accuracy_Percent}%`)
              : 'Manual source',
            criticalChanges: critical.length ? critical.join(', ') : 'None',
            minorChanges: minor.length ? minor.join(', ') : 'None',
            createdAt: row.Reviewed_At,
            updatedAt: row.Updated_At,
            createdAtLabel: formatDateTime(row.Reviewed_At),
            updatedAtLabel: formatDateTime(row.Updated_At),
            searchText: [row.Comparison_ID, row.Submission_ID, eventName, row.Final_Decision, ...critical, ...minor].filter(Boolean).join(' ').toLowerCase(),
          };
        });
      } else if (selectedTemplate.id === 'user_accounts' && isAdmin) {
        const result = await supabase
          .from(USERS_TABLE)
          .select('user_id,email,role,is_active,access_start,access_end,created_at')
          .order('created_at', { ascending: false })
          .limit(2000);
        if (result.error) throw result.error;

        mappedRows = (result.data || []).map((row) => {
          const statusKey = row?.is_active === false ? 'inactive' : 'active';
          return {
            recordId: `U-${row.user_id}`,
            email: row.email || 'N/A',
            roleLabel: roleLabel(row.role),
            statusKey,
            statusLabel: statusKey === 'active' ? 'Active' : 'Inactive',
            accessWindow: row.access_start || row.access_end
              ? `${formatShortDate(row.access_start)} to ${formatShortDate(row.access_end)}`
              : 'No access window',
            createdAt: row.created_at || null,
            updatedAt: row.created_at || null,
            createdAtLabel: formatDateTime(row.created_at),
            updatedAtLabel: formatDateTime(row.created_at),
            searchText: [
              `U-${row.user_id}`,
              row.email,
              row.role,
              statusKey,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
          };
        });
      }

      setRawRows(mappedRows);
      setLastRefreshedAt(new Date().toISOString());
    } catch (error) {
      setRawRows([]);
      setNotice({ kind: 'error', text: error.message || 'Unable to load report data.' });
    } finally {
      setIsLoading(false);
    }
  }, [selectedTemplate, isAdmin, resolveStaffUserId]);

  useEffect(() => {
    setStatusFilter('all');
    setSearchTerm('');
    void loadTemplateRows();
  }, [loadTemplateRows, selectedTemplateId]);

  const statusOptions = useMemo(() => {
    const unique = [...new Set(rawRows.map((row) => row.statusLabel).filter(Boolean))];
    return ['all', ...unique];
  }, [rawRows]);

  const filteredRows = useMemo(() => {
    return rawRows.filter((row) => {
      if (statusFilter !== 'all' && row.statusLabel !== statusFilter) return false;
      if ((dateFrom || dateTo) && !withinDateRange(row.createdAt, dateFrom, dateTo)) return false;
      if (searchTerm.trim()) {
        const query = searchTerm.trim().toLowerCase();
        if (!String(row.searchText || '').includes(query)) return false;
      }
      return true;
    });
  }, [rawRows, statusFilter, dateFrom, dateTo, searchTerm]);

  const summary = useMemo(() => {
    const total = filteredRows.length;
    const pending = filteredRows.filter((row) => pendingLikeStatus(row.statusKey)).length;
    const approved = filteredRows.filter((row) => approvedLikeStatus(row.statusKey)).length;
    const rejected = filteredRows.filter((row) => rejectedLikeStatus(row.statusKey)).length;
    return { total, pending, approved, rejected };
  }, [filteredRows]);

  const pct = (value, total) => (total > 0 ? Math.round((value / total) * 100) : 0);

  const statusChartData = useMemo(() => {
    const map = new Map();
    filteredRows.forEach((row) => {
      const name = row.statusLabel || 'Unknown';
      if (!map.has(name)) {
        map.set(name, {
          name,
          value: 0,
          statusKey: row.statusKey,
          color: colorForStatus(row.statusKey, palette),
        });
      }
      map.get(name).value += 1;
    });
    return Array.from(map.values());
  }, [filteredRows, palette]);

  const recentTrend = useMemo(() => {
    const frame = buildRecent7DayFrame();
    const byDay = new Map(frame.map((row) => [row.dayKey, row]));
    filteredRows.forEach((row) => {
      const key = toDayKey(row.createdAt);
      if (!byDay.has(key)) return;
      byDay.get(key).value += 1;
    });
    return frame;
  }, [filteredRows]);

  const exportCsv = async () => {
    if (!selectedTemplate || filteredRows.length === 0) return;
    setIsExporting(true);
    try {
      const header = selectedTemplate.columns.map((column) => csvEscape(column.label)).join(',');
      const rows = filteredRows.map((row) => selectedTemplate.columns.map((column) => csvEscape(row[column.key] ?? '')).join(','));
      const content = [header, ...rows].join('\n');
      const fileName = buildFileName(selectedTemplate.exportPrefix, 'csv');
      downloadText(content, fileName, 'text/csv;charset=utf-8;');
      setNotice({ kind: 'success', text: `CSV generated: ${fileName}` });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to export CSV.' });
    } finally {
      setIsExporting(false);
    }
  };

  const exportPdf = async () => {
    if (!selectedTemplate || filteredRows.length === 0) return;
    setIsExporting(true);
    try {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const margin = 10;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const tableWidth = pageWidth - margin * 2;
      const columnWidth = tableWidth / selectedTemplate.columns.length;

      let y = margin;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text(selectedTemplate.name, margin, y);
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.text(`Generated: ${formatDateTime(new Date().toISOString())}`, margin, y);
      y += 8;

      doc.setFillColor(240, 244, 248);
      doc.rect(margin, y, tableWidth, 7, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      selectedTemplate.columns.forEach((column, index) => {
        doc.text(String(column.label || ''), margin + index * columnWidth + 1.2, y + 4.7);
      });
      y += 7;

      doc.setFont('helvetica', 'normal');
      const previewRows = filteredRows.slice(0, 600);
      previewRows.forEach((row, rowIndex) => {
        if (y > pageHeight - margin - 7) {
          doc.addPage('a4', 'landscape');
          y = margin;
          doc.setFillColor(240, 244, 248);
          doc.rect(margin, y, tableWidth, 7, 'F');
          doc.setFont('helvetica', 'bold');
          selectedTemplate.columns.forEach((column, index) => {
            doc.text(String(column.label || ''), margin + index * columnWidth + 1.2, y + 4.7);
          });
          doc.setFont('helvetica', 'normal');
          y += 7;
        }

        if (rowIndex % 2 === 1) {
          doc.setFillColor(250, 251, 252);
          doc.rect(margin, y, tableWidth, 6, 'F');
        }

        selectedTemplate.columns.forEach((column, index) => {
          const raw = String(row[column.key] ?? '');
          const maxChars = Math.max(8, Math.floor(columnWidth * 1.9));
          const clipped = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}...` : raw;
          doc.text(clipped, margin + index * columnWidth + 1.2, y + 4);
        });

        y += 6;
      });

      const fileName = buildFileName(selectedTemplate.exportPrefix, 'pdf');
      doc.save(fileName);
      setNotice({ kind: 'success', text: `PDF generated: ${fileName}` });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to export PDF.' });
    } finally {
      setIsExporting(false);
    }
  };

  if (!selectedTemplate) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        No report templates are available for this role.
      </div>
    );
  }

  const SelectedIcon = selectedTemplate.icon || ClipboardList;

  const kpiTiles = [
    {
      key: 'total',
      label: 'Total Records',
      value: summary.total,
      pctValue: summary.total > 0 ? 100 : 0,
      icon: SelectedIcon,
      accent: palette.primary,
    },
    {
      key: 'pending',
      label: 'Pending / In Flight',
      value: summary.pending,
      pctValue: pct(summary.pending, summary.total),
      icon: Clock3,
      accent: palette.pendingStaff,
    },
    {
      key: 'approved',
      label: 'Approved / Completed',
      value: summary.approved,
      pctValue: pct(summary.approved, summary.total),
      icon: CheckCircle2,
      accent: palette.approved,
    },
    {
      key: 'rejected',
      label: 'Rejected / Cancelled',
      value: summary.rejected,
      pctValue: pct(summary.rejected, summary.total),
      icon: XCircle,
      accent: palette.rejected,
    },
  ];

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
            {isAdmin ? 'Admin Reports' : 'Staff Reports'}
          </h1>
          <p className="text-sm" style={{ color: secondaryTextColor }}>
            Filter, visualize, and export data on events, wigs, and partner activity.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="hidden sm:inline">Last refreshed: <strong className="font-semibold text-slate-700">{lastRefreshedAt ? formatDateTime(lastRefreshedAt) : 'â€”'}</strong></span>
          <button
            type="button"
            onClick={() => loadTemplateRows()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={isExporting || filteredRows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
          >
            {isExporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            CSV
          </button>
          <button
            type="button"
            onClick={exportPdf}
            disabled={isExporting || filteredRows.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
            style={{ backgroundColor: primaryColor }}
          >
            <FileText size={13} />
            PDF
          </button>
        </div>
      </div>

      {notice.text && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {notice.kind === 'error' ? <AlertTriangle size={14} className="mt-0.5 flex-none" /> : <CheckCircle2 size={14} className="mt-0.5 flex-none" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Template selector â€” underlined tabs */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex flex-wrap gap-x-5 gap-y-1" aria-label="Report templates">
          {templates.map((template) => {
            const Icon = template.icon || ClipboardList;
            const isActive = selectedTemplate.id === template.id;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => setSelectedTemplateId(template.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`-mb-px inline-flex items-center gap-2 border-b-2 px-1 pb-3 pt-2 text-sm font-semibold transition-colors ${
                  isActive ? '' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                }`}
                style={isActive ? { borderColor: template.accent, color: template.accent } : undefined}
              >
                <Icon size={14} />
                {template.name}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Filters bar */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_2fr]">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">From Date</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">To Date</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option === 'all' ? 'All statuses' : option}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Search</span>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by id, name, status..."
                className="w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
              />
            </div>
          </label>
        </div>
      </div>

      {/* KPI tiles */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpiTiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <div
              key={tile.key}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-lg text-white shadow-sm"
                  style={{ backgroundColor: tile.accent }}
                >
                  <Icon size={15} />
                </div>
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold"
                  style={{ borderColor: `${tile.accent}33`, color: tile.accent, backgroundColor: `${tile.accent}10` }}
                >
                  {tile.pctValue}%
                </span>
              </div>
              <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-slate-500">{tile.label}</p>
              <p className="mt-1 text-3xl font-bold leading-none text-slate-900">{tile.value}</p>
            </div>
          );
        })}
      </section>

      {/* Charts row */}
      <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-800">{selectedTemplate.shortName || 'Report'} Statistics</h3>
              <p className="text-xs text-slate-500">Records grouped by current status</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: selectedTemplate.accent }} />
              {selectedTemplate.shortName}
            </span>
          </div>
          <div className="mt-3 h-56">
            {statusChartData.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
                No data for selected filters.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusChartData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={48} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: '#f1f5f9' }} />
                  <Bar dataKey="value" name="Records" radius={[6, 6, 0, 0]}>
                    {statusChartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-7">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-800">7-Day Activity Overview</h3>
              <p className="text-xs text-slate-500">Records created per day (within current filters)</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
              <Calendar size={11} />
              Last 7 days
            </span>
          </div>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={recentTrend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="reportTrendGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={primaryColor} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={primaryColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Area
                  type="monotone"
                  dataKey="value"
                  name="Records"
                  stroke={primaryColor}
                  strokeWidth={2.2}
                  fill="url(#reportTrendGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      {/* Preview table */}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-white shadow-sm"
              style={{ backgroundColor: selectedTemplate.accent }}
            >
              <SelectedIcon size={14} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">{selectedTemplate.name} Preview</h3>
              <p className="text-[11px] text-slate-500">
                {filteredRows.length} record{filteredRows.length === 1 ? '' : 's'}
                {rawRows.length !== filteredRows.length ? ` (filtered from ${rawRows.length})` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => typeof onNavigate === 'function' && onNavigate(selectedTemplate.page)}
            className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
            style={{ color: primaryColor }}
          >
            Open related page
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-slate-600">
            <Loader2 size={16} className="animate-spin" />
            Loading report rows...
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="flex flex-col items-center px-5 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <Search size={18} />
            </div>
            <p className="mt-2.5 text-sm font-semibold text-slate-700">No matching records</p>
            <p className="text-xs text-slate-500">Adjust filters or clear search to see more results.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {selectedTemplate.columns.map((column) => (
                    <th
                      key={column.key}
                      className="px-5 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-500"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, 200).map((row) => (
                  <tr
                    key={`${row.recordId}-${row.createdAt || row.updatedAt || Math.random()}`}
                    className="border-t border-slate-100 transition hover:bg-slate-50/50"
                  >
                    {selectedTemplate.columns.map((column) => {
                      const cellValue = row[column.key];
                      if (column.key === 'statusLabel') {
                        return (
                          <td key={`${row.recordId}-${column.key}`} className="px-5 py-2.5">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusBadgeClass(row.statusKey)}`}
                            >
                              {cellValue}
                            </span>
                          </td>
                        );
                      }
                      if (column.key === 'recordId') {
                        return (
                          <td key={`${row.recordId}-${column.key}`} className="px-5 py-2.5">
                            <span className="font-mono text-xs font-semibold text-slate-700">{cellValue}</span>
                          </td>
                        );
                      }
                      return (
                        <td key={`${row.recordId}-${column.key}`} className="px-5 py-2.5 text-slate-700">
                          {String(cellValue ?? 'N/A')}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredRows.length > 200 && (
              <div className="border-t border-slate-100 bg-slate-50 px-5 py-2 text-[11px] text-slate-500">
                Preview shows first 200 rows. Export CSV or PDF for the complete data set.
              </div>
            )}
          </div>
        )}
      </section>

      {(selectedTemplate.id === 'hospital_applications' && !isAdmin) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={13} className="mt-0.5 flex-none" />
          <span>Hospital application reports are admin-only.</span>
        </div>
      )}
    </div>
  );
}
