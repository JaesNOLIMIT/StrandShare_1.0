import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, CheckCircle2, FileText, Loader2,
  MailCheck, ShieldCheck, UploadCloud,
} from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import { triggerSmtpNow } from '../../lib/smtpTriggerClient';
import { formatPhilippineMobile, PERSON_SUFFIX_OPTIONS } from '../../lib/personIdentity';
import philippineAddressOptions from '../../data/philippineAddressOptions.json';

const CONDITIONS = ['Cancer', 'Alopecia', 'Other Hair-Loss Disease'];
const STAGES = {
  Cancer: ['Stage 0', 'Stage I', 'Stage II', 'Stage III', 'Stage IV', 'Recurrent', 'Unknown', 'Custom'],
  Alopecia: ['Mild', 'Moderate', 'Severe', 'Alopecia Totalis', 'Alopecia Universalis', 'Ophiasis Pattern', 'Custom'],
};
const PH_MOBILE_REGEX = /^\+63 9\d{2} \d{3} \d{4}$/;
const FORM_STEPS = ['Verify email', 'Application details', 'Review', 'Submitted'];
const PHILIPPINE_ADDRESS_TREE = philippineAddressOptions && typeof philippineAddressOptions === 'object'
  ? philippineAddressOptions
  : {};
const EMPTY_FORM = {
  firstName: '', middleName: '', lastName: '', suffix: '', birthdate: '', gender: '', contactNumber: '',
  street: '', barangay: '', city: '', province: '', region: '', country: 'Philippines',
  dateOfDiagnosis: '', conditionCategory: '', otherHairLossDisease: '', conditionStage: '', customConditionStage: '',
  doctorName: '', physicianContact: '', treatmentHospitalClinic: '', treatmentPlan: '', treatmentStatus: '',
  allergiesCurrentMedications: '', insurancePhilHealthInfo: '', clinicalSpecialNote: '',
  guardian: '', guardianRelationship: '', guardianContactNumber: '', secondaryGuardian: '',
  secondaryGuardianRelationship: '', secondaryGuardianContactNumber: '',
  hasKnownAllergies: '', allergyDetails: '', hasSensitiveScalp: '', hasScalpIrritation: '',
  hasOpenScalpWounds: '', hasMedicalRestriction: '', medicalRestrictionDetails: '', safetyInformationConfirmed: false,
};
const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#7a1020] focus:ring-2 focus:ring-[#7a1020]/10 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500';

function toUnifiedRegionOptions(addressData) {
  const data = addressData && typeof addressData === 'object' ? addressData : {};
  return Object.entries(data)
    .filter(([, region]) => region?.region_name && region?.province_list)
    .map(([, region]) => ({
      name: region.region_name,
      provinces: Object.entries(region.province_list || {}).map(([provinceName, province]) => ({
        name: provinceName,
        cities: Object.entries(province?.municipality_list || {}).map(([cityName, city]) => ({
          name: cityName,
          barangays: Array.isArray(city?.barangay_list) ? city.barangay_list.slice().sort((a, b) => a.localeCompare(b)) : [],
        })).sort((a, b) => a.name.localeCompare(b.name)),
      })).sort((a, b) => a.name.localeCompare(b.name)),
    })).sort((a, b) => a.name.localeCompare(b.name));
}

function Field({ label, required = false, children, wide = false, error = '', hint = '' }) {
  return <label data-field-error={error ? 'true' : undefined} className={`flex flex-col ${wide ? 'md:col-span-2' : ''}`}><span className="text-sm font-semibold text-slate-700">{label}{required ? <span className="text-rose-600"> *</span> : <span className="font-normal text-slate-400"> (optional)</span>}</span>{children}{error ? <span className="mt-1 text-xs font-medium text-rose-600">{error}</span> : hint ? <span className="mt-1 text-xs text-slate-500">{hint}</span> : null}</label>;
}

function YesNo({ label, value, onChange, error = '' }) {
  return (
    <Field label={label} required error={error}>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={`${inputClass} ${error ? 'border-rose-500 ring-2 ring-rose-100' : ''}`}>
        <option value="">Select answer</option><option value="no">No</option><option value="yes">Yes</option>
      </select>
    </Field>
  );
}

function FormSection({ number, title, description, children }) {
  return (
    <section className="rounded-xl border border-[#e7cbc6] bg-[#f8fafc] p-4 sm:p-5">
      <div className="grid gap-5 lg:grid-cols-[190px_minmax(0,1fr)]">
        <div><span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#650817] text-xs font-bold text-white">{number}</span><h2 className="mt-2 font-bold text-slate-700">{title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{description}</p></div>
        <div className="grid gap-4 md:grid-cols-2">{children}</div>
      </div>
    </section>
  );
}

function FormProgress({ step }) {
  const formStep = Math.max(1, step - 1);
  const percentage = Math.round((formStep / FORM_STEPS.length) * 100);
  return (
    <section className="mt-5 rounded-xl border border-[#e7cbc6] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div><p className="text-[11px] font-bold uppercase tracking-[.14em] text-[#b28578]">Step {formStep} of {FORM_STEPS.length}</p><p className="mt-1 text-sm font-semibold text-slate-600">{FORM_STEPS[formStep - 1]}</p></div>
        <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-bold text-[#48639b]">{percentage}%</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#650817] transition-all" style={{ width: `${percentage}%` }} /></div>
      <ol className="mt-3 grid grid-cols-4 gap-2">
        {FORM_STEPS.map((label, index) => {
          const number = index + 1;
          const active = formStep === number;
          const complete = formStep > number;
          return <li key={label} className={`flex min-w-0 items-center gap-2 text-xs ${active ? 'font-bold text-[#650817]' : complete ? 'font-semibold text-emerald-700' : 'text-[#b28578]'}`}><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${active ? 'border-[#650817] bg-[#650817] text-white' : complete ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-[#e1c3bd] bg-white'}`}>{complete ? <CheckCircle2 size={12} /> : number}</span><span className="hidden truncate sm:block">{label}</span></li>;
        })}
      </ol>
    </section>
  );
}

function ReviewItem({ label, value, wide = false }) {
  return <div className={wide ? 'sm:col-span-2' : ''}><dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 break-words text-sm font-medium text-slate-800">{String(value || '').trim() || 'Not provided'}</dd></div>;
}

function ReviewSection({ title, children }) {
  return <section className="border-t border-slate-200 py-5 first:border-t-0 first:pt-0"><h2 className="mb-4 text-sm font-bold text-[#650817]">{title}</h2><dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{children}</dl></section>;
}

async function invokePatientApplication(body) {
  const { data, error } = await supabase.functions.invoke('patient-application', { body });
  if (error) {
    let message = error.message || 'Unable to process the patient application.';
    try {
      const detail = await error.context?.json?.();
      if (detail?.error) message = detail.error;
    } catch {
      // Keep the function error message.
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export default function PatientApplicationPage() {
  const hospitalId = Number(new URLSearchParams(window.location.search).get('hospital') || 0);
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [step, setStep] = useState(1);
  const [acceptedTerms, setAcceptedTerms] = useState({ donivra: false, hospital: false });
  const [email, setEmail] = useState('');
  const [emailAvailability, setEmailAvailability] = useState({ status: 'idle', message: '' });
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const [submissionToken, setSubmissionToken] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState({});
  const [medicalDocument, setMedicalDocument] = useState(null);
  const [patientPicture, setPatientPicture] = useState(null);
  const [success, setSuccess] = useState(null);
  const [termsUrl, setTermsUrl] = useState('');
  const [showSubmitConfirmation, setShowSubmitConfirmation] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!hospitalId || !isSupabaseConfigured || !supabase) {
        if (mounted) { setError('Choose a valid partner hospital first.'); setLoading(false); }
        return;
      }
      const { data, error: setupError } = await supabase.rpc('get_patient_application_setup', { p_hospital_id: hospitalId });
      if (!mounted) return;
      if (setupError) setError(setupError.message || 'Unable to load application requirements.');
      else {
        setSetup(data);
        const path = String(data?.donivra_terms?.file_path || '').trim();
        if (path) {
          const signed = await supabase.storage.from('legal-documents').createSignedUrl(path, 60 * 60);
          if (mounted) setTermsUrl(signed.data?.signedUrl || '');
        }
      }
      if (mounted) setLoading(false);
    };
    void load();
    return () => { mounted = false; };
  }, [hospitalId]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    if (email.trim().toLowerCase() === verifiedEmail) return;
    setVerifiedEmail(''); setSubmissionToken(''); setOtp(''); setOtpSent(false);
  }, [email, verifiedEmail]);

  const hospital = setup?.hospital;
  const terms = setup?.donivra_terms;
  const requirements = Array.isArray(hospital?.requirements) ? hospital.requirements : [];
  const hospitalPdfUrl = hospital?.requirements_pdf_path
    ? supabase.storage.from('hospital-application-documents').getPublicUrl(hospital.requirements_pdf_path).data?.publicUrl || ''
    : '';
  const normalizedEmail = email.trim().toLowerCase();
  const clearFieldError = (key) => setFieldErrors((current) => {
    if (!current[key]) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
  const update = (key) => (event) => {
    clearFieldError(key);
    setForm((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  };
  const updatePhone = (key) => (event) => {
    clearFieldError(key);
    setForm((current) => ({ ...current, [key]: formatPhilippineMobile(event.target.value) }));
  };
  const setAnswer = (key) => (value) => {
    clearFieldError(key);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const fieldClass = (key) => `${inputClass} ${fieldErrors[key] ? 'border-rose-500 ring-2 ring-rose-100' : ''}`;
  const displayName = useMemo(() => [form.firstName, form.middleName, form.lastName, form.suffix].filter(Boolean).join(' '), [form]);
  const medicalCondition = form.conditionCategory === 'Other Hair-Loss Disease' ? form.otherHairLossDisease.trim() : form.conditionCategory;
  const conditionStage = form.conditionStage === 'Custom' ? form.customConditionStage.trim() : form.conditionStage;
  const regionOptions = useMemo(() => toUnifiedRegionOptions(PHILIPPINE_ADDRESS_TREE), []);
  const selectedRegion = useMemo(() => regionOptions.find((region) => region.name === form.region) || null, [form.region, regionOptions]);
  const provinceOptions = useMemo(() => selectedRegion?.provinces || [], [selectedRegion]);
  const selectedProvince = useMemo(() => provinceOptions.find((province) => province.name === form.province) || null, [form.province, provinceOptions]);
  const cityOptions = useMemo(() => selectedProvince?.cities || [], [selectedProvince]);
  const selectedCity = useMemo(() => cityOptions.find((city) => city.name === form.city) || null, [cityOptions, form.city]);
  const barangayOptions = useMemo(() => selectedCity?.barangays || [], [selectedCity]);

  const updateRegion = (event) => {
    ['region', 'province', 'city', 'barangay'].forEach(clearFieldError);
    setForm((current) => ({ ...current, region: event.target.value, province: '', city: '', barangay: '' }));
  };
  const updateProvince = (event) => {
    ['province', 'city', 'barangay'].forEach(clearFieldError);
    setForm((current) => ({ ...current, province: event.target.value, city: '', barangay: '' }));
  };
  const updateCity = (event) => {
    ['city', 'barangay'].forEach(clearFieldError);
    setForm((current) => ({ ...current, city: event.target.value, barangay: '' }));
  };

  useEffect(() => {
    let cancelled = false;
    let timerId;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setEmailAvailability({ status: 'idle', message: '' });
      return undefined;
    }

    setEmailAvailability({ status: 'checking', message: 'Checking for an active application or existing patient account...' });
    timerId = window.setTimeout(async () => {
      try {
        const result = await invokePatientApplication({ action: 'check-email', email: normalizedEmail });
        if (cancelled) return;
        setEmailAvailability({
          status: result?.available ? 'available' : 'blocked',
          message: result?.message || (result?.available ? 'This email can be used.' : 'This email cannot be used.'),
        });
      } catch (checkError) {
        if (cancelled) return;
        setEmailAvailability({ status: 'error', message: checkError.message || 'Unable to check this email right now.' });
      }
    }, 450);

    return () => {
      cancelled = true;
      if (timerId) window.clearTimeout(timerId);
    };
  }, [normalizedEmail]);

  const sendOtp = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) { setNotice('Enter a valid email address.'); return; }
    try {
      setBusy('send-otp'); setNotice('');
      const availability = await invokePatientApplication({ action: 'check-email', email: normalizedEmail });
      if (!availability?.available) {
        setEmailAvailability({ status: 'blocked', message: availability?.message || 'This email cannot be used.' });
        return;
      }
      const result = await invokePatientApplication({ action: 'send-otp', email: normalizedEmail });
      setCooldown(Number(result?.cooldownSeconds || 60));
      setOtpSent(true);
      setOtp('');
      setNotice(`A 6-digit code was sent to ${normalizedEmail}.`);
      void triggerSmtpNow('patient_application_otp');
    } catch (sendError) { setNotice(sendError.message); } finally { setBusy(''); }
  };

  const verifyOtp = async () => {
    try {
      setBusy('verify-otp'); setNotice('');
      const result = await invokePatientApplication({ action: 'verify-otp', email: normalizedEmail, otp });
      setVerifiedEmail(normalizedEmail); setSubmissionToken(result.submissionToken); setNotice('Email verified. You may complete the application.');
    } catch (verifyError) { setNotice(verifyError.message); } finally { setBusy(''); }
  };

  const validateDetails = () => {
    const errors = {};
    const requireValue = (key, label, value = form[key]) => {
      if (!String(value || '').trim()) errors[key] = `${label} is required.`;
    };
    requireValue('firstName', 'First name'); requireValue('lastName', 'Last name');
    requireValue('birthdate', 'Birthdate'); requireValue('gender', 'Gender'); requireValue('contactNumber', 'Mobile number');
    requireValue('region', 'Region'); requireValue('province', 'Province'); requireValue('city', 'City or municipality');
    requireValue('barangay', 'Barangay'); requireValue('street', 'Street address');
    requireValue('conditionCategory', 'Condition'); requireValue('medicalCondition', 'Medical condition', medicalCondition);
    requireValue('dateOfDiagnosis', 'Date of diagnosis'); requireValue('doctorName', 'Attending physician');
    requireValue('physicianContact', 'Physician mobile number'); requireValue('treatmentHospitalClinic', 'Treatment hospital or clinic');
    requireValue('treatmentPlan', 'Treatment plan'); requireValue('treatmentStatus', 'Current treatment status');
    requireValue('guardian', 'Guardian or emergency contact'); requireValue('guardianRelationship', 'Relationship');
    requireValue('guardianContactNumber', 'Guardian mobile number');
    if (form.birthdate && new Date(form.birthdate) > new Date()) errors.birthdate = 'Birthdate cannot be in the future.';
    if (form.dateOfDiagnosis && new Date(form.dateOfDiagnosis) > new Date()) errors.dateOfDiagnosis = 'Date of diagnosis cannot be in the future.';
    if ((STAGES[form.conditionCategory] || []).length > 0 && !conditionStage) errors.conditionStage = 'Select or enter the stage or severity.';
    if (form.contactNumber && !PH_MOBILE_REGEX.test(form.contactNumber.trim())) errors.contactNumber = 'Use the +63 912 345 6789 format.';
    if (form.physicianContact && !PH_MOBILE_REGEX.test(form.physicianContact.trim())) errors.physicianContact = 'Use the +63 912 345 6789 format.';
    if (form.guardianContactNumber && !PH_MOBILE_REGEX.test(form.guardianContactNumber.trim())) errors.guardianContactNumber = 'Use the +63 912 345 6789 format.';
    const hasSecondaryContact = [form.secondaryGuardian, form.secondaryGuardianRelationship, form.secondaryGuardianContactNumber]
      .some((value) => String(value || '').trim());
    if (hasSecondaryContact && [form.secondaryGuardian, form.secondaryGuardianRelationship, form.secondaryGuardianContactNumber]
      .some((value) => !String(value || '').trim())) errors.secondaryGuardian = 'Complete all three secondary contact fields or leave all three blank.';
    if (form.secondaryGuardianContactNumber && !PH_MOBILE_REGEX.test(form.secondaryGuardianContactNumber.trim())) errors.secondaryGuardianContactNumber = 'Use the +63 912 345 6789 format.';
    if (form.secondaryGuardianContactNumber && form.secondaryGuardianContactNumber.trim() === form.guardianContactNumber.trim()) errors.secondaryGuardianContactNumber = 'Use a different number from the primary contact.';
    if (!medicalDocument) errors.medicalDocument = 'Upload the required medical document.';
    if (form.hasKnownAllergies === 'yes' && !form.allergyDetails.trim()) errors.allergyDetails = 'Enter the known allergy details.';
    if (form.hasMedicalRestriction === 'yes' && !form.medicalRestrictionDetails.trim()) errors.medicalRestrictionDetails = 'Enter the medical restriction details.';
    ['hasKnownAllergies', 'hasSensitiveScalp', 'hasScalpIrritation', 'hasOpenScalpWounds', 'hasMedicalRestriction'].forEach((key) => {
      if (!form[key]) errors[key] = 'Select Yes or No.';
    });
    if (!form.safetyInformationConfirmed) errors.safetyInformationConfirmed = 'Confirm that the safety information is accurate.';
    setFieldErrors(errors);
    const firstError = Object.values(errors)[0];
    if (firstError) {
      window.setTimeout(() => document.querySelector('[data-field-error="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
      return 'Complete the highlighted required fields.';
    }
    return '';
  };

  const submit = async () => {
    const validation = validateDetails();
    if (validation) { setNotice(validation); return; }
    const payload = {
      action: 'submit', email: normalizedEmail, submissionToken, hospitalId,
      donivraTermsDocumentId: terms.id, donivraTermsVersion: terms.version,
      acceptDonivraTerms: acceptedTerms.donivra, acceptHospitalConditions: acceptedTerms.hospital,
      ...form, medicalCondition, conditionStage,
      hospitalSettingsUpdatedAt: hospital.settings_updated_at,
      hasKnownAllergies: form.hasKnownAllergies === 'yes', hasSensitiveScalp: form.hasSensitiveScalp === 'yes',
      hasScalpIrritation: form.hasScalpIrritation === 'yes', hasOpenScalpWounds: form.hasOpenScalpWounds === 'yes',
      hasMedicalRestriction: form.hasMedicalRestriction === 'yes',
    };
    const body = new FormData();
    body.append('action', 'submit'); body.append('email', normalizedEmail); body.append('submissionToken', submissionToken);
    body.append('payload', JSON.stringify(payload)); body.append('medicalDocument', medicalDocument);
    if (patientPicture) body.append('patientPicture', patientPicture);
    try {
      setBusy('submit'); setNotice('');
      const result = await invokePatientApplication(body);
      setSuccess(result); setShowSubmitConfirmation(false); setStep(5);
      void triggerSmtpNow('patient_application_submitted');
    } catch (submitError) { setNotice(submitError.message); } finally { setBusy(''); }
  };

  if (loading) return <main className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-600"><Loader2 className="mr-2 animate-spin" size={18} /> Loading application...</main>;
  if (error || !hospital) return <main className="min-h-screen bg-slate-50 p-6"><div className="mx-auto max-w-xl rounded-xl border border-rose-200 bg-white p-6"><p className="font-semibold text-rose-800">{error || 'Hospital is unavailable.'}</p><button type="button" onClick={() => window.location.assign('/partner-hospitals')} className="mt-4 text-sm font-bold text-[#7a1020]">Choose another hospital</button></div></main>;

  return (
    <main className="min-h-screen bg-[#f4f7fb] px-4 py-8 text-slate-900 sm:py-10">
      <div className="mx-auto max-w-4xl rounded-[22px] border border-[#e7cbc6] bg-white p-5 shadow-[0_12px_32px_rgba(15,23,42,0.06)] sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <button type="button" onClick={() => window.location.assign('/partner-hospitals')} className="inline-flex items-center gap-2 rounded-lg border border-[#e1c3bd] px-3 py-2 text-sm font-medium text-[#48639b] transition hover:bg-slate-50"><ArrowLeft size={16} /> Back to partner hospitals</button>
          <div className="min-w-0 text-right"><p className="text-xs text-[#b28578]">Patient application</p><p className="truncate text-sm font-bold text-[#650817]">{hospital.name}</p></div>
        </div>
        <header className="mt-6">
          <h1 className="text-2xl font-bold text-slate-700 sm:text-3xl">{step === 1 ? 'Patient Application Terms and Conditions' : 'Patient Application Form'}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#48639b]">{step === 1 ? `Review Donivra's policy and ${hospital.name}'s requirements before starting your application.` : 'Verify your email, provide the patient information, and review everything before submission.'}</p>
        </header>
        {step > 1 && <FormProgress step={step} />}

        {notice && <div role="alert" className={`mt-5 rounded-xl border p-3 text-sm ${notice.toLowerCase().includes('verified') || notice.toLowerCase().includes('sent to') ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>{notice}</div>}

        {step === 1 && (
          <section className="mt-5">
            {!hospital.applications_open && <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">Applications are currently closed for this hospital.</div>}

            <div className="space-y-5">
              <div className="space-y-5">
                <div className="grid gap-4">
                  <article className="rounded-xl border border-[#e7cbc6] bg-white p-4">
                    <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-[#7a1020]">Donivra policy</p><h2 className="mt-1 font-bold text-slate-800">Terms and conditions</h2></div><ShieldCheck className="shrink-0 text-[#7a1020]" size={21} /></div>
                    {terms ? <><p className="mt-2 text-xs text-[#b28578]">{terms.title} · Version {terms.version}</p>{termsUrl ? <iframe title={terms.title || 'Donivra patient application terms'} src={`${termsUrl}#toolbar=1&navpanes=1&view=FitH`} className="mt-4 h-[500px] w-full rounded-xl border border-[#e7cbc6] bg-slate-100" /> : <div className="mt-3 max-h-80 overflow-y-auto whitespace-pre-line rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">{terms.content}</div>}{termsUrl && <p className="mt-2 text-xs text-[#b28578]">If the preview does not load, <a href={termsUrl} target="_blank" rel="noreferrer" className="font-bold text-[#7a1020] underline">open the PDF in a new tab</a>.</p>}</> : <p className="mt-3 text-sm font-medium text-rose-700">No active patient application terms are published.</p>}
                  </article>

                  <article className="rounded-xl border border-[#e7cbc6] bg-[#f8fafc] p-4">
                    <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-[#7a1020]">Hospital policy</p><h2 className="mt-1 font-bold text-slate-800">{hospital.name} conditions</h2></div><FileText className="shrink-0 text-[#7a1020]" size={21} /></div>
                    <p className="mt-3 max-h-40 overflow-y-auto whitespace-pre-line pr-2 text-sm leading-6 text-slate-600">{hospital.conditions || 'Conditions have not been published.'}</p>
                    {hospitalPdfUrl && <a href={hospitalPdfUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-[#7a1020]"><FileText size={16} /> Open hospital requirements PDF</a>}
                  </article>
                </div>

                <article className="border-t border-slate-200 pt-5">
                  <div className="flex items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-wide text-[#7a1020]">Checklist</p><h2 className="mt-1 font-bold text-slate-800">Required before submission</h2></div><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">{requirements.length} item{requirements.length === 1 ? '' : 's'}</span></div>
                  {requirements.length > 0 ? <ul className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">{requirements.map((item, index) => <li key={`${item}-${index}`} className="flex gap-2.5 text-sm leading-5 text-slate-700"><CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /><span>{String(item)}</span></li>)}</ul> : <p className="mt-3 text-sm text-slate-500">No additional hospital requirements were listed.</p>}
                </article>
              </div>

              <aside className="rounded-xl border border-[#e7cbc6] bg-[#f8fafc] p-5">
                <div className="space-y-3">
                  <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${acceptedTerms.donivra ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#650817]" checked={acceptedTerms.donivra} onChange={(event) => setAcceptedTerms((value) => ({ ...value, donivra: event.target.checked }))} /><span>I have read and accept Donivra's patient application terms.</span></label>
                  <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${acceptedTerms.hospital ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 hover:border-slate-300'}`}><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#650817]" checked={acceptedTerms.hospital} onChange={(event) => setAcceptedTerms((value) => ({ ...value, hospital: event.target.checked }))} /><span>I have read and meet {hospital.name}'s conditions and requirements.</span></label>
                </div>
                <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => window.location.assign('/partner-hospitals')} className="rounded-lg border border-[#e1c3bd] px-4 py-2.5 text-sm font-bold text-[#48639b]">Decline</button><button type="button" disabled={!hospital.applications_open || !terms || !acceptedTerms.donivra || !acceptedTerms.hospital} onClick={() => { setNotice(''); setStep(2); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#650817] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#520612] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">Accept and Continue <ArrowRight size={16} /></button></div>
                {hospital.applications_open && (!acceptedTerms.donivra || !acceptedTerms.hospital) && <p className="mt-2 text-center text-xs text-slate-500">Accept both statements to continue.</p>}
              </aside>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="mt-5 rounded-xl border border-[#e7cbc6] bg-[#f8fafc] p-5 sm:p-7">
            <p className="text-xs font-bold uppercase tracking-[.16em] text-[#7a1020]">Email verification</p><h1 className="mt-2 text-2xl font-bold">Enter your email first</h1><p className="mt-2 text-sm text-slate-600">We check it before sending a code. An email with an active application or existing patient account cannot start another application.</p>
            <div className="mt-6 max-w-xl space-y-4">
              <Field label="Email address" required><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} placeholder="patient@example.com" disabled={Boolean(verifiedEmail)} /></Field>
              {!verifiedEmail && emailAvailability.message && <div className={`flex items-start gap-2 rounded-xl p-3 text-sm ${emailAvailability.status === 'available' ? 'bg-emerald-50 text-emerald-800' : emailAvailability.status === 'blocked' || emailAvailability.status === 'error' ? 'bg-rose-50 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>{emailAvailability.status === 'checking' ? <Loader2 size={17} className="mt-0.5 shrink-0 animate-spin" /> : emailAvailability.status === 'available' ? <CheckCircle2 size={17} className="mt-0.5 shrink-0" /> : <ShieldCheck size={17} className="mt-0.5 shrink-0" />}<span>{emailAvailability.message}</span></div>}
              {!verifiedEmail && <button type="button" onClick={sendOtp} disabled={Boolean(busy) || cooldown > 0 || emailAvailability.status !== 'available'} className="inline-flex items-center gap-2 rounded-lg border border-[#7a1020] px-4 py-2 text-sm font-bold text-[#7a1020] disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"><MailCheck size={16} /> {busy === 'send-otp' ? 'Checking and sending...' : cooldown > 0 ? `Resend in ${cooldown}s` : otpSent ? 'Resend 6-digit OTP' : 'Send 6-digit OTP'}</button>}
              {!verifiedEmail && otpSent && <div className="flex gap-2"><input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))} className={`${inputClass} mt-0 max-w-xs tracking-[.3em]`} placeholder="000000" inputMode="numeric" /><button type="button" onClick={verifyOtp} disabled={Boolean(busy) || otp.length !== 6} className="rounded-lg bg-[#650817] px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy === 'verify-otp' ? 'Verifying...' : 'Verify'}</button></div>}
              {verifiedEmail && <div className="rounded-xl bg-emerald-50 p-4 text-sm font-semibold text-emerald-800"><ShieldCheck size={17} className="mr-2 inline" /> {verifiedEmail} is verified.</div>}
            </div>
            <div className="mt-8 flex justify-between"><button type="button" onClick={() => setStep(1)} className="text-sm font-bold text-slate-600">Back</button><button type="button" disabled={!submissionToken} onClick={() => { setNotice(''); setStep(3); }} className="inline-flex items-center gap-2 rounded-xl bg-[#650817] px-5 py-2.5 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-500">Complete application <ArrowRight size={16} /></button></div>
          </section>
        )}

        {step === 3 && (
          <section className="mt-5 rounded-xl border border-[#e7cbc6] bg-white">
            <header className="flex flex-col justify-between gap-3 border-b border-slate-200 px-5 py-5 sm:flex-row sm:items-end sm:px-7"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-[#7a1020]">Patient application</p><h1 className="mt-1 text-2xl font-bold">Complete your details</h1><p className="mt-1 text-sm text-slate-600">Fields marked <span className="font-bold text-rose-600">*</span> are required. Your information is visible only to {hospital.name}.</p></div><span className="text-xs font-medium text-slate-500">Verified email: {verifiedEmail}</span></header>
            <div className="space-y-4 px-5 py-6 sm:px-7">
              <FormSection number="1" title="Personal information" description="Enter the patient's legal and contact information.">
                <Field label="First name" required error={fieldErrors.firstName}><input value={form.firstName} onChange={update('firstName')} className={fieldClass('firstName')} autoComplete="given-name" /></Field>
                <Field label="Middle name" error={fieldErrors.middleName}><input value={form.middleName} onChange={update('middleName')} className={fieldClass('middleName')} autoComplete="additional-name" /></Field>
                <Field label="Last name" required error={fieldErrors.lastName}><input value={form.lastName} onChange={update('lastName')} className={fieldClass('lastName')} autoComplete="family-name" /></Field>
                <Field label="Suffix" error={fieldErrors.suffix}><select value={form.suffix} onChange={update('suffix')} className={fieldClass('suffix')}>{PERSON_SUFFIX_OPTIONS.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}</select></Field>
                <Field label="Birthdate" required error={fieldErrors.birthdate}><input type="date" value={form.birthdate} onChange={update('birthdate')} max={new Date().toISOString().slice(0, 10)} className={fieldClass('birthdate')} /></Field>
                <Field label="Gender" required error={fieldErrors.gender}><select value={form.gender} onChange={update('gender')} className={fieldClass('gender')}><option value="">Select gender</option><option>Female</option><option>Male</option></select></Field>
                <Field label="Mobile number" required error={fieldErrors.contactNumber} hint="Format: +63 912 345 6789"><input type="tel" inputMode="numeric" maxLength={16} value={form.contactNumber} onChange={updatePhone('contactNumber')} className={fieldClass('contactNumber')} placeholder="+63 912 345 6789" autoComplete="tel" /></Field>
              </FormSection>

              <FormSection number="2" title="Home address" description="Select the location in order. Options come from the Philippine address directory.">
                <Field label="Region" required error={fieldErrors.region}><select value={form.region} onChange={updateRegion} className={fieldClass('region')}><option value="">Select region</option>{regionOptions.map((region) => <option key={region.name} value={region.name}>{region.name}</option>)}</select></Field>
                <Field label="Province" required error={fieldErrors.province}><select value={form.province} onChange={updateProvince} className={fieldClass('province')} disabled={!form.region}><option value="">{form.region ? 'Select province' : 'Select a region first'}</option>{provinceOptions.map((province) => <option key={province.name} value={province.name}>{province.name}</option>)}</select></Field>
                <Field label="City / Municipality" required error={fieldErrors.city}><select value={form.city} onChange={updateCity} className={fieldClass('city')} disabled={!form.province}><option value="">{form.province ? 'Select city or municipality' : 'Select a province first'}</option>{cityOptions.map((city) => <option key={city.name} value={city.name}>{city.name}</option>)}</select></Field>
                <Field label="Barangay" required error={fieldErrors.barangay}><select value={form.barangay} onChange={update('barangay')} className={fieldClass('barangay')} disabled={!form.city}><option value="">{form.city ? 'Select barangay' : 'Select a city first'}</option>{barangayOptions.map((barangay) => <option key={barangay} value={barangay}>{barangay}</option>)}</select></Field>
                <Field label="House number and street" required wide error={fieldErrors.street} hint="Example: 24 Mabini Street"><input value={form.street} onChange={update('street')} className={fieldClass('street')} placeholder="House number, building, and street" autoComplete="street-address" /></Field>
                <Field label="Country" required><input value="Philippines" readOnly className={`${inputClass} bg-slate-100`} /></Field>
              </FormSection>

              <FormSection number="3" title="Clinical information" description="Provide current information that the hospital can verify from the uploaded medical document.">
                <Field label="Condition" required error={fieldErrors.conditionCategory}><select value={form.conditionCategory} onChange={update('conditionCategory')} className={fieldClass('conditionCategory')}><option value="">Select condition</option>{CONDITIONS.map((condition) => <option key={condition}>{condition}</option>)}</select></Field>
                {form.conditionCategory === 'Other Hair-Loss Disease' && <Field label="Disease name" required error={fieldErrors.medicalCondition}><input value={form.otherHairLossDisease} onChange={(event) => { clearFieldError('medicalCondition'); update('otherHairLossDisease')(event); }} className={fieldClass('medicalCondition')} /></Field>}
                <Field label="Stage / severity" required={Boolean(STAGES[form.conditionCategory])} error={fieldErrors.conditionStage}><select value={form.conditionStage} onChange={update('conditionStage')} className={fieldClass('conditionStage')} disabled={!form.conditionCategory}><option value="">Select stage or severity</option>{(STAGES[form.conditionCategory] || []).map((stage) => <option key={stage}>{stage}</option>)}</select></Field>
                {form.conditionStage === 'Custom' && <Field label="Custom stage / severity" required error={fieldErrors.conditionStage}><input value={form.customConditionStage} onChange={(event) => { clearFieldError('conditionStage'); update('customConditionStage')(event); }} className={fieldClass('conditionStage')} /></Field>}
                <Field label="Date of diagnosis" required error={fieldErrors.dateOfDiagnosis}><input type="date" value={form.dateOfDiagnosis} onChange={update('dateOfDiagnosis')} max={new Date().toISOString().slice(0, 10)} className={fieldClass('dateOfDiagnosis')} /></Field>
                <Field label="Attending physician" required error={fieldErrors.doctorName}><input value={form.doctorName} onChange={update('doctorName')} className={fieldClass('doctorName')} placeholder="Doctor's full name" /></Field>
                <Field label="Physician mobile number" required error={fieldErrors.physicianContact} hint="Format: +63 912 345 6789"><input type="tel" inputMode="numeric" maxLength={16} value={form.physicianContact} onChange={updatePhone('physicianContact')} className={fieldClass('physicianContact')} placeholder="+63 912 345 6789" /></Field>
                <Field label="Treatment hospital / clinic" required error={fieldErrors.treatmentHospitalClinic}><input value={form.treatmentHospitalClinic} onChange={update('treatmentHospitalClinic')} className={fieldClass('treatmentHospitalClinic')} /></Field>
                <Field label="Current treatment status" required error={fieldErrors.treatmentStatus}><input value={form.treatmentStatus} onChange={update('treatmentStatus')} className={fieldClass('treatmentStatus')} placeholder="Example: Ongoing chemotherapy" /></Field>
                <Field label="Treatment plan" required wide error={fieldErrors.treatmentPlan}><textarea value={form.treatmentPlan} onChange={update('treatmentPlan')} rows={3} className={fieldClass('treatmentPlan')} /></Field>
                <Field label="Current medications" wide error={fieldErrors.allergiesCurrentMedications}><textarea value={form.allergiesCurrentMedications} onChange={update('allergiesCurrentMedications')} rows={3} className={fieldClass('allergiesCurrentMedications')} placeholder="List current medications or write None" /></Field>
                <Field label="Insurance / PhilHealth information" error={fieldErrors.insurancePhilHealthInfo}><input value={form.insurancePhilHealthInfo} onChange={update('insurancePhilHealthInfo')} className={fieldClass('insurancePhilHealthInfo')} /></Field>
                <Field label="Clinical special note" error={fieldErrors.clinicalSpecialNote}><textarea value={form.clinicalSpecialNote} onChange={update('clinicalSpecialNote')} rows={2} className={fieldClass('clinicalSpecialNote')} /></Field>
              </FormSection>

              <FormSection number="4" title="Wig safety" description="These answers help staff identify possible fit or scalp-safety concerns.">
                <YesNo label="Known allergies?" value={form.hasKnownAllergies} onChange={setAnswer('hasKnownAllergies')} error={fieldErrors.hasKnownAllergies} />
                <YesNo label="Sensitive scalp?" value={form.hasSensitiveScalp} onChange={setAnswer('hasSensitiveScalp')} error={fieldErrors.hasSensitiveScalp} />
                <YesNo label="Scalp irritation?" value={form.hasScalpIrritation} onChange={setAnswer('hasScalpIrritation')} error={fieldErrors.hasScalpIrritation} />
                <YesNo label="Open scalp wounds?" value={form.hasOpenScalpWounds} onChange={setAnswer('hasOpenScalpWounds')} error={fieldErrors.hasOpenScalpWounds} />
                <YesNo label="Medical restriction for wearing a wig?" value={form.hasMedicalRestriction} onChange={setAnswer('hasMedicalRestriction')} error={fieldErrors.hasMedicalRestriction} />
                {form.hasKnownAllergies === 'yes' && <Field label="Allergy details" required error={fieldErrors.allergyDetails}><textarea value={form.allergyDetails} onChange={update('allergyDetails')} rows={3} className={fieldClass('allergyDetails')} /></Field>}
                {form.hasMedicalRestriction === 'yes' && <Field label="Medical restriction details" required wide error={fieldErrors.medicalRestrictionDetails}><textarea value={form.medicalRestrictionDetails} onChange={update('medicalRestrictionDetails')} rows={3} className={fieldClass('medicalRestrictionDetails')} /></Field>}
                <label data-field-error={fieldErrors.safetyInformationConfirmed ? 'true' : undefined} className={`flex items-start gap-3 rounded-xl p-4 text-sm md:col-span-2 ${fieldErrors.safetyInformationConfirmed ? 'bg-rose-50 text-rose-800 ring-1 ring-rose-300' : 'bg-slate-50 text-slate-700'}`}><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#650817]" checked={form.safetyInformationConfirmed} onChange={update('safetyInformationConfirmed')} /><span>I confirm that the wig-safety information is complete and accurate.{fieldErrors.safetyInformationConfirmed && <span className="mt-1 block text-xs font-medium text-rose-600">{fieldErrors.safetyInformationConfirmed}</span>}</span></label>
              </FormSection>

              <FormSection number="5" title="Guardian or emergency contact" description="Provide one required primary contact. A secondary contact is optional.">
                <Field label="Primary contact name" required error={fieldErrors.guardian}><input value={form.guardian} onChange={update('guardian')} className={fieldClass('guardian')} /></Field>
                <Field label="Relationship" required error={fieldErrors.guardianRelationship}><input value={form.guardianRelationship} onChange={update('guardianRelationship')} className={fieldClass('guardianRelationship')} /></Field>
                <Field label="Mobile number" required error={fieldErrors.guardianContactNumber} hint="Format: +63 912 345 6789"><input type="tel" inputMode="numeric" maxLength={16} value={form.guardianContactNumber} onChange={updatePhone('guardianContactNumber')} className={fieldClass('guardianContactNumber')} placeholder="+63 912 345 6789" /></Field>
                <Field label="Secondary contact name" error={fieldErrors.secondaryGuardian}><input value={form.secondaryGuardian} onChange={update('secondaryGuardian')} className={fieldClass('secondaryGuardian')} /></Field>
                <Field label="Secondary relationship" error={fieldErrors.secondaryGuardianRelationship}><input value={form.secondaryGuardianRelationship} onChange={update('secondaryGuardianRelationship')} className={fieldClass('secondaryGuardianRelationship')} /></Field>
                <Field label="Secondary mobile number" error={fieldErrors.secondaryGuardianContactNumber} hint="Format: +63 912 345 6789"><input type="tel" inputMode="numeric" maxLength={16} value={form.secondaryGuardianContactNumber} onChange={updatePhone('secondaryGuardianContactNumber')} className={fieldClass('secondaryGuardianContactNumber')} placeholder="+63 912 345 6789" /></Field>
              </FormSection>

              <FormSection number="6" title="Documents" description="Upload a readable medical record. A patient photo is optional.">
                <label data-field-error={fieldErrors.medicalDocument ? 'true' : undefined} className={`rounded-xl border border-dashed p-4 ${fieldErrors.medicalDocument ? 'border-rose-500 bg-rose-50' : 'border-slate-300 bg-slate-50'}`}><span className="flex items-center gap-2 text-sm font-bold"><UploadCloud size={17} /> Medical document <span className="text-rose-600">*</span></span><input type="file" accept="application/pdf,image/*" onChange={(event) => { clearFieldError('medicalDocument'); setMedicalDocument(event.target.files?.[0] || null); }} className="mt-3 block w-full text-xs" /><span className="mt-2 block text-xs text-slate-500">PDF or image, maximum 15 MB</span>{fieldErrors.medicalDocument && <span className="mt-1 block text-xs font-medium text-rose-600">{fieldErrors.medicalDocument}</span>}</label>
                <label className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4"><span className="flex items-center gap-2 text-sm font-bold"><UploadCloud size={17} /> Patient picture <span className="font-normal text-slate-400">(optional)</span></span><input type="file" accept="image/*" onChange={(event) => setPatientPicture(event.target.files?.[0] || null)} className="mt-3 block w-full text-xs" /><span className="mt-2 block text-xs text-slate-500">Image only, maximum 5 MB</span></label>
              </FormSection>
            </div>
            <footer className="sticky bottom-0 flex items-center justify-between border-t border-slate-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-7"><button type="button" onClick={() => setStep(2)} className="text-sm font-bold text-slate-600">Back</button><button type="button" onClick={() => { const issue = validateDetails(); if (issue) setNotice(issue); else { setNotice(''); setStep(4); window.scrollTo({ top: 0, behavior: 'smooth' }); } }} className="inline-flex items-center gap-2 rounded-xl bg-[#650817] px-5 py-2.5 text-sm font-bold text-white">Review application <ArrowRight size={16} /></button></footer>
          </section>
        )}

        {step === 4 && (
          <section className="mt-5 rounded-xl border border-[#e7cbc6] bg-white">
            <header className="border-b border-slate-200 px-5 py-5 sm:px-7"><p className="text-xs font-bold uppercase tracking-[.16em] text-[#7a1020]">Final review</p><h1 className="mt-1 text-2xl font-bold">Confirm your application</h1><p className="mt-1 text-sm text-slate-600">Check every section before submitting. You cannot edit the application afterward.</p></header>
            <div className="px-5 py-6 sm:px-7">
              <ReviewSection title="Applicant and contact"><ReviewItem label="Applicant" value={displayName} /><ReviewItem label="Verified email" value={verifiedEmail} /><ReviewItem label="Birthdate" value={form.birthdate} /><ReviewItem label="Gender" value={form.gender} /><ReviewItem label="Mobile number" value={form.contactNumber} /><ReviewItem label="Selected hospital" value={hospital.name} /></ReviewSection>
              <ReviewSection title="Home address"><ReviewItem label="Complete address" wide value={[form.street, form.barangay, form.city, form.province, form.region, form.country].filter(Boolean).join(', ')} /></ReviewSection>
              <ReviewSection title="Clinical information"><ReviewItem label="Condition" value={`${medicalCondition}${conditionStage ? ` · ${conditionStage}` : ''}`} /><ReviewItem label="Diagnosis date" value={form.dateOfDiagnosis} /><ReviewItem label="Attending physician" value={form.doctorName} /><ReviewItem label="Physician mobile" value={form.physicianContact} /><ReviewItem label="Treatment hospital / clinic" value={form.treatmentHospitalClinic} /><ReviewItem label="Treatment status" value={form.treatmentStatus} /><ReviewItem label="Treatment plan" wide value={form.treatmentPlan} /><ReviewItem label="Current medications" wide value={form.allergiesCurrentMedications || 'None stated'} /></ReviewSection>
              <ReviewSection title="Safety, contacts, and documents"><ReviewItem label="Known allergies" value={form.hasKnownAllergies === 'yes' ? form.allergyDetails : 'No'} /><ReviewItem label="Medical restriction" value={form.hasMedicalRestriction === 'yes' ? form.medicalRestrictionDetails : 'No'} /><ReviewItem label="Primary contact" value={`${form.guardian} · ${form.guardianRelationship}`} /><ReviewItem label="Primary contact number" value={form.guardianContactNumber} /><ReviewItem label="Medical document" value={medicalDocument?.name} /><ReviewItem label="Patient picture" value={patientPicture?.name || 'Not provided (optional)'} /></ReviewSection>
            </div>
            <footer className="flex justify-between border-t border-slate-200 px-5 py-4 sm:px-7"><button type="button" onClick={() => setStep(3)} className="text-sm font-bold text-slate-600">Back to edit</button><button type="button" onClick={() => setShowSubmitConfirmation(true)} disabled={busy === 'submit'} className="inline-flex items-center gap-2 rounded-xl bg-[#650817] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60"><CheckCircle2 size={16} /> Submit application</button></footer>
          </section>
        )}

        {step === 5 && success && <section className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50/40 p-8 text-center"><CheckCircle2 size={42} className="mx-auto text-emerald-600" /><h1 className="mt-4 text-2xl font-bold">Application submitted</h1><p className="mt-2 text-sm text-slate-600">We sent a confirmation email to {verifiedEmail}. The hospital will email you after making a decision.</p><div className="mx-auto mt-5 max-w-sm rounded-xl bg-white p-4"><p className="text-xs font-bold uppercase text-slate-500">Application reference</p><p className="mt-1 font-mono text-xl font-bold text-[#650817]">{success.applicationCode}</p></div><button type="button" onClick={() => window.location.assign('/')} className="mt-6 rounded-xl bg-[#650817] px-5 py-2.5 text-sm font-bold text-white">Return to landing page</button></section>}
      </div>

      {showSubmitConfirmation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="patient-submit-title" onClick={() => { if (busy !== 'submit') setShowSubmitConfirmation(false); }}>
          <section className="w-full max-w-lg rounded-2xl border border-[#e7cbc6] bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#650817]/10 text-[#650817]"><MailCheck size={22} /></div>
            <h2 id="patient-submit-title" className="mt-4 text-xl font-bold text-slate-800">Submit your patient application?</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Your confidential information will be sent to {hospital.name} for review.</p>
            <ul className="mt-5 space-y-3 rounded-xl bg-[#f8fafc] p-4 text-sm leading-5 text-slate-700">
              <li className="flex gap-2.5"><CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /><span>A confirmation email and application reference will be sent to <strong>{verifiedEmail}</strong>.</span></li>
              <li className="flex gap-2.5"><CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /><span>If approved, you will receive your patient code and mobile-app login credentials by email.</span></li>
              <li className="flex gap-2.5"><CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /><span>If rejected, no account will be created and you may submit a new application.</span></li>
            </ul>
            <div className="mt-6 flex justify-end gap-2"><button type="button" disabled={busy === 'submit'} onClick={() => setShowSubmitConfirmation(false)} className="rounded-lg border border-[#e1c3bd] px-4 py-2.5 text-sm font-bold text-slate-600 disabled:opacity-50">Go back</button><button type="button" onClick={submit} disabled={busy === 'submit'} className="inline-flex items-center gap-2 rounded-lg bg-[#650817] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-60">{busy === 'submit' ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}{busy === 'submit' ? 'Submitting...' : 'Confirm submission'}</button></div>
          </section>
        </div>
      )}
    </main>
  );
}
