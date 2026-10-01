import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Boxes,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Download,
  FileText,
  Loader2,
  Package,
  Search,
  ScanLine,
  Send,
  UserPlus,
  Users,
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
  LabelList,
} from 'recharts';
import PageHeaderActions from '../../../components/PageHeaderActions';
import ProgramScheduleCalendarModal, {
  formatScheduleDateLabel,
  scheduleDateKeysForRecord,
} from '../../../components/events/ProgramScheduleCalendarModal';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const EVENT_REQUESTS_TABLE = 'Event_Requests';
const HOSPITALS_TABLE = 'Hospitals';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const USERS_TABLE = 'users';
const PROGRAM_LIFECYCLE_COLORS = {
  applications: '#6b1010',
  pending: '#d97706',
  approved: '#2563eb',
  rejected: '#dc2626',
  ended: '#64748b',
  successful: '#059669',
  cancelled: '#d97706',
};

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const raw = String(value).trim();
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized) ? normalized : `${normalized}+08:00`);
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
  const raw = String(value).trim();
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = new Date(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized) ? normalized : `${normalized}+08:00`);
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
  if (key === 'appealed') return 'Concern Reported';
  if (key === 'returnedcompleted') return 'Returned - Completed';
  if (key === 'cancelled') return 'Cancelled';
  if (key === 'ended') return 'Ended';
  if (key === 'successful') return 'Successful';
  if (key === 'cut') return 'Cut';
  if (key === 'bundling') return 'Bundling';
  if (key === 'wiginproduction') return 'Wig In Production';
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
  return statusKey.includes('approved') || statusKey.includes('completed') || statusKey.includes('released') || statusKey === 'successful';
}

function rejectedLikeStatus(statusKey) {
  if (!statusKey) return false;
  return statusKey.includes('rejected');
}

function manilaDateParts(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return parts;
}

function emptyProgramLifecycleBucket(label, key) {
  return {
    label,
    key,
    applications: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    ended: 0,
    successful: 0,
    cancelled: 0,
  };
}

function addProgramLifecycleMilestones(counts, statusKey) {
  if (statusKey === 'successful') {
    counts.approved += 1;
    counts.ended += 1;
    counts.successful += 1;
    return;
  }
  if (statusKey === 'ended') {
    counts.approved += 1;
    counts.ended += 1;
    return;
  }
  if (statusKey === 'approved') {
    counts.approved += 1;
    return;
  }
  if (statusKey === 'rejected') {
    counts.rejected += 1;
    return;
  }
  if (statusKey === 'cancelled') {
    counts.cancelled += 1;
    return;
  }
  counts.pending += 1;
}

function buildProgramLifecycleSeries(grouping, selectedMonth, selectedYear, rows) {
  const currentYear = new Date().getFullYear();
  const year = Number(selectedYear) || currentYear;
  const [monthYear, monthNumber] = String(selectedMonth || '').split('-').map(Number);
  let buckets = [];
  let bucketKeyForParts = () => null;

  if (grouping === 'weekly') {
    const targetYear = monthYear || currentYear;
    const targetMonth = monthNumber || 1;
    const weekCount = Math.ceil(new Date(targetYear, targetMonth, 0).getDate() / 7);
    buckets = Array.from({ length: weekCount }, (_, index) => emptyProgramLifecycleBucket(`Week ${index + 1}`, `${targetYear}-${targetMonth}-${index + 1}`));
    bucketKeyForParts = (parts) => (
      parts?.year === targetYear && parts?.month === targetMonth
        ? `${targetYear}-${targetMonth}-${Math.floor((parts.day - 1) / 7) + 1}`
        : null
    );
  } else if (grouping === 'monthly') {
    const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    buckets = monthLabels.map((label, index) => emptyProgramLifecycleBucket(label, `${year}-${index + 1}`));
    bucketKeyForParts = (parts) => (parts?.year === year ? `${year}-${parts.month}` : null);
  } else {
    const years = Array.from({ length: 5 }, (_, index) => currentYear - 4 + index);
    buckets = years.map((item) => emptyProgramLifecycleBucket(String(item), String(item)));
    bucketKeyForParts = (parts) => (years.includes(parts?.year) ? String(parts.year) : null);
  }

  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  rows.forEach((row) => {
    const bucket = byKey.get(bucketKeyForParts(manilaDateParts(row.createdAt)));
    if (!bucket) return;
    bucket.applications += 1;
    addProgramLifecycleMilestones(bucket, row.lifecycleStatusKey || row.statusKey);
  });
  return buckets;
}

function calculateAiReviewAccuracy(screening, staffValues) {
  const ai = screening && typeof screening === 'object' ? screening : {};
  const staff = staffValues && typeof staffValues === 'object' ? staffValues : {};
  const comparisons = [
    {
      key: 'length',
      ai: ai.Estimated_Length,
      staff: staff.length,
      matches: (aiValue, staffValue) => staffValue != null
        && String(staffValue).trim() !== ''
        && Math.abs(Number(aiValue) - Number(staffValue)) <= 4,
    },
    { key: 'color', ai: ai.Detected_Color, staff: staff.color },
    { key: 'texture', ai: ai.Detected_Texture, staff: staff.texture },
    { key: 'density', ai: ai.Detected_Density, staff: staff.density },
    { key: 'condition', ai: ai.Detected_Condition, staff: staff.condition },
  ];

  let comparable = 0;
  let matched = 0;
  const changed = [];

  comparisons.forEach((field) => {
    if (field.ai == null || String(field.ai).trim() === '') return;
    comparable += 1;
    const isMatch = typeof field.matches === 'function'
      ? field.matches(field.ai, field.staff)
      : normalizeKey(field.ai) === normalizeKey(field.staff);
    if (isMatch) matched += 1;
    else changed.push(field.key);
  });

  const aiPercent = comparable > 0 ? (matched / comparable) * 100 : 0;
  return {
    comparable,
    matched,
    changed,
    aiPercent,
    humanPercent: comparable > 0 ? 100 - aiPercent : 0,
  };
}

function formatPercentage(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function isoWeekKey(value) {
  const parts = manilaDateParts(value);
  if (!parts) return '';
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthKey(value) {
  const parts = manilaDateParts(value);
  return parts ? `${parts.year}-${String(parts.month).padStart(2, '0')}` : '';
}

function ProgramSummaryTable({ rows }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
      {rows.map((row) => (
        <div key={row.name} className="flex items-center justify-between gap-3 border-t border-slate-100 px-2.5 py-1.5 text-[10px] first:border-t-0 even:bg-slate-50/70">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-600">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
            {row.name}
          </span>
          <strong className="text-slate-800">{row.value}{row.suffix || ''}</strong>
        </div>
      ))}
    </div>
  );
}

function ProgramSummaryChart({ rows, className = 'mt-2 h-24' }) {
  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 14, right: 4, left: -28, bottom: 0 }}>
          <XAxis dataKey="shortName" tick={{ fontSize: 8, fill: '#64748b' }} tickLine={false} axisLine={false} interval={0} />
          <YAxis allowDecimals={false} tick={{ fontSize: 8, fill: '#64748b' }} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} formatter={(value) => [value, 'Count']} labelFormatter={(_, payload) => payload?.[0]?.payload?.name || ''} />
          <Bar dataKey="value" radius={[5, 5, 0, 0]} maxBarSize={48}>
            {rows.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
            <LabelList dataKey="value" position="top" fill="#475569" fontSize={9} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ProgramAiSplit({ aiPercent = 0 }) {
  const ai = Math.min(100, Math.max(0, Number(aiPercent || 0)));
  const human = Math.max(0, 100 - ai);
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] font-semibold">
        <span className="inline-flex items-center gap-1.5 text-blue-700"><span className="h-2 w-2 rounded-full bg-blue-600" />AI correct <strong>{formatPercentage(ai)}%</strong></span>
        <span className="inline-flex items-center gap-1.5 text-amber-700"><strong>{formatPercentage(human)}%</strong> Human changes<span className="h-2 w-2 rounded-full bg-amber-600" /></span>
      </div>
      <div className="relative flex h-3 overflow-hidden rounded-full bg-slate-200 ring-1 ring-inset ring-slate-200">
        <div className="h-full bg-blue-600" style={{ width: `${ai}%` }} />
        <div className="h-full flex-1 bg-amber-600" />
        <span className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-white/90" />
      </div>
      <div className="relative mt-0.5 h-3 text-[8px] font-semibold text-slate-400"><span className="absolute left-1/2 -translate-x-1/2">50%</span></div>
    </div>
  );
}

// Brand accents come from UI_Settings. Status colors stay semantic across
// every theme: green = good, red = bad, and yellow = pending / warning.
function buildStatusPalette(theme) {
  return {
    pendingStaff: '#d97706',
    pendingAdmin: '#d97706',
    approved: '#059669',
    rejected: '#dc2626',
    appealed: '#d97706',
    neutral: theme?.secondaryColorLight || '#9CA3AF',
    primary: theme?.primaryColor || '#0275d8',
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
  if (statusKey === 'pendingadmindecision' || statusKey === 'pendingadminapproval') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (statusKey.includes('appealed')) return 'border-amber-200 bg-amber-50 text-amber-700';
  if (statusKey === 'cancelled') return 'border-orange-200 bg-orange-50 text-orange-700';
  if (approvedLikeStatus(statusKey)) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (rejectedLikeStatus(statusKey)) return 'border-red-200 bg-red-50 text-red-700';
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
  const secondary = theme?.secondaryColor || '#6B7280';
  const secondaryLight = theme?.secondaryColorLight || '#9CA3AF';
  const tertiary = theme?.tertiaryColor || '#10b981';
  const tertiaryLight = theme?.tertiaryColorLight || '#34d399';

  const base = [
    {
      id: 'event_applications',
      name: 'Program Applications',
      shortName: 'Applications',
      description: 'Public program submissions and their current review status.',
      icon: ClipboardList,
      accent: theme?.primaryColor || '#0275d8',
      page: isAdmin ? 'manage-event-applications' : 'event-application-intake',
      exportPrefix: 'event_applications',
      columns: [
        { key: 'recordId', label: 'Application ID' },
        { key: 'eventName', label: 'Program Name' },
        { key: 'applicant', label: 'Applicant' },
        { key: 'statusLabel', label: 'Status' },
        { key: 'preferredContact', label: 'Preferred Contact' },
        { key: 'linkedRequest', label: 'Linked Program Request' },
        { key: 'createdAtLabel', label: 'Submitted At' },
      ],
    },
    {
      id: 'event_requests',
      name: isAdmin ? 'Program Analytics' : 'Assigned Program Analytics',
      shortName: 'Program Analytics',
      description: isAdmin
        ? 'Attendance, hair outcomes, inventory results, and AI review accuracy across all completed programs.'
        : 'Attendance, hair outcomes, inventory results, and AI review accuracy for your assigned completed programs.',
      icon: Send,
      accent: tertiary,
      page: isAdmin ? 'manage-event-applications' : 'assigned-event-operations',
      exportPrefix: 'event_requests',
      columns: [
        { key: 'recordId', label: 'Program Record' },
        { key: 'eventName', label: 'Program Name' },
        { key: 'statusLabel', label: 'Status' },
        { key: 'schedule', label: 'Schedule' },
        { key: 'donors', label: 'Donors' },
        { key: 'registered', label: 'Registered with Mobile App' },
        { key: 'walkIns', label: 'Walk-in Donors' },
        { key: 'present', label: 'Present' },
        { key: 'accepted', label: 'Accepted Hair' },
        { key: 'inventoryAdded', label: 'Added to Inventory' },
        { key: 'aiAccuracyLabel', label: 'AI Accuracy' },
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
        { key: 'eventName', label: 'Program / Source' },
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
      description: 'AI predictions compared with the final human review.',
      icon: ScanLine,
      accent: secondary,
      page: 'reports',
      exportPrefix: 'ai_hair_accuracy',
      columns: [
        { key: 'recordId', label: 'Comparison ID' },
        { key: 'submissionId', label: 'Submission' },
        { key: 'sourceLabel', label: 'Source Type' },
        { key: 'eventName', label: 'Program / Source' },
        { key: 'statusLabel', label: 'Final Decision' },
        { key: 'accuracyLabel', label: 'AI Correct' },
        { key: 'humanChangeLabel', label: 'Human Changes' },
        { key: 'changedFieldsLabel', label: 'Changes' },
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
  const [sourceFilter, setSourceFilter] = useState('all');
  const [rejectedRecordsFilter, setRejectedRecordsFilter] = useState('include');
  const [selectedAiEventKey, setSelectedAiEventKey] = useState('all');
  const [aiEventDate, setAiEventDate] = useState('');
  const [showAiReviewCalendar, setShowAiReviewCalendar] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [eventReportPage, setEventReportPage] = useState(1);
  const [applicationActivityGrouping, setApplicationActivityGrouping] = useState('weekly');
  const [applicationActivityMonth, setApplicationActivityMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [applicationActivityYear, setApplicationActivityYear] = useState(() => String(new Date().getFullYear()));
  const [programAnalyticsPeriod, setProgramAnalyticsPeriod] = useState('overall');
  const [programAnalyticsWeek, setProgramAnalyticsWeek] = useState(() => isoWeekKey(new Date()));
  const [programAnalyticsMonth, setProgramAnalyticsMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [programAnalyticsYear, setProgramAnalyticsYear] = useState(() => String(new Date().getFullYear()));
  const [programAnalyticsDate, setProgramAnalyticsDate] = useState('');
  const [selectedProgramAnalyticsId, setSelectedProgramAnalyticsId] = useState('all');
  const [showProgramAnalyticsCalendar, setShowProgramAnalyticsCalendar] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
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
  const isAiAccuracyReport = selectedTemplate?.id === 'ai_hair_accuracy';
  const isProgramApplicationsReport = selectedTemplate?.id === 'event_applications';
  const isProgramAnalyticsReport = selectedTemplate?.id === 'event_requests';

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
    setRawRows([]);
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

        const linkedRequestIds = (result.data || [])
          .map((row) => Number(row.Linked_Event_Request_ID || 0))
          .filter(Boolean);
        let requestsById = new Map();
        if (linkedRequestIds.length) {
          const requestResult = await supabase
            .from(EVENT_REQUESTS_TABLE)
            .select('Event_Request_ID,Status,End_Date')
            .in('Event_Request_ID', [...new Set(linkedRequestIds)]);
          if (requestResult.error) throw requestResult.error;
          requestsById = new Map((requestResult.data || []).map((row) => [Number(row.Event_Request_ID), row]));
        }

        mappedRows = (result.data || []).map((row) => {
          const statusKey = normalizeKey(row.Status);
          const linked = Number(row.Linked_Event_Request_ID || 0);
          const linkedRequest = requestsById.get(linked);
          const linkedStatusKey = normalizeKey(linkedRequest?.Status);
          const lifecycleStatusKey = linkedStatusKey === 'approved'
            && linkedRequest?.End_Date
            && new Date(linkedRequest.End_Date).getTime() <= Date.now()
            ? 'ended'
            : (linkedStatusKey || statusKey);
          return {
            recordId: `EA-${row.Event_Application_ID}`,
            eventName: row.Event_Name || 'Untitled Program',
            applicant: applicantFullName(row),
            statusKey,
            statusLabel: labelFromKey(statusKey),
            lifecycleStatusKey,
            lifecycleStatusLabel: labelFromKey(lifecycleStatusKey),
            preferredContact: row.Preferred_Contact_Method || 'N/A',
            linkedRequest: linked > 0 ? `ER-${linked}` : 'None',
            createdAt: row.Created_At || null,
            filterDate: row.Created_At || null,
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
        if (!isAdmin) {
          const resolvedStaffId = await resolveStaffUserId();
          if (!resolvedStaffId) {
            throw new Error('Unable to resolve your staff account for assigned program reports.');
          }
        }

        const result = await supabase.rpc('get_program_analytics_report');
        if (result.error) throw result.error;
        mappedRows = (Array.isArray(result.data) ? result.data : []).map((row) => {
          const statusKey = normalizeKey(row.status);
          const aiAccuracy = Number(row.ai_accuracy_percent || 0);
          return {
            recordId: `ER-${row.event_request_id}`,
            eventRequestId: Number(row.event_request_id || 0),
            eventName: row.event_name || 'Untitled Program',
            statusKey,
            statusLabel: labelFromKey(statusKey),
            assignedStaffUserId: Number(row.assigned_staff_user_id || 0) || null,
            programStartDate: row.start_date || null,
            programEndDate: row.end_date || row.start_date || null,
            schedule: `${formatShortDate(row.start_date)} - ${formatShortDate(row.end_date)}`,
            registered: Number(row.registered || 0),
            walkIns: Number(row.walk_ins || 0),
            present: Number(row.present || 0),
            noShow: Number(row.no_show || 0),
            donors: Number(row.donors || 0),
            visitors: Number(row.visitors || 0),
            accepted: Number(row.accepted || 0),
            rejected: Number(row.rejected || 0),
            rejectedCut: Number(row.rejected_cut || 0),
            pending: Number(row.pending || 0),
            inventoryAdded: Number(row.inventory_added || 0),
            aiReviews: Number(row.ai_reviews || 0),
            aiAccuracy,
            aiAccuracyLabel: `${formatPercentage(aiAccuracy)}%`,
            createdAt: row.start_date || null,
            filterDate: row.start_date || null,
            updatedAt: row.successful_at || row.ended_at || row.end_date || null,
            createdAtLabel: formatDateTime(row.start_date),
            updatedAtLabel: formatDateTime(row.successful_at || row.ended_at || row.end_date),
            searchText: [
              `ER-${row.event_request_id}`,
              row.event_name,
              row.status,
              row.assigned_staff_user_id,
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
            || (row.Source_Type === 'Non-Event' ? 'Independent donation' : `Program #${row.Event_Request_ID || 'N/A'}`);
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
        const result = await supabase.rpc('get_hair_ai_accuracy_report');
        if (result.error) throw result.error;
        const programIds = [...new Set((result.data || []).map((row) => Number(row.event_request_id || 0)).filter(Boolean))];
        let programsById = new Map();
        if (programIds.length) {
          const programResult = await supabase
            .from(EVENT_REQUESTS_TABLE)
            .select('Event_Request_ID,Event_Name,Start_Date,End_Date,Status')
            .in('Event_Request_ID', programIds);
          if (programResult.error) throw programResult.error;
          programsById = new Map((programResult.data || []).map((program) => [Number(program.Event_Request_ID), program]));
        }
        mappedRows = (result.data || []).map((row) => {
          const program = programsById.get(Number(row.event_request_id || 0));
          const statusKey = normalizeKey(row.final_decision || 'Pending');
          const screening = row.ai_screening || {};
          const comparison = calculateAiReviewAccuracy(screening, row.staff_values);
          const recordedChangedFields = Array.isArray(row.changed_fields)
            ? row.changed_fields.filter(Boolean)
            : comparison.changed;
          const storedComparableFieldCount = Number(row.comparable_field_count);
          const hasStoredComparison = Number.isFinite(storedComparableFieldCount)
            && storedComparableFieldCount > 0;
          const comparableFieldCount = hasStoredComparison
            ? storedComparableFieldCount
            : comparison.comparable;
          const storedMatchedFieldCount = Number(row.matched_field_count);
          const matchedFieldCount = hasStoredComparison && Number.isFinite(storedMatchedFieldCount)
            ? Math.min(Math.max(storedMatchedFieldCount, 0), comparableFieldCount)
            : comparison.matched;
          const aiPercent = comparableFieldCount > 0
            ? (matchedFieldCount / comparableFieldCount) * 100
            : null;
          return {
            recordId: `AI-${String(row.comparison_id).padStart(6, '0')}`,
            submissionId: `Submission #${row.submission_id}`,
            eventRequestId: Number(row.event_request_id || 0) || null,
            eventName: program?.Event_Name || row.event_name || `Program #${row.event_request_id || 'N/A'}`,
            programStartDate: program?.Start_Date || null,
            programEndDate: program?.End_Date || program?.Start_Date || null,
            programStatus: normalizeKey(program?.Status || 'ended'),
            sourceType: normalizeKey(row.source_type) === 'event' ? 'event' : 'non-event',
            sourceLabel: normalizeKey(row.source_type) === 'event' ? 'Program' : 'Independent',
            statusKey,
            statusLabel: labelFromKey(statusKey),
            accuracyLabel: aiPercent == null ? 'N/A' : `${formatPercentage(aiPercent)}%`,
            humanChangeLabel: aiPercent == null ? 'N/A' : `${formatPercentage(100 - aiPercent)}%`,
            comparableFieldCount,
            matchedFieldCount,
            changedFields: recordedChangedFields,
            changedFieldsLabel: recordedChangedFields.length
              ? recordedChangedFields.map(labelFromKey).join(', ')
              : 'No changes',
            createdAt: row.reviewed_at,
            updatedAt: row.reviewed_at,
            createdAtLabel: formatDateTime(row.reviewed_at),
            updatedAtLabel: formatDateTime(row.reviewed_at),
            searchText: [row.comparison_id, row.submission_id, row.source_type, row.event_name, row.final_decision, ...recordedChangedFields].filter(Boolean).join(' ').toLowerCase(),
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
    setSourceFilter('all');
    setRejectedRecordsFilter('include');
    setSelectedAiEventKey('all');
    setAiEventDate('');
    setProgramAnalyticsPeriod('overall');
    setProgramAnalyticsDate('');
    setSelectedProgramAnalyticsId('all');
    setSearchTerm('');
    void loadTemplateRows();
  }, [loadTemplateRows, selectedTemplateId]);

  const statusOptions = useMemo(() => {
    const unique = [...new Set(rawRows.map((row) => row.statusLabel).filter(Boolean))];
    return ['all', ...unique];
  }, [rawRows]);

  const programAnalyticsStatusOptions = useMemo(() => {
    const colors = {
      approved: '#2563eb',
      ended: '#64748b',
      successful: '#059669',
      cancelled: '#d97706',
      rejected: '#dc2626',
    };
    const unique = [...new Set([
      ...rawRows.map((row) => row.statusLabel).filter(Boolean),
      'Ended',
      'Successful',
    ])];
    const priority = ['Approved', 'Ended', 'Successful', 'Cancelled', 'Rejected'];
    unique.sort((left, right) => {
      const leftIndex = priority.indexOf(left);
      const rightIndex = priority.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
    return [
      { value: 'all', label: 'All programs', color: primaryColor },
      ...unique.map((status) => ({
        value: status,
        label: status,
        color: colors[normalizeKey(status)] || '#475569',
      })),
    ];
  }, [primaryColor, rawRows]);

  const aiEventOptions = useMemo(() => {
    if (!isAiAccuracyReport) return [];
    const grouped = new Map();
    rawRows.forEach((row) => {
      if (row.sourceType !== 'event') return;
      if (rejectedRecordsFilter === 'exclude' && rejectedLikeStatus(row.statusKey)) return;
      if ((dateFrom || dateTo) && !withinDateRange(row.createdAt, dateFrom, dateTo)) return;
      if (searchTerm.trim() && !String(row.searchText || '').includes(searchTerm.trim().toLowerCase())) return;
      const key = String(row.eventRequestId || row.eventName);
      const reviewedAt = row.createdAt ? new Date(row.createdAt).getTime() : 0;
      const current = grouped.get(key);
      if (!current || reviewedAt > current.reviewedAt) {
        grouped.set(key, {
          key,
          eventName: row.eventName,
          reviewedAt,
          reviewedAtValue: row.createdAt,
          programStartDate: row.programStartDate,
          programEndDate: row.programEndDate,
          programStatus: row.programStatus,
        });
      }
    });
    return Array.from(grouped.values()).sort((a, b) => b.reviewedAt - a.reviewedAt);
  }, [dateFrom, dateTo, isAiAccuracyReport, rawRows, rejectedRecordsFilter, searchTerm]);

  const aiCalendarPrograms = useMemo(() => {
    const programs = new Map();
    rawRows.forEach((row) => {
      if (row.sourceType !== 'event' || !row.eventRequestId || !row.programStartDate) return;
      const key = String(row.eventRequestId);
      if (!programs.has(key)) {
        programs.set(key, {
          key,
          eventName: row.eventName,
          programStartDate: row.programStartDate,
          programEndDate: row.programEndDate,
          programStatus: row.programStatus,
        });
      }
    });
    return Array.from(programs.values());
  }, [rawRows]);

  const programAnalyticsCalendarRows = useMemo(() => rawRows.filter((row) => {
    if (!isProgramAnalyticsReport) return false;
    if (statusFilter !== 'all' && row.statusLabel !== statusFilter) return false;
    const query = searchTerm.trim().toLowerCase();
    return !query || String(row.searchText || '').includes(query);
  }), [isProgramAnalyticsReport, rawRows, searchTerm, statusFilter]);

  const programAnalyticsEventOptions = useMemo(() => programAnalyticsCalendarRows.filter((row) => (
    !programAnalyticsDate
    || scheduleDateKeysForRecord(row, (item) => item.programStartDate, (item) => item.programEndDate).includes(programAnalyticsDate)
  )), [programAnalyticsCalendarRows, programAnalyticsDate]);

  useEffect(() => {
    if (programAnalyticsPeriod !== 'event') return;
    const selectionExists = programAnalyticsEventOptions.some((row) => String(row.eventRequestId) === String(selectedProgramAnalyticsId));
    if (!selectionExists) {
      setSelectedProgramAnalyticsId(programAnalyticsEventOptions[0]?.eventRequestId ? String(programAnalyticsEventOptions[0].eventRequestId) : 'all');
    }
  }, [programAnalyticsEventOptions, programAnalyticsPeriod, selectedProgramAnalyticsId]);

  const filteredRows = useMemo(() => {
    return rawRows.filter((row) => {
      if (statusFilter !== 'all' && row.statusLabel !== statusFilter) return false;
      if (isProgramAnalyticsReport) {
        if (programAnalyticsPeriod === 'weekly' && isoWeekKey(row.programStartDate) !== programAnalyticsWeek) return false;
        if (programAnalyticsPeriod === 'monthly' && monthKey(row.programStartDate) !== programAnalyticsMonth) return false;
        if (programAnalyticsPeriod === 'yearly' && String(manilaDateParts(row.programStartDate)?.year || '') !== programAnalyticsYear) return false;
        if (programAnalyticsPeriod === 'event') {
          if (selectedProgramAnalyticsId !== 'all' && String(row.eventRequestId) !== String(selectedProgramAnalyticsId)) return false;
          if (selectedProgramAnalyticsId === 'all' && programAnalyticsDate && !scheduleDateKeysForRecord(row, (item) => item.programStartDate, (item) => item.programEndDate).includes(programAnalyticsDate)) return false;
        }
        if (searchTerm.trim() && !String(row.searchText || '').includes(searchTerm.trim().toLowerCase())) return false;
        return true;
      }
      if (isAiAccuracyReport && sourceFilter !== 'all') {
        const wantedSource = sourceFilter === 'per-event' ? 'event' : sourceFilter;
        if (row.sourceType !== wantedSource) return false;
      }
      if (isAiAccuracyReport && rejectedRecordsFilter === 'exclude' && rejectedLikeStatus(row.statusKey)) return false;
      if (isAiAccuracyReport && sourceFilter === 'per-event') {
        const rowEventKey = String(row.eventRequestId || row.eventName);
        if (selectedAiEventKey !== 'all' && rowEventKey !== selectedAiEventKey) return false;
        if (aiEventDate && !scheduleDateKeysForRecord(row, (item) => item.programStartDate, (item) => item.programEndDate).includes(aiEventDate)) return false;
      }
      if ((dateFrom || dateTo) && !withinDateRange(row.filterDate || row.createdAt, dateFrom, dateTo)) return false;
      if (searchTerm.trim()) {
        const query = searchTerm.trim().toLowerCase();
        if (!String(row.searchText || '').includes(query)) return false;
      }
      return true;
    });
  }, [rawRows, statusFilter, sourceFilter, rejectedRecordsFilter, selectedAiEventKey, aiEventDate, dateFrom, dateTo, searchTerm, isAiAccuracyReport, isProgramAnalyticsReport, programAnalyticsPeriod, programAnalyticsWeek, programAnalyticsMonth, programAnalyticsYear, programAnalyticsDate, selectedProgramAnalyticsId]);

  useEffect(() => {
    setEventReportPage(1);
    setPreviewPage(1);
  }, [sourceFilter, rejectedRecordsFilter, selectedAiEventKey, aiEventDate, dateFrom, dateTo, searchTerm, programAnalyticsPeriod, programAnalyticsWeek, programAnalyticsMonth, programAnalyticsYear, programAnalyticsDate, selectedProgramAnalyticsId]);

  useEffect(() => {
    setPreviewPage(1);
  }, [selectedTemplateId, statusFilter]);

  const perEventRows = useMemo(() => {
    if (!isAiAccuracyReport || sourceFilter !== 'per-event') return [];
    const grouped = new Map();
    filteredRows.forEach((row) => {
      const key = row.eventRequestId || row.eventName;
      const current = grouped.get(key) || {
        key,
        eventName: row.eventName,
        reviewed: 0,
        accepted: 0,
        rejected: 0,
        rejectedCut: 0,
        comparable: 0,
        matched: 0,
        latestReviewedAt: null,
        donations: [],
      };
      current.reviewed += 1;
      current.donations.push(row);
      current.comparable += Number(row.comparableFieldCount || 0);
      current.matched += Number(row.matchedFieldCount || 0);
      if (row.statusKey === 'rejectedcut') current.rejectedCut += 1;
      else if (rejectedLikeStatus(row.statusKey)) current.rejected += 1;
      else if (approvedLikeStatus(row.statusKey) || row.statusKey === 'cut') current.accepted += 1;
      if (!current.latestReviewedAt || new Date(row.createdAt || 0).getTime() > new Date(current.latestReviewedAt || 0).getTime()) {
        current.latestReviewedAt = row.createdAt;
      }
      grouped.set(key, current);
    });
    return Array.from(grouped.values())
      .map((row) => ({
        ...row,
        aiPercent: row.comparable > 0 ? (row.matched / row.comparable) * 100 : null,
        donations: [...row.donations].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()),
      }))
      .sort((a, b) => new Date(b.latestReviewedAt || 0).getTime() - new Date(a.latestReviewedAt || 0).getTime());
  }, [filteredRows, isAiAccuracyReport, sourceFilter]);

  const eventReportPageSize = 1;
  const eventReportPageCount = Math.max(1, Math.ceil(perEventRows.length / eventReportPageSize));
  const visiblePerEventRows = perEventRows.slice(
    (Math.min(eventReportPage, eventReportPageCount) - 1) * eventReportPageSize,
    Math.min(eventReportPage, eventReportPageCount) * eventReportPageSize,
  );
  const previewPageSize = 15;
  const previewPageCount = Math.max(1, Math.ceil(filteredRows.length / previewPageSize));
  const safePreviewPage = Math.min(previewPage, previewPageCount);
  const visiblePreviewRows = filteredRows.slice(
    (safePreviewPage - 1) * previewPageSize,
    safePreviewPage * previewPageSize,
  );

  const applicationLifecycleSeries = useMemo(() => buildProgramLifecycleSeries(
    applicationActivityGrouping,
    applicationActivityMonth,
    applicationActivityYear,
    filteredRows,
  ), [applicationActivityGrouping, applicationActivityMonth, applicationActivityYear, filteredRows]);

  const applicationLifecycleCounts = useMemo(() => {
    const counts = emptyProgramLifecycleBucket('All applications', 'all');
    filteredRows.forEach((row) => {
      counts.applications += 1;
      addProgramLifecycleMilestones(counts, row.lifecycleStatusKey || row.statusKey);
    });
    return counts;
  }, [filteredRows]);

  const applicationLifecycleRows = useMemo(() => {
    const total = applicationLifecycleCounts.applications;
    return [
      { key: 'applications', label: 'Total Applications', value: total },
      { key: 'pending', label: 'Pending', value: applicationLifecycleCounts.pending },
      { key: 'approved', label: 'Approved', value: applicationLifecycleCounts.approved },
      { key: 'rejected', label: 'Rejected', value: applicationLifecycleCounts.rejected },
      { key: 'ended', label: 'Ended', value: applicationLifecycleCounts.ended },
      { key: 'successful', label: 'Successful', value: applicationLifecycleCounts.successful },
      { key: 'cancelled', label: 'Cancelled', value: applicationLifecycleCounts.cancelled },
    ].map((row) => ({
      ...row,
      color: PROGRAM_LIFECYCLE_COLORS[row.key],
      percent: total > 0 ? Math.round((row.value / total) * 100) : 0,
    }));
  }, [applicationLifecycleCounts]);

  const applicationActivityYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 10 }, (_, index) => String(currentYear - index));
  }, []);

  const programAnalyticsSummary = useMemo(() => {
    const totals = filteredRows.reduce((summary, row) => {
      summary.programs += 1;
      summary.registered += Number(row.registered || 0);
      summary.walkIns += Number(row.walkIns || 0);
      summary.present += Number(row.present || 0);
      summary.noShow += Number(row.noShow || 0);
      summary.donors += Number(row.donors || 0);
      summary.visitors += Number(row.visitors || 0);
      summary.accepted += Number(row.accepted || 0);
      summary.rejected += Number(row.rejected || 0);
      summary.rejectedCut += Number(row.rejectedCut || 0);
      summary.pending += Number(row.pending || 0);
      summary.inventoryAdded += Number(row.inventoryAdded || 0);
      summary.aiReviews += Number(row.aiReviews || 0);
      summary.weightedAiAccuracy += Number(row.aiAccuracy || 0) * Number(row.aiReviews || 0);
      return summary;
    }, {
      programs: 0,
      registered: 0,
      walkIns: 0,
      present: 0,
      noShow: 0,
      donors: 0,
      visitors: 0,
      accepted: 0,
      rejected: 0,
      rejectedCut: 0,
      pending: 0,
      inventoryAdded: 0,
      aiReviews: 0,
      weightedAiAccuracy: 0,
    });
    return {
      ...totals,
      aiAccuracy: totals.aiReviews > 0 ? totals.weightedAiAccuracy / totals.aiReviews : 0,
    };
  }, [filteredRows]);

  const programAttendanceChart = useMemo(() => ([
    { name: 'Donors', shortName: 'Donors', value: programAnalyticsSummary.donors, color: '#6b1010' },
    { name: 'Registered with mobile app', shortName: 'Mobile app', value: programAnalyticsSummary.registered, color: '#64748b' },
    { name: 'Walk-in donors', shortName: 'Walk-ins', value: programAnalyticsSummary.walkIns, color: '#7c3aed' },
    { name: 'Present', shortName: 'Present', value: programAnalyticsSummary.present, color: '#0f766e' },
    { name: 'No-show', shortName: 'No-show', value: programAnalyticsSummary.noShow, color: '#dc2626' },
    { name: 'Visitors', shortName: 'Visitors', value: programAnalyticsSummary.visitors, color: '#2563eb' },
  ]), [programAnalyticsSummary]);

  const programHairChart = useMemo(() => ([
    { name: 'Accepted', shortName: 'Accepted', value: programAnalyticsSummary.accepted, color: '#059669' },
    { name: 'Rejected', shortName: 'Rejected', value: programAnalyticsSummary.rejected, color: '#dc2626' },
    { name: 'Rejected but cut', shortName: 'Cut', value: programAnalyticsSummary.rejectedCut, color: '#d97706' },
    { name: 'Pending', shortName: 'Pending', value: programAnalyticsSummary.pending, color: '#64748b' },
    { name: 'Added to inventory', shortName: 'Inventory', value: programAnalyticsSummary.inventoryAdded, color: '#6b1010' },
  ]), [programAnalyticsSummary]);

  const programAiDecisionChart = useMemo(() => ([
    { name: 'Approved donations', shortName: 'Approved', value: programAnalyticsSummary.accepted, color: '#059669' },
    { name: 'Rejected donations', shortName: 'Rejected', value: programAnalyticsSummary.rejected, color: '#dc2626' },
    { name: 'Rejected cut donations', shortName: 'Rejected cut', value: programAnalyticsSummary.rejectedCut, color: '#d97706' },
  ]), [programAnalyticsSummary]);

  const aiAccuracySummary = useMemo(() => {
    const comparableRows = filteredRows.filter((row) => Number(row.comparableFieldCount || 0) > 0);
    const totals = comparableRows.reduce((accumulator, row) => ({
      comparable: accumulator.comparable + Number(row.comparableFieldCount || 0),
      matched: accumulator.matched + Number(row.matchedFieldCount || 0),
    }), { comparable: 0, matched: 0 });
    const aiPercent = totals.comparable > 0 ? (totals.matched / totals.comparable) * 100 : 0;
    return {
      totalRecords: filteredRows.length,
      scoredRecords: comparableRows.length,
      unscoredRecords: filteredRows.length - comparableRows.length,
      comparableFields: totals.comparable,
      aiPercent,
      humanPercent: totals.comparable > 0 ? 100 - aiPercent : 0,
    };
  }, [filteredRows]);

  const aiDecisionBarData = useMemo(() => ([
    { name: 'Approved', value: filteredRows.filter((row) => row.statusKey === 'approved').length, color: '#059669' },
    { name: 'Rejected', value: filteredRows.filter((row) => row.statusKey === 'rejected').length, color: '#dc2626' },
    { name: 'Rejected cut', value: filteredRows.filter((row) => row.statusKey === 'rejectedcut').length, color: '#d97706' },
  ]), [filteredRows]);

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
      const key = toDayKey(row.filterDate || row.createdAt);
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

  return (
    <div
      className="space-y-4"
      style={{ fontFamily: `${fontFamily}, sans-serif`, color: primaryTextColor, '--report-accent': primaryColor }}
    >
      {/* Plain title row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="role-page-title text-2xl font-bold"
            style={{ fontFamily: `${headingFontFamily}, sans-serif`, color: primaryTextColor }}
          >
            {isAdmin ? 'Admin Reports' : 'Staff Reports'}
          </h1>
          <p className="text-sm" style={{ color: secondaryTextColor }}>
            Filter, visualize, and export data on programs, wigs, and partner activity.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Last refreshed: <strong className="font-semibold text-slate-700">{lastRefreshedAt ? formatDateTime(lastRefreshedAt) : 'Not refreshed yet'}</strong>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PageHeaderActions
            onRefresh={() => loadTemplateRows()}
            refreshLoading={isLoading}
            autoRefreshOnChanges={false}
            helpTitle={isAdmin ? 'About Admin Reports' : 'About Staff Reports'}
            helpContent={<p>Select a report, apply filters, review the visual summary, and export the current result to CSV or PDF.</p>}
          />
          <button
            type="button"
            onClick={exportCsv}
            disabled={isExporting || filteredRows.length === 0}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 disabled:opacity-60"
          >
            {isExporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            CSV
          </button>
          <button
            type="button"
            onClick={exportPdf}
            disabled={isExporting || filteredRows.length === 0}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
            style={{ backgroundColor: primaryColor }}
          >
            <FileText size={15} />
            PDF
          </button>
        </div>
      </div>

      {notice.text && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${notice.kind === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
          {notice.kind === 'error' ? <AlertTriangle size={14} className="mt-0.5 flex-none" /> : <CheckCircle2 size={14} className="mt-0.5 flex-none" />}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Template selector - underlined tabs */}
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
                style={isActive ? { borderColor: primaryColor, color: primaryColor } : undefined}
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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold text-slate-800">Filter report</h3>
            <p className="text-[11px] text-slate-500">Narrow the report without changing stored results.</p>
          </div>
          {(dateFrom || dateTo || statusFilter !== 'all' || sourceFilter !== 'all' || rejectedRecordsFilter !== 'include' || searchTerm || selectedAiEventKey !== 'all' || aiEventDate || programAnalyticsPeriod !== 'overall' || programAnalyticsDate || selectedProgramAnalyticsId !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setStatusFilter('all');
                setSourceFilter('all');
                setRejectedRecordsFilter('include');
                setSelectedAiEventKey('all');
                setAiEventDate('');
                setProgramAnalyticsPeriod('overall');
                setProgramAnalyticsDate('');
                setSelectedProgramAnalyticsId('all');
                setSearchTerm('');
              }}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              Clear filters
            </button>
          )}
        </div>
        {isProgramAnalyticsReport ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">View</span>
                <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                  {[
                    { key: 'overall', label: 'Overall', color: primaryColor },
                    { key: 'weekly', label: 'Weekly', color: '#2563eb' },
                    { key: 'monthly', label: 'Monthly', color: '#7c3aed' },
                    { key: 'yearly', label: 'Yearly', color: '#d97706' },
                  ].map((period) => {
                    const active = programAnalyticsPeriod === period.key;
                    return (
                      <button
                        key={period.key}
                        type="button"
                        onClick={() => { setProgramAnalyticsPeriod(period.key); setProgramAnalyticsDate(''); setSelectedProgramAnalyticsId('all'); }}
                        className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${active ? 'text-white shadow-sm' : 'text-slate-600 hover:bg-white'}`}
                        style={active ? { backgroundColor: period.color } : undefined}
                      >
                        {period.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Program status</span>
                <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                  {programAnalyticsStatusOptions.map((option) => {
                    const active = statusFilter === option.value;
                    return (
                      <button key={option.value} type="button" onClick={() => setStatusFilter(option.value)} className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${active ? 'text-white shadow-sm' : 'text-slate-600 hover:bg-white'}`} style={active ? { backgroundColor: option.color } : undefined}>
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {programAnalyticsPeriod === 'weekly' && (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Week</span>
                  <input type="week" value={programAnalyticsWeek} onChange={(event) => setProgramAnalyticsWeek(event.target.value)} className="rounded-lg border border-blue-200 bg-blue-50/40 px-3 py-2 text-sm text-slate-700" />
                </label>
              )}
              {programAnalyticsPeriod === 'monthly' && (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Month</span>
                  <input type="month" value={programAnalyticsMonth} onChange={(event) => setProgramAnalyticsMonth(event.target.value)} className="rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2 text-sm text-slate-700" />
                </label>
              )}
              {programAnalyticsPeriod === 'yearly' && (
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Year</span>
                  <select value={programAnalyticsYear} onChange={(event) => setProgramAnalyticsYear(event.target.value)} className="rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-2 text-sm text-slate-700">
                    {Array.from({ length: 10 }, (_, index) => String(new Date().getFullYear() - index)).map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                </label>
              )}

              <button
                type="button"
                onClick={() => { setProgramAnalyticsPeriod('event'); setShowProgramAnalyticsCalendar(true); }}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition ${programAnalyticsPeriod === 'event' ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm' : 'border-slate-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50'}`}
              >
                <Calendar size={14} />
                {programAnalyticsDate ? formatScheduleDateLabel(programAnalyticsDate, true) : 'Choose date'}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 md:grid-cols-[minmax(240px,1fr)_minmax(240px,1fr)_auto] md:items-end">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Search</span>
                <div className="relative">
                  <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search program name or ID..." className="w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20" />
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
                  {isAdmin ? 'Program — all records' : 'Program — assigned to me'}
                </span>
                <select
                  value={selectedProgramAnalyticsId}
                  onChange={(event) => {
                    const value = event.target.value;
                    setSelectedProgramAnalyticsId(value);
                    if (value !== 'all') {
                      setProgramAnalyticsPeriod('event');
                    } else {
                      setProgramAnalyticsPeriod('overall');
                      setProgramAnalyticsDate('');
                    }
                  }}
                  className="rounded-lg border border-emerald-200 bg-emerald-50/30 px-3 py-2 text-sm text-slate-700"
                >
                  <option value="all">All visible programs ({programAnalyticsEventOptions.length})</option>
                  {programAnalyticsEventOptions.map((row) => <option key={row.eventRequestId} value={row.eventRequestId}>{row.eventName} — {row.statusLabel} — {formatShortDate(row.programStartDate)}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => { setProgramAnalyticsPeriod('overall'); setProgramAnalyticsDate(''); setSelectedProgramAnalyticsId('all'); }} disabled={programAnalyticsPeriod === 'overall'} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Back to Overall</button>
            </div>
          </div>
        ) : (<>
        <div className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${isAiAccuracyReport ? 'xl:grid-cols-[0.85fr_0.85fr_1.15fr_1.15fr_1.6fr]' : 'xl:grid-cols-[1fr_1fr_1fr_2fr]'}`}>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">From Date</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">To Date</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20"
            />
          </label>
          {!isAiAccuracyReport ? (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20"
              >
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {option === 'all' ? 'All statuses' : option}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Donation Source</span>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20">
                <option value="all">All donation sources</option>
                <option value="event">Program donations</option>
                <option value="per-event">Per program</option>
                <option value="non-event">Non-program donations</option>
              </select>
            </label>
          )}
          {isAiAccuracyReport && (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Rejected Records</span>
              <select
                value={rejectedRecordsFilter}
                onChange={(event) => setRejectedRecordsFilter(event.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20"
              >
                <option value="include">Include rejected</option>
                <option value="exclude">Exclude rejected</option>
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Search</span>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder={isAiAccuracyReport && sourceFilter === 'per-event' ? 'Search programs or decisions...' : 'Search by id, name, status...'}
                className="w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20"
              />
            </div>
          </label>
        </div>
        {isAiAccuracyReport && sourceFilter === 'per-event' && (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 md:grid-cols-[minmax(170px,0.7fr)_minmax(260px,1.8fr)_auto] md:items-end">
            <label className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500"><Calendar size={12} /> Program Date</span>
              <button
                type="button"
                onClick={() => setShowAiReviewCalendar(true)}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20 ${aiEventDate ? 'border-slate-400 bg-slate-50 font-semibold text-slate-800' : 'border-slate-300 bg-white text-slate-500 hover:bg-slate-50'}`}
              >
                <span>{aiEventDate ? formatScheduleDateLabel(aiEventDate, true) : 'Choose program date'}</span>
                <Calendar size={14} className="flex-none" />
              </button>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Program</span>
              <select
                value={selectedAiEventKey}
                onChange={(event) => setSelectedAiEventKey(event.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-[var(--report-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--report-accent)]/20"
              >
                <option value="all">All programs — newest reviewed first</option>
                {aiEventOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.eventName} — {formatShortDate(option.programStartDate)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => { setSelectedAiEventKey('all'); setAiEventDate(''); }}
              disabled={selectedAiEventKey === 'all' && !aiEventDate}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Show all programs
            </button>
          </div>
        )}
        </>)}
      </div>

      {/* Charts row */}
      {isProgramAnalyticsReport ? (
        <section className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              { label: 'Donors', value: programAnalyticsSummary.donors, detail: 'All donor registrations', Icon: Users, color: '#6b1010' },
              { label: 'Registered with Mobile App', value: programAnalyticsSummary.registered, detail: 'Before the program', Icon: Users, color: '#64748b' },
              { label: 'Walk-in Donors', value: programAnalyticsSummary.walkIns, detail: 'Registered on-site', Icon: UserPlus, color: '#7c3aed' },
              { label: 'Present', value: programAnalyticsSummary.present, detail: 'Checked in', Icon: CheckCircle2, color: '#0f766e' },
              { label: 'Accepted Hair', value: programAnalyticsSummary.accepted, detail: `${programAnalyticsSummary.donors} donors`, Icon: ScanLine, color: '#059669' },
              { label: 'Inventory Added', value: programAnalyticsSummary.inventoryAdded, detail: `${formatPercentage(programAnalyticsSummary.aiAccuracy)}% AI accuracy`, Icon: Boxes, color: '#6b1010' },
            ].map((metric) => (
              <article key={metric.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{metric.label}</p>
                    <p className="mt-1 text-2xl font-bold text-slate-900">{metric.value}</p>
                    <p className="mt-0.5 text-[10px] text-slate-500">{metric.detail}</p>
                  </div>
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: `${metric.color}14`, color: metric.color }}>
                    <metric.Icon size={17} />
                  </span>
                </div>
              </article>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Performance Overview</h3>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  {programAnalyticsPeriod === 'event' && filteredRows[0]?.eventName
                    ? `${filteredRows[0].eventName} — attendance, hair outcomes, and AI review results`
                    : isAdmin
                      ? 'Combined results across all programs visible to Admin.'
                      : 'Combined results from programs assigned to you.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-700">{programAnalyticsSummary.programs} program{programAnalyticsSummary.programs === 1 ? '' : 's'}</span>
                {statusFilter !== 'all' && <span className={`rounded-full border px-3 py-1.5 text-xs font-bold ${statusBadgeClass(normalizeKey(statusFilter))}`}>{statusFilter}</span>}
              </div>
            </div>

            {filteredRows.length === 0 ? (
              <div className="flex h-40 items-center justify-center bg-slate-50/50 px-4 text-sm text-slate-500">No programs match the selected filters.</div>
            ) : (
              <div className="grid items-start xl:grid-cols-3">
                <article className="flex flex-col border-b border-slate-200 p-4 xl:border-b-0 xl:border-r">
                  <div className="flex items-center justify-between"><h4 className="text-xs font-bold text-slate-800">Attendance</h4><span className="text-[10px] text-slate-500">{programAnalyticsSummary.donors} donors · {programAnalyticsSummary.registered} mobile app · {programAnalyticsSummary.walkIns} walk-in</span></div>
                  <ProgramSummaryChart rows={programAttendanceChart} className="mt-2 h-32" />
                  <ProgramSummaryTable rows={programAttendanceChart} />
                </article>
                <article className="flex flex-col border-b border-slate-200 p-4 xl:border-b-0 xl:border-r">
                  <div className="flex items-center justify-between"><h4 className="text-xs font-bold text-slate-800">Hair Outcomes</h4><span className="text-[10px] text-slate-500">{programAnalyticsSummary.inventoryAdded} inventoried</span></div>
                  <ProgramSummaryChart rows={programHairChart} className="mt-2 h-32" />
                  <ProgramSummaryTable rows={programHairChart} />
                </article>
                <article className="flex flex-col p-4">
                  <div className="flex items-center justify-between"><h4 className="text-xs font-bold text-slate-800">AI vs Human</h4><span className="text-[10px] text-slate-500">{programAnalyticsSummary.aiReviews} comparisons</span></div>
                  <ProgramAiSplit aiPercent={programAnalyticsSummary.aiAccuracy} />
                  <ProgramSummaryChart rows={programAiDecisionChart} className="mt-1 h-24" />
                  <ProgramSummaryTable rows={[
                    { name: 'Compared', value: programAnalyticsSummary.aiReviews, color: '#64748b' },
                    { name: 'AI correct', value: formatPercentage(programAnalyticsSummary.aiAccuracy), suffix: '%', color: '#2563eb' },
                    { name: 'Human changes', value: formatPercentage(Math.max(0, 100 - programAnalyticsSummary.aiAccuracy)), suffix: '%', color: '#d97706' },
                  ]} />
                </article>
              </div>
            )}

            <div className="border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-600">
              {programAnalyticsPeriod === 'event'
                ? 'Showing one selected program. Choose All visible programs to restore the combined report.'
                : `Showing ${programAnalyticsPeriod === 'overall' ? 'all visible programs' : `${programAnalyticsPeriod} results`} with a separate color for every metric.`}
            </div>
          </div>
        </section>
      ) : isProgramApplicationsReport ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Performance Overview</h3>
              <p className="mt-0.5 text-[10px] text-slate-500">Switch views to compare the program application lifecycle.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1" aria-label="Program application reporting period">
                {[
                  { key: 'weekly', label: 'Weekly' },
                  { key: 'monthly', label: 'Monthly' },
                  { key: 'yearly', label: 'Yearly' },
                ].map((item) => {
                  const active = applicationActivityGrouping === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setApplicationActivityGrouping(item.key)}
                      className={`rounded-md px-3 py-1.5 text-[10px] font-bold transition ${active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              {applicationActivityGrouping === 'weekly' && (
                <input
                  type="month"
                  value={applicationActivityMonth}
                  onChange={(event) => setApplicationActivityMonth(event.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] text-slate-700"
                  aria-label="Month for weekly application report"
                />
              )}
              {applicationActivityGrouping === 'monthly' && (
                <select
                  value={applicationActivityYear}
                  onChange={(event) => setApplicationActivityYear(event.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] text-slate-700"
                  aria-label="Year for monthly application report"
                >
                  {applicationActivityYears.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              )}
              {applicationActivityGrouping === 'yearly' && (
                <span className="rounded-lg bg-slate-100 px-3 py-2 text-[10px] font-semibold text-slate-600">Past 5 years</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]">
            <article className="min-h-[330px] border-b border-slate-200 p-4 xl:border-b-0 xl:border-r">
              <h4 className="text-xs font-bold text-slate-900">
                {applicationActivityGrouping === 'weekly' ? 'Weekly' : applicationActivityGrouping === 'monthly' ? 'Monthly' : 'Yearly'} program lifecycle
              </h4>
              <p className="mt-0.5 text-[10px] text-slate-500">
                Cumulative milestones for applications submitted {applicationActivityGrouping === 'weekly' ? 'each week' : applicationActivityGrouping === 'monthly' ? 'each month' : 'each year'}.
              </p>
              <div className="mt-3 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={applicationLifecycleSeries} margin={{ top: 8, right: 12, left: -24, bottom: 4 }} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="label" interval={0} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: '#64748b' }} tickLine={false} axisLine={false} />
                    <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderColor: '#e2e8f0', borderRadius: 8, fontSize: 11 }} />
                    <Bar dataKey="applications" name="Total Applications" fill={PROGRAM_LIFECYCLE_COLORS.applications} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="pending" name="Pending" fill={PROGRAM_LIFECYCLE_COLORS.pending} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="approved" name="Approved" fill={PROGRAM_LIFECYCLE_COLORS.approved} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="rejected" name="Rejected" fill={PROGRAM_LIFECYCLE_COLORS.rejected} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="ended" name="Ended" fill={PROGRAM_LIFECYCLE_COLORS.ended} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="successful" name="Successful" fill={PROGRAM_LIFECYCLE_COLORS.successful} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="cancelled" name="Cancelled" fill={PROGRAM_LIFECYCLE_COLORS.cancelled} radius={[4, 4, 0, 0]} maxBarSize={34} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <aside className="p-4">
              <h4 className="text-xs font-bold text-slate-900">Program Counts</h4>
              <p className="mt-0.5 text-[10px] text-slate-500">Milestones are cumulative; successful programs also remain counted as approved and ended.</p>
              <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
                <div className="grid grid-cols-[1fr,64px,64px] gap-2 bg-slate-50 px-3 py-2 text-[9px] font-bold uppercase tracking-wide text-slate-500">
                  <span>Status</span><span className="text-right">Count</span><span className="text-right">Percent</span>
                </div>
                {applicationLifecycleRows.map((row) => (
                  <div key={row.key} className="grid grid-cols-[1fr,64px,64px] items-center gap-2 border-t border-slate-100 px-3 py-2 text-[10px] even:bg-slate-50/60">
                    <span>
                      <span className="inline-flex rounded-full border px-2 py-0.5 font-semibold" style={{ color: row.color, borderColor: `${row.color}45`, backgroundColor: `${row.color}0D` }}>
                        {row.label}
                      </span>
                    </span>
                    <strong className="text-right text-slate-800">{row.value}</strong>
                    <span className="text-right font-medium text-slate-500">{row.percent}%</span>
                  </div>
                ))}
              </div>
            </aside>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-[10px] text-slate-600">
            {applicationLifecycleRows.map((row) => (
              <span key={row.key} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />{row.label}</span>
            ))}
          </div>
        </section>
      ) : isAiAccuracyReport ? (
        <section className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.5fr)]">
          <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">AI vs Human</h3>
                <p className="mt-0.5 text-xs text-slate-500">AI results compared with the final human review.</p>
              </div>
              <span className="text-xs font-semibold text-slate-500">{aiAccuracySummary.scoredRecords} comparison{aiAccuracySummary.scoredRecords === 1 ? '' : 's'}</span>
            </div>
            {aiAccuracySummary.comparableFields === 0 ? (
              <div className="mt-4 flex h-20 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-xs text-slate-500">
                No AI and human comparisons match these filters.
              </div>
            ) : (
              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between gap-4 text-xs font-semibold">
                  <span className="inline-flex items-center gap-2 text-blue-700"><span className="h-2.5 w-2.5 rounded-full bg-blue-600" />AI correct <strong>{formatPercentage(aiAccuracySummary.aiPercent)}%</strong></span>
                  <span className="inline-flex items-center gap-2 text-amber-700"><strong>{formatPercentage(aiAccuracySummary.humanPercent)}%</strong> Human changes<span className="h-2.5 w-2.5 rounded-full bg-amber-600" /></span>
                </div>
                <div className="relative flex h-4 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200" aria-label={`AI correct ${formatPercentage(aiAccuracySummary.aiPercent)} percent; Human changes ${formatPercentage(aiAccuracySummary.humanPercent)} percent`}>
                  <div className="h-full bg-blue-600 transition-all" style={{ width: `${Math.min(Math.max(aiAccuracySummary.aiPercent, 0), 100)}%` }} />
                  <div className="h-full flex-1 bg-amber-600" />
                  <span className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-white/90" />
                </div>
                <div className="relative mt-1 h-4 text-[9px] font-semibold text-slate-400">
                  <span className="absolute left-1/2 -translate-x-1/2">50%</span>
                </div>
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Decisions</p>
                  <div className="h-24">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={aiDecisionBarData} margin={{ top: 18, right: 8, left: 8, bottom: 0 }} barCategoryGap="24%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                        <YAxis hide allowDecimals={false} />
                        <Tooltip cursor={{ fill: '#f8fafc' }} />
                        <Bar dataKey="value" name="Donations" radius={[5, 5, 0, 0]} maxBarSize={76}>
                          {aiDecisionBarData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                          <LabelList dataKey="value" position="top" className="fill-slate-500 text-[9px]" />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}
          </article>

          <aside
            className="h-fit self-start overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
            style={{ alignSelf: 'flex-start', height: 'fit-content' }}
          >
            <h3 className="border-b border-slate-200 px-4 py-3 text-sm font-bold text-slate-900">Summary</h3>
            <div>
              {[
                { label: 'Reviews', value: aiAccuracySummary.totalRecords, color: '#64748b' },
                { label: 'Compared', value: aiAccuracySummary.scoredRecords, color: '#475569' },
                { label: 'AI correct', value: `${formatPercentage(aiAccuracySummary.aiPercent)}%`, color: '#2563eb' },
                { label: 'Human changes', value: `${formatPercentage(aiAccuracySummary.humanPercent)}%`, color: '#d97706' },
              ].map((entry) => (
                <div key={entry.label} className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 first:border-t-0 even:bg-slate-50/60">
                  <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                    {entry.label}
                  </span>
                  <strong className="text-sm text-slate-900">{entry.value}</strong>
                </div>
              ))}
            </div>
          </aside>
        </section>
      ) : (
      <section className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-800">{selectedTemplate.shortName || 'Report'} Statistics</h3>
              <p className="text-xs text-slate-500">Records grouped by current status</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: selectedTemplate.accent }} />{selectedTemplate.shortName}</span>
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
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} height={28} tickLine={false} axisLine={false} />
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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">7-Day Activity Overview</h3>
              <p className="text-xs text-slate-500">Records created per day (within current filters)</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500"><Calendar size={11} />Last 7 days</span>
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
      )}

      {isAiAccuracyReport && sourceFilter === 'per-event' && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Program donation reviews</h3>
              <p className="text-xs text-slate-500">
                {selectedAiEventKey === 'all'
                  ? 'Programs are ordered by their latest review, with every cut donation shown inside.'
                  : 'Every reviewed cut donation from the selected program is shown.'}
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{perEventRows.length} program{perEventRows.length === 1 ? '' : 's'}</span>
          </div>
          {perEventRows.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-slate-500">No program reviews match the selected filters.</div>
          ) : (
            <>
              <div className="space-y-3 bg-slate-50/60 p-3">
                {visiblePerEventRows.map((program) => (
                  <article key={program.key} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
                      <div>
                        <h4 className="text-sm font-bold text-slate-900">{program.eventName}</h4>
                        <p className="mt-0.5 text-[11px] text-slate-500">Last reviewed {formatDateTime(program.latestReviewedAt)}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold">
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{program.reviewed} donation{program.reviewed === 1 ? '' : 's'}</span>
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700">{program.accepted} approved</span>
                        <span className="rounded-full bg-rose-50 px-2 py-1 text-rose-700">{program.rejected} rejected</span>
                        <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">{program.rejectedCut} rejected cut</span>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-xs">
                        <thead className="bg-slate-50 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                          <tr><th className="px-4 py-2.5">Cut donation</th><th className="px-4 py-2.5">Decision</th><th className="px-4 py-2.5">AI correct</th><th className="px-4 py-2.5">Human changes</th><th className="px-4 py-2.5">Changes</th><th className="px-4 py-2.5">Reviewed</th></tr>
                        </thead>
                        <tbody>
                          {program.donations.map((donation) => {
                            const donationAiPercent = Number(donation.comparableFieldCount || 0) > 0
                              ? (Number(donation.matchedFieldCount || 0) / Number(donation.comparableFieldCount)) * 100
                              : null;
                            return (
                              <tr key={donation.recordId} className="border-t border-slate-100 hover:bg-slate-50/70">
                                <td className="px-4 py-2.5 font-semibold text-slate-800">{donation.submissionId}</td>
                                <td className="px-4 py-2.5"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusBadgeClass(donation.statusKey)}`}>{donation.statusLabel}</span></td>
                                <td className="px-4 py-2.5 font-semibold text-blue-700">{donationAiPercent == null ? 'N/A' : `${formatPercentage(donationAiPercent)}%`}</td>
                                <td className="px-4 py-2.5 font-semibold text-amber-700">{donationAiPercent == null ? 'N/A' : `${formatPercentage(100 - donationAiPercent)}%`}</td>
                                <td className="max-w-xs px-4 py-2.5 text-slate-600">{donation.changedFields?.length ? donation.changedFields.map(labelFromKey).join(', ') : 'None'}</td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">{donation.createdAtLabel}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3">
                <span className="text-xs text-slate-500">Page {Math.min(eventReportPage, eventReportPageCount)} of {eventReportPageCount}</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setEventReportPage((page) => Math.max(1, page - 1))} disabled={eventReportPage <= 1} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40">Previous</button>
                  <button type="button" onClick={() => setEventReportPage((page) => Math.min(eventReportPageCount, page + 1))} disabled={eventReportPage >= eventReportPageCount} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40">Next</button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* Preview table */}
      {!isProgramAnalyticsReport && !(isAiAccuracyReport && sourceFilter === 'per-event') && (
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
          {selectedTemplate.page !== 'reports' ? (
            <button
              type="button"
              onClick={() => typeof onNavigate === 'function' && onNavigate(selectedTemplate.page)}
              className="inline-flex items-center gap-1 text-xs font-semibold hover:underline"
              style={{ color: primaryColor }}
            >
              Open related page
            </button>
          ) : null}
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
                {visiblePreviewRows.map((row) => (
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
                      if (column.key === 'accuracyLabel' || column.key === 'humanChangeLabel') {
                        const isAiCorrect = column.key === 'accuracyLabel';
                        const isUnavailable = Number(row.comparableFieldCount || 0) === 0;
                        const accent = isUnavailable
                          ? palette.neutral
                          : (isAiCorrect ? '#2563eb' : '#d97706');
                        return (
                          <td key={`${row.recordId}-${column.key}`} className="px-5 py-2.5">
                            <span
                              className="inline-flex rounded-full border px-2.5 py-1 text-xs font-bold"
                              style={{ borderColor: `${accent}35`, color: accent, backgroundColor: `${accent}0D` }}
                              title={isUnavailable ? 'No comparable AI and staff fields were recorded for this review.' : undefined}
                            >
                              {cellValue}
                            </span>
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
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3">
              <span className="text-xs text-slate-500">Page {safePreviewPage} of {previewPageCount} · {filteredRows.length} records</span>
              <div className="flex gap-2"><button type="button" onClick={() => setPreviewPage((page) => Math.max(1, page - 1))} disabled={safePreviewPage <= 1} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40">Previous</button><button type="button" onClick={() => setPreviewPage((page) => Math.min(previewPageCount, page + 1))} disabled={safePreviewPage >= previewPageCount} className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40">Next</button></div>
            </div>
          </div>
        )}
      </section>
      )}

      <ProgramScheduleCalendarModal
        open={isProgramAnalyticsReport && showProgramAnalyticsCalendar}
        onClose={() => setShowProgramAnalyticsCalendar(false)}
        records={programAnalyticsCalendarRows}
        selectedDate={programAnalyticsDate}
        onSelectDate={(date) => {
          setProgramAnalyticsDate(date);
          setProgramAnalyticsPeriod('event');
          setSelectedProgramAnalyticsId('all');
        }}
        primaryColor={primaryColor}
        title="Program Calendar"
        description={isAdmin ? 'Choose a date to see any program in the system.' : 'Choose a date to see programs assigned to you.'}
        recordNoun="program"
        resultCount={programAnalyticsCalendarRows.length}
        getStartDate={(row) => row.programStartDate}
        getEndDate={(row) => row.programEndDate}
        getStatus={(row) => row.statusLabel}
        getRecordLabel={(row) => row.eventName}
        statusItems={[
          { key: 'approved', label: 'Approved', dotClass: 'bg-blue-600', reserved: true },
          { key: 'ended', label: 'Ended', dotClass: 'bg-slate-500', reserved: true },
          { key: 'successful', label: 'Successful', dotClass: 'bg-emerald-600', reserved: true },
          { key: 'cancelled', label: 'Cancelled', dotClass: 'bg-amber-600', reserved: true },
        ]}
        showOpenDates={false}
      />

      <ProgramScheduleCalendarModal
        open={isAiAccuracyReport && sourceFilter === 'per-event' && showAiReviewCalendar}
        onClose={() => setShowAiReviewCalendar(false)}
        records={aiCalendarPrograms}
        selectedDate={aiEventDate}
        onSelectDate={setAiEventDate}
        primaryColor={primaryColor}
        title="Program Calendar"
        description="Choose a scheduled program date. Each program appears only once."
        recordNoun="program"
        resultCount={perEventRows.length}
        getStartDate={(row) => row.programStartDate}
        getEndDate={(row) => row.programEndDate}
        getStatus={(row) => row.programStatus}
        getRecordLabel={(row) => row.eventName}
        statusItems={[
          { key: 'approved', label: 'Approved', dotClass: 'bg-blue-600', reserved: true },
          { key: 'rejected', label: 'Rejected', dotClass: 'bg-rose-600', reserved: true },
          { key: 'ended', label: 'Ended', dotClass: 'bg-slate-500', reserved: true },
          { key: 'successful', label: 'Successful', dotClass: 'bg-emerald-600', reserved: true },
          { key: 'cancelled', label: 'Cancelled', dotClass: 'bg-amber-600', reserved: true },
        ]}
        showOpenDates={false}
      />

      {(selectedTemplate.id === 'hospital_applications' && !isAdmin) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={13} className="mt-0.5 flex-none" />
          <span>Hospital application reports are admin-only.</span>
        </div>
      )}
    </div>
  );
}
