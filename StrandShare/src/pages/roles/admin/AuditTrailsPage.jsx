import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Search } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

function formatTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const datePart = parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timePart = parsed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${datePart} ${timePart}`;
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

    const normalized = (rows || []).map((row) => ({
      logId: row.log_id,
      userName: nameMap[row.user_id] || 'Unknown User',
      userEmail: row.user_email || '-',
      action: row.action || '-',
      description: row.description || '-',
      resource: row.resource || '-',
      status: row.status || '-',
      time: formatTimestamp(row.time),
    }));

    setLogs(normalized);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadAuditLogs();

    if (!isSupabaseConfigured || !supabase) {
      return undefined;
    }

    const channel = supabase
      .channel('admin-audit-trails-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs' }, () => void loadAuditLogs())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_details' }, () => void loadAuditLogs())
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
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
  const eventsToday = filteredLogs.filter((row) => row.time.startsWith(todayPstDateString)).length;
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
          <p className="text-sm text-gray-500">Events Today</p>
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
            placeholder="Search by user name, email, action, or resource..."
            className="w-full bg-transparent outline-none text-sm"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px]">
            <thead style={{ backgroundColor: `${theme.primaryColor}15` }}>
              <tr>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">Time</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">User Name</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">User Email</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">Action</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">Resource</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">Status</th>
                <th className="px-4 py-3 text-left text-sm font-bold text-gray-900">Description</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td className="px-4 py-3 text-sm text-gray-600" colSpan={7}>
                    Loading audit logs...
                  </td>
                </tr>
              )}

              {!isLoading && loadError && (
                <tr>
                  <td className="px-4 py-3 text-sm text-red-600" colSpan={7}>
                    {loadError}
                  </td>
                </tr>
              )}

              {!isLoading && !loadError && filteredLogs.length === 0 && (
                <tr>
                  <td className="px-4 py-3 text-sm text-gray-600" colSpan={7}>
                    No matching logs.
                  </td>
                </tr>
              )}

              {filteredLogs.map((row) => (
                <tr key={row.logId} className="border-t border-gray-200">
                  <td className="px-4 py-3 text-sm text-gray-700">{row.time}</td>
                  <td className="px-4 py-3 text-sm text-gray-900">{row.userName}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.userEmail}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.action}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.resource}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${String(row.status).toLowerCase() === 'failed' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl p-4 border" style={{ borderColor: `${theme.secondaryColor}55`, backgroundColor: `${theme.secondaryColor}12` }}>
        <div className="flex items-center gap-2 text-sm" style={{ color: theme.secondaryColorDark }}>
          <ShieldAlert size={16} />
          Live data source: audit_logs table.
        </div>
      </div>
    </div>
  );
}
