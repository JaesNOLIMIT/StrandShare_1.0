import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CheckCircle2, ExternalLink, Loader2, MapPin, ShieldCheck } from 'lucide-react';
import useActiveLegalDocument from '../../hooks/useActiveLegalDocument';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import { triggerSmtpNow } from '../../lib/smtpTriggerClient';

const WALK_IN_TERMS_DOCUMENT_TYPE = 'walk_in_donation_terms';
const PRIVACY_NOTICE_DOCUMENT_TYPE = 'privacy_notice';

function formatSchedule(value) {
  if (!value) return 'To be announced';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}

function calculateAgeFromBirthdate(value, now = new Date()) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, birthYear, birthMonth, birthDay] = match.map(Number);
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((parts, part) => ({ ...parts, [part.type]: Number(part.value) }), {});
  let age = todayParts.year - birthYear;
  if (todayParts.month < birthMonth || (todayParts.month === birthMonth && todayParts.day < birthDay)) age -= 1;
  return Number.isInteger(age) && age >= 0 && age <= 120 ? age : null;
}

export default function EventWalkInRegistrationPage({ token }) {
  const walkInTerms = useActiveLegalDocument(WALK_IN_TERMS_DOCUMENT_TYPE);
  const privacyNotice = useActiveLegalDocument(PRIVACY_NOTICE_DOCUMENT_TYPE);
  const [intake, setIntake] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ email: '', fullName: '', birthdate: '', guardianName: '', guardianRelationship: '', guardianEmail: '', terms: false, privacy: false });
  const calculatedAge = useMemo(() => calculateAgeFromBirthdate(form.birthdate), [form.birthdate]);
  const isMinor = calculatedAge != null && calculatedAge < 18;

  useEffect(() => {
    let active = true;
    async function load() {
      if (!isSupabaseConfigured || !supabase || !token) {
        setError('This walk-in registration link is invalid.'); setLoading(false); return;
      }
      const response = await supabase.rpc('get_public_event_walk_in_intake', { p_public_token: token });
      if (!active) return;
      if (response.error) setError(response.error.message || 'Unable to open walk-in registration.');
      else setIntake(response.data);
      setLoading(false);
    }
    void load(); return () => { active = false; };
  }, [token]);

  const termsReady = Boolean(walkInTerms.document?.legal_document_id && walkInTerms.previewUrl && !walkInTerms.error);
  const privacyReady = Boolean(privacyNotice.document?.legal_document_id && privacyNotice.previewUrl && !privacyNotice.error);
  const canContinue = useMemo(() => (
    form.terms && form.privacy && termsReady && privacyReady
  ), [form.privacy, form.terms, privacyReady, termsReady]);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event) {
    event.preventDefault(); setError('');
    if (!form.email.trim() || !form.birthdate) { setError('Email and birthdate are required.'); return; }
    if (calculatedAge == null || calculatedAge < 1) { setError('Enter a valid birthdate for a donor between 1 and 120 years old.'); return; }
    if (isMinor && (!form.guardianName.trim() || !form.guardianRelationship.trim() || !form.guardianEmail.trim())) {
      setError('Guardian name, relationship, and email are required for donors under 18.'); return;
    }
    setSubmitting(true);
    const response = await supabase.rpc('submit_event_walk_in_registration', {
      p_public_token: token, p_email: form.email, p_age: calculatedAge,
      p_full_name: form.fullName || null, p_birthdate: form.birthdate || null,
      p_guardian_name: isMinor ? form.guardianName : null,
      p_guardian_relationship: isMinor ? form.guardianRelationship : null,
      p_guardian_email: isMinor ? form.guardianEmail : null,
      p_terms_accepted: form.terms, p_privacy_accepted: form.privacy,
    });
    setSubmitting(false);
    if (response.error) setError(response.error.message || 'Registration could not be submitted.');
    else {
      setResult(response.data);
      void triggerSmtpNow('walk_in_registration_submitted');
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-50"><Loader2 className="animate-spin text-rose-900" /></div>;
  if (result) return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <section className="w-full max-w-lg rounded-3xl border border-emerald-200 bg-white p-8 text-center shadow-xl">
        <CheckCircle2 className="mx-auto text-emerald-600" size={52} />
        <h1 className="mt-4 text-2xl font-bold text-slate-900">Walk-in registration received</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">You are registered for <strong>{result.event_name}</strong>. A confirmation was sent to {result.email}.</p>
        <div className="mt-5 rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your event waybill</p><p className="mt-1 font-mono text-lg font-bold text-slate-900">{result.waybill_code}</p></div>
        <p className="mt-4 text-xs text-slate-500">Please show this screen to the assigned Staff member. Staff will record and review the donated hair.</p>
      </section>
    </main>
  );

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <section className="mx-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">
        <header className="bg-rose-950 px-6 py-6 text-white">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-rose-200">Donivra event walk-in</p>
          <h1 className="mt-2 text-2xl font-bold !text-white">{intake?.event_name || 'Walk-in donor registration'}</h1>
          <div className="mt-3 space-y-1 text-sm text-rose-100"><p className="flex gap-2"><CalendarDays size={17} />{formatSchedule(intake?.start_date)} – {formatSchedule(intake?.end_date)}</p>{intake?.venue_address && <p className="flex gap-2"><MapPin size={17} />{intake.venue_name ? `${intake.venue_name}, ` : ''}{intake.venue_address}</p>}</div>
        </header>
        <div className="p-6 sm:p-8">
          {!intake?.is_open ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900"><strong>Registration is closed.</strong><p className="mt-1">{intake?.message || error}</p></div> : step === 1 ? (
            <div>
              <div className="flex items-center gap-3"><ShieldCheck className="text-rose-900" /><h2 className="text-xl font-bold text-slate-900">Consent and privacy</h2></div>
              <p className="mt-3 text-sm leading-6 text-slate-600">Your information is collected only to document this event donation, review the hair, maintain traceability, and send donor-safe progress emails. Recipient and patient details will never be included.</p>
              <div className="mt-5 space-y-3">
                <div className={`rounded-xl border p-4 ${termsReady ? 'border-slate-200' : 'border-amber-200 bg-amber-50'}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <input id="walk-in-terms-consent" type="checkbox" checked={form.terms} onChange={(e) => update('terms', e.target.checked)} disabled={!termsReady} className="h-4 w-4 accent-rose-900 disabled:cursor-not-allowed" />
                    <label htmlFor="walk-in-terms-consent" className={`min-w-0 flex-1 text-sm ${termsReady ? 'text-slate-700' : 'text-amber-900'}`}>I accept the current Terms and Conditions for walk-in hair donation.</label>
                    {termsReady && <a href={walkInTerms.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700"><ExternalLink size={13} /> Open Terms PDF</a>}
                  </div>
                  {!termsReady && <p className="mt-2 text-xs text-amber-800">{walkInTerms.isLoading ? 'Loading the Walk-in Donation Terms PDF…' : 'The Walk-in Donation Terms PDF is unavailable. Ask an administrator to publish it under Legal Documents.'}</p>}
                  {termsReady && <p className="mt-2 text-[11px] text-slate-500">Version {walkInTerms.document.version}</p>}
                </div>
                <div className={`rounded-xl border p-4 ${privacyReady ? 'border-slate-200' : 'border-amber-200 bg-amber-50'}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <input id="walk-in-privacy-consent" type="checkbox" checked={form.privacy} onChange={(e) => update('privacy', e.target.checked)} disabled={!privacyReady} className="h-4 w-4 accent-rose-900 disabled:cursor-not-allowed" />
                    <label htmlFor="walk-in-privacy-consent" className={`min-w-0 flex-1 text-sm ${privacyReady ? 'text-slate-700' : 'text-amber-900'}`}>I acknowledge the Privacy Notice and consent to the stated processing and email updates.</label>
                    {privacyReady && <a href={privacyNotice.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700"><ExternalLink size={13} /> Open Privacy PDF</a>}
                  </div>
                  {!privacyReady && <p className="mt-2 text-xs text-amber-800">{privacyNotice.isLoading ? 'Loading the Privacy Notice PDF…' : 'The Privacy Notice PDF is unavailable. Ask an administrator to publish it under Legal Documents.'}</p>}
                  {privacyReady && <p className="mt-2 text-[11px] text-slate-500">Version {privacyNotice.document.version}</p>}
                </div>
              </div>
              <button type="button" disabled={!canContinue} onClick={() => setStep(2)} className="mt-6 w-full rounded-xl bg-rose-950 px-5 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-45">Continue to donor details</button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <h2 className="text-xl font-bold text-slate-900">Walk-in donor details</h2>
              <p className="mt-1 text-sm text-slate-500">Email and birthdate are required. Age is calculated automatically. Staff will record the hair details and photos separately.</p>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-semibold text-slate-700 sm:col-span-2">Email *<input type="email" required value={form.email} onChange={(e) => update('email', e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" /></label>
                <label className="text-sm font-semibold text-slate-700">Birthdate *<input type="date" required value={form.birthdate} onChange={(e) => update('birthdate', e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" /></label>
                <label className="text-sm font-semibold text-slate-700">Age (auto-calculated)<input readOnly tabIndex={-1} value={calculatedAge ?? ''} placeholder="Select birthdate" className="mt-1.5 w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 font-normal text-slate-600" /></label>
                <label className="text-sm font-semibold text-slate-700 sm:col-span-2">Name (optional)<input value={form.fullName} onChange={(e) => update('fullName', e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-3 font-normal" /></label>
              </div>
              {isMinor && <fieldset className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4"><legend className="px-2 text-sm font-bold text-amber-900">Guardian details (required for under 18)</legend><div className="grid gap-3 sm:grid-cols-2"><input value={form.guardianName} onChange={(e) => update('guardianName', e.target.value)} placeholder="Guardian full name" className="rounded-xl border border-amber-300 px-4 py-3 text-sm" /><input value={form.guardianRelationship} onChange={(e) => update('guardianRelationship', e.target.value)} placeholder="Relationship" className="rounded-xl border border-amber-300 px-4 py-3 text-sm" /><input type="email" value={form.guardianEmail} onChange={(e) => update('guardianEmail', e.target.value)} placeholder="Guardian email" className="rounded-xl border border-amber-300 px-4 py-3 text-sm sm:col-span-2" /></div><p className="mt-3 text-xs text-amber-800">A parent or guardian must provide these details before a minor's registration can be submitted.</p></fieldset>}
              {error && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
              <div className="mt-6 flex gap-3"><button type="button" onClick={() => setStep(1)} className="rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700">Back</button><button disabled={submitting} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-rose-950 px-5 py-3 font-bold text-white disabled:opacity-60">{submitting && <Loader2 size={18} className="animate-spin" />}Submit registration</button></div>
            </form>
          )}
          {error && step === 1 && <p className="mt-4 text-sm text-red-700">{error}</p>}
        </div>
      </section>
    </main>
  );
}
