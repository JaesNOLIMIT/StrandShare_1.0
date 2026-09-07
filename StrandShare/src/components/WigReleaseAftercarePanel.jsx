import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, FileImage, Loader2, Search, ShieldCheck, X } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import { useToast } from '../context/ToastContext';

const TERMS_VERSION = '2026-09-02-v1';
const PATIENT_ASSETS_BUCKET = 'patient_assets';
const APPEAL_REASONS = ['Damaged on Receipt', 'Wrong Wig', 'Poor Fit', 'Other'];
const REQUESTED_RESOLUTIONS = ['Repair or Replace', 'Return and Close'];

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

function concernStatusLabel(status) {
  if (status === 'Approved for Replacement') return 'Problem confirmed';
  if (status === 'Rejected') return 'Problem not confirmed';
  if (status === 'Pending Staff Review') return 'Awaiting Staff review';
  return status;
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

function AppealEvidenceGallery({ paths = [] }) {
  if (!paths.length) {
    return <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">No photos were attached to this older concern record.</p>;
  }
  return (
    <div className="mt-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Attached photos</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {paths.map((path, index) => (
          <a key={path} href={getPublicUrl(path)} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
            <img src={getPublicUrl(path)} alt={`Concern evidence ${index + 1}`} className="h-28 w-full object-cover transition group-hover:scale-105" />
            <span className="flex items-center justify-center gap-1 p-2 text-[11px] font-bold text-slate-700"><FileImage size={13} /> View photo {index + 1}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function SelectedConcernPhotoPreviews({ files, onRemove }) {
  const [previews, setPreviews] = useState([]);

  useEffect(() => {
    const nextPreviews = files.map((file) => ({
      file,
      url: URL.createObjectURL(file),
    }));
    setPreviews(nextPreviews);
    return () => nextPreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [files]);

  if (!previews.length) return null;

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {previews.map((preview, index) => (
        <article key={`${preview.file.name}-${preview.file.lastModified}-${index}`} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <img src={preview.url} alt={`Selected concern evidence ${index + 1}`} className="h-28 w-full bg-slate-100 object-cover" />
          <div className="flex items-center justify-between gap-2 p-2">
            <div className="min-w-0">
              <p className="truncate text-[11px] font-semibold text-slate-700" title={preview.file.name}>{preview.file.name}</p>
              <p className="text-[10px] text-slate-400">{Math.max(1, Math.round(preview.file.size / 1024))} KB</p>
            </div>
            <button type="button" onClick={() => onRemove(index)} className="shrink-0 rounded-md border border-slate-200 p-1 text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700" aria-label={`Remove ${preview.file.name}`}>
              <X size={14} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function AppealSubmissionForm({ form, setForm, onSubmit, busy }) {
  const canSubmit = APPEAL_REASONS.includes(form.reason) && REQUESTED_RESOLUTIONS.includes(form.requestedResolution) && form.files.length > 0 && !busy;
  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <h4 className="font-bold text-slate-900">Report a wig problem</h4>
      <p className="mt-1 text-xs text-slate-500">Tell us the problem, choose what you need, and attach at least one photo.</p>

      <fieldset className="mt-4">
        <legend className="text-xs font-bold uppercase tracking-wide text-slate-600">1. Choose a reason</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {APPEAL_REASONS.map((reason) => (
            <button key={reason} type="button" onClick={() => setForm((previous) => ({ ...previous, reason }))} className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold ${form.reason === reason ? 'border-violet-600 bg-violet-50 text-violet-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'}`}>
              {reason}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-xs font-bold uppercase tracking-wide text-slate-600">2. What would you like us to do?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {REQUESTED_RESOLUTIONS.map((resolution) => (
            <button key={resolution} type="button" onClick={() => setForm((previous) => ({ ...previous, requestedResolution: resolution }))} className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold ${form.requestedResolution === resolution ? 'border-indigo-600 bg-indigo-50 text-indigo-900' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'}`}>
              {resolution}
              <span className="mt-0.5 block text-xs font-normal text-slate-500">{resolution === 'Repair or Replace' ? 'Return the wig so Staff can repair or replace it.' : 'Return the wig and permanently close this request.'}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-4 block text-xs font-bold uppercase tracking-wide text-slate-600">
        3. Attach wig photos <span className="text-red-600">(required)</span>
        <input type="file" accept="image/*" multiple required onChange={(event) => setForm((previous) => ({ ...previous, files: Array.from(event.target.files || []).filter((file) => file.type.startsWith('image/')).slice(0, 4) }))} className="mt-2 block w-full rounded-lg border border-slate-300 bg-white p-2 text-xs" />
      </label>
      <p className="mt-1 text-xs text-slate-500">Attach 1 to 4 clear photos. {form.files.length ? `${form.files.length} photo${form.files.length === 1 ? '' : 's'} selected.` : 'No photo selected.'}</p>
      <SelectedConcernPhotoPreviews
        files={form.files}
        onRemove={(indexToRemove) => setForm((previous) => ({
          ...previous,
          files: previous.files.filter((_, index) => index !== indexToRemove),
        }))}
      />

      <label className="mt-4 block text-xs font-bold uppercase tracking-wide text-slate-600">
        4. Additional details <span className="font-normal normal-case text-slate-400">(optional)</span>
        <textarea value={form.description} onChange={(event) => setForm((previous) => ({ ...previous, description: event.target.value }))} rows={3} maxLength={1000} placeholder="Add a short note if Staff needs more context..." className="mt-2 w-full rounded-lg border border-slate-300 p-3 text-sm font-normal normal-case tracking-normal" />
      </label>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-200 pt-3">
        <p className="text-xs text-slate-500">Staff will confirm the problem first. Return instructions appear only after confirmation.</p>
        <button type="button" onClick={onSubmit} disabled={!canSubmit} className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40">Submit concern</button>
      </div>
    </div>
  );
}

function SubmittedAppealCard({ mode, appeal, decisionForm, setDecisionForm, onReview, busy }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reported problem</p>
        <h4 className="mt-0.5 font-bold text-slate-900">{appeal.reason}</h4>
        <p className="mt-1 text-xs text-slate-600"><strong>Requested outcome:</strong> {appeal.requested_resolution || 'Repair or Replace'}</p>
      </div>

      {appeal.description ? <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{appeal.description}</p> : null}
      <AppealEvidenceGallery paths={appeal.evidence_paths || []} />

      {appeal.status === 'Pending Staff Review' ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">Waiting for Staff to confirm the problem. Return instructions will appear only after confirmation.</p> : null}
      {appeal.decision_note ? <div className="mt-3 border-t border-slate-200 pt-3 text-sm"><p className="text-xs font-bold uppercase tracking-wide text-slate-500">Staff response</p><p className="mt-1 text-slate-700">{appeal.decision_note}</p></div> : null}

      {mode === 'staff' && appeal.status === 'Pending Staff Review' ? (
        <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setDecisionForm((previous) => ({ ...previous, decision: 'approve' }))} className={`rounded-lg border px-3 py-2 text-sm font-bold ${decisionForm.decision === 'approve' ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-slate-200 text-slate-700'}`}>Confirm problem &amp; allow return</button>
            <button type="button" onClick={() => setDecisionForm((previous) => ({ ...previous, decision: 'reject' }))} className={`rounded-lg border px-3 py-2 text-sm font-bold ${decisionForm.decision === 'reject' ? 'border-red-600 bg-red-50 text-red-900' : 'border-slate-200 text-slate-700'}`}>Problem not confirmed</button>
          </div>
          <textarea value={decisionForm.note} onChange={(event) => setDecisionForm((previous) => ({ ...previous, note: event.target.value }))} rows={2} placeholder="Short response and next step..." className="w-full rounded-lg border border-slate-300 p-3 text-sm" />
          <div className="flex justify-end"><button type="button" onClick={onReview} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Save decision</button></div>
        </div>
      ) : null}
    </section>
  );
}

function ReturnWorkflowPanel({ mode, appeal, busy, returnForm, setReturnForm, onSubmitShipment, onStaffAction }) {
  if (!appeal?.return_status) return null;
  const destination = appeal.return_destination_snapshot || {};
  const destinationAddress = formatDestination(destination);
  const latitude = Number(destination.Latitude);
  const longitude = Number(destination.Longitude);
  const hasMap = Number.isFinite(latitude) && Number.isFinite(longitude);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{appeal.requested_resolution === 'Return and Close' ? 'Return and close' : 'Return, repair and re-release'}</p>
          <h4 className="mt-0.5 font-bold text-slate-900">{appeal.return_status}</h4>
        </div>
        {appeal.return_tracking_number ? <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{appeal.return_courier}: {appeal.return_tracking_number}</span> : null}
      </div>

      {destinationAddress ? (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
          <p className="font-bold text-slate-900">Send the wig here</p>
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

      {appeal.return_status === 'Ready for Re-release' ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">Repair complete. A new release date must now be scheduled.</p> : null}
      {appeal.return_status === 'Return Completed' ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">Returned wig received. This request is now closed with no repair or re-release.</p> : null}
      {appeal.return_status === 'Completed' ? <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">Re-release complete. The repaired or replacement wig was handed over.</p> : null}
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
  const [appealForm, setAppealForm] = useState({ reason: '', requestedResolution: '', description: '', files: [] });
  const [decisionForm, setDecisionForm] = useState({ decision: 'approve', note: '' });
  const [returnForm, setReturnForm] = useState({ courier: '', trackingNumber: '', note: '' });

  useEffect(() => {
    if (!notice.text) return;
    showToast({
      type: notice.kind || 'info',
      title: notice.kind === 'success' ? 'After-release concern updated' : 'Action not completed',
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
      setNotice({ kind: 'error', text: error.message || 'Unable to load after-release records. Apply the latest wig concern migrations first.' });
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
      activeReturns: appeals.filter((appeal) => appeal.return_status && !['Completed', 'Return Completed'].includes(appeal.return_status)).length,
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
    if (!APPEAL_REASONS.includes(appealForm.reason)) {
      setNotice({ kind: 'error', text: 'Choose the wig problem.' });
      return;
    }
    if (!REQUESTED_RESOLUTIONS.includes(appealForm.requestedResolution)) {
      setNotice({ kind: 'error', text: 'Choose Repair or Replace, or Return and Close.' });
      return;
    }
    if (appealForm.files.length < 1) {
      setNotice({ kind: 'error', text: 'Attach at least one photo of the wig.' });
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
        p_requested_resolution: appealForm.requestedResolution,
        p_description: appealForm.description.trim(),
        p_evidence_paths: uploaded,
      });
      if (error) throw error;
      setAppealForm({ reason: '', requestedResolution: '', description: '', files: [] });
      setNotice({ kind: 'success', text: 'Concern submitted. Wait for Staff to confirm the problem; return instructions will appear after confirmation.' });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      if (uploaded.length) await supabase.storage.from(PATIENT_ASSETS_BUCKET).remove(uploaded);
      setNotice({ kind: 'error', text: error.message || 'Unable to submit the concern.' });
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
      setNotice({ kind: 'success', text: 'Concern decision saved. The H-Representative has been notified.' });
      await loadRecords(selected.receipt_id);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to review the concern.' });
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
            <h2 className="text-base font-bold text-slate-900">{mode === 'staff' ? 'After-release Concerns' : 'Receipt & 7-Day Concerns'}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{mode === 'staff' ? 'Review submitted issues and approve a replacement or reject with a clear explanation.' : 'Confirm receipt, accept the release terms, and report eligible issues within seven days of staff release.'}</p>
          </div>
          <div className="relative w-full sm:w-80"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search request or patient" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm" /></div>
        </div>
        {mode === 'staff' ? <p className="mt-3 text-xs text-slate-500"><strong className="text-slate-800">{staffSummary.total}</strong> total · <strong className="text-amber-700">{staffSummary.pending}</strong> awaiting review · <strong className="text-indigo-700">{staffSummary.activeReturns}</strong> in return or repair</p> : null}
      </header>
      {loading ? <div className="flex items-center gap-2 p-6 text-sm text-slate-600"><Loader2 size={16} className="animate-spin" /> Loading release records...</div> : filtered.length === 0 ? <div className="p-6 text-sm text-slate-600">{mode === 'staff' ? 'No after-release concerns have been submitted.' : 'No released wigs are available for receipt confirmation.'}</div> : (
        <div className="grid min-h-[360px] lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="border-r border-slate-200 bg-slate-50 p-3">
            <div className="space-y-2">{filtered.map((row) => <button key={row.receipt_id} type="button" onClick={() => { setSelectedId(row.receipt_id); setTermsChecked(false); }} className={`w-full rounded-lg border p-3 text-left ${selectedId === row.receipt_id ? 'border-slate-900 bg-white shadow-sm' : 'border-slate-200 bg-white hover:border-slate-400'}`}><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-bold text-slate-900">{row.requestCode}</p><p className="text-xs text-slate-600">{row.patientName}</p></div>{row.appeal ? <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${statusClasses(row.appeal.status)}`}>{concernStatusLabel(row.appeal.status)}</span> : row.terms_accepted_at ? <CheckCircle2 size={17} className="text-emerald-600" /> : <Clock3 size={17} className="text-amber-600" />}</div><p className="mt-2 text-[11px] text-slate-500">Released {formatDateTime(row.released_at)}</p></button>)}</div>
          </div>
          {selected && <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{selected.requestCode}</p>{selected.appeal ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusClasses(selected.appeal.status)}`}>{concernStatusLabel(selected.appeal.status)}</span> : null}</div><h3 className="mt-0.5 text-xl font-bold text-slate-900">{selected.patientName}</h3><p className="text-xs text-slate-500">{selected.patientCode}</p></div>{!selected.appeal ? <div className={`rounded-lg px-3 py-2 text-right ${appealOpen ? 'bg-emerald-50 text-emerald-900' : 'bg-slate-100 text-slate-700'}`}><p className="text-xs font-bold">{appealOpen ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining` : 'Concern period ended'}</p><p className="text-[11px]">{formatDateTime(selected.appeal_deadline)}</p></div> : null}</div>
            {mode === 'hospital' && !selected.terms_accepted_at && <div className="rounded-xl border border-amber-300 bg-amber-50 p-4"><div className="flex gap-2"><ShieldCheck size={20} className="shrink-0 text-amber-700" /><div><h4 className="font-bold text-amber-950">Confirm receipt and accept terms</h4><p className="mt-1 text-sm leading-6 text-amber-950">{selected.terms_snapshot}</p><p className="mt-2 text-xs font-semibold text-amber-800">Terms version {selected.terms_version} · The seven-day concern period is based on Staff's release time.</p></div></div><label className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-white p-3 text-sm text-slate-800"><input type="checkbox" checked={termsChecked} onChange={(event) => setTermsChecked(event.target.checked)} className="mt-0.5" /><span>I confirm the wig was received for this patient, I reviewed these terms, and I accept the seven-day concern policy.</span></label><div className="mt-4 flex justify-end"><button type="button" onClick={confirmReceipt} disabled={!termsChecked || busyId === selected.receipt_id} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busyId === selected.receipt_id ? 'Saving...' : 'Confirm receipt & accept'}</button></div></div>}
            {selected.terms_accepted_at && <p className="flex items-center gap-2 text-xs text-emerald-800"><CheckCircle2 size={15} /> Receipt confirmed {formatDateTime(selected.terms_accepted_at)}</p>}
            {selected.appeal ? <SubmittedAppealCard mode={mode} appeal={selected.appeal} decisionForm={decisionForm} setDecisionForm={setDecisionForm} onReview={reviewAppeal} busy={busyId === selected.receipt_id} /> : mode === 'hospital' && selected.terms_accepted_at && appealOpen ? <AppealSubmissionForm form={appealForm} setForm={setAppealForm} onSubmit={submitAppeal} busy={busyId === selected.receipt_id} /> : mode === 'hospital' && !appealOpen ? <div className="flex gap-2 rounded-lg border border-slate-200 bg-slate-100 p-3 text-sm text-slate-700"><AlertTriangle size={18} className="shrink-0" /> The seven-day concern period has ended. Contact Staff for exceptional assistance.</div> : null}
            <ReturnWorkflowPanel mode={mode} appeal={selected.appeal} busy={busyId === selected.receipt_id} returnForm={returnForm} setReturnForm={setReturnForm} onSubmitShipment={submitReturnShipment} onStaffAction={updateReturnWorkflow} />
          </div>}
        </div>
      )}
    </section>
  );
}
