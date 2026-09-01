import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CalendarOff,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Save,
  Scissors,
  Settings2,
  User,
  XCircle,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import PageHeaderActions from '../../../components/PageHeaderActions';

const APPOINTMENTS_TABLE = 'Salon_Donation_Appointments';
const HOURS_TABLE = 'Salon_Operating_Hours';
const OVERRIDES_TABLE = 'Salon_Schedule_Overrides';
const HISTORY_TABLE = 'Salon_Appointment_Status_History';
const LOGISTICS_TABLE = 'Logistics_Settings';

const EMPTY_OVERRIDE = {
  date: '',
  isClosed: true,
  openingTime: '09:00',
  closingTime: '17:00',
  breakStartTime: '',
  breakEndTime: '',
  capacity: '3',
  reason: '',
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseDateKey(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  return new Date(year, Math.max(0, month - 1), day || 1);
}

function startOfMonth(value) {
  const date = value instanceof Date ? value : parseDateKey(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(value, amount) {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1);
}

function addDays(value, amount) {
  const date = value instanceof Date ? new Date(value) : parseDateKey(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function formatDate(value, options = {}) {
  if (!value) return 'N/A';
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? parseDateKey(value)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    ...options,
  });
}

function formatTime(value) {
  if (!value) return 'N/A';
  const date = new Date(String(value).includes('T') ? `${value}+08:00`.replace('+08:00+08:00', '+08:00') : value);
  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleTimeString('en-PH', {
      timeZone: 'Asia/Manila',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  const raw = String(value).slice(0, 5);
  const [hour, minute] = raw.split(':').map(Number);
  const fallback = new Date(2000, 0, 1, hour || 0, minute || 0);
  return fallback.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
}

function normalizeTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.includes('T') ? raw : raw.replace(' ', 'T');
}

function statusClasses(status) {
  switch (status) {
    case 'Confirmed':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'Rescheduled':
      return 'border-violet-200 bg-violet-50 text-violet-700';
    case 'Checked In':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'Completed':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'Cancelled':
    case 'No Show':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600';
  }
}

function humanize(value) {
  const text = String(value || '').replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Not provided';
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join(', ') : 'None';
  if (typeof value === 'object') return JSON.stringify(value);
  return humanize(value);
}

function formatAddress(row) {
  if (!row) return 'Salon address has not been configured.';
  return [
    row.Destination_Name,
    row.Street,
    row.Barangay,
    row.City,
    row.Province,
    row.Region,
    row.Country,
  ].filter((part) => String(part || '').trim()).join(', ');
}

function buildMonthCells(monthDate) {
  const first = startOfMonth(monthDate);
  const firstWeekday = first.getDay();
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= last; day += 1) {
    cells.push(new Date(first.getFullYear(), first.getMonth(), day));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function SalonSchedulePage({ isActivePage = true }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#7c2d12';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';

  const [activeTab, setActiveTab] = useState('calendar');
  const [monthDate, setMonthDate] = useState(startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(todayKey());
  const [appointments, setAppointments] = useState([]);
  const [hoursDraft, setHoursDraft] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [logistics, setLogistics] = useState(null);
  const [guardians, setGuardians] = useState([]);
  const [history, setHistory] = useState([]);
  const [slots, setSlots] = useState([]);
  const [rescheduleSlots, setRescheduleSlots] = useState([]);
  const [selectedAppointmentId, setSelectedAppointmentId] = useState(null);
  const [selectedGuardianId, setSelectedGuardianId] = useState('');
  const [actionNotes, setActionNotes] = useState('');
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleStart, setRescheduleStart] = useState('');
  const [overrideDraft, setOverrideDraft] = useState(EMPTY_OVERRIDE);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSlots, setIsLoadingSlots] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isActioning, setIsActioning] = useState(false);

  const monthStartKey = dateKey(startOfMonth(monthDate));
  const nextMonthKey = dateKey(addMonths(startOfMonth(monthDate), 1));

  const loadPage = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      return;
    }
    setIsLoading(true);
    setNotice({ kind: '', text: '' });
    try {
      const [appointmentsResult, hoursResult, overridesResult, logisticsResult] = await Promise.all([
        supabase
          .from(APPOINTMENTS_TABLE)
          .select('*')
          .gte('Appointment_Start_At', `${monthStartKey}T00:00:00`)
          .lt('Appointment_Start_At', `${nextMonthKey}T00:00:00`)
          .order('Appointment_Start_At', { ascending: true }),
        supabase.from(HOURS_TABLE).select('*').order('Day_Group', { ascending: true }),
        supabase
          .from(OVERRIDES_TABLE)
          .select('*')
          .gte('Override_Date', dateKey(addDays(new Date(), -31)))
          .order('Override_Date', { ascending: true }),
        supabase.from(LOGISTICS_TABLE).select('*').limit(1).maybeSingle(),
      ]);
      if (appointmentsResult.error) throw appointmentsResult.error;
      if (hoursResult.error) throw hoursResult.error;
      if (overridesResult.error) throw overridesResult.error;
      if (logisticsResult.error) throw logisticsResult.error;

      const appointmentRows = appointmentsResult.data || [];
      const donorIds = Array.from(new Set(appointmentRows.map((row) => Number(row.User_ID)).filter(Boolean)));
      const appointmentIds = appointmentRows.map((row) => Number(row.Appointment_ID)).filter(Boolean);

      let usersById = {};
      let detailsById = {};
      let guardianRows = [];
      let historyRows = [];
      if (donorIds.length) {
        const [usersResult, detailsResult, guardiansResult] = await Promise.all([
          supabase.from('users').select('user_id,email').in('user_id', donorIds),
          supabase
            .from('user_details')
            .select('user_id,first_name,middle_name,last_name,suffix,birthdate,contact_number')
            .in('user_id', donorIds),
          supabase
            .from('guardian_consents')
            .select('*')
            .in('user_id', donorIds)
            .order('consented_at', { ascending: false }),
        ]);
        if (usersResult.error) throw usersResult.error;
        if (detailsResult.error) throw detailsResult.error;
        if (guardiansResult.error) throw guardiansResult.error;
        usersById = (usersResult.data || []).reduce((map, row) => ({ ...map, [row.user_id]: row }), {});
        detailsById = (detailsResult.data || []).reduce((map, row) => ({ ...map, [row.user_id]: row }), {});
        guardianRows = guardiansResult.data || [];
      }
      if (appointmentIds.length) {
        const historyResult = await supabase
          .from(HISTORY_TABLE)
          .select('*')
          .in('Appointment_ID', appointmentIds)
          .order('Changed_At', { ascending: false });
        if (historyResult.error) throw historyResult.error;
        historyRows = historyResult.data || [];
      }

      const enriched = appointmentRows.map((row) => ({
        ...row,
        donorAccount: usersById[row.User_ID] || null,
        donorProfile: detailsById[row.User_ID] || null,
      }));
      setAppointments(enriched);
      setHoursDraft((hoursResult.data || []).map((row) => ({
        ...row,
        Opening_Time: String(row.Opening_Time || '').slice(0, 5),
        Closing_Time: String(row.Closing_Time || '').slice(0, 5),
        Break_Start_Time: String(row.Break_Start_Time || '').slice(0, 5),
        Break_End_Time: String(row.Break_End_Time || '').slice(0, 5),
      })));
      setOverrides(overridesResult.data || []);
      setLogistics(logisticsResult.data || null);
      setGuardians(guardianRows);
      setHistory(historyRows);
      setSelectedAppointmentId((previous) => {
        if (enriched.some((row) => row.Appointment_ID === previous)) return previous;
        const selectedDayRow = enriched.find((row) => dateKey(row.Appointment_Start_At) === selectedDate);
        return selectedDayRow?.Appointment_ID || enriched[0]?.Appointment_ID || null;
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load salon schedule.' });
    } finally {
      setIsLoading(false);
    }
  }, [monthStartKey, nextMonthKey, selectedDate]);

  const loadSlots = useCallback(async (targetDate, setter = setSlots) => {
    if (!targetDate || !supabase) {
      setter([]);
      return;
    }
    setIsLoadingSlots(true);
    try {
      const { data, error } = await supabase.rpc('get_salon_available_slots', {
        p_from_date: targetDate,
        p_to_date: targetDate,
      });
      if (error) throw error;
      setter(data || []);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load available times.' });
      setter([]);
    } finally {
      setIsLoadingSlots(false);
    }
  }, []);

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase) {
      return undefined;
    }

    const refreshSchedule = () => void loadPage();
    const channel = supabase
      .channel('staff-salon-schedule-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: APPOINTMENTS_TABLE }, refreshSchedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: HOURS_TABLE }, refreshSchedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: OVERRIDES_TABLE }, refreshSchedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: HISTORY_TABLE }, refreshSchedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: LOGISTICS_TABLE }, refreshSchedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'guardian_consents' }, refreshSchedule)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [isActivePage, loadPage]);

  useEffect(() => {
    void loadSlots(selectedDate);
  }, [selectedDate, loadSlots]);

  useEffect(() => {
    if (rescheduleDate) void loadSlots(rescheduleDate, setRescheduleSlots);
    else setRescheduleSlots([]);
    setRescheduleStart('');
  }, [rescheduleDate, loadSlots]);

  const appointmentsByDate = useMemo(() => appointments.reduce((map, row) => {
    const key = dateKey(row.Appointment_Start_At);
    if (!map[key]) map[key] = [];
    map[key].push(row);
    return map;
  }, {}), [appointments]);

  const selectedDayAppointments = appointmentsByDate[selectedDate] || [];
  const selectedAppointment = appointments.find((row) => row.Appointment_ID === selectedAppointmentId) || null;
  const selectedGuardians = guardians.filter((row) => Number(row.user_id) === Number(selectedAppointment?.User_ID));
  const selectedHistory = history.filter((row) => row.Appointment_ID === selectedAppointment?.Appointment_ID);
  const selectedOverride = overrides.find((row) => row.Override_Date === selectedDate) || null;
  const monthCells = useMemo(() => buildMonthCells(monthDate), [monthDate]);
  const todayAppointments = appointmentsByDate[todayKey()] || [];
  const monthConfirmed = appointments.filter((row) => ['Confirmed', 'Rescheduled'].includes(row.Status)).length;
  const monthCompleted = appointments.filter((row) => row.Status === 'Completed').length;
  const consentNeeded = appointments.filter((row) => row.Is_Minor && !row.Guardian_Consent_ID && !['Cancelled', 'No Show', 'Completed'].includes(row.Status)).length;

  useEffect(() => {
    setSelectedGuardianId(selectedAppointment?.Guardian_Consent_ID ? String(selectedAppointment.Guardian_Consent_ID) : '');
    setActionNotes('');
    setRescheduleDate('');
    setRescheduleStart('');
  }, [selectedAppointment?.Appointment_ID, selectedAppointment?.Guardian_Consent_ID]);

  const selectAppointment = (row) => {
    setSelectedDate(dateKey(row.Appointment_Start_At));
    setSelectedAppointmentId(row.Appointment_ID);
  };

  const updateStatus = async (nextStatus) => {
    if (!selectedAppointment || !supabase) return;
    if (['Cancelled', 'No Show'].includes(nextStatus) && !actionNotes.trim()) {
      setNotice({ kind: 'error', text: `Add a reason before marking this appointment ${nextStatus}.` });
      return;
    }
    if (nextStatus === 'Completed' && !window.confirm('Complete this salon donation and create its Cut/Approved hair submission?')) return;
    setIsActioning(true);
    setNotice({ kind: '', text: '' });
    try {
      const { error } = await supabase.rpc('staff_update_salon_appointment_status', {
        p_appointment_id: selectedAppointment.Appointment_ID,
        p_status: nextStatus,
        p_notes: actionNotes.trim() || null,
        p_guardian_consent_id: selectedGuardianId ? Number(selectedGuardianId) : null,
      });
      if (error) throw error;
      setNotice({
        kind: 'success',
        text: nextStatus === 'Completed'
          ? 'Donation completed. A Cut/Approved non-event hair submission was created.'
          : `Appointment updated to ${nextStatus}.`,
      });
      await loadPage();
      await loadSlots(selectedDate);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to update appointment.' });
    } finally {
      setIsActioning(false);
    }
  };

  const rescheduleAppointment = async () => {
    if (!selectedAppointment || !rescheduleStart || !supabase) return;
    setIsActioning(true);
    setNotice({ kind: '', text: '' });
    try {
      const { error } = await supabase.rpc('staff_reschedule_salon_appointment', {
        p_appointment_id: selectedAppointment.Appointment_ID,
        p_new_start_at: rescheduleStart,
        p_notes: actionNotes.trim() || null,
      });
      if (error) throw error;
      setNotice({ kind: 'success', text: 'Appointment rescheduled successfully.' });
      setSelectedDate(dateKey(rescheduleStart));
      setMonthDate(startOfMonth(parseDateKey(dateKey(rescheduleStart))));
      await loadPage();
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to reschedule appointment.' });
    } finally {
      setIsActioning(false);
    }
  };

  const updateHoursDraft = (id, field, value) => {
    setHoursDraft((previous) => previous.map((row) => (
      row.Operating_Hours_ID === id ? { ...row, [field]: value } : row
    )));
  };

  const saveHours = async () => {
    if (!supabase) return;
    setIsSaving(true);
    setNotice({ kind: '', text: '' });
    try {
      for (const row of hoursDraft) {
        const payload = {
          Is_Open: Boolean(row.Is_Open),
          Opening_Time: row.Opening_Time,
          Closing_Time: row.Closing_Time,
          Break_Start_Time: row.Break_Start_Time || null,
          Break_End_Time: row.Break_End_Time || null,
          Appointment_Duration_Minutes: Number(row.Appointment_Duration_Minutes),
          Buffer_Minutes: Number(row.Buffer_Minutes),
          Late_Grace_Minutes: Number(row.Late_Grace_Minutes),
          Capacity_Per_Slot: Number(row.Capacity_Per_Slot),
          Minimum_Booking_Notice_Days: Number(row.Minimum_Booking_Notice_Days),
          Maximum_Booking_Days: Number(row.Maximum_Booking_Days),
        };
        const { error } = await supabase.from(HOURS_TABLE).update(payload).eq('Operating_Hours_ID', row.Operating_Hours_ID);
        if (error) throw error;
      }
      setNotice({ kind: 'success', text: 'Salon operating hours and booking rules saved.' });
      await loadPage();
      await loadSlots(selectedDate);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to save operating hours.' });
    } finally {
      setIsSaving(false);
    }
  };

  const saveOverride = async () => {
    if (!supabase || !overrideDraft.date) {
      setNotice({ kind: 'error', text: 'Select a date for the override.' });
      return;
    }
    setIsSaving(true);
    setNotice({ kind: '', text: '' });
    try {
      const payload = {
        Override_Date: overrideDraft.date,
        Is_Closed: overrideDraft.isClosed,
        Opening_Time: overrideDraft.isClosed ? null : overrideDraft.openingTime,
        Closing_Time: overrideDraft.isClosed ? null : overrideDraft.closingTime,
        Break_Start_Time: overrideDraft.isClosed ? null : (overrideDraft.breakStartTime || null),
        Break_End_Time: overrideDraft.isClosed ? null : (overrideDraft.breakEndTime || null),
        Capacity_Per_Slot: overrideDraft.isClosed || !overrideDraft.capacity ? null : Number(overrideDraft.capacity),
        Reason: overrideDraft.reason.trim() || null,
      };
      const { error } = await supabase.from(OVERRIDES_TABLE).upsert(payload, { onConflict: 'Override_Date' });
      if (error) throw error;
      setNotice({ kind: 'success', text: overrideDraft.isClosed ? 'Date closed successfully.' : 'Special hours saved.' });
      setOverrideDraft(EMPTY_OVERRIDE);
      await loadPage();
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to save schedule override.' });
    } finally {
      setIsSaving(false);
    }
  };

  const deleteOverride = async (id) => {
    if (!supabase || !window.confirm('Remove this schedule override and restore the normal hours?')) return;
    const { error } = await supabase.from(OVERRIDES_TABLE).delete().eq('Schedule_Override_ID', id);
    if (error) {
      setNotice({ kind: 'error', text: error.message });
      return;
    }
    setNotice({ kind: 'success', text: 'Schedule override removed.' });
    await loadPage();
  };

  const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500';

  return (
    <div className="min-w-0 space-y-5" style={{ color: primaryTextColor }}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="role-page-title text-2xl font-bold" style={{ fontFamily: `${headingFont}, sans-serif` }}>Salon Schedule</h1>
          <p className="max-w-3xl text-sm" style={{ color: secondaryTextColor }}>
            Review automatically confirmed salon donations, manage capacity and closures, and complete on-site hair intake.
          </p>
          <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
            <MapPin size={14} className="mt-0.5 shrink-0" />
            <span>{formatAddress(logistics)}</span>
          </div>
        </div>
        <PageHeaderActions
          onRefresh={() => void loadPage()}
          refreshLoading={isLoading}
          autoRefreshOnChanges={false}
          helpTitle="About Salon Schedule"
          helpContent={(
            <div className="space-y-2">
              <p>Use <strong>Appointments</strong> to review confirmed salon donations and complete on-site intake.</p>
              <p>Use <strong>Hours &amp; closures</strong> to manage capacity, operating hours, and special schedule overrides.</p>
            </div>
          )}
        />
      </header>

      {notice.text ? (
        <div className={`rounded-xl border px-4 py-3 text-sm ${
          notice.kind === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-rose-200 bg-rose-50 text-rose-800'
        }`}>
          {notice.text}
        </div>
      ) : null}

      <div className="flex gap-5 border-b border-slate-300">
        {[
          ['calendar', CalendarDays, 'Appointments'],
          ['settings', Settings2, 'Hours & closures'],
        ].map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className="inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-semibold"
            style={activeTab === id ? { color: primaryColor, borderColor: primaryColor } : { color: '#64748b', borderColor: 'transparent' }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'calendar' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ['Today', todayAppointments.length, CalendarDays],
              ['Confirmed this month', monthConfirmed, Clock3],
              ['Completed this month', monthCompleted, CheckCircle2],
              ['Consent to follow', consentNeeded, AlertTriangle],
            ].map(([label, count, Icon]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                    <Icon size={16} />
                  </span>
                </div>
                <p className="mt-1 text-2xl font-bold" style={{ color: primaryColor }}>{count}</p>
              </div>
            ))}
          </div>

          <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
            <div className="min-w-0 space-y-5">
              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                  <button type="button" onClick={() => setMonthDate(addMonths(monthDate, -1))} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50">
                    <ChevronLeft size={17} />
                  </button>
                  <h2 className="text-base font-semibold">{monthDate.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })}</h2>
                  <button type="button" onClick={() => setMonthDate(addMonths(monthDate, 1))} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50">
                    <ChevronRight size={17} />
                  </button>
                </div>
                <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <div key={day} className="py-2">{day}</div>)}
                </div>
                <div className="grid grid-cols-7 bg-slate-200 gap-px">
                  {monthCells.map((day, index) => {
                    if (!day) return <div key={`empty-${index}`} className="min-h-[88px] bg-slate-50" />;
                    const key = dateKey(day);
                    const rows = appointmentsByDate[key] || [];
                    const activeCount = rows.filter((row) => ['Confirmed', 'Rescheduled', 'Checked In'].includes(row.Status)).length;
                    const isSelected = key === selectedDate;
                    const isToday = key === todayKey();
                    const override = overrides.find((row) => row.Override_Date === key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedDate(key)}
                        className="min-h-[88px] min-w-0 bg-white p-2 text-left transition hover:bg-slate-50"
                        style={isSelected ? { boxShadow: `inset 0 0 0 2px ${primaryColor}` } : undefined}
                      >
                        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                          isToday ? 'bg-slate-900 text-white' : 'text-slate-700'
                        }`}>
                          {day.getDate()}
                        </span>
                        {override?.Is_Closed ? <p className="mt-1 truncate text-[10px] font-semibold text-rose-600">Closed</p> : null}
                        {activeCount ? <p className="mt-1 truncate text-[10px] font-semibold text-blue-700">{activeCount} booked</p> : null}
                        {rows.some((row) => row.Status === 'Completed') ? <p className="truncate text-[10px] text-emerald-600">Completed</p> : null}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{formatDate(selectedDate, { weekday: 'long' })}</h2>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {selectedOverride?.Is_Closed
                        ? `Closed${selectedOverride.Reason ? ` â€” ${selectedOverride.Reason}` : ''}`
                        : `${selectedDayAppointments.length} appointment${selectedDayAppointments.length === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  {isLoadingSlots ? <Loader2 size={17} className="animate-spin text-slate-400" /> : null}
                </div>

                {!slots.length ? (
                  <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                    <CalendarOff className="mx-auto text-slate-400" size={26} />
                    <p className="mt-2 text-sm font-medium text-slate-600">No operating slots on this date.</p>
                    {selectedDayAppointments.length ? (
                      <div className="mx-auto mt-4 grid max-w-2xl gap-2 text-left sm:grid-cols-2">
                        {selectedDayAppointments.map((row) => (
                          <button
                            key={row.Appointment_ID}
                            type="button"
                            onClick={() => selectAppointment(row)}
                            className="rounded-lg border border-amber-200 bg-white px-3 py-2"
                          >
                            <p className="truncate text-xs font-semibold text-slate-800">{formatTime(row.Appointment_Start_At)} Â· {row.Contact_Name}</p>
                            <p className="mt-1 text-[10px] text-amber-700">Existing appointment outside the current schedule</p>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {slots.map((slot) => {
                      const slotRows = selectedDayAppointments.filter((row) => normalizeTimestamp(row.Appointment_Start_At) === normalizeTimestamp(slot.Slot_Start_At));
                      const activeSlotRows = slotRows.filter((row) => ['Confirmed', 'Rescheduled', 'Checked In'].includes(row.Status));
                      return (
                        <div key={slot.Slot_Start_At} className="rounded-xl border border-slate-200">
                          <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                            <div>
                              <p className="text-sm font-semibold">{formatTime(slot.Slot_Start_At)}â€“{formatTime(slot.Slot_End_At)}</p>
                              <p className="text-[10px] text-slate-500">{slot.Late_Grace_Minutes}-minute arrival grace period</p>
                            </div>
                            <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                              slot.Remaining_Capacity > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                            }`}>
                              {slot.Booked_Count}/{slot.Capacity} booked
                            </span>
                          </div>
                          <div className="grid gap-2 p-3 md:grid-cols-3">
                            {slotRows.map((row) => (
                              <button
                                key={row.Appointment_ID}
                                type="button"
                                onClick={() => selectAppointment(row)}
                                className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left hover:border-slate-400"
                              >
                                <p className="truncate text-xs font-semibold text-slate-800">{row.Contact_Name}</p>
                                <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold ${statusClasses(row.Status)}`}>{row.Status}</span>
                              </button>
                            ))}
                            {Array.from({ length: Math.max(0, Number(slot.Capacity) - activeSlotRows.length) }, (_, index) => (
                              <div key={`open-${index}`} className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-[10px] text-slate-400">Open place</div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm xl:sticky xl:top-4">
              {!selectedAppointment ? (
                <div className="py-12 text-center text-slate-500">
                  <User className="mx-auto mb-2" size={28} />
                  <p className="text-sm">Select an appointment to view its details.</p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold">{selectedAppointment.Contact_Name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">Appointment #{selectedAppointment.Appointment_ID}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusClasses(selectedAppointment.Status)}`}>{selectedAppointment.Status}</span>
                  </div>

                  <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                    <p className="flex gap-2"><CalendarDays size={14} className="shrink-0" /> {formatDate(selectedAppointment.Appointment_Start_At)} at {formatTime(selectedAppointment.Appointment_Start_At)}</p>
                    <p className="flex gap-2"><Phone size={14} className="shrink-0" /> {selectedAppointment.Contact_Number}</p>
                    <p className="flex gap-2"><Mail size={14} className="shrink-0" /> {selectedAppointment.Contact_Email || selectedAppointment.donorAccount?.email || 'Not provided'}</p>
                  </div>

                  {selectedAppointment.Is_Minor ? (
                    <div className={`rounded-xl border p-3 text-xs ${
                      selectedAppointment.Guardian_Consent_ID
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-amber-200 bg-amber-50 text-amber-800'
                    }`}>
                      <p className="font-semibold">{selectedAppointment.Guardian_Consent_ID ? 'Guardian consent attached' : 'Guardian consent must be followed up'}</p>
                      <select value={selectedGuardianId} onChange={(event) => setSelectedGuardianId(event.target.value)} className="mt-2 w-full rounded-lg border border-current/20 bg-white px-2 py-1.5 text-slate-700">
                        <option value="">No consent selected</option>
                        {selectedGuardians.map((row) => (
                          <option key={row.guardian_consent_id} value={row.guardian_consent_id}>
                            {row.guardian_full_name} â€” {row.consent_status}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  <section>
                    <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><Scissors size={14} /> Hair details</h3>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {Object.entries(selectedAppointment.Hair_Details || {}).filter(([, value]) => value !== '' && value !== null).map(([key, value]) => (
                        <div key={key} className="min-w-0 rounded-lg border border-slate-200 p-2">
                          <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-slate-400">{humanize(key)}</p>
                          <p className="mt-0.5 break-words text-xs font-medium text-slate-700">{displayValue(value)}</p>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"><FileText size={14} /> Screening answers</h3>
                    <details className="mt-2 rounded-lg border border-slate-200">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-600">View submitted answers</summary>
                      <div className="border-t border-slate-200">
                        {Object.entries(selectedAppointment.Screening_Answers || {}).map(([key, value]) => (
                          <div key={key} className="flex items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-xs last:border-0">
                            <span className="text-slate-500">{humanize(key)}</span>
                            <span className="max-w-[55%] break-words text-right font-medium text-slate-700">{displayValue(value)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                    {selectedAppointment.Donor_Notes ? <p className="mt-2 break-words rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{selectedAppointment.Donor_Notes}</p> : null}
                  </section>

                  {!['Completed', 'Cancelled', 'No Show'].includes(selectedAppointment.Status) ? (
                    <section className="border-t border-slate-200 pt-4">
                      <label className="text-xs font-semibold text-slate-600">
                        Staff notes / reason
                        <textarea value={actionNotes} onChange={(event) => setActionNotes(event.target.value)} rows={2} className={inputClass} placeholder="Required for cancellation or no-show" />
                      </label>

                      <div className="mt-3 grid grid-cols-2 gap-2">
                        {['Confirmed', 'Rescheduled'].includes(selectedAppointment.Status) ? (
                          <button type="button" onClick={() => void updateStatus('Checked In')} disabled={isActioning} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">Check in</button>
                        ) : null}
                        {selectedAppointment.Status === 'Checked In' ? (
                          <button type="button" onClick={() => void updateStatus('Completed')} disabled={isActioning} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">Complete donation</button>
                        ) : null}
                        <button type="button" onClick={() => void updateStatus('No Show')} disabled={isActioning} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60">No show</button>
                        <button type="button" onClick={() => void updateStatus('Cancelled')} disabled={isActioning} className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-60">Cancel</button>
                      </div>

                      {['Confirmed', 'Rescheduled'].includes(selectedAppointment.Status) ? (
                        <div className="mt-4 rounded-xl border border-slate-200 p-3">
                          <p className="text-xs font-semibold text-slate-700">Reschedule</p>
                          <input type="date" value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} min={todayKey()} className={inputClass} />
                          <select value={rescheduleStart} onChange={(event) => setRescheduleStart(event.target.value)} disabled={!rescheduleDate} className={inputClass}>
                            <option value="">Select an available time</option>
                            {rescheduleSlots.filter((slot) => slot.Remaining_Capacity > 0).map((slot) => (
                              <option key={slot.Slot_Start_At} value={slot.Slot_Start_At}>{formatTime(slot.Slot_Start_At)} â€” {slot.Remaining_Capacity} places left</option>
                            ))}
                          </select>
                          <button type="button" onClick={() => void rescheduleAppointment()} disabled={!rescheduleStart || isActioning} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">Confirm new time</button>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <details className="border-t border-slate-200 pt-4">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-600">Appointment history ({selectedHistory.length})</summary>
                    <div className="mt-2 space-y-2">
                      {selectedHistory.map((row) => (
                        <div key={row.Status_History_ID} className="rounded-lg bg-slate-50 p-2 text-[10px] text-slate-500">
                          <p className="font-semibold text-slate-700">{row.Change_Type}: {row.To_Status}</p>
                          <p>{formatDate(row.Changed_At)} {formatTime(row.Changed_At)}</p>
                          {row.Notes ? <p className="mt-1">{row.Notes}</p> : null}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </aside>
          </div>
        </>
      ) : (
        <div className="space-y-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Regular operating hours</h2>
                <p className="mt-0.5 text-xs text-slate-500">The 60-minute service and 30-minute allowance create 90-minute booking intervals.</p>
              </div>
              <button type="button" onClick={() => void saveHours()} disabled={isSaving} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: primaryColor }}>
                {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save hours
              </button>
            </div>
            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              {hoursDraft.map((row) => (
                <div key={row.Operating_Hours_ID} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-slate-800">{row.Day_Group}</p>
                      <p className="text-xs text-slate-500">{row.Day_Group === 'Weekday' ? 'Mondayâ€“Friday' : 'Saturdayâ€“Sunday'}</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                      <input type="checkbox" checked={Boolean(row.Is_Open)} onChange={(event) => updateHoursDraft(row.Operating_Hours_ID, 'Is_Open', event.target.checked)} />
                      Open
                    </label>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      ['Opening_Time', 'Opening time', 'time'],
                      ['Closing_Time', 'Closing time', 'time'],
                      ['Break_Start_Time', 'Break starts', 'time'],
                      ['Break_End_Time', 'Break ends', 'time'],
                      ['Appointment_Duration_Minutes', 'Service minutes', 'number'],
                      ['Buffer_Minutes', 'Allowance minutes', 'number'],
                      ['Late_Grace_Minutes', 'Arrival grace minutes', 'number'],
                      ['Capacity_Per_Slot', 'Donors per slot', 'number'],
                      ['Minimum_Booking_Notice_Days', 'Minimum notice days', 'number'],
                      ['Maximum_Booking_Days', 'Maximum days ahead', 'number'],
                    ].map(([field, label, type]) => (
                      <label key={field} className="text-xs font-medium text-slate-600">
                        {label}
                        <input type={type} value={row[field] ?? ''} onChange={(event) => updateHoursDraft(row.Operating_Hours_ID, field, event.target.value)} disabled={!row.Is_Open} min={type === 'number' ? 0 : undefined} className={inputClass} />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="grid items-start gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Close a date or set special hours</h2>
              <p className="mt-0.5 text-xs text-slate-500">Use this for holidays, salon events, and one-day schedule changes.</p>
              <div className="mt-4 space-y-3">
                <label className="block text-xs font-medium text-slate-600">Date<input type="date" value={overrideDraft.date} onChange={(event) => setOverrideDraft((previous) => ({ ...previous, date: event.target.value }))} className={inputClass} /></label>
                <label className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={overrideDraft.isClosed} onChange={(event) => setOverrideDraft((previous) => ({ ...previous, isClosed: event.target.checked }))} />
                  Close the salon for the whole date
                </label>
                {!overrideDraft.isClosed ? (
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      ['openingTime', 'Opening time'],
                      ['closingTime', 'Closing time'],
                      ['breakStartTime', 'Break starts'],
                      ['breakEndTime', 'Break ends'],
                    ].map(([field, label]) => (
                      <label key={field} className="text-xs font-medium text-slate-600">{label}<input type="time" value={overrideDraft[field]} onChange={(event) => setOverrideDraft((previous) => ({ ...previous, [field]: event.target.value }))} className={inputClass} /></label>
                    ))}
                    <label className="col-span-2 text-xs font-medium text-slate-600">Capacity for this date<input type="number" min="1" value={overrideDraft.capacity} onChange={(event) => setOverrideDraft((previous) => ({ ...previous, capacity: event.target.value }))} className={inputClass} /></label>
                  </div>
                ) : null}
                <label className="block text-xs font-medium text-slate-600">Reason / event<textarea rows={2} value={overrideDraft.reason} onChange={(event) => setOverrideDraft((previous) => ({ ...previous, reason: event.target.value }))} className={inputClass} placeholder="Holiday, private salon event, maintenance..." /></label>
                <button type="button" onClick={() => void saveOverride()} disabled={isSaving} className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: primaryColor }}>Save date override</button>
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-5 py-4">
                <h2 className="text-lg font-semibold">Schedule overrides</h2>
                <p className="text-xs text-slate-500">Upcoming and recent closures or special hours.</p>
              </div>
              {!overrides.length ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">No schedule overrides yet.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {overrides.map((row) => (
                    <div key={row.Schedule_Override_ID} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{formatDate(row.Override_Date)}</p>
                        <p className="text-xs text-slate-500">
                          {row.Is_Closed ? 'Closed all day' : `${formatTime(row.Opening_Time)}â€“${formatTime(row.Closing_Time)}`}
                          {row.Reason ? ` â€” ${row.Reason}` : ''}
                        </p>
                      </div>
                      <button type="button" onClick={() => void deleteOverride(row.Schedule_Override_ID)} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-semibold text-rose-700"><XCircle size={13} /> Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
