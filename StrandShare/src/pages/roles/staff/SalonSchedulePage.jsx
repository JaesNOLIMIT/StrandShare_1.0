import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Camera, CameraOff, CheckCircle2, Clock3, Loader2, MapPin, Save, ScanLine, Search, UserCheck, UserX, XCircle } from 'lucide-react';
import jsQR from 'jsqr';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import PageHeaderActions from '../../../components/PageHeaderActions';
import { isValidWaybillCode, normalizeWaybillCodeInput, parseWaybillQrPayload } from '../../../lib/hairSubmissionWorkflow';

const LOGISTICS_TABLE = 'Hair_Submission_Logistics';
const SUBMISSIONS_TABLE = 'Hair_Submissions';
const HOURS_TABLE = 'Salon_Operating_Hours';
const OVERRIDES_TABLE = 'Salon_Schedule_Overrides';
const EMPTY_OVERRIDE = { date: '', isClosed: true, openingTime: '09:00', closingTime: '17:00', breakStartTime: '', breakEndTime: '', reason: '' };

function dateKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
function formatDate(value) {
  if (!value) return 'Not set';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T12:00:00+08:00`) : new Date(value);
  return date.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
}
function formatDateTime(value) {
  if (!value) return 'Not recorded';
  const raw = String(value);
  const date = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}+08:00`);
  return date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function formatTime(value) {
  if (!value) return 'Not set';
  const [hour, minute] = String(value).slice(0, 5).split(':').map(Number);
  return new Date(2000, 0, 1, hour || 0, minute || 0).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
}
function fullName(row) { return [row?.first_name, row?.middle_name, row?.last_name, row?.suffix].filter(Boolean).join(' ') || 'Unknown donor'; }
function routeKind(row) {
  const key = String(row?.Logistics_Type || '').toLowerCase().replace(/[_\s-]+/g, '');
  if (['courier', 'shipbycourier'].includes(key)) return 'Courier';
  if (['dropoff', 'salondropoff', 'walkindropoff'].includes(key)) return 'Drop-off';
  return '';
}
function receivingStatus(row) {
  if (routeKind(row) === 'Courier') {
    const key = String(row?.Shipment_Status || '').toLowerCase().replace(/[_\s-]+/g, '');
    if (row?.Received_At || ['received', 'completed', 'delivered'].includes(key)) return 'Received';
    if (['cancelled', 'canceled', 'noshow'].includes(key)) return 'Cancelled';
    return 'Expected';
  }
  return row?.Dropoff_Status || 'Expected';
}
function badgeClass(status) {
  if (status === 'Expected') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (status === 'Checked In') return 'border-amber-200 bg-amber-50 text-amber-700';
  if (status === 'Completed' || status === 'Received') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (['Cancelled', 'No Show'].includes(status)) return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}
function address(row) {
  return row ? [row.Destination_Name, row.Street, row.Barangay, row.City, row.Province, row.Region, row.Country].filter(Boolean).join(', ') : 'Salon address has not been configured.';
}

export default function SalonSchedulePage({ isActivePage = true }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#7c2d12';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const [tab, setTab] = useState('arrivals');
  const [rows, setRows] = useState([]);
  const [hours, setHours] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [office, setOffice] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('Active');
  const [dateFilter, setDateFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [notes, setNotes] = useState('');
  const [overrideDraft, setOverrideDraft] = useState(EMPTY_OVERRIDE);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scannerCode, setScannerCode] = useState('');
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const scanBusyRef = useRef(false);
  const lastScanRef = useRef({ value: '', at: 0 });

  const loadPage = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setLoading(true);
    try {
      const [lr, hr, or, officeResult] = await Promise.all([
        supabase.from(LOGISTICS_TABLE).select('*').order('Created_At', { ascending: false }),
        supabase.from(HOURS_TABLE).select('*').order('Day_Group'),
        supabase.from(OVERRIDES_TABLE).select('*').gte('Override_Date', dateKey(new Date(Date.now() - 31 * 86400000))).order('Override_Date'),
        supabase.from('Logistics_Settings').select('*').limit(1).maybeSingle(),
      ]);
      if (lr.error) throw lr.error;
      if (hr.error) throw hr.error;
      if (or.error) throw or.error;
      if (officeResult.error) throw officeResult.error;
      const logisticsRows = (lr.data || []).filter((row) => Boolean(routeKind(row)));
      const ids = logisticsRows.map((row) => row.Submission_ID).filter(Boolean);
      let submissions = [];
      if (ids.length) {
        const result = await supabase.from(SUBMISSIONS_TABLE).select('Submission_ID,User_ID,Status,Waybill_Code,Created_At,Donor_Notes,From_Event').in('Submission_ID', ids).eq('From_Event', false);
        if (result.error) throw result.error;
        submissions = result.data || [];
      }
      const submissionById = Object.fromEntries(submissions.map((row) => [row.Submission_ID, row]));
      const userIds = [...new Set(submissions.map((row) => row.User_ID).filter(Boolean))];
      let usersById = {}; let detailsById = {};
      if (userIds.length) {
        const [ur, dr] = await Promise.all([
          supabase.from('users').select('user_id,email').in('user_id', userIds),
          supabase.from('user_details').select('user_id,first_name,middle_name,last_name,suffix,contact_number').in('user_id', userIds),
        ]);
        if (ur.error) throw ur.error;
        if (dr.error) throw dr.error;
        usersById = Object.fromEntries((ur.data || []).map((row) => [row.user_id, row]));
        detailsById = Object.fromEntries((dr.data || []).map((row) => [row.user_id, row]));
      }
      const enriched = logisticsRows.map((logistics) => {
        const submission = submissionById[logistics.Submission_ID] || {};
        return { ...logistics, submission, account: usersById[submission.User_ID], profile: detailsById[submission.User_ID] };
      }).filter((row) => row.submission?.Submission_ID);
      setRows(enriched);
      setHours((hr.data || []).map((row) => ({ ...row, Opening_Time: String(row.Opening_Time || '').slice(0, 5), Closing_Time: String(row.Closing_Time || '').slice(0, 5), Break_Start_Time: String(row.Break_Start_Time || '').slice(0, 5), Break_End_Time: String(row.Break_End_Time || '').slice(0, 5) })));
      setOverrides(or.data || []); setOffice(officeResult.data || null);
      setSelectedId((previous) => enriched.some((row) => row.Submission_ID === previous) ? previous : enriched[0]?.Submission_ID || null);
    } catch (error) { setNotice({ kind: 'error', text: error?.message || 'Unable to load expected walk-ins.' }); }
    finally { setLoading(false); }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraOn(false);
  }, []);

  useEffect(() => { void loadPage(); return () => stopCamera(); }, [loadPage, stopCamera]);
  useEffect(() => {
    if (!isActivePage || !supabase) return undefined;
    const channel = supabase.channel('salon-expected-arrivals-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: LOGISTICS_TABLE }, () => void loadPage())
      .on('postgres_changes', { event: '*', schema: 'public', table: SUBMISSIONS_TABLE }, () => void loadPage()).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [isActivePage, loadPage]);

  const counts = useMemo(() => rows.reduce((map, row) => {
    const status = receivingStatus(row);
    return { ...map, [status]: (map[status] || 0) + 1 };
  }, {}), [rows]);
  const filtered = useMemo(() => rows.filter((row) => {
    const status = receivingStatus(row);
    if (statusFilter === 'Active' && !['Expected', 'Checked In'].includes(status)) return false;
    if (!['All', 'Active'].includes(statusFilter) && status !== statusFilter) return false;
    if (dateFilter && row.Expected_Dropoff_Date !== dateFilter) return false;
    return `${fullName(row.profile)} ${row.account?.email || ''} ${row.submission.Waybill_Code || ''} ${row.Submission_ID} ${routeKind(row)}`.toLowerCase().includes(query.toLowerCase().trim());
  }), [rows, statusFilter, dateFilter, query]);
  const selected = rows.find((row) => row.Submission_ID === selectedId) || null;

  const receiveScannedWaybill = useCallback(async (rawValue) => {
    if (!supabase || scanBusyRef.current) return;
    const parsed = parseWaybillQrPayload(String(rawValue || ''));
    const waybill = normalizeWaybillCodeInput(parsed?.waybillCode || rawValue);
    if (!isValidWaybillCode(waybill)) {
      setNotice({ kind: 'error', text: 'Scan a complete Hair Submissions waybill: WB followed by 6 letters or numbers.' });
      return;
    }
    scanBusyRef.current = true;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('staff_receive_non_event_hair_by_waybill', {
        p_waybill_code: waybill,
        p_note: notes.trim() || null,
      });
      if (error) throw error;
      const submissionId = Number(data?.submission?.Submission_ID || 0);
      setScannerCode('');
      setNotice({ kind: 'success', text: `${data?.route || 'Donation'} ${waybill} received. It is now waiting for Specialist Quality Check.` });
      await loadPage();
      if (submissionId) setSelectedId(submissionId);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to receive this waybill.' });
    } finally {
      setSaving(false);
      scanBusyRef.current = false;
    }
  }, [loadPage, notes]);

  const toggleCamera = async () => {
    if (isCameraOn) { stopCamera(); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice({ kind: 'error', text: 'Camera scanning is unavailable in this browser. Enter the waybill manually.' });
      return;
    }
    setIsStartingCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }
      setIsCameraOn(true);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Camera access failed.' });
      stopCamera();
    } finally { setIsStartingCamera(false); }
  };

  useEffect(() => {
    if (!isCameraOn) return undefined;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || scanBusyRef.current) return;
      const width = video.videoWidth; const height = video.videoHeight;
      if (!width || !height) return;
      const canvas = canvasRef.current || document.createElement('canvas');
      canvasRef.current = canvas; canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      const image = context.getImageData(0, 0, width, height);
      const decoded = String(jsQR(image.data, width, height, { inversionAttempts: 'attemptBoth' })?.data || '').trim();
      if (!decoded) return;
      const now = Date.now();
      if (lastScanRef.current.value === decoded && now - lastScanRef.current.at < 2500) return;
      lastScanRef.current = { value: decoded, at: now };
      void receiveScannedWaybill(decoded);
    }, 250);
    return () => window.clearInterval(timer);
  }, [isCameraOn, receiveScannedWaybill]);

  const runAction = async (action) => {
    if (!selected || !supabase) return;
    if (['cancel', 'no_show'].includes(action) && !notes.trim()) { setNotice({ kind: 'error', text: 'Enter a reason before cancelling or marking No Show.' }); return; }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('staff_update_walk_in_donation', { p_submission_id: selected.Submission_ID, p_action: action, p_notes: notes.trim() || null });
      if (error) throw error;
      setNotice({ kind: 'success', text: action === 'complete' ? 'Receiving completed. The hair can now move to its separate quality review.' : 'Walk-in status updated.' });
      setNotes(''); await loadPage();
    } catch (error) { setNotice({ kind: 'error', text: error?.message || 'Unable to update this walk-in.' }); }
    finally { setSaving(false); }
  };
  const updateHour = (id, field, value) => setHours((old) => old.map((row) => row.Operating_Hours_ID === id ? { ...row, [field]: value } : row));
  const saveHours = async () => {
    setSaving(true);
    try {
      for (const row of hours) {
        const { error } = await supabase.from(HOURS_TABLE).update({ Is_Open: Boolean(row.Is_Open), Opening_Time: row.Opening_Time, Closing_Time: row.Closing_Time, Break_Start_Time: row.Break_Start_Time || null, Break_End_Time: row.Break_End_Time || null, Minimum_Booking_Notice_Days: Number(row.Minimum_Booking_Notice_Days || 0), Maximum_Booking_Days: Number(row.Maximum_Booking_Days || 30) }).eq('Operating_Hours_ID', row.Operating_Hours_ID);
        if (error) throw error;
      }
      setNotice({ kind: 'success', text: 'Receiving hours and allowed date range saved.' }); await loadPage();
    } catch (error) { setNotice({ kind: 'error', text: error.message }); } finally { setSaving(false); }
  };
  const saveOverride = async () => {
    if (!overrideDraft.date) { setNotice({ kind: 'error', text: 'Select an override date.' }); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from(OVERRIDES_TABLE).upsert({ Override_Date: overrideDraft.date, Is_Closed: overrideDraft.isClosed, Opening_Time: overrideDraft.isClosed ? null : overrideDraft.openingTime, Closing_Time: overrideDraft.isClosed ? null : overrideDraft.closingTime, Break_Start_Time: overrideDraft.isClosed ? null : (overrideDraft.breakStartTime || null), Break_End_Time: overrideDraft.isClosed ? null : (overrideDraft.breakEndTime || null), Capacity_Per_Slot: null, Reason: overrideDraft.reason.trim() || null }, { onConflict: 'Override_Date' });
      if (error) throw error;
      setOverrideDraft(EMPTY_OVERRIDE); setNotice({ kind: 'success', text: 'Date override saved.' }); await loadPage();
    } catch (error) { setNotice({ kind: 'error', text: error.message }); } finally { setSaving(false); }
  };

  const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-500';
  return <div className="min-w-0 space-y-5" style={{ color: primaryTextColor }}>
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="role-page-title text-2xl font-bold" style={{ fontFamily: `${headingFont}, sans-serif` }}>Salon Receiving Schedule</h1><p className="max-w-3xl text-sm" style={{ color: secondaryTextColor }}>Expected arrival times help staff prepare. They are not appointments, and late donors may still check in.</p><p className="mt-2 flex items-start gap-2 text-xs text-slate-500"><MapPin size={14} className="mt-0.5 shrink-0" />{address(office)}</p></div><PageHeaderActions onRefresh={() => void loadPage()} refreshLoading={loading} helpTitle="Expected walk-ins" helpContent={<p>Check in arrivals, complete physical receiving, and manage hours or closures. Quality approval happens separately.</p>} /></header>
    {notice.text ? <div className={`rounded-xl border px-4 py-3 text-sm ${notice.kind === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>{notice.text}</div> : null}
    <div className="flex w-fit gap-1 rounded-xl border border-slate-200 bg-white p-1">{[['arrivals', 'Expected arrivals'], ['settings', 'Hours & closures']].map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === key ? 'text-white' : 'text-slate-600'}`} style={tab === key ? { backgroundColor: primaryColor } : undefined}>{label}</button>)}</div>

    {tab === 'arrivals' ? <>
      <section className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[minmax(280px,0.8fr)_minmax(320px,1.2fr)]">
        <div>
          <div className="flex items-center gap-2"><ScanLine size={18} style={{ color: primaryColor }} /><h2 className="font-semibold">Receive donated hair</h2></div>
          <p className="mt-1 text-xs text-slate-500">Scan only the code stored in Hair_Submissions.Waybill_Code. Event waybills are handled in Assigned Events.</p>
          <div className="mt-3 flex gap-2">
            <input value={scannerCode} onChange={(event) => setScannerCode(normalizeWaybillCodeInput(event.target.value))} onKeyDown={(event) => { if (event.key === 'Enter') void receiveScannedWaybill(scannerCode); }} placeholder="WBXXXXXX" maxLength={8} className={`${inputClass} font-mono uppercase`} />
            <button type="button" disabled={saving || !isValidWaybillCode(scannerCode)} onClick={() => void receiveScannedWaybill(scannerCode)} className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: primaryColor }}>Receive</button>
          </div>
          <p className="mt-2 text-xs text-slate-500">Courier and Drop-off both remain Pending until this staff receiving scan succeeds.</p>
        </div>
        <div className="overflow-hidden rounded-xl bg-slate-950">
          <div className="relative h-44">
            <video ref={videoRef} className={`h-full w-full object-cover ${isCameraOn ? '' : 'hidden'}`} />
            {!isCameraOn ? <div className="flex h-full flex-col items-center justify-center text-slate-300"><CameraOff size={28} /><p className="mt-2 text-sm font-semibold">Camera scanner is off</p></div> : null}
          </div>
          <button type="button" disabled={isStartingCamera} onClick={() => void toggleCamera()} className="flex w-full items-center justify-center gap-2 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white">{isCameraOn ? <CameraOff size={16} /> : <Camera size={16} />}{isStartingCamera ? 'Starting camera...' : isCameraOn ? 'Stop camera' : 'Start QR scanner'}</button>
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['Waiting', counts.Expected || 0], ['Checked In', counts['Checked In'] || 0], ['Received', (counts.Received || 0) + (counts.Completed || 0)], ['Cancelled / No Show', (counts.Cancelled || 0) + (counts['No Show'] || 0)]].map(([label, count]) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold">{count}</p></div>)}</div>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-3 border-b border-slate-200 p-4 md:grid-cols-[1fr_180px_180px]"><label className="relative"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search donor, route, waybill, or ID" className={`${inputClass} pl-9`} /></label><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>{['Active', 'Expected', 'Checked In', 'Received', 'Completed', 'Cancelled', 'No Show', 'All'].map((item) => <option key={item}>{item}</option>)}</select><input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className={inputClass} /></div>
        <div className="grid min-h-[420px] lg:grid-cols-[minmax(330px,0.85fr)_minmax(420px,1.15fr)]"><div className="max-h-[650px] overflow-y-auto border-b lg:border-b-0 lg:border-r">{loading ? <p className="flex items-center gap-2 p-5 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />Loading donations...</p> : null}{!loading && !filtered.length ? <p className="p-8 text-center text-sm text-slate-500">No Courier or Drop-off records match these filters.</p> : null}{filtered.map((row) => <button key={row.Submission_ID} onClick={() => setSelectedId(row.Submission_ID)} className={`w-full border-b border-slate-100 p-4 text-left ${selectedId === row.Submission_ID ? 'bg-amber-50' : 'hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-900">{fullName(row.profile)}</p><p className="font-mono text-xs text-slate-500">{row.submission.Waybill_Code || `Submission #${row.Submission_ID}`}</p><p className="mt-1 text-xs font-semibold text-slate-500">{routeKind(row)}</p></div><span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeClass(receivingStatus(row))}`}>{receivingStatus(row)}</span></div>{routeKind(row) === 'Drop-off' ? <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-600"><CalendarDays size={13} />{formatDate(row.Expected_Dropoff_Date)} <Clock3 size={13} className="ml-2" />{formatTime(row.Expected_Arrival_Time)}</p> : <p className="mt-2 text-xs text-slate-600">{row.Courier_Name || 'Courier'}{row.Tracking_Number ? ` · ${row.Tracking_Number}` : ''}</p>}</button>)}</div>
          <div className="p-5">{!selected ? <p className="text-sm text-slate-500">Select an arrival to see its complete receiving record.</p> : <div className="space-y-5"><div className="flex flex-wrap justify-between gap-3"><div><p className="text-lg font-semibold">{fullName(selected.profile)}</p><p className="text-sm text-slate-500">{selected.account?.email || 'No email'} · {selected.profile?.contact_number || 'No phone'}</p></div><div className="text-right"><p className="font-mono font-bold">{selected.submission.Waybill_Code}</p><p className="text-xs text-slate-500">Submission #{selected.Submission_ID}</p></div></div><div className="rounded-xl border border-blue-100 bg-blue-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Expected arrival — not an appointment</p><p className="mt-1 font-semibold text-blue-950">{formatDate(selected.Expected_Dropoff_Date)} at {formatTime(selected.Expected_Arrival_Time)}</p><p className="mt-1 text-xs text-blue-700">Late arrival is allowed. Passing this time never marks No Show automatically.</p></div><div className="grid gap-3 sm:grid-cols-3">{[['Checked in', selected.Checked_In_At], ['Receiving completed', selected.Completed_At || selected.Received_At], ['Cancelled', selected.Cancelled_At]].map(([label, value]) => <div key={label} className="rounded-lg border border-slate-200 p-3"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-1 text-xs">{formatDateTime(value)}</p></div>)}</div>{selected.Cancellation_Reason ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><strong>{selected.Dropoff_Status}</strong> by {selected.Cancellation_Source || 'Staff'}: {selected.Cancellation_Reason}</div> : null}
            {['Expected', 'Checked In'].includes(selected.Dropoff_Status) ? <><label className="block text-sm font-medium text-slate-700">Staff note / required reason<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Required for cancellation or No Show" className={`${inputClass} mt-1`} /></label><div className="flex flex-wrap gap-2">{selected.Dropoff_Status === 'Expected' ? <button disabled={saving} onClick={() => void runAction('check_in')} className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white"><UserCheck size={16} />Check in</button> : null}{selected.Dropoff_Status === 'Checked In' ? <button disabled={saving} onClick={() => void runAction('complete')} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"><CheckCircle2 size={16} />Complete receiving</button> : null}{selected.Dropoff_Status === 'Expected' ? <button disabled={saving} onClick={() => void runAction('no_show')} className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700"><UserX size={16} />Mark No Show</button> : null}<button disabled={saving} onClick={() => void runAction('cancel')} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold"><XCircle size={16} />Cancel</button></div></> : <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">This record is final. Completed hair continues to Quality Check; cancelled/no-show donations remain history and cannot be reopened.</div>}</div>}</div></div>
      </section>
    </> : <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold">Regular receiving hours</h2><p className="mt-1 text-xs text-slate-500">No slot capacity, duration, end time, or grace period is used.</p><div className="mt-4 space-y-4">{hours.map((row) => <div key={row.Operating_Hours_ID} className="rounded-xl border border-slate-200 p-4"><div className="flex justify-between"><strong>{row.Day_Group}</strong><label className="flex gap-2 text-sm"><input type="checkbox" checked={row.Is_Open} onChange={(e) => updateHour(row.Operating_Hours_ID, 'Is_Open', e.target.checked)} />Open</label></div><div className="mt-3 grid grid-cols-2 gap-3">{[['Opening_Time', 'Opens'], ['Closing_Time', 'Closes'], ['Break_Start_Time', 'Break starts'], ['Break_End_Time', 'Break ends']].map(([field, label]) => <label key={field} className="text-xs font-semibold text-slate-600">{label}<input type="time" value={row[field]} onChange={(e) => updateHour(row.Operating_Hours_ID, field, e.target.value)} className={`${inputClass} mt-1`} /></label>)}</div><div className="mt-3 grid grid-cols-2 gap-3">{[['Minimum_Booking_Notice_Days', 'Minimum notice (days)'], ['Maximum_Booking_Days', 'Maximum days ahead']].map(([field, label]) => <label key={field} className="text-xs font-semibold text-slate-600">{label}<input type="number" min="0" value={row[field]} onChange={(e) => updateHour(row.Operating_Hours_ID, field, e.target.value)} className={`${inputClass} mt-1`} /></label>)}</div></div>)}</div><button disabled={saving} onClick={() => void saveHours()} className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}><Save size={16} />Save hours</button></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold">Closures & special hours</h2><p className="mt-1 text-xs text-slate-500">Date overrides take priority over regular hours.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Date<input type="date" value={overrideDraft.date} onChange={(e) => setOverrideDraft((old) => ({ ...old, date: e.target.value }))} className={`${inputClass} mt-1`} /></label><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={overrideDraft.isClosed} onChange={(e) => setOverrideDraft((old) => ({ ...old, isClosed: e.target.checked }))} />Closed all day</label>{!overrideDraft.isClosed ? [['openingTime', 'Opens'], ['closingTime', 'Closes'], ['breakStartTime', 'Break starts'], ['breakEndTime', 'Break ends']].map(([field, label]) => <label key={field} className="text-xs font-semibold text-slate-600">{label}<input type="time" value={overrideDraft[field]} onChange={(e) => setOverrideDraft((old) => ({ ...old, [field]: e.target.value }))} className={`${inputClass} mt-1`} /></label>) : null}<label className="text-xs font-semibold text-slate-600 sm:col-span-2">Reason<input value={overrideDraft.reason} onChange={(e) => setOverrideDraft((old) => ({ ...old, reason: e.target.value }))} className={`${inputClass} mt-1`} /></label></div><button disabled={saving} onClick={() => void saveOverride()} className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}><Save size={16} />Save override</button><div className="mt-5 space-y-2">{overrides.map((row) => <div key={row.Schedule_Override_ID} className="flex justify-between rounded-lg border border-slate-200 p-3"><div><p className="text-sm font-semibold">{formatDate(row.Override_Date)}</p><p className="text-xs text-slate-500">{row.Is_Closed ? 'Closed all day' : `${formatTime(row.Opening_Time)} - ${formatTime(row.Closing_Time)}`}{row.Reason ? ` · ${row.Reason}` : ''}</p></div><span className={`h-fit rounded-full border px-2 py-0.5 text-xs ${row.Is_Closed ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>{row.Is_Closed ? 'Closed' : 'Special hours'}</span></div>)}</div></section>
    </div>}
  </div>;
}
