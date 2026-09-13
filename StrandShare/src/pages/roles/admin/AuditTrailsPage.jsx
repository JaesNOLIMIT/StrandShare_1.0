import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Search } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

function formatTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { date: value || '-', time: '' };
  }

  const datePart = parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timePart = parsed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { date: datePart, time: timePart };
}

const ACTION_LABELS = {
  'auth.sign_in': 'Signed in',
  'auth.sign_out': 'Signed out',
  hospital_release_completed: 'Completed hospital release',
  staff_wig_request_action: 'Reviewed wig request',
  'wig_requests.schedule_release': 'Scheduled wig release',
  'wig_requests.complete_release': 'Completed wig release',
  'event_attendees.rsvp_scan': 'Scanned attendee RSVP',
  'hair_submissions.staff_quality_review': 'Reviewed hair quality',
  'hair_submissions.specialist_non_event_quality_review': 'Reviewed walk-in hair quality',
  'hair_submissions.staff_update_details': 'Updated hair details',
  'hair_submissions.scan_non_event': 'Scanned walk-in donation',
  'hair_submission_bundles.open_draft': 'Started a hair bundle',
  'hair_submission_bundles.scan_waybill': 'Scanned a bundle waybill',
  'hair_submission_bundles.close_draft': 'Completed a hair bundle',
  'wigs.complete_stock_from_bundle_scan': 'Added completed wig stock',
  'wigs.completed_from_bundle': 'Created wig from hair bundle',
  wig_catalog_bundle_scan_completed: 'Completed wig bundle scan',
  wig_catalog_item_created: 'Added a wig catalog item',
  wig_catalog_stock_adjusted: 'Adjusted wig stock',
  'backup.create': 'Created application backup',
  'backup.verify': 'Verified application backup',
  'backup.download': 'Downloaded application backup',
};

const RESOURCE_LABELS = {
  Hair_Submissions: 'Hair submission',
  Hair_Submission_Details: 'Hair details',
  Hair_Submission_Bundles: 'Hair bundle',
  Event_Attendees: 'Program attendee',
  Event_Requests: 'Program',
  Event_Applications: 'Program application',
  Wig_Requests: 'Wig request',
  Wigs: 'Wig inventory',
  Wig_Catalog: 'Wig catalog',
  app: 'Platform',
};

const DETAIL_LABELS = {
  event_request_id: 'Program',
  event_application_id: 'Application',
  submission_id: 'Submission',
  attendee_id: 'Attendee',
  request_id: 'Request',
  schedule_id: 'Schedule',
  allocated_wig_id: 'Wig',
  waybill: 'Waybill',
  decision: 'Decision',
  resulting_status: 'Outcome',
  status: 'Status',
  reason: 'Reason',
  detail_count: 'Details updated',
};

const ID_DETAIL_KEYS = new Set([
  'event_request_id',
  'event_application_id',
  'submission_id',
  'attendee_id',
  'request_id',
  'schedule_id',
  'allocated_wig_id',
]);

function humanize(value) {
  return String(value || '-')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getActionLabel(action) {
  return ACTION_LABELS[action] || humanize(action);
}

function getResourceLabel(resource) {
  const value = String(resource || '-');
  if (RESOURCE_LABELS[value]) return RESOURCE_LABELS[value];
  if (value.startsWith('backup:')) return 'Application backup';
  return humanize(value);
}

function formatDetailValue(key, value) {
  const cleanValue = String(value || '').trim().replace(/[.;]+$/, '');
  if (!cleanValue || cleanValue.toLowerCase() === 'none' || cleanValue.toLowerCase() === 'n/a') {
    return 'Not provided';
  }
  return ID_DETAIL_KEYS.has(key) ? `#${cleanValue}` : cleanValue.replace(/_/g, ' ');
}

function parseAuditDescription(description) {
  const cleanDescription = String(description || '')
    .replace(/\s*\[actor:[^\]]*\]\s*/gi, ' ')
    .trim();

  if (!cleanDescription || cleanDescription === '-') return { summary: '', details: [] };

  const markerPattern = /\b(event_request_id|event_application_id|submission_id|attendee_id|request_id|schedule_id|allocated_wig_id|waybill|decision|resulting_status|status|reason|detail_count)=/gi;
  const matches = [...cleanDescription.matchAll(markerPattern)];
  if (matches.length === 0) return { summary: cleanDescription, details: [] };

  const summary = cleanDescription.slice(0, matches[0].index).trim().replace(/[:;,-]+$/, '');
  const details = matches.map((match, index) => {
    const key = match[1].toLowerCase();
    const valueStart = match.index + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index : cleanDescription.length;
    return {
      label: DETAIL_LABELS[key] || humanize(key),
      value: formatDetailValue(key, cleanDescription.slice(valueStart, valueEnd)),
    };
  });

  return { summary, details };
}

export default function AuditTrailsPage() {
  const { theme } = useTheme();
  const [logs, setLogs] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadAuditLogs = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setLoadError('Supabase is not configured.');
      return;
    }

    setIsLoading(true);
    setLoadError('');

    const { data: rows, error } = await supabase
      .from('audit_logs')
      .select('log_id, user_id, action, description, time, user_email, resource, status')
      .order('time', { ascending: false })
      .limit(300);

    if (error) {
      setLoadError('Unable to load audit logs. Please verify audit_logs table and policies.');
      setIsLoading(false);
      return;
    }

    const userIds = [...new Set((rows || []).map((row) => row.user_id).filter(Boolean))];
    let nameMap = {};

    if (userIds.length > 0) {
      const { data: detailRows } = await supabase
        .from('user_details')
        .select('user_id, first_name, last_name')
        .in('user_id', userIds);

      nameMap = (detailRows || []).reduce((acc, row) => {
        const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
        acc[row.user_id] = fullName;
        return acc;
      }, {});
    }

    const normalized = (rows || []).map((row) => {
      const description = row.description || '-';
      return {
        logId: row.log_id,
        userName: nameMap[row.user_id] || 'Unknown user',
        userEmail: row.user_email || 'Email unavailable',
        action: row.action || '-',
        actionLabel: getActionLabel(row.action),
        description,
        descriptionDisplay: parseAuditDescription(description),
        resource: row.resource || '-',
        resourceLabel: getResourceLabel(row.resource),
        status: row.status || '-',
        timestamp: formatTimestamp(row.time),
      };
    });

    setLogs(normalized);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs]);

  const filteredLogs = useMemo(() => {
    if (!searchQuery.trim()) {
      return logs;
    }

    const q = searchQuery.toLowerCase();
    return logs.filter((row) => {
      return (
        row.userName.toLowerCase().includes(q)
        || row.userEmail.toLowerCase().includes(q)
        || row.action.toLowerCase().includes(q)
        || row.resource.toLowerCase().includes(q)
        || row.description.toLowerCase().includes(q)
        || row.status.toLowerCase().includes(q)
      );
    });
  }, [logs, searchQuery]);

  const todayPstDateString = new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
  const eventsToday = filteredLogs.filter((row) => row.timestamp.date === todayPstDateString).length;
  const failedActions = filteredLogs.filter((row) => String(row.status).toLowerCase() === 'failed').length;
  const uniqueUsers = new Set(filteredLogs.map((row) => row.userEmail)).size;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="role-page-title text-3xl font-bold text-gray-900 mb-2">Audit Trails</h1>
        <p className="text-gray-600">Track account and security-sensitive actions across the platform.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-200 p-4 bg-white">
          <p className="text-sm text-gray-500">Actions Today</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{eventsToday}</p>
        </div>
        <div className="rounded-xl border border-gray-200 p-4 bg-white">
          <p className="text-sm text-gray-500">Failed Actions</p>
          <p className="text-2xl font-bold text-red-600 mt-1">{failedActions}</p>
        </div>
        <div className="rounded-xl border border-gray-200 p-4 bg-white">
          <p className="text-sm text-gray-500">Unique Users</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{uniqueUsers}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-2 mb-4 text-gray-700">
          <Search size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search people, activities, records, or details..."
            className="w-full bg-transparent outline-none text-sm"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] table-fixed">
            <thead style={{ backgroundColor: `${theme.primaryColor}15` }}>
              <tr>
                <th className="w-[150px] px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-600">When</th>
                <th className="w-[230px] px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-600">User</th>
                <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-600">Activity</th>
                <th className="w-[110px] px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-gray-600">Result</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-gray-600" colSpan={4}>
                    Loading audit logs...
                  </td>
                </tr>
              )}

              {!isLoading && loadError && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-red-600" colSpan={4}>
                    {loadError}
                  </td>
                </tr>
              )}

              {!isLoading && !loadError && filteredLogs.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-gray-600" colSpan={4}>
                    No matching logs.
                  </td>
                </tr>
              )}

              {filteredLogs.map((row) => (
                <tr key={row.logId} className="border-t border-gray-200 align-top hover:bg-gray-50/70">
                  <td className="px-4 py-4">
                    <p className="text-sm font-medium text-gray-800">{row.timestamp.date}</p>
                    <p className="mt-0.5 text-xs text-gray-500">{row.timestamp.time}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="text-sm font-semibold text-gray-900">{row.userName}</p>
                    <p className="mt-0.5 truncate text-xs text-gray-500" title={row.userEmail}>{row.userEmail}</p>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">{row.actionLabel}</p>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        {row.resourceLabel}
                      </span>
                    </div>
                    {row.descriptionDisplay.summary && (
                      <p className="mt-1 text-xs leading-5 text-gray-600">{row.descriptionDisplay.summary}</p>
                    )}
                    {row.descriptionDisplay.details.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {row.descriptionDisplay.details.map((detail, index) => (
                          <span key={`${detail.label}-${index}`} className="text-xs text-gray-600">
                            <span className="font-medium text-gray-500">{detail.label}:</span>{' '}
                            <span className="text-gray-800">{detail.value}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-4 text-sm">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${String(row.status).toLowerCase() === 'failed' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {String(row.status).toLowerCase() === 'failed' ? 'Failed' : 'Successful'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl p-4 border" style={{ borderColor: `${theme.secondaryColor}55`, backgroundColor: `${theme.secondaryColor}12` }}>
        <div className="flex items-center gap-2 text-sm" style={{ color: theme.secondaryColorDark }}>
          <ShieldAlert size={16} />
          Showing the 300 most recent security and account activities.
        </div>
      </div>
    </div>
  );
}
