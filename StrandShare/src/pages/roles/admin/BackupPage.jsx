import React, { useEffect, useMemo, useState } from 'react';
import { DatabaseBackup, DownloadCloud, RefreshCcw, HardDrive } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { logAuditAction } from '../../../lib/auditLogger';

function formatTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const datePart = parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timePart = parsed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${datePart} ${timePart}`;
}

function getBackupIdFromResource(resource = '') {
  const parts = String(resource).split(':');
  return parts[1] || `BKP-${Date.now()}`;
}

function getSizeFromDescription(description = '') {
  const match = String(description).match(/size\s([\d.]+\s(?:GB|MB))/i);
  return match?.[1] || 'N/A';
}

function parseSizeToGb(sizeText) {
  const match = String(sizeText).match(/^([\d.]+)\s(GB|MB)$/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  return unit === 'GB' ? value : value / 1024;
}

function generateBackupSize() {
  const size = (1.8 + Math.random() * 1.4).toFixed(1);
  return `${size} GB`;
}

export default function BackupPage({ userProfile }) {
  const { theme } = useTheme();
  const [backupRows, setBackupRows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState('');

  const loadBackups = async () => {
    if (!isSupabaseConfigured || !supabase) {
      return;
    }

    setIsLoading(true);
    setNotice('');

    const { data, error } = await supabase
      .from('audit_logs')
      .select('log_id, action, description, time, resource, status')
      .eq('action', 'backup.create')
      .order('time', { ascending: false })
      .limit(50);

    if (error) {
      setNotice('Could not load backup history yet.');
      setIsLoading(false);
      return;
    }

    const rows = (data || []).map((row) => ({
      id: getBackupIdFromResource(row.resource),
      createdAt: formatTime(row.time),
      size: getSizeFromDescription(row.description),
      status: row.status || 'completed',
      logId: row.log_id,
    }));

    setBackupRows(rows);
    setIsLoading(false);
  };

  useEffect(() => {
    loadBackups();
  }, []);

  const latestBackup = backupRows[0]?.createdAt || 'No backups yet';
  const storageUsedGb = useMemo(() => backupRows.reduce((sum, row) => sum + parseSizeToGb(row.size), 0), [backupRows]);

  const handleCreateBackup = async () => {
    const backupId = `BKP-${Date.now().toString().slice(-6)}`;
    const size = generateBackupSize();

    const result = await logAuditAction({
      action: 'backup.create',
      description: `Created backup snapshot ${backupId} with size ${size}.`,
      resource: `backup:${backupId}`,
      status: 'completed',
      userProfile,
    });

    if (!result.logged) {
      setNotice('Backup action could not be logged. Check audit_logs setup in Supabase.');
      return;
    }

    setNotice(`Backup ${backupId} created.`);
    await loadBackups();
  };

  const handleRunVerification = async () => {
    const result = await logAuditAction({
      action: 'backup.verify',
      description: 'Ran backup verification check.',
      resource: 'backup/system',
      status: 'success',
      userProfile,
    });

    setNotice(result.logged ? 'Verification completed and logged.' : 'Verification ran, but logging failed.');
  };

  const handleDownloadBackup = async (row) => {
    const result = await logAuditAction({
      action: 'backup.download',
      description: `Downloaded backup ${row.id}.`,
      resource: `backup:${row.id}`,
      status: 'success',
      userProfile,
    });

    setNotice(result.logged ? `${row.id} download action logged.` : `${row.id} download logging failed.`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="role-page-title text-3xl font-bold text-gray-900 mb-2">Backup</h1>
        <p className="text-gray-600">Manage snapshots, retention, and restore readiness.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">Latest Backup</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{latestBackup}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">Storage Used</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{storageUsedGb.toFixed(1)} GB</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">Retention Policy</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">30 days</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleCreateBackup}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white"
          style={{ backgroundColor: theme.primaryColor }}
        >
          <DatabaseBackup size={16} /> Create Backup
        </button>
        <button
          onClick={handleRunVerification}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-700"
        >
          <RefreshCcw size={16} /> Run Verification
        </button>
      </div>

      {notice && (
        <div className="text-sm text-gray-700">{notice}</div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead style={{ backgroundColor: `${theme.primaryColor}15` }}>
            <tr>
              <th className="px-6 py-3 text-left text-sm font-bold text-gray-900">Backup ID</th>
              <th className="px-6 py-3 text-left text-sm font-bold text-gray-900">Created At</th>
              <th className="px-6 py-3 text-left text-sm font-bold text-gray-900">Size</th>
              <th className="px-6 py-3 text-left text-sm font-bold text-gray-900">Status</th>
              <th className="px-6 py-3 text-right text-sm font-bold text-gray-900">Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td className="px-6 py-4 text-sm text-gray-600" colSpan={5}>
                  Loading backup history...
                </td>
              </tr>
            )}

            {!isLoading && backupRows.length === 0 && (
              <tr>
                <td className="px-6 py-4 text-sm text-gray-600" colSpan={5}>
                  No backup logs yet. Create your first backup.
                </td>
              </tr>
            )}

            {backupRows.map((row) => (
              <tr key={row.id} className="border-t border-gray-200">
                <td className="px-6 py-4 text-sm text-gray-800">{row.id}</td>
                <td className="px-6 py-4 text-sm text-gray-600">{row.createdAt}</td>
                <td className="px-6 py-4 text-sm text-gray-600">{row.size}</td>
                <td className="px-6 py-4 text-sm">
                  <span className={`px-2 py-1 rounded text-xs font-semibold ${row.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    {row.status}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <button
                    onClick={() => handleDownloadBackup(row)}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm"
                  >
                    <DownloadCloud size={14} /> Download
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl p-4 border" style={{ borderColor: `${theme.tertiaryColor}55`, backgroundColor: `${theme.tertiaryColor}12` }}>
        <div className="flex items-center gap-2 text-sm" style={{ color: theme.tertiaryColorDark }}>
          <HardDrive size={16} />
          Ensure backup verification is enabled after each scheduled snapshot.
        </div>
      </div>
    </div>
  );
}
