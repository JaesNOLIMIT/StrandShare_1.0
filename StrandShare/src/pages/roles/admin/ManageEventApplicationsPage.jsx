import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  Send,
  User,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { triggerSmtpNow } from '../../../lib/smtpTriggerClient';

const EVENT_REQUESTS_TABLE = 'Event_Requests';
const EVENT_APPLICATIONS_TABLE = 'Event_Applications';
const USERS_TABLE = 'users';
const SMTP_OUTBOX_TABLE = 'SMTP_Email_Outbox';

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
  if (email) return `${email} (ID: ${staff.user_id})`;
  return `Staff ID: ${staff.user_id}`;
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

export default function ManageEventRequestsPage() {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';

  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingStaff, setIsLoadingStaff] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [rows, setRows] = useState([]);
  const [staffOptions, setStaffOptions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  const [isApproveModalOpen, setIsApproveModalOpen] = useState(false);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [assignedStaffId, setAssignedStaffId] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [resultModalData, setResultModalData] = useState({ title: '', lines: [] });

  const loadRows = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      setRows([]);
      return;
    }

    setIsLoading(true);
    setNotice({ kind: '', text: '' });

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
      if (!selectedId && mergedRows.length > 0) {
        setSelectedId(mergedRows[0].Event_Request_ID);
      }
    } catch (error) {
      setRows([]);
      setNotice({ kind: 'error', text: error.message || 'Unable to load event requests.' });
    } finally {
      setIsLoading(false);
    }
  }, [selectedId]);

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
    if (!query) return queueRows;
    return queueRows.filter((row) => {
      const requestId = String(row.Event_Request_ID || '').toLowerCase();
      const eventName = String(row.Event_Name || '').toLowerCase();
      const applicantName = applicantFullName(row.Application).toLowerCase();
      const venue = String(row.Venue_Name || '').toLowerCase();
      return requestId.includes(query)
        || eventName.includes(query)
        || applicantName.includes(query)
        || venue.includes(query);
    });
  }, [queueRows, searchTerm]);

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

  const selectedStatusKey = useMemo(() => normalizeStatus(selectedRow?.Status), [selectedRow]);
  const canDecide = selectedStatusKey === 'pendingadminapproval' || selectedStatusKey === 'appealed';

  const assignedStaffLabel = useMemo(() => {
    const id = Number(selectedRow?.Assigned_Staff_User_ID || 0);
    if (id <= 0) return 'Not assigned';
    const row = staffOptions.find((staff) => Number(staff.user_id || 0) === id);
    return row ? staffLabel(row) : `Staff ID: ${id}`;
  }, [selectedRow, staffOptions]);

  const nextActionCard = useMemo(() => {
    if (!selectedRow) {
      return {
        icon: Clock3,
        tone: 'border-slate-200 bg-slate-50 text-slate-700',
        title: 'Select a request',
        body: 'Choose an event request from the queue to review and decide.',
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
        body: 'Staff can revise and resubmit this request as an appeal.',
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

      const smtpKickResult = await triggerSmtpNow('admin_approved_event_request');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after admin approval failed:', smtpKickResult.message || smtpKickResult);
      }
      const emailStatus = await checkLatestEmailQueue(updated.Event_Request_ID, 'admin_approved');
      setResultModalData({
        title: `ER-${updated.Event_Request_ID} Approved`,
        lines: [
          `Assigned Staff: ${staffOptions.find((staff) => Number(staff.user_id || 0) === staffIdNumber) ? staffLabel(staffOptions.find((staff) => Number(staff.user_id || 0) === staffIdNumber)) : `Staff ID: ${staffIdNumber}`}`,
          emailStatus.text,
        ],
      });
      setIsApproveModalOpen(false);
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

      const smtpKickResult = await triggerSmtpNow('admin_rejected_event_request');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after admin rejection failed:', smtpKickResult.message || smtpKickResult);
      }
      const emailStatus = await checkLatestEmailQueue(updated.Event_Request_ID, 'admin_rejected');
      setResultModalData({
        title: `ER-${updated.Event_Request_ID} Rejected`,
        lines: [
          `Reason: ${rejectReason.trim()}`,
          emailStatus.text,
        ],
      });
      setIsRejectModalOpen(false);
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
        <div className="flex items-start gap-3">
          <div
            className="flex h-11 w-11 flex-none items-center justify-center rounded-xl text-white shadow-sm"
            style={{ backgroundColor: primaryColor }}
          >
            <Inbox size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Manage Event Requests</h1>
            <p className="text-sm text-slate-600">Review staff-endorsed requests, assign one staff, then finalize admin decision.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={loadRows}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          disabled={isLoading}
        >
          <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Workflow</p>
        <div className="grid grid-cols-1 gap-y-3 sm:grid-cols-3 sm:gap-y-0">
          {[
            { step: 1, title: 'Review Request', body: 'Check applicant, venue, schedule, and staff notes.' },
            { step: 2, title: 'Decision Modal', body: 'Approve with assigned staff or reject with reason.' },
            { step: 3, title: 'Result Confirmation', body: 'Success modal confirms decision and email delivery.' },
          ].map((stepRow, index) => (
            <div
              key={stepRow.step}
              className={`flex items-start gap-2.5 ${index > 0 ? 'sm:border-l sm:border-slate-100 sm:pl-5' : ''} ${index < 2 ? 'sm:pr-5' : ''}`}
            >
              <span
                className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
                style={{ backgroundColor: primaryColor }}
                aria-hidden
              >
                {stepRow.step}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800">{stepRow.title}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{stepRow.body}</p>
              </div>
            </div>
          ))}
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
                Requests Queue
              </h2>
              <div className="flex items-center gap-1.5">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">{visibleRows.length}</span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Oldest first</span>
              </div>
            </div>

            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search request, event, requester..."
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
                  {queueRows.length === 0 ? 'No event requests' : 'No matches'}
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
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm font-semibold text-slate-900">{row.Event_Name || 'Untitled Event'}</p>
                            <span className="flex-none text-[10px] font-bold uppercase tracking-wider text-slate-400">ER-{row.Event_Request_ID}</span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-slate-600">{applicantFullName(row.Application)}</p>
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
              <h2 className="mt-4 text-base font-bold text-slate-800">Select an event request</h2>
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
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">ER-{selectedRow.Event_Request_ID}</p>
                      <h2 className="mt-0.5 text-xl font-bold text-slate-900">{selectedRow.Event_Name || 'Untitled Event'}</h2>
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

              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800">Request Details</h3>
                <div className="mt-3 space-y-7 text-sm">
                  <div>
                    <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Applicant</p>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Applicant Profile</p>
                        <div className="grid grid-cols-1 gap-3">
                          <div className="flex items-start gap-2.5">
                            <User size={14} className="mt-0.5 text-slate-400" />
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Full Name</p>
                              <p className="text-lg font-semibold text-slate-700">{applicantFullName(selectedRow.Application)}</p>
                            </div>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <User size={14} className="mt-0.5 text-slate-400" />
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Gender</p>
                              <p className="text-lg font-semibold text-slate-700">{selectedRow.Application?.Applicant_Gender || 'N/A'}</p>
                            </div>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <FileText size={14} className="mt-0.5 text-slate-400" />
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Valid ID Type</p>
                              <p className="text-lg font-semibold text-slate-700">{selectedRow.Application?.Applicant_Valid_ID_Type || 'N/A'}</p>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Preferred Contact</p>
                        <div className="grid grid-cols-1 gap-3">
                          <div className="flex items-start gap-2.5">
                            <Phone size={14} className="mt-0.5 text-slate-400" />
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Contact Method</p>
                              <p className="text-lg font-semibold text-slate-700">{selectedRow.Application?.Preferred_Contact_Method || 'N/A'}</p>
                            </div>
                          </div>
                          <div className="flex items-start gap-2.5">
                            <Mail size={14} className="mt-0.5 text-slate-400" />
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Contact Email</p>
                              <p className="text-lg font-semibold text-teal-700">{selectedRow.Application?.Applicant_Email || 'N/A'}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">Event Schedule & Venue</p>
                    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                      <div className="flex items-start gap-2.5">
                        <Calendar size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Proposed Start</p>
                          <p className="text-lg font-semibold text-slate-700">{formatDateTime(selectedRow.Start_Date)}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <Calendar size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Proposed End</p>
                          <p className="text-lg font-semibold text-slate-700">{formatDateTime(selectedRow.End_Date)}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <FileText size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Event Type</p>
                          <p className="text-lg font-semibold text-slate-700">{eventVisibilityLabel(selectedRow.Event_Visibility)}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <FileText size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Assigned Staff</p>
                          <p className="text-lg font-semibold text-slate-700">{assignedStaffLabel}</p>
                        </div>
                      </div>
                      <div className="md:col-span-2 flex items-start gap-2.5">
                        <MapPin size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Venue</p>
                          <p className="text-lg font-semibold text-slate-700">{extractVenueName(selectedRow.Venue_Name)}</p>
                        </div>
                      </div>
                      <div className="md:col-span-2 flex items-start gap-2.5">
                        <MapPin size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Address</p>
                          <p className="text-lg font-semibold text-slate-700">
                            {[selectedRow.Street, selectedRow.Barangay, selectedRow.City_Municipality, selectedRow.Province, selectedRow.Region, selectedRow.Country].filter(Boolean).join(', ') || 'N/A'}
                          </p>
                        </div>
                      </div>
                      <div className="md:col-span-2 flex items-start gap-2.5">
                        <FileText size={14} className="mt-0.5 text-slate-400" />
                        <div>
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Overview</p>
                          <p className="text-lg font-semibold text-slate-700">{selectedRow.Application?.Event_Overview || 'N/A'}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Attachments</p>
                      {Number.isFinite(Number(selectedRow.Latitude)) && Number.isFinite(Number(selectedRow.Longitude)) && (
                        <a
                          href={`https://maps.google.com/?q=${encodeURIComponent(`${selectedRow.Latitude},${selectedRow.Longitude}`)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline"
                        >
                          Open map <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Valid ID</p>
                          {selectedRow.Application?.Applicant_Valid_ID_URL && (
                            <a href={selectedRow.Application.Applicant_Valid_ID_URL} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">Open</a>
                          )}
                        </div>
                        {selectedRow.Application?.Applicant_Valid_ID_URL ? (
                          <a href={selectedRow.Application.Applicant_Valid_ID_URL} target="_blank" rel="noreferrer" className="block">
                            <img src={selectedRow.Application.Applicant_Valid_ID_URL} alt="Applicant valid ID" className="h-48 w-full object-cover" />
                          </a>
                        ) : (
                          <div className="flex h-48 items-center justify-center text-xs text-slate-500">No valid ID uploaded.</div>
                        )}
                      </div>

                      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Place Photo</p>
                          {selectedRow.Application?.Event_Place_Photo_URL && (
                            <a href={selectedRow.Application.Event_Place_Photo_URL} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">Open</a>
                          )}
                        </div>
                        {selectedRow.Application?.Event_Place_Photo_URL ? (
                          <a href={selectedRow.Application.Event_Place_Photo_URL} target="_blank" rel="noreferrer" className="block">
                            <img src={selectedRow.Application.Event_Place_Photo_URL} alt="Event place" className="h-48 w-full object-cover" />
                          </a>
                        ) : (
                          <div className="flex h-48 items-center justify-center text-xs text-slate-500">No place photo uploaded.</div>
                        )}
                      </div>

                      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                        <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Poster</p>
                          {selectedRow.Event_Photo_URL && (
                            <a href={selectedRow.Event_Photo_URL} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">Open</a>
                          )}
                        </div>
                        {selectedRow.Event_Photo_URL ? (
                          <a href={selectedRow.Event_Photo_URL} target="_blank" rel="noreferrer" className="block">
                            <img src={selectedRow.Event_Photo_URL} alt="Event poster" className="h-48 w-full object-cover" />
                          </a>
                        ) : (
                          <div className="flex h-48 items-center justify-center text-xs text-slate-500">No poster uploaded.</div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Staff Contact Notes</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-slate-800">{selectedRow.Staff_Contact_Notes || 'N/A'}</p>
                  </div>
                </div>
              </div>

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

      <PortalModal open={isApproveModalOpen}>
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 opacity-100 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Approve Event Request</h3>
              <button type="button" onClick={closeAllModals} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-slate-600">
              ER-{selectedRow?.Event_Request_ID}: assign one staff member before approval.
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
              <h3 className="text-lg font-semibold text-slate-900">Reject Event Request</h3>
              <button type="button" onClick={closeAllModals} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-slate-600">
              ER-{selectedRow?.Event_Request_ID}: provide clear reason for staff revision or final rejection.
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
