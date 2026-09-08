import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, CameraOff, CheckCircle2, Loader2, MapPin, Save, ScanLine, Search, UserCheck, UserX, XCircle } from 'lucide-react';
import jsQR from 'jsqr';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import PageHeaderActions from '../../../components/PageHeaderActions';
import { useToast } from '../../../context/ToastContext';
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
  const status = String(row?.Dropoff_Status || 'Expected').trim();
  if (status === 'Completed') return 'Received';
  return status;
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
function compactAddress(row) {
  if (!row) return 'Location not configured';
  const place = row.Destination_Name || 'Main Office';
  const locality = [row.City, row.Province].filter(Boolean).join(', ');
  return [place, locality].filter(Boolean).join(' · ');
}
function expectedArrivalLabel(row) {
  if (!row?.Expected_Dropoff_Date && !row?.Expected_Arrival_Time) return 'Not set';
  return [
    row?.Expected_Dropoff_Date ? formatDate(row.Expected_Dropoff_Date) : null,
    row?.Expected_Arrival_Time ? formatTime(row.Expected_Arrival_Time) : null,
  ].filter(Boolean).join(' · ');
}
function receivingTimeline(row) {
  if (!row) return [];
  const status = receivingStatus(row);
  const receivedAt = row.Completed_At || row.Received_At;
  const submissionStatus = String(row.submission?.Status || '').trim();
  const submissionKey = submissionStatus.toLowerCase().replace(/[^a-z0-9]/g, '');
  const qualityDone = ['approved', 'accepted', 'hairaccepted', 'qualityapproved', 'forbundling', 'bundled', 'inproduction', 'wigcreated', 'wigcompleted']
    .some((key) => submissionKey.includes(key));
  const completed = ['bundled', 'inproduction', 'wigcreated', 'wigcompleted'].some((key) => submissionKey.includes(key));
  const stages = [
    { label: 'Expected Arrival', detail: expectedArrivalLabel(row), done: ['Checked In', 'Received'].includes(status) },
    { label: 'Checked In', detail: row.Checked_In_At ? formatDateTime(row.Checked_In_At) : '—', done: Boolean(row.Checked_In_At) },
    { label: 'Hair Received', detail: receivedAt ? formatDateTime(receivedAt) : '—', done: Boolean(receivedAt) },
    { label: 'Quality Check', detail: qualityDone ? submissionStatus : receivedAt ? 'Waiting for Specialist' : '—', done: qualityDone },
    { label: 'Completed', detail: completed ? submissionStatus : '—', done: completed },
  ];
  let currentAssigned = false;
  return stages.map((stage) => {
    const current = !['Cancelled', 'No Show'].includes(status) && !stage.done && !currentAssigned;
    if (current) currentAssigned = true;
    return { ...stage, current };
  });
}

export default function SalonSchedulePage({ isActivePage = true }) {
  const { theme } = useTheme();
  const { showToast } = useToast();
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

  useEffect(() => {
    if (!notice.text) return;
    showToast({
      type: notice.kind === 'error' ? 'error' : 'success',
      title: notice.kind === 'error' ? 'Action not completed' : 'Receiving updated',
      message: notice.text,
    });
    setNotice({ kind: '', text: '' });
  }, [notice, showToast]);

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
      stopCamera();
      setNotice({ kind: 'success', text: `${data?.route || 'Donation'} ${waybill} received. It is now waiting for Specialist Quality Check.` });
      await loadPage();
      if (submissionId) setSelectedId(submissionId);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to receive this waybill.' });
    } finally {
      setSaving(false);
      scanBusyRef.current = false;
    }
  }, [loadPage, notes, stopCamera]);

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
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!isCameraOn || !video || !stream) return;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    void video.play().catch(() => {
      setNotice({ kind: 'error', text: 'The camera opened but its preview could not start. Please close it and try again.' });
    });
  }, [isCameraOn]);

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
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="role-page-title text-2xl font-bold" style={{ fontFamily: `${headingFont}, sans-serif` }}>Receiving Schedule</h1><p className="max-w-3xl text-sm" style={{ color: secondaryTextColor }}>Expected arrivals help staff prepare; late donors may still check in.</p><p title={address(office)} className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500"><MapPin size={13} className="shrink-0" />{compactAddress(office)}</p></div><PageHeaderActions onRefresh={() => void loadPage()} refreshLoading={loading} helpTitle="Expected arrivals" helpContent={<p>Check in arrivals, complete physical receiving, and manage hours or closures. Quality approval happens separately.</p>} /></header>
    <div className="flex w-fit gap-1 rounded-xl border border-slate-200 bg-white p-1">{[['arrivals', 'Expected arrivals'], ['settings', 'Hours & closures']].map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === key ? 'text-white' : 'text-slate-600'}`} style={tab === key ? { backgroundColor: primaryColor } : undefined}>{label}</button>)}</div>

    {tab === 'arrivals' ? <>
      <section className="rounded-2xl bg-white px-4 py-4 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><ScanLine size={18} style={{ color: primaryColor }} /><h2 className="font-semibold">Receive donation</h2></div>
            <p className="mt-1 text-xs text-slate-500">Enter or scan the waybill attached to the donated hair.</p>
            <div className="mt-3 flex max-w-3xl flex-col gap-2 sm:flex-row">
              <input value={scannerCode} onChange={(event) => setScannerCode(normalizeWaybillCodeInput(event.target.value))} onKeyDown={(event) => { if (event.key === 'Enter') void receiveScannedWaybill(scannerCode); }} placeholder="Enter waybill or scan QR" maxLength={8} className={`${inputClass} min-w-0 flex-1 font-mono uppercase`} />
              <button type="button" disabled={saving || !isValidWaybillCode(scannerCode)} onClick={() => void receiveScannedWaybill(scannerCode)} className="rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: primaryColor }}>{saving ? 'Receiving…' : 'Receive'}</button>
              <button type="button" disabled={isStartingCamera} onClick={() => void toggleCamera()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Camera size={16} />{isStartingCamera ? 'Starting…' : isCameraOn ? 'Stop scanner' : 'Scan QR'}</button>
            </div>
          </div>
          <p className="max-w-xs text-xs leading-relaxed text-slate-400">Non-event courier and drop-off donations only. Event receiving stays in Assigned Events.</p>
        </div>
      </section>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{[
        ['Waiting', counts.Expected || 0, 'bg-amber-50 text-amber-800'],
        ['Checked In', counts['Checked In'] || 0, 'bg-blue-50 text-blue-800'],
        ['Received', counts.Received || 0, 'bg-emerald-50 text-emerald-800'],
        ['Cancelled / No Show', (counts.Cancelled || 0) + (counts['No Show'] || 0), 'bg-rose-50 text-rose-800'],
      ].map(([label, count, tone]) => <div key={label} className={`flex items-center justify-between rounded-xl px-4 py-2.5 ${tone}`}><p className="text-[11px] font-semibold uppercase tracking-wide">{label}</p><p className="text-xl font-bold">{count}</p></div>)}</div>
      <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="grid gap-2 bg-slate-50/80 p-3 md:grid-cols-[1fr_170px_170px]"><label className="relative"><Search size={16} className="absolute left-3 top-2.5 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search donor, waybill, route, or ID" className={`${inputClass} pl-9`} /></label><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>{['Active', 'Expected', 'Checked In', 'Received', 'Cancelled', 'No Show', 'All'].map((item) => <option key={item}>{item}</option>)}</select><input type="date" aria-label="Filter by expected date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className={inputClass} /></div>
        <div className="grid min-h-[500px] lg:grid-cols-[minmax(300px,0.72fr)_minmax(480px,1.28fr)]">
          <div className="max-h-[680px] overflow-y-auto border-b border-slate-100 lg:border-b-0 lg:border-r">
            <div className="sticky top-0 z-10 bg-white/95 px-4 py-3 backdrop-blur"><h2 className="font-semibold text-slate-900">Donor Queue</h2><p className="text-xs text-slate-500">{filtered.length} matching donations</p></div>
            {loading ? <p className="flex items-center gap-2 p-5 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />Loading donations...</p> : null}
            {!loading && !filtered.length ? <p className="p-8 text-center text-sm text-slate-500">No courier or drop-off records match these filters.</p> : null}
            {filtered.map((row) => {
              const isSelected = selectedId === row.Submission_ID;
              return <button key={row.Submission_ID} onClick={() => setSelectedId(row.Submission_ID)} className={`w-full border-b border-l-[3px] border-b-slate-100 px-4 py-3 text-left transition-colors ${isSelected ? 'bg-rose-50/70' : 'border-l-transparent hover:bg-slate-50'}`} style={isSelected ? { borderLeftColor: primaryColor } : undefined}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-semibold text-slate-900">{fullName(row.profile)}</p><p className="mt-0.5 font-mono text-xs text-slate-500">{row.submission.Waybill_Code || `Submission #${row.Submission_ID}`}</p><p className="mt-1 text-xs font-medium text-slate-500">{routeKind(row)}</p></div><span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badgeClass(receivingStatus(row))}`}>{receivingStatus(row)}</span></div></button>;
            })}
          </div>
          <div className="p-5 lg:p-6">
            {!selected ? <div className="flex h-full min-h-80 items-center justify-center text-sm text-slate-500">Select a donor to view the receiving record.</div> : <div className="mx-auto max-w-3xl space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-5"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Selected donation</p><h2 className="mt-1 text-xl font-bold text-slate-900">{fullName(selected.profile)}</h2><p className="mt-1 text-sm text-slate-500">{selected.account?.email || 'No email'} · {selected.profile?.contact_number || 'No phone'}</p></div><div className="text-right"><p className="font-mono text-base font-bold" style={{ color: primaryColor }}>{selected.submission.Waybill_Code || 'No waybill'}</p><p className="mt-1 text-xs text-slate-500">Submission #{selected.Submission_ID} · {routeKind(selected)}</p></div></div>

              <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
                <div><h3 className="text-sm font-semibold text-slate-900">Receiving progress</h3><div className="mt-4 space-y-0">{receivingTimeline(selected).map((stage, index, stages) => <div key={stage.label} className="relative flex gap-3 pb-5 last:pb-0">{index < stages.length - 1 ? <span className={`absolute left-[9px] top-5 h-full w-px ${stage.done ? 'bg-emerald-300' : 'bg-slate-200'}`} /> : null}<span className={`relative z-[1] mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${stage.done ? 'bg-emerald-600 text-white' : stage.current ? 'ring-2 ring-offset-2 text-white' : 'bg-slate-200 text-slate-400'}`} style={stage.current ? { backgroundColor: primaryColor, '--tw-ring-color': primaryColor } : undefined}>{stage.done ? <CheckCircle2 size={13} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}</span><div><p className={`text-sm font-semibold ${stage.current ? 'text-slate-900' : stage.done ? 'text-slate-800' : 'text-slate-400'}`}>{stage.label}</p><p className="mt-0.5 text-xs text-slate-500">{stage.detail}</p></div></div>)}</div></div>
                <div className="space-y-4"><div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Expected arrival</p><p className="mt-1 text-sm font-semibold text-slate-900">{expectedArrivalLabel(selected)}</p><p className="mt-1 text-xs leading-relaxed text-slate-500">This is a preparation estimate, not an appointment. Late check-in remains allowed.</p></div>{selected.Cancellation_Reason ? <div className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800"><p className="text-xs font-bold uppercase tracking-wide">Exception · {selected.Dropoff_Status}</p><p className="mt-1">{selected.Cancellation_Reason}</p><p className="mt-1 text-xs text-rose-600">Recorded by {selected.Cancellation_Source || 'Staff'}</p></div> : null}</div>
              </div>

              {['Expected', 'Checked In'].includes(selected.Dropoff_Status) ? <div className="border-t border-slate-100 pt-5"><label className="block text-sm font-medium text-slate-700">Staff note <span className="font-normal text-slate-400">(required for cancellation or No Show)</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Add a receiving note or exception reason" className={`${inputClass} mt-2`} /></label><div className="mt-3 flex flex-wrap gap-2">{selected.Dropoff_Status === 'Expected' ? <button disabled={saving} onClick={() => void runAction('check_in')} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ backgroundColor: primaryColor }}><UserCheck size={16} />Check In</button> : null}{selected.Dropoff_Status === 'Checked In' ? <button disabled={saving} onClick={() => void runAction('complete')} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"><CheckCircle2 size={16} />Mark Received</button> : null}{selected.Dropoff_Status === 'Expected' ? <button disabled={saving} onClick={() => void runAction('no_show')} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"><UserX size={16} />No Show</button> : null}<button disabled={saving} onClick={() => void runAction('cancel')} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"><XCircle size={16} />Cancel</button></div></div> : <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">This receiving record is final. Received hair continues to Specialist Quality Check; cancelled and no-show records remain in history.</div>}
            </div>}
          </div>
        </div>
      </section>
    </> : <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold">Regular receiving hours</h2><p className="mt-1 text-xs text-slate-500">No slot capacity, duration, end time, or grace period is used.</p><div className="mt-4 space-y-4">{hours.map((row) => <div key={row.Operating_Hours_ID} className="rounded-xl border border-slate-200 p-4"><div className="flex justify-between"><strong>{row.Day_Group}</strong><label className="flex gap-2 text-sm"><input type="checkbox" checked={row.Is_Open} onChange={(e) => updateHour(row.Operating_Hours_ID, 'Is_Open', e.target.checked)} />Open</label></div><div className="mt-3 grid grid-cols-2 gap-3">{[['Opening_Time', 'Opens'], ['Closing_Time', 'Closes'], ['Break_Start_Time', 'Break starts'], ['Break_End_Time', 'Break ends']].map(([field, label]) => <label key={field} className="text-xs font-semibold text-slate-600">{label}<input type="time" value={row[field]} onChange={(e) => updateHour(row.Operating_Hours_ID, field, e.target.value)} className={`${inputClass} mt-1`} /></label>)}</div><div className="mt-3 grid grid-cols-2 gap-3">{[['Minimum_Booking_Notice_Days', 'Minimum notice (days)'], ['Maximum_Booking_Days', 'Maximum days ahead']].map(([field, label]) => <label key={field} className="text-xs font-semibold text-slate-600">{label}<input type="number" min="0" value={row[field]} onChange={(e) => updateHour(row.Operating_Hours_ID, field, e.target.value)} className={`${inputClass} mt-1`} /></label>)}</div></div>)}</div><button disabled={saving} onClick={() => void saveHours()} className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}><Save size={16} />Save hours</button></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold">Closures & special hours</h2><p className="mt-1 text-xs text-slate-500">Date overrides take priority over regular hours.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Date<input type="date" value={overrideDraft.date} onChange={(e) => setOverrideDraft((old) => ({ ...old, date: e.target.value }))} className={`${inputClass} mt-1`} /></label><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={overrideDraft.isClosed} onChange={(e) => setOverrideDraft((old) => ({ ...old, isClosed: e.target.checked }))} />Closed all day</label>{!overrideDraft.isClosed ? [['openingTime', 'Opens'], ['closingTime', 'Closes'], ['breakStartTime', 'Break starts'], ['breakEndTime', 'Break ends']].map(([field, label]) => <label key={field} className="text-xs font-semibold text-slate-600">{label}<input type="time" value={overrideDraft[field]} onChange={(e) => setOverrideDraft((old) => ({ ...old, [field]: e.target.value }))} className={`${inputClass} mt-1`} /></label>) : null}<label className="text-xs font-semibold text-slate-600 sm:col-span-2">Reason<input value={overrideDraft.reason} onChange={(e) => setOverrideDraft((old) => ({ ...old, reason: e.target.value }))} className={`${inputClass} mt-1`} /></label></div><button disabled={saving} onClick={() => void saveOverride()} className="mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}><Save size={16} />Save override</button><div className="mt-5 space-y-2">{overrides.map((row) => <div key={row.Schedule_Override_ID} className="flex justify-between rounded-lg border border-slate-200 p-3"><div><p className="text-sm font-semibold">{formatDate(row.Override_Date)}</p><p className="text-xs text-slate-500">{row.Is_Closed ? 'Closed all day' : `${formatTime(row.Opening_Time)} - ${formatTime(row.Closing_Time)}`}{row.Reason ? ` · ${row.Reason}` : ''}</p></div><span className={`h-fit rounded-full border px-2 py-0.5 text-xs ${row.Is_Closed ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>{row.Is_Closed ? 'Closed' : 'Special hours'}</span></div>)}</div></section>
    </div>}

    {isCameraOn && typeof document !== 'undefined' ? createPortal(
      <div className="fixed inset-0 z-[2147483000] flex items-center justify-center p-4">
        <button type="button" aria-label="Close QR scanner" onClick={stopCamera} className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" />
        <section role="dialog" aria-modal="true" aria-labelledby="receiving-scanner-title" className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
          <header className="flex items-start justify-between gap-3 px-4 py-3">
            <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Receiving scanner</p><h2 id="receiving-scanner-title" className="mt-0.5 font-semibold text-slate-900">Scan donation waybill</h2><p className="mt-0.5 text-xs text-slate-500">Hold the complete QR code inside the guide.</p></div>
            <button type="button" onClick={stopCamera} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><XCircle size={18} /></button>
          </header>
          <div className="relative aspect-[4/3] bg-slate-950">
            <video ref={videoRef} className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="h-44 w-44 rounded-2xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(2,6,23,0.28)]" /></div>
          </div>
          <footer className="flex items-center justify-between gap-3 px-4 py-3"><p className="text-xs text-slate-500">Scanning automatically…</p><button type="button" onClick={stopCamera} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white"><CameraOff size={14} />Close scanner</button></footer>
        </section>
      </div>,
      document.body,
    ) : null}
  </div>;
}
