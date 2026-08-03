import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  CalendarDays,
  Layers,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  Scissors,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const PERIODS = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];

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

function fullName(row) {
  return [row?.first_name, row?.middle_name, row?.last_name, row?.suffix]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ') || 'Unknown donor';
}

function periodStart(period) {
  const now = new Date();
  if (period === 'all') return null;
  if (period === 'year') return new Date(now.getFullYear(), 0, 1).getTime();
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start.getTime();
}

function statusClasses(status) {
  if (status === 'Wig Created') return 'border-violet-200 bg-violet-50 text-violet-700';
  if (status === 'Bundling') return 'border-sky-200 bg-sky-50 text-sky-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

export default function CutHairInventoryPage() {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState('month');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState('');

  const loadInventory = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice('Supabase is not configured.');
      return;
    }
    setIsLoading(true);
    setNotice('');
    try {
      const inventoryResult = await supabase
        .from('Cut_Hair_Inventory')
        .select('*')
        .order('Approved_At', { ascending: false })
        .limit(3000);
      if (inventoryResult.error) throw inventoryResult.error;

      const baseRows = inventoryResult.data || [];
      const submissionIds = [...new Set(baseRows.map((row) => Number(row.Submission_ID || 0)).filter(Boolean))];
      const eventIds = [...new Set(baseRows.map((row) => Number(row.Event_Request_ID || 0)).filter(Boolean))];
      const donorIds = [...new Set(baseRows.map((row) => Number(row.Donor_User_ID || 0)).filter(Boolean))];
      const wigIds = [...new Set(baseRows.map((row) => Number(row.Wig_ID || 0)).filter(Boolean))];

      const [detailsResult, eventsResult, donorsResult, wigsResult] = await Promise.all([
        submissionIds.length
          ? supabase.from('Hair_Submission_Details').select('Submission_ID, Declared_Length, Declared_Color, Declared_Texture, Declared_Density, Declared_Condition').in('Submission_ID', submissionIds)
          : Promise.resolve({ data: [], error: null }),
        eventIds.length
          ? supabase.from('Event_Requests').select('Event_Request_ID, Event_Name, Start_Date').in('Event_Request_ID', eventIds)
          : Promise.resolve({ data: [], error: null }),
        donorIds.length
          ? supabase.from('user_details').select('user_id, first_name, middle_name, last_name, suffix').in('user_id', donorIds)
          : Promise.resolve({ data: [], error: null }),
        wigIds.length
          ? supabase.from('Wigs').select('Wig_ID, Wig_Code, Wig_Name').in('Wig_ID', wigIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (detailsResult.error) throw detailsResult.error;
      if (eventsResult.error) throw eventsResult.error;
      if (donorsResult.error) throw donorsResult.error;
      if (wigsResult.error) throw wigsResult.error;

      const detailsBySubmission = new Map((detailsResult.data || []).map((row) => [Number(row.Submission_ID), row]));
      const eventsById = new Map((eventsResult.data || []).map((row) => [Number(row.Event_Request_ID), row]));
      const donorsById = new Map((donorsResult.data || []).map((row) => [Number(row.user_id), row]));
      const wigsById = new Map((wigsResult.data || []).map((row) => [Number(row.Wig_ID), row]));

      setRows(baseRows.map((row) => ({
        ...row,
        detail: detailsBySubmission.get(Number(row.Submission_ID)) || null,
        event: eventsById.get(Number(row.Event_Request_ID)) || null,
        donor: donorsById.get(Number(row.Donor_User_ID)) || null,
        wig: wigsById.get(Number(row.Wig_ID)) || null,
      })));
    } catch (error) {
      setNotice(error?.message || 'Unable to load cut hair inventory. Run the new SQL migration first.');
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadInventory(); }, [loadInventory]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;
    let timer = null;
    const refresh = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void loadInventory(); }, 250);
    };
    const channel = supabase
      .channel('cut-hair-inventory-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'Cut_Hair_Inventory' }, refresh)
      .subscribe();
    return () => {
      if (timer) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [loadInventory]);

  const filteredRows = useMemo(() => {
    const start = periodStart(period);
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== 'all' && row.Status !== status) return false;
      if (start && new Date(row.Approved_At).getTime() < start) return false;
      if (!term) return true;
      return [
        row.Submission_ID,
        row.event?.Event_Name,
        fullName(row.donor),
        row.detail?.Declared_Color,
        row.detail?.Declared_Texture,
        row.Status,
      ].join(' ').toLowerCase().includes(term);
    });
  }, [period, rows, search, status]);

  const summary = useMemo(() => ({
    total: filteredRows.length,
    cut: filteredRows.filter((row) => row.Status === 'Cut').length,
    bundling: filteredRows.filter((row) => row.Status === 'Bundling').length,
    usedInWigs: filteredRows.filter((row) => row.Status === 'Wig Created' && row.Wig_ID).length,
    created: new Set(
      filteredRows
        .filter((row) => row.Status === 'Wig Created' && row.Wig_ID && row.Bundle_ID)
        .map((row) => Number(row.Bundle_ID)),
    ).size,
  }), [filteredRows]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cut Hair Inventory</h1>
          <p className="text-sm text-slate-600">Only quality-approved cut hair appears here and can proceed to bundling.</p>
          <p className="mt-1 text-xs text-emerald-700">Inventory status updates live from Cut to Bundling to Wig Created.</p>
        </div>
        <button
          type="button"
          onClick={() => { void loadInventory(); }}
          disabled={isLoading}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {isLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
      </div>

      {notice && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{notice}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Approved hair items', summary.total, Boxes, 'Quality-approved inventory'],
          ['Cut / Available', summary.cut, Scissors, 'Ready for bundling'],
          ['Bundling hair', summary.bundling, Layers, 'Assigned to unfinished bundles'],
          ['Completed wigs', summary.created, PackageCheck, `${summary.usedInWigs} hair item${summary.usedInWigs === 1 ? '' : 's'} used`],
        ].map(([label, value, Icon, helper]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-500">{label}</p>
              <Icon size={16} style={{ color: primaryColor }} />
            </div>
            <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">{helper}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-4">
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
            {PERIODS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPeriod(item.id)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${period === item.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700">
            <option value="all">All statuses</option>
            <option value="Cut">Cut</option>
            <option value="Bundling">Bundling</option>
            <option value="Wig Created">Wig Created</option>
          </select>
          <div className="relative min-w-[220px] flex-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search donor, event, hair, or ID" className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs" />
          </div>
        </div>

        {isLoading && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 p-12 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />Loading inventory...</div>
        ) : filteredRows.length === 0 ? (
          <div className="p-12 text-center text-sm text-slate-500">No approved cut hair matches these filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">Inventory</th>
                  <th className="px-4 py-3 font-semibold">Donor / Source</th>
                  <th className="px-4 py-3 font-semibold">Hair details</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Approved</th>
                  <th className="px-4 py-3 font-semibold">Production links</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.Inventory_ID} className="border-t border-slate-200 align-top hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs font-bold text-slate-900">CHI-{String(row.Inventory_ID).padStart(6, '0')}</p>
                      <p className="text-[11px] text-slate-500">Submission #{row.Submission_ID}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">{fullName(row.donor)}</p>
                      <p className="text-xs text-slate-500">{row.Source_Type}</p>
                      {row.event && <p className="mt-1 inline-flex items-center gap-1 text-xs text-slate-600"><CalendarDays size={11} />{row.event.Event_Name}</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      <p>{row.detail?.Declared_Length ?? 'N/A'} in · {row.detail?.Declared_Color || 'No color'}</p>
                      <p>{row.detail?.Declared_Texture || 'No texture'} · {row.detail?.Declared_Density || 'No density'}</p>
                      <p className="text-slate-500">{row.detail?.Declared_Condition || 'No condition'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${statusClasses(row.Status)}`}>{row.Status}</span>
                      {row.Status === 'Wig Created' && <p className="mt-1 text-[11px] text-slate-500">Hair used in completed wig</p>}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{formatDateTime(row.Approved_At)}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      <p>{row.Bundle_ID ? `Bundle #${row.Bundle_ID}` : 'Not bundled'}</p>
                      <p>{row.wig?.Wig_Code || (row.Wig_ID ? `Wig #${row.Wig_ID}` : 'No wig yet')}</p>
                      {row.wig?.Wig_Name && <p className="text-slate-500">{row.wig.Wig_Name}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
