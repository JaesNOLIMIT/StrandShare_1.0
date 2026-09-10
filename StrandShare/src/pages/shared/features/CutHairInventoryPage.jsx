import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  CalendarDays,
  Layers,
  Loader2,
  Package,
  PackageCheck,
  Search,
  Scissors,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { useToast } from '../../../context/ToastContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import PageHeaderActions from '../../../components/PageHeaderActions';

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

function canonicalInventoryStatus(value, bundleId, submissionStatus) {
  const key = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '');
  const submissionKey = String(submissionStatus || '').trim().toLowerCase().replace(/[_\s-]+/g, '');
  if (key === 'wigcreated' || submissionKey === 'wigcreated') return 'Wig Created';
  if (key === 'wiginproduction' || submissionKey === 'wiginproduction') return 'Wig In Production';
  if (key === 'cut') return 'Cut';
  if (key === 'bundling') return 'Bundling';
  if (bundleId == null) return 'Cut';
  return 'Bundling';
}

function dateBoundary(value, endOfDay = false) {
  if (!value) return null;
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function statusClasses(status) {
  if (status === 'Wig Created') return 'border-violet-200 bg-violet-50 text-violet-700';
  if (status === 'Wig In Production') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (status === 'Bundling') return 'border-sky-200 bg-sky-50 text-sky-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

export default function CutHairInventoryPage({ isActivePage = true }) {
  const { theme } = useTheme();
  const { showToast } = useToast();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const [rows, setRows] = useState([]);
  const [period, setPeriod] = useState('all');
  const [status, setStatus] = useState('all');
  const [eventFilter, setEventFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const loadInventory = useCallback(async ({ showSuccess = false } = {}) => {
    if (!isSupabaseConfigured || !supabase) {
      showToast({ type: 'error', title: 'Error', message: 'Supabase is not configured.' });
      return;
    }
    setIsLoading(true);
    try {
      const inventoryResult = await supabase
        .from('Cut_Hair_Inventory')
        .select('*')
        .order('Approved_At', { ascending: false })
        .limit(3000);
      if (inventoryResult.error) throw inventoryResult.error;

      const baseRows = inventoryResult.data || [];
      const submissionIds = [...new Set(baseRows.map((row) => Number(row.Submission_ID || 0)).filter(Boolean))];
      const submissionsResult = submissionIds.length
        ? await supabase
          .from('Hair_Submissions')
          .select('Submission_ID, User_ID, Status, Bundle_ID, Event_Request_ID, Event_Attendee_ID, From_Event')
          .in('Submission_ID', submissionIds)
        : { data: [], error: null };
      if (submissionsResult.error) throw submissionsResult.error;

      const submissionsById = new Map((submissionsResult.data || []).map((row) => [Number(row.Submission_ID), row]));
      const bundleIds = [...new Set([
        ...baseRows.map((row) => Number(row.Bundle_ID || 0)),
        ...(submissionsResult.data || []).map((row) => Number(row.Bundle_ID || 0)),
      ].filter(Boolean))];
      const bundlesResult = bundleIds.length
        ? await supabase
          .from('Hair_Submission_Bundles')
          .select('Bundle_ID, Wig_Specification_ID, Status, Wig_Completed_At')
          .in('Bundle_ID', bundleIds)
        : { data: [], error: null };
      if (bundlesResult.error) throw bundlesResult.error;

      const specificationIds = [...new Set((bundlesResult.data || [])
        .map((row) => Number(row.Wig_Specification_ID || 0))
        .filter(Boolean))];
      const specificationsResult = specificationIds.length
        ? await supabase
          .from('Wig_Specifications')
          .select('Wig_Specification_ID, Wig_ID')
          .in('Wig_Specification_ID', specificationIds)
        : { data: [], error: null };
      if (specificationsResult.error) throw specificationsResult.error;

      const specificationsById = new Map((specificationsResult.data || []).map((row) => [
        Number(row.Wig_Specification_ID),
        row,
      ]));
      const resolvedWigIdByBundle = new Map((bundlesResult.data || []).map((bundle) => [
        Number(bundle.Bundle_ID),
        Number(specificationsById.get(Number(bundle.Wig_Specification_ID))?.Wig_ID || 0) || null,
      ]));
      const eventIds = [...new Set([
        ...baseRows.map((row) => Number(row.Event_Request_ID || 0)),
        ...(submissionsResult.data || []).map((row) => Number(row.Event_Request_ID || 0)),
      ].filter(Boolean))];
      const donorIds = [...new Set([
        ...baseRows.map((row) => Number(row.Donor_User_ID || 0)),
        ...(submissionsResult.data || []).map((row) => Number(row.User_ID || 0)),
      ].filter(Boolean))];
      const wigIds = [...new Set([
        ...baseRows.map((row) => Number(row.Wig_ID || 0)),
        ...resolvedWigIdByBundle.values(),
      ].filter(Boolean))];
      const attendeeIds = [...new Set([
        ...baseRows.map((row) => Number(row.Event_Attendee_ID || 0)),
        ...(submissionsResult.data || []).map((row) => Number(row.Event_Attendee_ID || 0)),
      ].filter(Boolean))];

      const [detailsResult, eventsResult, attendeesResult, donorsResult, wigsResult] = await Promise.all([
        submissionIds.length
          ? supabase.from('Hair_Submission_Details').select('Submission_ID, Declared_Length, Declared_Color, Declared_Texture, Declared_Density, Declared_Condition').in('Submission_ID', submissionIds)
          : Promise.resolve({ data: [], error: null }),
        eventIds.length
          ? supabase.from('Event_Requests').select('Event_Request_ID, Event_Name, Start_Date').in('Event_Request_ID', eventIds)
          : Promise.resolve({ data: [], error: null }),
        attendeeIds.length
          ? supabase.rpc('get_cut_hair_inventory_waybills', { p_event_attendee_ids: attendeeIds })
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
      if (attendeesResult.error) throw attendeesResult.error;
      if (donorsResult.error) throw donorsResult.error;
      if (wigsResult.error) throw wigsResult.error;

      const detailsBySubmission = new Map((detailsResult.data || []).map((row) => [Number(row.Submission_ID), row]));
      const eventsById = new Map((eventsResult.data || []).map((row) => [Number(row.Event_Request_ID), row]));
      const attendeesById = new Map((attendeesResult.data || []).map((row) => [Number(row.event_attendee_id), row]));
      const attendeesByEventAndUser = new Map((attendeesResult.data || []).map((row) => [
        `${Number(row.event_request_id || 0)}:${Number(row.user_id || 0)}`,
        row,
      ]));
      const donorsById = new Map((donorsResult.data || []).map((row) => [Number(row.user_id), row]));
      const wigsById = new Map((wigsResult.data || []).map((row) => [Number(row.Wig_ID), row]));

      setRows(baseRows.map((row) => {
        const submission = submissionsById.get(Number(row.Submission_ID)) || null;
        const bundleId = submission ? submission.Bundle_ID : row.Bundle_ID;
        const inventoryStatus = canonicalInventoryStatus(row.Status, bundleId, submission?.Status);
        const resolvedWigId = inventoryStatus === 'Wig Created'
          ? (Number(row.Wig_ID || resolvedWigIdByBundle.get(Number(bundleId)) || 0) || null)
          : null;
        const donorUserId = Number(submission?.User_ID || row.Donor_User_ID || 0);
        const eventRequestId = Number(submission?.Event_Request_ID || row.Event_Request_ID || 0);
        const eventAttendeeId = Number(submission?.Event_Attendee_ID || row.Event_Attendee_ID || 0);
        const attendee = attendeesById.get(eventAttendeeId)
          || attendeesByEventAndUser.get(`${eventRequestId}:${donorUserId}`)
          || null;

        return {
          ...row,
          Bundle_ID: bundleId,
          Wig_ID: resolvedWigId,
          Status: inventoryStatus,
          Donor_User_ID: donorUserId || row.Donor_User_ID,
          Event_Request_ID: eventRequestId || row.Event_Request_ID,
          Event_Attendee_ID: eventAttendeeId || row.Event_Attendee_ID,
          Waybill_Code: String(attendee?.waybill_code || '').trim().toUpperCase(),
          detail: detailsBySubmission.get(Number(row.Submission_ID)) || null,
          event: eventsById.get(eventRequestId) || null,
          donor: donorsById.get(donorUserId) || null,
          wig: resolvedWigId ? (wigsById.get(resolvedWigId) || null) : null,
        };
      }));
      if (showSuccess) {
        showToast({ type: 'success', message: 'Cut hair inventory refreshed.' });
      }
    } catch (error) {
      showToast({
        type: 'error',
        title: 'Error',
        message: error?.message || 'Unable to load cut hair inventory. Run the new SQL migration first.',
      });
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void loadInventory(); }, [loadInventory]);

  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase) return undefined;
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
  }, [isActivePage, loadInventory]);

  const eventOptions = useMemo(() => {
    const events = new Map();
    rows.forEach((row) => {
      const eventId = Number(row.Event_Request_ID || 0);
      if (eventId) {
        events.set(eventId, row.event?.Event_Name || `Event #${eventId}`);
      }
    });
    return [...events.entries()]
      .map(([id, name]) => ({ id: String(id), name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const quickStart = dateFrom || dateTo ? null : periodStart(period);
    const customStart = dateBoundary(dateFrom);
    const customEnd = dateBoundary(dateTo, true);
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== 'all' && row.Status !== status) return false;
      const eventId = Number(row.Event_Request_ID || 0);
      const isNonEvent = !eventId || row.Source_Type === 'Non-Event';
      if (eventFilter === 'non-event' && !isNonEvent) return false;
      if (!['all', 'non-event'].includes(eventFilter) && eventId !== Number(eventFilter)) return false;

      const approvedAt = new Date(row.Approved_At).getTime();
      if (quickStart && approvedAt < quickStart) return false;
      if (customStart && approvedAt < customStart) return false;
      if (customEnd && approvedAt > customEnd) return false;
      if (!term) return true;
      return [
        row.Submission_ID,
        row.Waybill_Code,
        row.Bundle_ID,
        row.wig?.Wig_Code,
        row.wig?.Wig_Name,
        row.event?.Event_Name,
        fullName(row.donor),
        row.detail?.Declared_Color,
        row.detail?.Declared_Texture,
        row.Status,
      ].join(' ').toLowerCase().includes(term);
    });
  }, [dateFrom, dateTo, eventFilter, period, rows, search, status]);

  const hasActiveFilters = period !== 'all'
    || status !== 'all'
    || eventFilter !== 'all'
    || Boolean(dateFrom)
    || Boolean(dateTo)
    || Boolean(search.trim());

  const clearFilters = () => {
    setPeriod('all');
    setStatus('all');
    setEventFilter('all');
    setDateFrom('');
    setDateTo('');
    setSearch('');
  };

  const summary = useMemo(() => ({
    total: filteredRows.length,
    cut: filteredRows.filter((row) => row.Status === 'Cut').length,
    bundling: filteredRows.filter((row) => row.Status === 'Bundling').length,
    production: filteredRows.filter((row) => row.Status === 'Wig In Production').length,
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
          <h1 className="role-page-title text-2xl font-bold text-slate-900">Cut Hair Inventory</h1>
          <p className="text-sm text-slate-600">Only quality-approved cut hair appears here and can proceed to bundling.</p>
        </div>
        <PageHeaderActions
          onRefresh={() => { void loadInventory({ showSuccess: true }); }}
          refreshLoading={isLoading}
          helpTitle="About Cut Hair Inventory"
          helpContent={(
            <>
              <p>Review quality-approved hair and follow each item from available stock through bundling, wig production, and completion.</p>
              <p>Use the status, event, date, and search filters to find a specific inventory item or waybill.</p>
            </>
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ['Approved hair items', summary.total, Boxes, 'Quality-approved inventory'],
          ['Cut / Available', summary.cut, Scissors, 'Ready for bundling'],
          ['Bundling hair', summary.bundling, Layers, 'Assigned to a draft bundle'],
          ['Wig In Production', summary.production, Package, 'Closed bundle in production'],
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
        <div className="border-b border-slate-200 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-slate-500" />
              <div>
                <p className="text-sm font-semibold text-slate-800">Filter inventory</p>
                <p className="text-[11px] text-slate-500">Showing {filteredRows.length} of {rows.length} hair items</p>
              </div>
            </div>
            {hasActiveFilters && (
              <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                <X size={13} /> Clear filters
              </button>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700">
                <option value="all">All statuses</option>
                <option value="Cut">Cut / Available</option>
                <option value="Bundling">Bundling</option>
                <option value="Wig In Production">Wig In Production</option>
                <option value="Wig Created">Wig Created</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Source event</span>
              <select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700">
                <option value="all">All events and sources</option>
                <option value="non-event">Non-event donations</option>
                {eventOptions.map((event) => (
                  <option key={event.id} value={event.id}>{event.name} (ER-{event.id})</option>
                ))}
              </select>
            </label>

            <label className="space-y-1 md:col-span-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Search</span>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Waybill, donor, event, submission, bundle, or wig" className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs" />
              </div>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Quick date</span>
              <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
                {PERIODS.map((item) => {
                  const isSelected = !dateFrom && !dateTo && period === item.id;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => { setPeriod(item.id); setDateFrom(''); setDateTo(''); }}
                      className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-1 ${
                        isSelected
                          ? 'border-transparent text-white shadow-sm ring-1 ring-slate-900/10'
                          : 'border-transparent text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900'
                      }`}
                      style={isSelected ? { backgroundColor: primaryColor } : undefined}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">From</span>
              <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} className="block rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">To</span>
              <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} className="block rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700" />
            </label>
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
                  <th className="px-4 py-3 font-semibold">Submission ID</th>
                  <th className="px-4 py-3 font-semibold">Waybill</th>
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
                      <p className="font-mono text-xs font-bold text-slate-900">{row.Submission_ID}</p>
                    </td>
                    <td className="px-4 py-3">
                      {row.Waybill_Code ? (
                        <p className="whitespace-nowrap font-mono text-xs font-bold text-slate-900">{row.Waybill_Code}</p>
                      ) : (
                        <p className="text-xs text-slate-400">{row.Source_Type === 'Non-Event' ? 'Not issued' : 'Unavailable'}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">{fullName(row.donor)}</p>
                      <p className="text-xs text-slate-500">{row.Source_Type === 'Non-Event' ? 'Non-event donation' : 'Event donation'}</p>
                      {row.event && <p className="mt-1 inline-flex items-center gap-1 text-xs text-slate-600"><CalendarDays size={11} />{row.event.Event_Name} (ER-{row.Event_Request_ID})</p>}
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
