import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Save, UploadCloud } from 'lucide-react';
import { useToast } from '../../../context/ToastContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const BUCKET = 'hospital-application-documents';

function safeFileName(value) {
  return String(value || 'requirements.pdf').replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '').slice(-120);
}

export default function PatientApplicationSettingsPage({ userProfile, isActivePage = true }) {
  const { showToast } = useToast();
  const fileInputRef = useRef(null);
  const [settings, setSettings] = useState(null);
  const [conditions, setConditions] = useState('');
  const [requirementsText, setRequirementsText] = useState('');
  const [applicationsOpen, setApplicationsOpen] = useState(false);
  const [pdfPath, setPdfPath] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setLoading(true);
    const { data, error } = await supabase.rpc('get_my_hospital_patient_application_settings');
    if (error) {
      showToast({ type: 'error', title: 'Application setup error', message: error.message });
    } else {
      const next = data || {};
      setSettings(next);
      setConditions(String(next.conditions || ''));
      setRequirementsText((Array.isArray(next.requirements) ? next.requirements : []).join('\n'));
      setApplicationsOpen(Boolean(next.applications_open));
      setPdfPath(String(next.requirements_pdf_path || ''));
    }
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    if (isActivePage) void load();
  }, [isActivePage, load]);

  const requirements = useMemo(() => requirementsText.split('\n').map((item) => item.trim()).filter(Boolean), [requirementsText]);
  const pdfUrl = pdfPath ? supabase.storage.from(BUCKET).getPublicUrl(pdfPath).data?.publicUrl || '' : '';

  const save = async () => {
    if (!settings?.hospital_id) return;
    let nextPdfPath = pdfPath;
    let uploadedPath = '';
    try {
      setSaving(true);
      if (pdfFile) {
        const isPdf = String(pdfFile.type || '').toLowerCase() === 'application/pdf' || pdfFile.name.toLowerCase().endsWith('.pdf');
        if (!isPdf) throw new Error('Hospital requirements must be uploaded as a PDF.');
        if (pdfFile.size > 15 * 1024 * 1024) throw new Error('Hospital requirements PDF must not exceed 15 MB.');
        const authSession = await supabase.auth.getUser();
        const authId = String(userProfile?.auth_user_id || authSession.data?.user?.id || '').trim();
        if (!authId) throw new Error('Your session is missing its authentication ID. Sign in again.');
        uploadedPath = `${settings.hospital_id}/${authId}/${Date.now()}-${safeFileName(pdfFile.name)}`;
        const upload = await supabase.storage.from(BUCKET).upload(uploadedPath, pdfFile, {
          contentType: 'application/pdf', cacheControl: '3600', upsert: false,
        });
        if (upload.error) throw upload.error;
        nextPdfPath = uploadedPath;
      }

      const result = await supabase.rpc('update_my_hospital_patient_application_settings', {
        p_applications_open: applicationsOpen,
        p_conditions: conditions,
        p_requirements: requirements,
        p_requirements_pdf_path: nextPdfPath || null,
      });
      if (result.error) throw result.error;
      if (uploadedPath && pdfPath && pdfPath !== uploadedPath) {
        void supabase.storage.from(BUCKET).remove([pdfPath]);
      }
      setPdfFile(null);
      setPdfPath(nextPdfPath);
      showToast({ type: 'success', title: 'Patient application setup saved', message: applicationsOpen ? 'Your hospital is visible and accepting applications.' : 'Your changes were saved. Applications remain closed.' });
      await load();
    } catch (error) {
      if (uploadedPath) void supabase.storage.from(BUCKET).remove([uploadedPath]);
      showToast({ type: 'error', title: 'Unable to save setup', message: error.message || 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 py-10 text-sm text-slate-600"><Loader2 size={18} className="animate-spin" /> Loading hospital application setup...</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="role-page-title text-3xl font-bold text-slate-900">Patient Application Setup</h1>
        <p className="mt-1 text-sm text-slate-600">Publish your hospital’s conditions, checklist, and PDF. Donivra’s overall terms remain managed by Admin.</p>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="text-xs font-bold uppercase tracking-[.14em] text-slate-500">Partner hospital</p><h2 className="mt-1 text-xl font-bold text-slate-900">{settings?.hospital_name || 'Assigned hospital'}</h2></div>
          <label className="inline-flex items-center gap-3 rounded-xl bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700"><input type="checkbox" checked={applicationsOpen} onChange={(event) => setApplicationsOpen(event.target.checked)} className="h-4 w-4" /> Accept public applications</label>
        </div>

        <div className="mt-6 space-y-6">
          <label className="block"><span className="text-sm font-bold text-slate-800">Hospital conditions *</span><span className="mt-1 block text-xs text-slate-500">Explain eligibility, including whether the applicant must receive treatment at your hospital.</span><textarea value={conditions} onChange={(event) => setConditions(event.target.value)} rows={7} placeholder="Example: Applicant must currently receive treatment at this hospital..." className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-sm leading-6 outline-none focus:border-[#7a1020] focus:ring-2 focus:ring-[#7a1020]/10" /></label>

          <label className="block"><span className="text-sm font-bold text-slate-800">Required items *</span><span className="mt-1 block text-xs text-slate-500">Enter one requirement per line. This becomes the checklist applicants see.</span><textarea value={requirementsText} onChange={(event) => setRequirementsText(event.target.value)} rows={7} placeholder={'Proof of current treatment\nMedical certificate\nValid identification'} className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 text-sm leading-6 outline-none focus:border-[#7a1020] focus:ring-2 focus:ring-[#7a1020]/10" /></label>

          <div><p className="text-sm font-bold text-slate-800">Detailed requirements PDF *</p><p className="mt-1 text-xs text-slate-500">Upload one PDF, maximum 15 MB. Replacing it removes the previous file after saving.</p><button type="button" onClick={() => fileInputRef.current?.click()} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"><UploadCloud size={17} /> {pdfFile ? 'Choose another PDF' : pdfPath ? 'Replace PDF' : 'Upload PDF'}</button><input ref={fileInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(event) => setPdfFile(event.target.files?.[0] || null)} />{pdfFile && <p className="mt-2 text-sm font-semibold text-emerald-700"><CheckCircle2 size={15} className="mr-1 inline" /> {pdfFile.name}</p>}{!pdfFile && pdfUrl && <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-3 inline-flex items-center gap-1 text-sm font-bold text-[#7a1020]"><FileText size={15} /> View current PDF</a>}</div>
        </div>

        <div className="mt-7 flex justify-end border-t border-slate-200 pt-5"><button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-[#650817] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {saving ? 'Saving...' : 'Save application setup'}</button></div>
      </section>
    </div>
  );
}
