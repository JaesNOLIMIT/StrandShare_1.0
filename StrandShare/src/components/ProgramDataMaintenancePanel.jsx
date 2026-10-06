import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, HardDrive, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

const PRO_DATABASE_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
const PRO_STORAGE_LIMIT_BYTES = 100 * 1024 * 1024 * 1024;

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

function formatDateTime(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function maintenanceErrorMessage(error) {
  const message = String(error?.message || '').trim();
  const normalized = message.toLowerCase();
  if (
    normalized.includes('failed to send a request to the edge function')
    || normalized.includes('requested function was not found')
    || normalized.includes('not_found')
  ) {
    return 'The delete service is not ready. Ask an admin for help.';
  }
  return message || 'Could not reach the delete service. Try again.';
}

export default function ProgramDataMaintenancePanel() {
  const [summary, setSummary] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const invokeMaintenance = useCallback(async (body) => {
    if (!isSupabaseConfigured || !supabase) throw new Error('Supabase is not configured.');
    const { data, error: invokeError } = await supabase.functions.invoke(
      'program-applicant-maintenance',
      { body },
    );
    if (invokeError) {
      let serverMessage = '';
      try {
        const responseBody = await invokeError.context?.clone?.().json();
        serverMessage = String(responseBody?.error || responseBody?.message || '').trim();
      } catch {
        // Fall back to the client error when the response is not JSON.
      }
      throw new Error(serverMessage || invokeError.message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const result = await invokeMaintenance({ action: 'preview' });
      setSummary(result?.summary || null);
    } catch (loadError) {
      setError(maintenanceErrorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [invokeMaintenance]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runCleanup = async () => {
    setConfirmOpen(false);
    setIsRunning(true);
    setError('');
    setMessage('');
    try {
      const result = await invokeMaintenance({ action: 'cleanup', mode: 'manual' });
      setMessage(
        result.completed > 0
          ? `Data was deleted from ${result.completed} application${result.completed === 1 ? '' : 's'}.`
          : 'No data is ready to delete.',
      );
      await refresh();
    } catch (runError) {
      setError(maintenanceErrorMessage(runError));
    } finally {
      setIsRunning(false);
    }
  };

  const databasePercent = useMemo(
    () => Math.min(100, (Number(summary?.database_size_bytes || 0) / PRO_DATABASE_LIMIT_BYTES) * 100),
    [summary?.database_size_bytes],
  );
  const storagePercent = useMemo(
    () => Math.min(100, (Number(summary?.storage_size_bytes || 0) / PRO_STORAGE_LIMIT_BYTES) * 100),
    [summary?.storage_size_bytes],
  );

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-slate-900">
              <ShieldCheck className="text-emerald-600" size={22} />
              <h2 className="text-xl font-bold">Applicant data</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              After three months, Donivra deletes IDs, birth dates, gender, phone numbers, ID checks, and attendee details.
              Names, emails, and program records stay.
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={isLoading || isRunning}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            <AlertTriangle size={17} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {message && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
            <span>{message}</span>
          </div>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">To delete</p>
            <p className="mt-2 text-2xl font-bold text-slate-900">{isLoading ? '—' : Number(summary?.eligible_count || 0)}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Deleted</p>
            <p className="mt-2 text-2xl font-bold text-slate-900">{isLoading ? '—' : Number(summary?.completed_count || 0)}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Next date</p>
            <p className="mt-2 text-sm font-semibold text-slate-900">{isLoading ? 'Loading…' : formatDateTime(summary?.next_eligible_at)}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Auto delete</p>
            <p className={`mt-2 text-sm font-bold ${summary?.automatic_schedule_active ? 'text-emerald-700' : 'text-amber-700'}`}>
              {isLoading ? 'Checking…' : summary?.automatic_schedule_active ? 'On · Daily at 2:35 AM' : 'Off'}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-5">
          <div className="text-sm text-slate-600">
            <p>Last delete: <span className="font-semibold text-slate-800">{formatDateTime(summary?.last_cleanup_at)}</span></p>
            <p className="mt-1">Only data that is three months old can be deleted.</p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isLoading || isRunning || Number(summary?.eligible_count || 0) === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-700 px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 size={16} />
            {isRunning ? 'Deleting…' : 'Delete data now'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h2 className="text-lg font-bold text-slate-900">Storage use</h2>
        <p className="mt-1 text-sm text-slate-500">Your Supabase Pro storage.</p>
        <div className="mt-5 grid gap-5 md:grid-cols-2">
          {[
            {
              label: 'Database',
              icon: Database,
              used: summary?.database_size_bytes,
              total: PRO_DATABASE_LIMIT_BYTES,
              percent: databasePercent,
              limitLabel: '8 GB total',
            },
            {
              label: 'Uploaded files',
              icon: HardDrive,
              used: summary?.storage_size_bytes,
              total: PRO_STORAGE_LIMIT_BYTES,
              percent: storagePercent,
              limitLabel: '100 GB total (shared)',
            },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-semibold text-slate-800"><Icon size={17} />{item.label}</div>
                  <span className="text-right text-sm font-bold text-slate-900">
                    {isLoading ? '—' : `${formatBytes(item.used)} / ${formatBytes(item.total)}`}
                  </span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-sky-600" style={{ width: `${item.percent}%` }} />
                </div>
                <p className="mt-2 text-xs text-slate-500">{item.limitLabel}</p>
              </div>
            );
          })}
        </div>
      </section>

      {confirmOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-700"><AlertTriangle size={22} /><h3 className="text-lg font-bold">Delete this data?</h3></div>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              This will delete personal data and files from {Number(summary?.eligible_count || 0)} application(s). You cannot undo this.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Cancel</button>
              <button type="button" onClick={runCleanup} className="rounded-lg bg-rose-700 px-4 py-2 text-sm font-bold text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
