import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, FileImage, Loader2, Search, ShieldCheck } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { useToast } from '../context/ToastContext';

const TERMS_VERSION = '2026-09-02-v1';
const PATIENT_ASSETS_BUCKET = 'patient_assets';
const APPEAL_REASONS = ['Damaged on Receipt', 'Wrong Wig', 'Poor Fit', 'Other'];

function formatDateTime(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' });
}

function safeFileName(value) {
  return String(value || 'evidence').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');
}

function getPublicUrl(path) {
  if (!path || !supabase) return '';
  return supabase.storage.from(PATIENT_ASSETS_BUCKET).getPublicUrl(path).data?.publicUrl || '';
}

function statusClasses(status) {
  if (status === 'Approved for Replacement') return 'bg-emerald-100 text-emerald-800';
  if (status === 'Rejected') return 'bg-red-100 text-red-800';
  return 'bg-amber-100 text-amber-900';
}

function formatDestination(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  return [
    snapshot.Destination_Name,
    snapshot.Street,
    snapshot.Barangay,
    snapshot.City,
    snapshot.Province,
    snapshot.Region,
    snapshot.Country,
  ].map((value) => String(value || '').trim()).filter(Boolean).join(', ');
}

function ReturnWorkflowPanel({ mode, appeal, busy, returnForm, setReturnForm, onSubmitShipment, onStaffAction }) {
  if (!appeal?.return_status) return null;
  const destination = appeal.return_destination_snapshot || {};
  const destinationAddress = formatDestination(destination);
  const latitude = Number(destination.Latitude);
  const longitude = Number(destination.Longitude);
  const hasMap = Number.isFinite(latitude) && Number.isFinite(longitude);

  return (
    <section className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Return, repair and re-release</p>
          <h4 className="mt-1 font-bold text-slate-900">{appeal.return_status}</h4>
        </div>
        {appeal.return_tracking_number ? <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">{appeal.return_courier}: {appeal.return_tracking_number}</span> : null}
      </div>

      {destinationAddress ? (
        <div className="mt-3 rounded-lg border border-indigo-200 bg-white p-3 text-sm text-slate-700">
          <p className="font-bold text-slate-900">Office return destination</p>
          <p className="mt-1">{destinationAddress}</p>
          {destination.Contact_Person || destination.Contact_Number ? <p className="mt-1 text-xs">Contact: {[destination.Contact_Person, destination.Contact_Number].filter(Boolean).join(' · ')}</p> : null}
          {hasMap ? <a href={`https://www.google.com/maps?q=${latitude},${longitude}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-bold text-indigo-700 underline">Open pinned destination</a> : null}
        </div>
      ) : null}

      {mode === 'hospital' && appeal.return_status === 'Awaiting Return' ? (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-sm font-semibold text-slate-800">Send the wig to the destination above, then enter the shipment details.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input value={returnForm.courier} onChange={(event) => setReturnForm((previous) => ({ ...previous, courier: event.target.value }))} placeholder="Courier" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={returnForm.trackingNumber} onChange={(event) => setReturnForm((previous) => ({ ...previous, trackingNumber: event.target.value }))} placeholder="Tracking/reference number" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <textarea value={returnForm.note} onChange={(event) => setReturnForm((previous) => ({ ...previous, note: event.target.value }))} rows={2} placeholder="Optional shipment note" className="w-full rounded-lg border border-slate-300 p-3 text-sm" />
          <div className="flex justify-end"><button type="button" onClick={onSubmitShipment} disabled={busy} className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Confirm wig was sent</button></div>
        </div>
      ) : null}

      {mode === 'staff' ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {appeal.return_status === 'In Transit' ? <button type="button" onClick={() => onStaffAction('receive')} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Confirm return received</button> : null}
          {appeal.return_status === 'Return Received' ? <button type="button" onClick={() => onStaffAction('start_repair')} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Start repair</button> : null}
          {appeal.return_status === 'Under Repair' ? <button type="button" onClick={() => onStaffAction('complete_repair')} disabled={busy} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Repair complete · send to release scheduling</button> : null}
        </div>
      ) : null}

      {appeal.return_status === 'Ready for Re-release' ? <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">Repair is complete. Staff can now use the normal Release Date Approval process again.</p> : null}
      {appeal.return_status === 'Completed' ? <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-900">The repaired/replacement wig has been released again.</p> : null}
    </section>
  );
}

export default function WigReleaseAftercarePanel({ mode = 'hospital', isActivePage = true }) {
  const { showToast } = useToast();
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [termsChecked, setTermsChecked] = useState(false);
  const [appealForm, setAppealForm] = useState({ reason: 'Damaged on Receipt', description: '', files: [] });
  const [decisionForm, setDecisionForm] = useState({ decision: 'approve', note: '' });
  const [returnForm, setReturnForm] = useState({ courier: '', trackingNumber: '', note: '' });

  useEffect(() => {
    if (!notice.text) return;
    showToast({
      type: notice.kind || 'info',
      title: notice.kind === 'success' ? 'Appeal workflow updated' : 'Action not completed',
      message: notice.text,
    });
    setNotice({ kind: '', text: '' });
  }, [notice, showToast]);

  const loadRecords = useCallback(async (keepSelectedId = null) => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({ kind: 'error', text: 'Supabase is not configured.' });
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const [receiptsRes, appealsRes, requestsRes, patientsRes] = await Promise.all([
        supabase.from('wig_release_receipts').select('*').order('released_at', { ascending: false }),
        supabase.from('wig_release_appeals').select('*').order('submitted_at', { ascending: false }),
        supabase.from('Wig_Requests').select('Req_ID,Request_Code,Patient_ID,Hospital_ID,Allocated_Wig_ID,Status'),
        supabase.from('Patients').select('Patient_ID,Patient_Code,User_ID'),
      ]);
      if (receiptsRes.error) throw receiptsRes.error;
      if (appealsRes.error) throw appealsRes.error;
      if (requestsRes.error) throw requestsRes.error;
      if (patientsRes.error) throw patientsRes.error;

      const userIds = (patientsRes.data || []).map((row) => Number(row.User_ID || 0)).filter(Boolean);
      let details = [];
      if (userIds.length) {
        const detailsRes = await supabase.from('user_details').select('user_id,first_name,middle_name,last_name,suffix').in('user_id', userIds);
        if (detailsRes.error) throw detailsRes.error;
        details = detailsRes.data || [];
      }
      const requestMap = new Map((requestsRes.data || []).map((row) => [Number(row.Req_ID), row]));
      const patientMap = new Map((patientsRes.data || []).map((row) => [Number(row.Patient_ID), row]));
      const detailMap = new Map(details.map((row) => [Number(row.user_id), row]));
      const appealMap = new Map((appealsRes.data || []).map((row) => [Number(row.receipt_id), row]));
      const nextRecords = (receiptsRes.data || []).map((receipt) => {
        const request = requestMap.get(Number(receipt.req_id)) || {};
        const patient = patientMap.get(Number(request.Patient_ID)) || {};
        const detail = detailMap.get(Number(patient.User_ID)) || {};
        return {
          ...receipt,
          request,
          appeal: appealMap.get(Number(receipt.receipt_id)) || null,
          requestCode: request.Request_Code || `Request #${receipt.req_id}`,
          patientName: [detail.first_name, detail.middle_name, detail.last_name, detail.suffix].filter(Boolean).join(' ') || patient.Patient_Code || 'Patient',
          patientCode: patient.Patient_Code || 'N/A',
        };
      });
      setRecords(nextRecords);
      const selectableRecords = mode === 'staff' ? nextRecords.filter((row) => row.appeal) : nextRecords;
      setSelectedId((currentId) => {
        const desired = keepSelectedId || currentId;
        return selectableRecords.some((row) => row.receipt_id === desired)
          ? desired
          : selectableRecords[0]?.receipt_id || null;
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load release aftercare records. Apply the wig release terms and appeals migration first.' });
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (isActivePage) void loadRecords();
  }, [isActivePage, loadRecords]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    let list = records;
    if (mode === 'staff') list = records.filter((row) => row.appeal);
    if (!query) return list;
    return list.filter((row) => [row.requestCode, row.patientName, row.patientCode, row.appeal?.reason, row.appeal?.status]
      .join(' ').toLowerCase().includes(query));
  }, [mode, records, search]);
  const staffSummary = useMemo(() => {
    const appeals = records.filter((row) => row.appeal).map((row) => row.appeal);
    return {
      total: appeals.length,
      pending: appeals.filter((appeal) => appeal.status === 'Pending Staff Review').length,
      activeReturns: appeals.filter((appeal) => appeal.return_status && appeal.return_status !== 'Completed').length,
    };
  }, [records]);
  const selected = records.find((row) => row.receipt_id === selectedId) || null;
  const now = Date.now();
  const appealOpen = selected && now <= new Date(selected.appeal_deadline).getTime();
  const daysRemaining = selected ? Math.max(0, Math.ceil((new Date(selected.appeal_deadline).getTime() - now) / 86400000)) : 0;

  const confirmReceipt = async () => {
    if (!selected || !termsChecked || busyId) return;
    setBusyId(selected.receipt_id);
    try {
      const { error } = await supabase.rpc('hrep_confirm_wig_receipt_terms', { p_req_id: selected.req_id, p_terms_version: selected.terms_version || TERMS_VERSION });
      if (error) throw error;
      setTermsChecked(false);
      setNotice({ kind: 'success', text: 'Receipt confirmed and terms accepted. The acceptance record has been saved.' });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to confirm receipt.' });
    } finally {
      setBusyId(null);
    }
  };

  const submitAppeal = async () => {
    if (!selected || busyId) return;
    if (appealForm.description.trim().length < 20) {
      setNotice({ kind: 'error', text: 'Describe the issue using at least 20 characters.' });
      return;
    }
    setBusyId(selected.receipt_id);
    const uploaded = [];
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user?.id) throw authError || new Error('Your session could not be verified.');
      for (const file of appealForm.files.slice(0, 4)) {
        const path = `${authData.user.id}/wig-appeals/${selected.req_id}/${Date.now()}-${safeFileName(file.name)}`;
        const { error } = await supabase.storage.from(PATIENT_ASSETS_BUCKET).upload(path, file, { cacheControl: '3600', upsert: false });
        if (error) throw error;
        uploaded.push(path);
      }
      const { error } = await supabase.rpc('hrep_submit_wig_release_appeal', {
        p_req_id: selected.req_id,
        p_reason: appealForm.reason,
        p_description: appealForm.description.trim(),
        p_evidence_paths: uploaded,
      });
      if (error) throw error;
      setAppealForm({ reason: 'Damaged on Receipt', description: '', files: [] });
      setNotice({ kind: 'success', text: 'Appeal submitted to Staff for review.' });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      if (uploaded.length) await supabase.storage.from(PATIENT_ASSETS_BUCKET).remove(uploaded);
      setNotice({ kind: 'error', text: error.message || 'Unable to submit the appeal.' });
    } finally {
      setBusyId(null);
    }
  };

  const reviewAppeal = async () => {
    if (!selected?.appeal || busyId) return;
    if (decisionForm.note.trim().length < 10) {
      setNotice({ kind: 'error', text: 'Add a clear decision note using at least 10 characters.' });
      return;
    }
    setBusyId(selected.receipt_id);
    try {
      const { error } = await supabase.rpc('staff_review_wig_release_appeal', {
        p_appeal_id: selected.appeal.appeal_id,
        p_decision: decisionForm.decision,
        p_decision_note: decisionForm.note.trim(),
      });
      if (error) throw error;
      setDecisionForm({ decision: 'approve', note: '' });
      setNotice({ kind: 'success', text: 'Appeal decision saved. The H-Representative has been notified.' });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to review the appeal.' });
    } finally {
      setBusyId(null);
    }
  };

  const submitReturnShipment = async () => {
    if (!selected?.appeal || busyId) return;
    if (returnForm.courier.trim().length < 2 || returnForm.trackingNumber.trim().length < 3) {
      setNotice({ kind: 'error', text: 'Enter the courier and tracking/reference number.' });
      return;
    }
    setBusyId(selected.receipt_id);
    try {
      const { error } = await supabase.rpc('hrep_submit_wig_return', {
        p_appeal_id: selected.appeal.appeal_id,
        p_courier: returnForm.courier.trim(),
        p_tracking_number: returnForm.trackingNumber.trim(),
        p_note: returnForm.note.trim() || null,
      });
      if (error) throw error;
      setReturnForm({ courier: '', trackingNumber: '', note: '' });
      setNotice({ kind: 'success', text: 'Return shipment recorded. Staff can now confirm when the wig arrives.' });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to record the return shipment.' });
    } finally {
      setBusyId(null);
    }
  };

  const updateReturnWorkflow = async (action) => {
    if (!selected?.appeal || busyId) return;
    setBusyId(selected.receipt_id);
    try {
      const { error } = await supabase.rpc('staff_update_wig_return', {
        p_appeal_id: selected.appeal.appeal_id,
        p_action: action,
        p_note: decisionForm.note.trim() || null,
      });
      if (error) throw error;
      setDecisionForm((previous) => ({ ...previous, note: '' }));
      setNotice({
        kind: 'success',
        text: action === 'complete_repair'
          ? 'Repair completed. The request is ready for Staff to schedule a new release date.'
          : 'Return workflow updated successfully.',
      });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to update the return workflow.' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">{mode === 'staff' ? 'Wig Appeals Review' : 'Receipt & 7-Day Appeals'}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{mode === 'staff' ? 'Review submitted issues and approve a replacement or reject with a clear explanation.' : 'Confirm receipt, accept the release terms, and report eligible issues within seven days of staff release.'}</p>
          </div>
          <div className="relative w-full sm:w-80"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search request or patient" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm" /></div>
        </div>
        {mode === 'staff' ? (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"><p className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Total appeals</p><p className="mt-0.5 text-lg font-bold text-slate-900">{staffSummary.total}</p></div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2"><p className="text-[9px] font-bold uppercase tracking-wide text-amber-700">Awaiting review</p><p className="mt-0.5 text-lg font-bold text-amber-950">{staffSummary.pending}</p></div>
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2"><p className="text-[9px] font-bold uppercase tracking-wide text-indigo-700">Return / repair</p><p className="mt-0.5 text-lg font-bold text-indigo-950">{staffSummary.activeReturns}</p></div>
          </div>
        ) : null}
      </header>
      {loading ? <div className="flex items-center gap-2 p-6 text-sm text-slate-600"><Loader2 size={16} className="animate-spin" /> Loading release records...</div> : filtered.length === 0 ? <div className="p-6 text-sm text-slate-600">{mode === 'staff' ? 'No wig appeals have been submitted.' : 'No released wigs are available for receipt confirmation.'}</div> : (
        <div className="grid min-h-[430px] lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="border-r border-slate-200 bg-slate-50 p-3">
            <div className="space-y-2">{filtered.map((row) => <button key={row.receipt_id} type="button" onClick={() => { setSelectedId(row.receipt_id); setTermsChecked(false); }} className={`w-full rounded-lg border p-3 text-left ${selectedId === row.receipt_id ? 'border-slate-900 bg-white shadow-sm' : 'border-slate-200 bg-white hover:border-slate-400'}`}><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-bold text-slate-900">{row.requestCode}</p><p className="text-xs text-slate-600">{row.patientName}</p></div>{row.appeal ? <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${statusClasses(row.appeal.status)}`}>{row.appeal.status}</span> : row.terms_accepted_at ? <CheckCircle2 size={17} className="text-emerald-600" /> : <Clock3 size={17} className="text-amber-600" />}</div><p className="mt-2 text-[11px] text-slate-500">Released {formatDateTime(row.released_at)}</p></button>)}</div>
          </div>
          {selected && <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{selected.requestCode}</p><h3 className="text-xl font-bold text-slate-900">{selected.patientName}</h3><p className="text-xs text-slate-500">{selected.patientCode}</p></div><div className={`rounded-lg border px-3 py-2 text-right ${appealOpen ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-slate-100 text-slate-700'}`}><p className="text-xs font-bold">{appealOpen ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining` : 'Appeal period ended'}</p><p className="text-[11px]">Deadline: {formatDateTime(selected.appeal_deadline)}</p></div></div>
            {mode === 'hospital' && !selected.terms_accepted_at && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4"><div className="flex gap-2"><ShieldCheck size={20} className="shrink-0 text-amber-700" /><div><h4 className="font-bold text-amber-950">Confirm receipt and accept terms</h4><p className="mt-1 text-sm leading-6 text-amber-950">{selected.terms_snapshot}</p><p className="mt-2 text-xs font-semibold text-amber-800">Terms version {selected.terms_version} · Appeal deadline is based on Staff’s release time.</p></div></div><label className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-white p-3 text-sm text-slate-800"><input type="checkbox" checked={termsChecked} onChange={(event) => setTermsChecked(event.target.checked)} className="mt-0.5" /><span>I confirm the wig was received for this patient, I reviewed these terms, and I accept the seven-day appeal policy.</span></label><div className="mt-3 flex justify-end"><button type="button" onClick={confirmReceipt} disabled={!termsChecked || busyId === selected.receipt_id} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busyId === selected.receipt_id ? 'Saving...' : 'Confirm receipt & accept'}</button></div></div>}
            {selected.terms_accepted_at && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"><p className="font-bold">Receipt confirmed</p><p className="text-xs">Terms {selected.terms_version} accepted {formatDateTime(selected.terms_accepted_at)}</p></div>}
            {selected.appeal ? <div className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-2"><div><p className="text-xs font-semibold uppercase text-slate-500">Submitted appeal</p><h4 className="font-bold text-slate-900">{selected.appeal.reason}</h4></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClasses(selected.appeal.status)}`}>{selected.appeal.status}</span></div><p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{selected.appeal.description}</p><div className="mt-3 flex flex-wrap gap-2">{(selected.appeal.evidence_paths || []).map((path) => <a key={path} href={getPublicUrl(path)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"><FileImage size={14} /> View evidence</a>)}</div>{selected.appeal.decision_note && <div className="mt-4 rounded-lg bg-slate-100 p-3 text-sm"><p className="font-bold text-slate-900">Staff decision</p><p className="mt-1 text-slate-700">{selected.appeal.decision_note}</p></div>}{mode === 'staff' && selected.appeal.status === 'Pending Staff Review' && <div className="mt-4 space-y-3 border-t border-slate-200 pt-4"><div className="grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => setDecisionForm((prev) => ({ ...prev, decision: 'approve' }))} className={`rounded-lg border p-3 text-left text-sm font-bold ${decisionForm.decision === 'approve' ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-slate-200'}`}>Approve return & repair</button><button type="button" onClick={() => setDecisionForm((prev) => ({ ...prev, decision: 'reject' }))} className={`rounded-lg border p-3 text-left text-sm font-bold ${decisionForm.decision === 'reject' ? 'border-red-600 bg-red-50 text-red-900' : 'border-slate-200'}`}>Reject appeal</button></div><textarea value={decisionForm.note} onChange={(event) => setDecisionForm((prev) => ({ ...prev, note: event.target.value }))} rows={3} placeholder="Explain the decision and next steps..." className="w-full rounded-lg border border-slate-300 p-3 text-sm" /><div className="flex justify-end"><button type="button" onClick={reviewAppeal} disabled={busyId === selected.receipt_id} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Save decision</button></div></div>}</div> : mode === 'hospital' && selected.terms_accepted_at && appealOpen ? <div className="rounded-xl border border-slate-200 p-4"><h4 className="font-bold text-slate-900">Report a problem</h4><p className="mt-1 text-xs text-slate-500">One appeal may be submitted for this release. Add clear evidence for damage claims.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Reason<select value={appealForm.reason} onChange={(event) => setAppealForm((prev) => ({ ...prev, reason: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm">{APPEAL_REASONS.map((reason) => <option key={reason}>{reason}</option>)}</select></label><label className="text-xs font-semibold text-slate-600">Damage photos or evidence (up to 4)<input type="file" accept="image/*,.pdf" multiple onChange={(event) => setAppealForm((prev) => ({ ...prev, files: Array.from(event.target.files || []).slice(0, 4) }))} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-2 text-xs" /></label></div><textarea value={appealForm.description} onChange={(event) => setAppealForm((prev) => ({ ...prev, description: event.target.value }))} rows={4} placeholder="Describe the damage, incorrect wig, or fit problem and when it was discovered..." className="mt-3 w-full rounded-lg border border-slate-300 p-3 text-sm" /><div className="mt-3 flex justify-end"><button type="button" onClick={submitAppeal} disabled={busyId === selected.receipt_id} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Submit appeal to Staff</button></div></div> : mode === 'hospital' && !appealOpen ? <div className="flex gap-2 rounded-lg border border-slate-200 bg-slate-100 p-3 text-sm text-slate-700"><AlertTriangle size={18} className="shrink-0" /> The seven-day appeal period has ended. Contact Staff for exceptional assistance.</div> : null}
            <ReturnWorkflowPanel mode={mode} appeal={selected.appeal} busy={busyId === selected.receipt_id} returnForm={returnForm} setReturnForm={setReturnForm} onSubmitShipment={submitReturnShipment} onStaffAction={updateReturnWorkflow} />
          </div>}
        </div>
      )}
    </section>
  );
}
