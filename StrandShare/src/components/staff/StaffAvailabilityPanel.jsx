import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarOff, CheckCircle2, History, Loader2, Plus, RotateCcw, Search, Users, X } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import StaffScheduleCalendar from './StaffScheduleCalendar';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function roleKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function formatManilaDateTime(value) {
  if (!value) return 'Not recorded';
  const raw = String(value).trim();
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(normalized) ? normalized : `${normalized}+08:00`;
  const parsed = new Date(withZone);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function userName(user) {
  const name = [user?.firstName, user?.middleName, user?.lastName, user?.suffix]
    .map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  return name || user?.email || `Account #${user?.id || 'unknown'}`;
}

function entryLabel(entry) {
  if (entry.Unavailability_Type === 'Recurring Weekday') {
    return `Every ${WEEKDAYS[Number(entry.Weekday)] || 'selected weekday'}`;
  }
  if (!entry.Specific_Date) return 'Specific date';
  return new Date(`${entry.Specific_Date}T00:00:00+08:00`).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
}

export default function StaffAvailabilityPanel({ allUsers = [], staffUserId = null, readOnly = false }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0f766e';
  const [entries, setEntries] = useState([]);
  const [scheduleEvents, setScheduleEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [selectedStaffIds, setSelectedStaffIds] = useState([]);
  const [staffSearch, setStaffSearch] = useState('');
  const [entryType, setEntryType] = useState('Specific Date');
  const [weekday, setWeekday] = useState('1');
  const [specificDate, setSpecificDate] = useState('');
  const [reason, setReason] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState(null);

  const staffUsers = useMemo(() => allUsers.filter((user) => (
    roleKey(user.role) === 'staff' && user.status !== 'Inactive'
  )), [allUsers]);
  const filteredStaffUsers = useMemo(() => {
    const query = staffSearch.trim().toLowerCase();
    if (!query) return staffUsers;
    return staffUsers.filter((user) => (
      userName(user).toLowerCase().includes(query)
      || String(user.email || '').toLowerCase().includes(query)
    ));
  }, [staffSearch, staffUsers]);
  const usersById = useMemo(() => new Map(allUsers.map((user) => [Number(user.id), user])), [allUsers]);

  const loadEntries = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setEntries([]);
      setLoading(false);
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }
    setLoading(true);
    try {
      let availabilityQuery = supabase.from('Staff_Unavailability').select('*').order('Created_At', { ascending: false });
      let eventsQuery = supabase
        .from('Event_Requests')
        .select('Event_Request_ID, Event_Name, Status, Start_Date, End_Date, Venue_Name, Street, Barangay, City_Municipality, Province, Assigned_Staff_User_ID')
        .eq('Status', 'Approved')
        .not('Assigned_Staff_User_ID', 'is', null)
        .order('Start_Date', { ascending: true });
      if (staffUserId) {
        availabilityQuery = availabilityQuery.eq('Staff_User_ID', Number(staffUserId));
        eventsQuery = eventsQuery.eq('Assigned_Staff_User_ID', Number(staffUserId));
      }
      const [availabilityResult, eventsResult] = await Promise.all([availabilityQuery, eventsQuery]);
      if (availabilityResult.error) throw availabilityResult.error;
      if (eventsResult.error) throw eventsResult.error;
      setEntries(availabilityResult.data || []);
      setScheduleEvents(eventsResult.data || []);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load Staff availability.' });
    } finally {
      setLoading(false);
    }
  }, [staffUserId]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const visibleEntries = useMemo(() => entries.filter((entry) => (
    showHistory ? true : entry.Is_Active !== false
  )), [entries, showHistory]);

  const toggleStaff = (id) => {
    setSelectedStaffIds((current) => (
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    ));
  };

  const addDayOff = async (event) => {
    event.preventDefault();
    if (selectedStaffIds.length === 0) {
      setNotice({ kind: 'error', text: 'Select at least one Staff member.' });
      return;
    }
    if (!reason.trim()) {
      setNotice({ kind: 'error', text: 'A reason is required.' });
      return;
    }
    setSaving(true);
    setNotice({ kind: '', text: '' });
    try {
      const { data, error } = await supabase.rpc('admin_add_staff_unavailability', {
        p_staff_user_ids: selectedStaffIds,
        p_unavailability_type: entryType,
        p_weekday: entryType === 'Recurring Weekday' ? Number(weekday) : null,
        p_specific_date: entryType === 'Specific Date' ? specificDate : null,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      setNotice({ kind: 'success', text: `${Number(data?.created_count || 0)} day-off entr${Number(data?.created_count || 0) === 1 ? 'y' : 'ies'} added.` });
      setReason('');
      setSpecificDate('');
      setSelectedStaffIds([]);
      setStaffSearch('');
      await loadEntries();
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to add the day off.' });
    } finally {
      setSaving(false);
    }
  };

  const removeDayOff = async (entry) => {
    setSaving(true);
    setNotice({ kind: '', text: '' });
    try {
      const { error } = await supabase.rpc('admin_remove_staff_unavailability', {
        p_staff_unavailability_id: entry.Staff_Unavailability_ID,
      });
      if (error) throw error;
      setNotice({ kind: 'success', text: 'Day off removed. Its audit history was kept.' });
      setPendingRemoval(null);
      await loadEntries();
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to remove the day off.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900"><CalendarOff size={22} /> Staff Availability</h2>
          <p className="mt-1 text-sm text-slate-600">
            {readOnly ? 'Your all-day recurring and date-specific days off.' : 'Manage all-day Staff days off. Conflicts block program assignment.'}
          </p>
        </div>
        <button type="button" onClick={() => void loadEntries()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          <RotateCcw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {notice.text && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
          {notice.text}
        </div>
      )}

      <StaffScheduleCalendar
        staffUsers={staffUserId ? staffUsers.filter((user) => Number(user.id) === Number(staffUserId)) : staffUsers}
        events={scheduleEvents}
        unavailability={entries.filter((entry) => entry.Is_Active !== false)}
        title={readOnly ? 'My Monthly Schedule' : 'Monthly Staff Schedule'}
        description={readOnly
          ? 'Your approved program assignments and days off. Select an entry to see its details.'
          : 'Approved programs and active days off. Each Staff member has a unique color; select an entry for details.'}
      />

      {!readOnly && (
        <form onSubmit={addDayOff} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2"><Plus size={18} style={{ color: primaryColor }} /><h3 className="font-bold text-slate-900">Add day off</h3></div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-700">Staff members *</p>
                {selectedStaffIds.length > 0 && <button type="button" onClick={() => setSelectedStaffIds([])} className="text-xs font-bold hover:underline" style={{ color: primaryColor }}>Clear selection</button>}
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white focus-within:ring-2" style={{ '--tw-ring-color': `${primaryColor}25` }}>
                <div className="relative border-b border-slate-200 bg-slate-50">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={staffSearch}
                    onChange={(event) => setStaffSearch(event.target.value)}
                    placeholder="Search Staff name or email"
                    className="w-full border-0 bg-transparent py-2.5 pl-9 pr-9 text-sm text-slate-800 outline-none placeholder:text-slate-400"
                  />
                  {staffSearch && <button type="button" onClick={() => setStaffSearch('')} aria-label="Clear Staff search" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"><X size={14} /></button>}
                </div>
                <div className="max-h-52 space-y-1 overflow-y-auto p-2">
                  {staffUsers.length === 0 ? <p className="p-3 text-center text-sm text-slate-500">No active Staff accounts.</p> : filteredStaffUsers.length === 0 ? <p className="p-3 text-center text-sm text-slate-500">No Staff member matches “{staffSearch}”.</p> : filteredStaffUsers.map((user) => {
                    const id = Number(user.id);
                    const isSelected = selectedStaffIds.includes(id);
                    return (
                      <label key={user.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition ${isSelected ? 'shadow-sm' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`} style={isSelected ? { borderColor: `${primaryColor}55`, backgroundColor: `${primaryColor}0D` } : undefined}>
                        <input type="checkbox" className="sr-only" checked={isSelected} onChange={() => toggleStaff(id)} />
                        <span className="grid h-5 w-5 flex-none place-items-center rounded-md border text-xs font-bold" style={isSelected ? { borderColor: primaryColor, backgroundColor: primaryColor, color: '#fff' } : { borderColor: '#cbd5e1', color: 'transparent' }}>✓</span>
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-800">{userName(user)}</span><span className="block truncate text-xs text-slate-500">{user.email}</span></span>
                        {isSelected && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ backgroundColor: `${primaryColor}18`, color: primaryColor }}>Selected</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
              <p className="mt-1.5 text-xs text-slate-500"><Users size={12} className="mr-1 inline" />{selectedStaffIds.length} Staff member{selectedStaffIds.length === 1 ? '' : 's'} selected</p>
            </div>
            <div className="space-y-3">
              <fieldset>
                <legend className="mb-2 text-sm font-semibold text-slate-700">Type *</legend>
                <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1.5">
                  {['Specific Date', 'Recurring Weekday'].map((type) => {
                    const isSelected = entryType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setEntryType(type)}
                        className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${isSelected ? 'text-white shadow-sm' : 'text-slate-600 hover:bg-white hover:text-slate-900'}`}
                        style={isSelected ? { backgroundColor: primaryColor } : undefined}
                      >
                        {type}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              {entryType === 'Specific Date' ? (
                <label className="block text-sm font-semibold text-slate-700">Date *
                  <input required type="date" value={specificDate} min={new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())} onChange={(event) => setSpecificDate(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" />
                </label>
              ) : (
                <label className="block text-sm font-semibold text-slate-700">Weekday *
                  <select value={weekday} onChange={(event) => setWeekday(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal">{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select>
                </label>
              )}
              <label className="block text-sm font-semibold text-slate-700">Reason *
                <textarea required rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for the all-day unavailability" className="mt-1 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-normal" />
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end"><button disabled={saving} type="submit" className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-60" style={{ backgroundColor: primaryColor }}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}Add day off</button></div>
        </form>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div><h3 className="font-bold text-slate-900">{showHistory ? 'Availability history' : 'Current days off'}</h3><p className="text-xs text-slate-500">All timestamps use Manila time (UTC+8).</p></div>
          {!readOnly && <button type="button" onClick={() => setShowHistory((value) => !value)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"><History size={14} />{showHistory ? 'Show active only' : 'Show history'}</button>}
        </div>
        {loading ? <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-600"><Loader2 size={17} className="animate-spin" />Loading availability...</div> : visibleEntries.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500"><CheckCircle2 className="mx-auto mb-2 text-emerald-500" />No {showHistory ? '' : 'active '}day-off entries.</div>
        ) : (
          <div className="divide-y divide-slate-100">{visibleEntries.map((entry) => {
            const staff = usersById.get(Number(entry.Staff_User_ID));
            const creator = usersById.get(Number(entry.Created_By_User_ID));
            const remover = usersById.get(Number(entry.Removed_By_User_ID));
            return <article key={entry.Staff_Unavailability_ID} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-bold text-slate-900">{entryLabel(entry)}</p><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${entry.Is_Active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{entry.Is_Active ? 'Active' : 'Removed'}</span></div>{!staffUserId && <p className="mt-1 text-sm font-semibold" style={{ color: primaryColor }}>{userName(staff)}</p>}<p className="mt-1 text-sm text-slate-700">{entry.Reason}</p><p className="mt-2 text-xs text-slate-500">Added by {userName(creator)} • {formatManilaDateTime(entry.Created_At)}</p>{!entry.Is_Active && <p className="text-xs text-slate-500">Removed by {userName(remover)} • {formatManilaDateTime(entry.Removed_At)}</p>}</div>
              {!readOnly && entry.Is_Active && <button type="button" disabled={saving} onClick={() => setPendingRemoval(entry)} className="flex-none rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-60">Remove</button>}
            </article>;
          })}</div>
        )}
      </section>

      {pendingRemoval && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[12000] flex items-center justify-center bg-slate-950/65 p-4 backdrop-blur-[2px]" onMouseDown={() => { if (!saving) setPendingRemoval(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="remove-day-off-title" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-2xl">
            <header className="flex items-start gap-3 border-b border-rose-100 bg-rose-50 px-5 py-4">
              <div className="grid h-10 w-10 flex-none place-items-center rounded-full bg-rose-100 text-rose-700">
                <AlertTriangle size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-wide text-rose-600">Confirm removal</p>
                <h2 id="remove-day-off-title" className="mt-0.5 text-lg font-bold text-slate-900">Remove this day off?</h2>
              </div>
              <button type="button" disabled={saving} onClick={() => setPendingRemoval(null)} aria-label="Close removal confirmation" className="rounded-lg p-2 text-slate-500 hover:bg-white disabled:opacity-50"><X size={17} /></button>
            </header>

            <div className="space-y-4 px-5 py-5">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-base font-bold text-slate-900">{entryLabel(pendingRemoval)}</p>
                <p className="mt-1 text-sm font-semibold" style={{ color: primaryColor }}>{userName(usersById.get(Number(pendingRemoval.Staff_User_ID)))}</p>
                <p className="mt-2 text-sm text-slate-700"><span className="font-semibold">Reason:</span> {pendingRemoval.Reason}</p>
              </div>
              <p className="text-sm leading-6 text-slate-600">
                This will make the Staff member available for future program assignments on this date or weekday. The removal will remain in the audit history.
              </p>
            </div>

            <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
              <button type="button" disabled={saving} onClick={() => setPendingRemoval(null)} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button type="button" disabled={saving} onClick={() => void removeDayOff(pendingRemoval)} className="inline-flex items-center gap-2 rounded-lg bg-rose-700 px-4 py-2 text-sm font-bold text-white hover:bg-rose-800 disabled:opacity-60">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CalendarOff size={15} />}
                {saving ? 'Removing...' : 'Remove day off'}
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
