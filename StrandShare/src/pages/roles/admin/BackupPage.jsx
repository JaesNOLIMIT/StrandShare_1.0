import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileArchive,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const MANILA_TIME_ZONE = 'Asia/Manila';

function formatDateTime(value) {
  if (!value) return 'Not yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Not yet';
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: MANILA_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function statusClasses(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'verified') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (key === 'failed') return 'border-red-200 bg-red-50 text-red-700';
  if (key === 'expired') return 'border-slate-200 bg-slate-100 text-slate-500';
  return 'border-blue-200 bg-blue-50 text-blue-700';
}

export default function BackupPage() {
  const { theme } = useTheme();
  const [backups, setBackups] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [busyBackupId, setBusyBackupId] = useState(null);
  const [notice, setNotice] = useState({ kind: '', text: '' });

  const loadBackups = useCallback(async ({ keepNotice = false } = {}) => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    if (!keepNotice) setNotice({ kind: '', text: '' });
    try {
      const result = await supabase.rpc('list_admin_application_backups');
      if (result.error) throw result.error;
      setBackups(result.data || []);
    } catch (error) {
      setBackups([]);
      setNotice({
        kind: 'error',
        text: error?.message?.includes('list_admin_application_backups')
          ? 'Backup functions are not installed yet. Apply migration 20260909110000_admin_application_backups.sql.'
          : (error?.message || 'Unable to load backup history.'),
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  useEffect(() => {
    if (!notice.text || notice.kind === 'info') return undefined;
    const timeoutId = window.setTimeout(() => setNotice({ kind: '', text: '' }), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  const summary = useMemo(() => ({
    latest: backups[0] || null,
    totalBytes: backups.reduce((total, backup) => total + Number(backup.size_bytes || 0), 0),
    verifiedCount: backups.filter((backup) => String(backup.status).toLowerCase() === 'verified').length,
  }), [backups]);

  const handleCreateBackup = async () => {
    if (isCreating) return;
    setIsCreating(true);
    setNotice({ kind: 'info', text: 'Creating the database backup...' });
    try {
      const result = await supabase.rpc('create_admin_application_backup');
      if (result.error) throw result.error;
      setNotice({
        kind: 'success',
        text: `${result.data?.backup_code || 'Backup'} created with ${Number(result.data?.row_count || 0).toLocaleString()} rows.`,
      });
      await loadBackups({ keepNotice: true });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to create the backup.' });
    } finally {
      setIsCreating(false);
    }
  };

  const handleVerify = async (backup) => {
    const backupId = Number(backup.backup_id);
    setBusyBackupId(backupId);
    setNotice({ kind: 'info', text: `Verifying ${backup.backup_code}...` });
    try {
      const result = await supabase.rpc('verify_admin_application_backup', { p_backup_id: backupId });
      if (result.error) throw result.error;
      const valid = Boolean(result.data?.valid);
      setNotice({
        kind: valid ? 'success' : 'error',
        text: valid
          ? `${backup.backup_code} passed the checksum verification.`
          : `${backup.backup_code} failed integrity verification. Do not use this backup.`,
      });
      await loadBackups({ keepNotice: true });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to verify the backup.' });
    } finally {
      setBusyBackupId(null);
    }
  };

  const handleDownload = async (backup) => {
    const backupId = Number(backup.backup_id);
    setBusyBackupId(backupId);
    setNotice({ kind: 'info', text: `Preparing ${backup.backup_code} for download...` });
    try {
      const result = await supabase.rpc('download_admin_application_backup', { p_backup_id: backupId });
      if (result.error) throw result.error;

      const file = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${backup.backup_code}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice({ kind: 'success', text: `${backup.backup_code} downloaded successfully.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to download the backup.' });
    } finally {
      setBusyBackupId(null);
    }
  };

  const noticeStyle = notice.kind === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : notice.kind === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-blue-200 bg-blue-50 text-blue-700';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="role-page-title text-3xl font-bold text-gray-900">Backup</h1>
        <p className="mt-1 text-sm text-gray-600">Create, verify, and download your Supabase database backups.</p>
        <p className="mt-1 text-xs text-gray-400">All displayed dates and times use Philippines time (UTC+8).</p>
      </div>

      {notice.text ? (
        <div className={`fixed bottom-5 right-5 z-[120] flex w-[min(380px,calc(100vw-2rem))] items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl ${noticeStyle}`} role="alert" aria-live="polite">
          {notice.kind === 'error'
            ? <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            : notice.kind === 'info'
              ? <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin" />
              : <CheckCircle2 size={18} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 flex-1 font-medium">{notice.text}</span>
          <button type="button" onClick={() => setNotice({ kind: '', text: '' })} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100" aria-label="Close notification">
            <X size={15} />
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Latest backup</p>
          <p className="mt-2 text-sm font-bold text-slate-800">{formatDateTime(summary.latest?.created_at)}</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Stored backups</p>
          <p className="mt-2 text-2xl font-bold text-slate-800">{backups.length}</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Backup storage</p>
          <p className="mt-2 text-2xl font-bold text-slate-800">{formatBytes(summary.totalBytes)}</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Retention / verified</p>
          <p className="mt-2 text-2xl font-bold text-slate-800">30 days <span className="text-sm font-medium text-slate-400">&middot; {summary.verifiedCount} verified</span></p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCreateBackup}
            disabled={isCreating || isLoading}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
            style={{ backgroundColor: theme.primaryColor }}
          >
            {isCreating ? <Loader2 size={16} className="animate-spin" /> : <DatabaseBackup size={16} />}
            {isCreating ? 'Creating...' : 'Create Backup'}
          </button>
          <button
            type="button"
            onClick={() => summary.latest && handleVerify(summary.latest)}
            disabled={!summary.latest || busyBackupId !== null || String(summary.latest?.status || '').toLowerCase() === 'expired'}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm disabled:opacity-50"
          >
            <ShieldCheck size={16} /> Verify Latest Backup
          </button>
        </div>
        <button
          type="button"
          onClick={() => void loadBackups()}
          disabled={isLoading || isCreating}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50"
        >
          <RefreshCcw size={15} className={isLoading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="font-bold text-slate-800">Backup history</h2>
            <p className="mt-0.5 text-xs text-slate-500">Backups expire after 30 days and are purged when the next backup is created.</p>
          </div>
          <FileArchive size={19} className="text-slate-400" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">Backup</th>
                <th className="px-5 py-3">Created</th>
                <th className="px-5 py-3">Contents</th>
                <th className="px-5 py-3">Size</th>
                <th className="px-5 py-3">Integrity</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500"><Loader2 size={18} className="mx-auto mb-2 animate-spin" />Loading backups...</td></tr>
              ) : !backups.length ? (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">No backups have been created yet.</td></tr>
              ) : backups.map((backup) => {
                const isBusy = busyBackupId === Number(backup.backup_id);
                const isExpired = String(backup.status).toLowerCase() === 'expired';
                return (
                  <tr key={backup.backup_id} className="text-sm text-slate-600">
                    <td className="px-5 py-4">
                      <p className="font-mono font-bold text-slate-800">{backup.backup_code}</p>
                      <p className="mt-1 font-mono text-[10px] text-slate-400" title={backup.checksum}>Checksum {String(backup.checksum || '').slice(0, 12)}...</p>
                    </td>
                    <td className="px-5 py-4">
                      <p>{formatDateTime(backup.created_at)}</p>
                      <p className="mt-1 text-[11px] text-slate-400">Expires {formatDateTime(backup.expires_at)}</p>
                    </td>
                    <td className="px-5 py-4">{Number(backup.table_count || 0).toLocaleString()} tables &middot; {Number(backup.row_count || 0).toLocaleString()} rows</td>
                    <td className="px-5 py-4 font-semibold text-slate-700">{formatBytes(backup.size_bytes)}</td>
                    <td className="px-5 py-4">
                      <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${statusClasses(backup.status)}`}>{backup.status}</span>
                      {backup.verified_at ? <p className="mt-1 text-[11px] text-slate-400">{formatDateTime(backup.verified_at)}</p> : null}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleVerify(backup)}
                          disabled={isBusy || isExpired}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40"
                        >
                          {isBusy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Verify
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDownload(backup)}
                          disabled={isBusy || isExpired}
                          className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                          style={{ backgroundColor: theme.primaryColor }}
                        >
                          {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download JSON
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
