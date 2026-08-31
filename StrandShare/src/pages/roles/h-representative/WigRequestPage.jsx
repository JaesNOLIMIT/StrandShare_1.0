import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { jsPDF } from 'jspdf';
import { AlertTriangle, CheckCircle2, FileText, Info, Loader2, Search, X } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import ReleaseDateApprovalPage from './ReleaseDateApprovalPage';

const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
const LEGACY_USERS_TABLE = 'Users';
const USER_DETAILS_TABLE = 'user_details';
const LEGACY_USER_DETAILS_TABLE = 'User_Details';
const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const WIG_REQUESTS_TABLE = 'Wig_Requests';
const WIG_SPECS_TABLE = 'Wig_Specifications';
const WIGS_TABLE = 'Wigs';
const WIG_FILTERS_TABLE = 'Wig_AI_Filters';
const RELEASE_SCHEDULES_TABLE = 'Release_Schedules';
const SAFETY_ASSESSMENTS_TABLE = 'patient_wig_safety_assessments';

const PATIENT_ASSETS_BUCKET = 'patient_assets';
const PROFILE_PICTURES_BUCKET = 'profile_pictures';
const WIG_REQUEST_PREVIEWS_BUCKET = 'wig_request_previews';
const WIG_AI_FILTERS_BUCKET = 'wig_ai_filters';
const WIG_AI_SOURCES_BUCKET = 'wig_ai_sources';
const BRANDING_BUCKET = 'branding_assests';

const REQUEST_STATUS = {
  pending: 'Pending',
  acceptedWithAllocatedWig: 'Accepted - Wig Allocated',
  acceptedInProduction: 'Accepted - In Production',
  toBeRelease: 'To Be Release',
  releasing: 'Releasing',
  released: 'Released',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const tabs = [
  { id: 'new-request', label: 'Request Wig' },
  { id: 'submitted', label: 'Submitted Requests' },
];

const SUBMITTED_STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted_allocated', label: 'Accepted - Wig Allocated' },
  { id: 'accepted_in_production', label: 'Accepted - In Production' },
  { id: 'to_be_release', label: 'To Be Release' },
  { id: 'releasing', label: 'Releasing' },
  { id: 'released', label: 'Released' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'cancelled', label: 'Cancelled' },
];

const CAP_SIZE_OPTIONS = [
  { value: 'Small', label: 'Small (21-21.5 inches)' },
  { value: 'Medium', label: 'Medium (22-22.5 inches)' },
  { value: 'Large', label: 'Large (23-23.5 inches)' },
];

const EMPTY_FORM = {
  patientId: '',
  patientCode: '',
  medicalCondition: '',
  wigSpecificationId: '',
  specialNoteTemplate: '',
  hasKnownAllergies: '',
  allergyDetails: '',
  hasSensitiveScalp: '',
  hasScalpIrritation: '',
  hasOpenScalpWounds: '',
  hasMedicalRestriction: '',
  medicalRestrictionDetails: '',
  informationConfirmed: false,
};

const LABEL_CLASS = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600';
const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 transition focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200';
const READONLY_INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 border-dashed bg-slate-100 px-2.5 py-1.5 text-sm text-slate-500 cursor-not-allowed';

function normalizeStatusKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function yesNoValue(value) {
  if (value === true || value === 'yes') return 'Yes';
  if (value === false || value === 'no') return 'No';
  return 'Not answered';
}

function toNullableBoolean(value) {
  if (value === 'yes' || value === true) return true;
  if (value === 'no' || value === false) return false;
  return null;
}

function normalizeReleaseWorkflowKey(value) {
  const key = normalizeStatusKey(value);
  if (['reschedulerequested', 'hospitalreschedulerequested', 'reschedule'].includes(key)) {
    return 'hospital_reschedule_requested';
  }
  if (['pending', 'pendinghospitalapproval', 'pendingapproval'].includes(key)) {
    return 'pending_hospital_approval';
  }
  if (['approved', 'hospitalapproved', 'hospitalapproval'].includes(key)) {
    return 'hospital_approved';
  }
  return '';
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCapSizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function toCanonicalCapSize(value) {
  const key = normalizeCapSizeKey(value);

  if (['small', 's', 'xs'].includes(key) || key.startsWith('small')) return 'Small';
  if (['medium', 'm'].includes(key) || key.startsWith('medium')) return 'Medium';
  if (['large', 'l', 'xl'].includes(key) || key.startsWith('large')) return 'Large';

  return '';
}

function getCapSizeLabel(value) {
  const canonical = toCanonicalCapSize(value);
  if (!canonical) return '';
  const matched = CAP_SIZE_OPTIONS.find((row) => row.value === canonical);
  return matched?.label || canonical;
}

function getFirstPresentValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value === null || value === undefined) {
      continue;
    }

    const normalized = String(value).trim();
    if (normalized) {
      return value;
    }
  }

  return '';
}

function computeAgeFromBirthdate(birthdateValue) {
  if (!birthdateValue) {
    return '';
  }

  const birthDate = new Date(birthdateValue);
  if (Number.isNaN(birthDate.getTime())) {
    return '';
  }

  const today = new Date();
  let years = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    years -= 1;
  }

  if (years < 0 || years > 130) {
    return '';
  }

  return String(years);
}

function scoreUserDetails(detailsRow) {
  let score = 0;

  if (getFirstPresentValue(detailsRow, ['birthdate', 'Birthdate'])) score += 3;
  if (getFirstPresentValue(detailsRow, ['gender', 'Gender'])) score += 2;
  if (getFirstPresentValue(detailsRow, ['contact_number', 'Contact_Number'])) score += 1;
  if (getFirstPresentValue(detailsRow, ['city', 'City'])) score += 1;
  if (getFirstPresentValue(detailsRow, ['photo_path', 'Photo_Path'])) score += 1;

  return score;
}

function buildAddress(detailsRow) {
  const parts = [
    getFirstPresentValue(detailsRow, ['street', 'Street']),
    getFirstPresentValue(detailsRow, ['barangay', 'Barangay']),
    getFirstPresentValue(detailsRow, ['city', 'City']),
    getFirstPresentValue(detailsRow, ['province', 'Province']),
    getFirstPresentValue(detailsRow, ['region', 'Region']),
    getFirstPresentValue(detailsRow, ['country', 'Country']),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return parts.join(', ');
}

function formatRequestCode(reqId) {
  const rawCode = String(reqId || '').trim();
  if (rawCode) {
    const cleanedCode = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^WR[A-Z0-9]{6}$/.test(cleanedCode)) {
      return cleanedCode;
    }
    if (/^[0-9]+$/.test(cleanedCode)) {
      return `WR${cleanedCode.padStart(6, '0').slice(-6)}`;
    }
    return cleanedCode.startsWith('WR') ? cleanedCode : `WR${cleanedCode}`;
  }
  return 'WR------';
}

function getPatientFullName(patient, linkedDetails = null) {
  if (!patient) return 'Unknown Patient';

  const legacyFullName = [patient.First_Name, patient.Middle_Name, patient.Last_Name, patient.Suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (legacyFullName) {
    return legacyFullName;
  }

  const linkedFullName = [
    getFirstPresentValue(linkedDetails, ['first_name', 'First_Name']),
    getFirstPresentValue(linkedDetails, ['middle_name', 'Middle_Name', 'Middle_name']),
    getFirstPresentValue(linkedDetails, ['last_name', 'Last_Name']),
    getFirstPresentValue(linkedDetails, ['suffix', 'Suffix']),
  ]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (linkedFullName) {
    return linkedFullName;
  }

  return patient.Patient_Code || (patient.User_ID ? `User #${patient.User_ID}` : `Patient #${patient.Patient_ID}`);
}

function serializeSpecialNotes(payload) {
  return `SSMETA:${JSON.stringify(payload || {})}`;
}

function parseSpecialNotesPayload(specialNotesValue) {
  const raw = String(specialNotesValue || '').trim();
  if (!raw) {
    return {};
  }

  if (!raw.startsWith('SSMETA:')) {
    return {
      specialNoteTemplate: raw,
    };
  }

  try {
    const parsed = JSON.parse(raw.slice(7));
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch {
    return {
      specialNoteTemplate: raw,
    };
  }
}

function normalizeSpecNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function getCanonicalStatusKey(status) {
  const key = normalizeStatusKey(status);

  if (['pendingreview', 'pending', 'pendingvalidation', 'pendingconfirmation'].includes(key)) {
    return 'pending';
  }

  if (['acceptedwithallocatedwig', 'acceptedallocatedwig', 'acceptedwigallocated', 'allocated', 'allocatedwig'].includes(key)) {
    return 'accepted_allocated';
  }

  if (['acceptedbutnowigavailable', 'acceptednowigavailable', 'acceptedinproduction', 'inproduction', 'production', 'inprocess', 'nowigavailable', 'findingmatchingwig', 'formatching', 'matching', 'findingallocatingwig', 'findingandallocatingwig'].includes(key)) {
    return 'accepted_in_production';
  }

  if (['toberelease', 'forrelease', 'releasequeue'].includes(key)) {
    return 'to_be_release';
  }

  if (['releasing', 'releaseongoing'].includes(key)) {
    return 'releasing';
  }

  if (['readyforhandingover', 'readyforrelease', 'readyforfitting', 'readyforevent'].includes(key)) {
    return 'to_be_release';
  }

  if (['completed', 'complete', 'released', 'releasecompleted', 'done'].includes(key)) {
    return 'released';
  }

  if (['rejected', 'declined', 'denied'].includes(key)) {
    return 'rejected';
  }

  if (['cancelled', 'canceled', 'cancel'].includes(key)) {
    return 'cancelled';
  }

  // Legacy generic accepted/approved values default to allocated path.
  if (['approved', 'accepted', 'acceptedforallocation', 'confirmed'].includes(key)) {
    return 'accepted_allocated';
  }

  return 'pending';
}

function getStatusLabel(status) {
  const key = getCanonicalStatusKey(status);

  if (key === 'accepted_allocated') return REQUEST_STATUS.acceptedWithAllocatedWig;
  if (key === 'accepted_in_production') return REQUEST_STATUS.acceptedInProduction;
  if (key === 'to_be_release') return REQUEST_STATUS.toBeRelease;
  if (key === 'releasing') return REQUEST_STATUS.releasing;
  if (key === 'released') return REQUEST_STATUS.released;
  if (key === 'rejected') return REQUEST_STATUS.rejected;
  if (key === 'cancelled') return REQUEST_STATUS.cancelled;
  return REQUEST_STATUS.pending;
}

function statusClass(status) {
  const key = getCanonicalStatusKey(status);
  if (key === 'accepted_allocated') return 'bg-emerald-100 text-emerald-700';
  if (key === 'accepted_in_production') return 'bg-blue-100 text-blue-700';
  if (key === 'to_be_release') return 'bg-indigo-100 text-indigo-700';
  if (key === 'releasing') return 'bg-teal-100 text-teal-700';
  if (key === 'released') return 'bg-green-100 text-green-700';
  if (key === 'rejected') return 'bg-red-100 text-red-700';
  if (key === 'cancelled') return 'bg-slate-200 text-slate-700';
  return 'bg-amber-100 text-amber-700';
}

function getJourneyPath(statusKey) {

  const allocatedPath = [
    {
      id: 'pending',
      title: REQUEST_STATUS.pending,
      note: 'Request submitted and queued for review.',
    },
    {
      id: 'accepted_allocated',
      title: REQUEST_STATUS.acceptedWithAllocatedWig,
      note: 'Request accepted and an available wig has been allocated.',
    },
    {
      id: 'to_be_release',
      title: REQUEST_STATUS.toBeRelease,
      note: 'Request is waiting for hospital release approval and scheduling confirmation.',
    },
    {
      id: 'releasing',
      title: REQUEST_STATUS.releasing,
      note: 'H-Representative approved schedule and release processing is ongoing.',
    },
    {
      id: 'released',
      title: REQUEST_STATUS.released,
      note: 'Release is completed and request has reached its final state.',
    },
  ];

  const productionPath = [
    {
      id: 'pending',
      title: REQUEST_STATUS.pending,
      note: 'Request submitted and queued for review.',
    },
    {
      id: 'accepted_in_production',
      title: REQUEST_STATUS.acceptedInProduction,
      note: 'No matching stock was available. The request is queued for priority specialist production.',
    },
    {
      id: 'to_be_release',
      title: REQUEST_STATUS.toBeRelease,
      note: 'Request is waiting for hospital release approval and scheduling confirmation.',
    },
    {
      id: 'releasing',
      title: REQUEST_STATUS.releasing,
      note: 'H-Representative approved schedule and release processing is ongoing.',
    },
    {
      id: 'released',
      title: REQUEST_STATUS.released,
      note: 'Release is completed and request has reached its final state.',
    },
  ];

  const rejectedPath = [
    {
      id: 'pending',
      title: REQUEST_STATUS.pending,
      note: 'Request submitted and queued for review.',
    },
    {
      id: 'rejected',
      title: REQUEST_STATUS.rejected,
      note: 'Request was rejected during review and will not proceed.',
    },
  ];

  const cancelledPath = [
    {
      id: 'pending',
      title: REQUEST_STATUS.pending,
      note: 'Request submitted and queued for review.',
    },
    {
      id: 'cancelled',
      title: REQUEST_STATUS.cancelled,
      note: 'Request was cancelled and closed.',
    },
  ];

  if (statusKey === 'accepted_allocated') {
    return { steps: allocatedPath, currentStepId: 'accepted_allocated' };
  }

  if (statusKey === 'accepted_in_production') {
    return { steps: productionPath, currentStepId: 'accepted_in_production' };
  }

  if (statusKey === 'to_be_release') {
    return { steps: productionPath, currentStepId: 'to_be_release' };
  }

  if (statusKey === 'releasing') {
    return { steps: productionPath, currentStepId: 'releasing' };
  }

  if (statusKey === 'released') {
    return { steps: productionPath, currentStepId: 'released' };
  }

  if (statusKey === 'rejected') {
    return { steps: rejectedPath, currentStepId: 'rejected' };
  }

  if (statusKey === 'cancelled') {
    return { steps: cancelledPath, currentStepId: 'cancelled' };
  }

  return { steps: productionPath, currentStepId: 'pending' };
}

function mapWigRequestInsertError(rawMessage) {
  const message = String(rawMessage || 'Unable to submit wig request.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('create_wig_request_with_spec') && lowerMessage.includes('function')) {
    return 'Database submit function is missing. Apply SQL migration 113_fix_wig_request_submit_rls_and_rpc.sql, then retry.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Action blocked by database policy. Apply SQL migration 113_fix_wig_request_submit_rls_and_rpc.sql, then retry.';
  }

  if (lowerMessage.includes('permission denied') && lowerMessage.includes('wig_request')) {
    return 'Permission denied on wig request tables. Apply SQL migration 113_fix_wig_request_submit_rls_and_rpc.sql, then retry.';
  }

  return message;
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function resolveStoragePublicUrl(bucket, pathValue) {
  const normalizedPath = String(pathValue || '').trim();
  if (!normalizedPath) {
    return '';
  }

  if (isAbsoluteUrl(normalizedPath)) {
    return normalizedPath;
  }

  if (!supabase) {
    return '';
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(normalizedPath);
  return data?.publicUrl || '';
}

async function resolveStorageSignedUrl(bucket, pathValue, expiresInSeconds = 3600) {
  const normalizedPath = String(pathValue || '').trim();
  if (!normalizedPath || !supabase) {
    return '';
  }

  if (isAbsoluteUrl(normalizedPath)) {
    return normalizedPath;
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(normalizedPath, expiresInSeconds);

  if (error) {
    return '';
  }

  return String(data?.signedUrl || '').trim();
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || '').trim());
}

async function fetchImageAsDataUrl(imageUrl) {
  const normalizedUrl = String(imageUrl || '').trim();
  if (!normalizedUrl) {
    return '';
  }

  if (isDataUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  try {
    const response = await fetch(normalizedUrl, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
    });

    if (!response.ok) {
      return '';
    }

    const blob = await response.blob();
    if (!blob || !blob.size) {
      return '';
    }

    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}

function getPdfImageFormat(dataUrl) {
  const normalized = String(dataUrl || '').trim().toLowerCase();
  if (normalized.startsWith('data:image/png')) return 'PNG';
  if (normalized.startsWith('data:image/webp')) return 'WEBP';
  return 'JPEG';
}

function getAvatarInitials(nameValue) {
  const words = String(nameValue || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return 'PT';
  }

  const first = words[0].charAt(0).toUpperCase();
  const second = words.length > 1 ? words[1].charAt(0).toUpperCase() : '';
  return `${first}${second}` || 'PT';
}

function getAvatarFallbackDataUrl(nameValue) {
  const initials = getAvatarInitials(nameValue);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="60" fill="#0f172a"/><text x="60" y="66" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="40" font-weight="700">${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function safePreviewValue(value) {
  const normalized = String(value || '').trim();
  return normalized || 'N/A';
}

function sanitizeFileNamePart(value) {
  return String(value || 'value')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'value';
}

function formatPreviewDate(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  const datePart = parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timePart = parsed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

function formatRequestDateTime(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  return parsed.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function AvatarCircle({ photoUrl, name, sizeClass = 'h-10 w-10' }) {
  const fallbackSrc = useMemo(() => getAvatarFallbackDataUrl(name), [name]);
  const [imageSrc, setImageSrc] = useState(photoUrl || fallbackSrc);

  useEffect(() => {
    setImageSrc(photoUrl || fallbackSrc);
  }, [photoUrl, fallbackSrc]);

  return (
    <img
      src={imageSrc}
      alt={name ? `${name} profile` : 'Patient profile'}
      className={`${sizeClass} rounded-full border border-slate-200 bg-slate-100 object-cover`}
      onError={() => setImageSrc(fallbackSrc)}
    />
  );
}

function PatientDetailRow({ label, value }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-xs font-medium leading-4 text-slate-800">{safePreviewValue(value)}</dd>
    </div>
  );
}

function WigPreviewImage({
  label,
  candidates = [],
  imageClassName = 'h-24',
  showLabel = true,
  containerClassName = '',
}) {
  const normalizedCandidates = useMemo(
    () => (Array.isArray(candidates) ? candidates.filter(Boolean) : []),
    [candidates],
  );
  const candidateKey = useMemo(() => normalizedCandidates.join('|'), [normalizedCandidates]);
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [candidateKey]);

  const currentSrc = normalizedCandidates[candidateIndex] || '';

  return (
    <div className={`rounded-md border border-slate-200 bg-slate-50 p-1.5 ${containerClassName}`}>
      {showLabel ? <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p> : null}
      {currentSrc ? (
        <img
          src={currentSrc}
          alt={`${label} wig preview`}
          className={`${showLabel ? 'mt-1' : ''} w-full rounded object-cover ${imageClassName}`}
          onError={() => {
            setCandidateIndex((prev) => (prev < normalizedCandidates.length - 1 ? prev + 1 : prev));
          }}
        />
      ) : (
        <div className={`${showLabel ? 'mt-1' : ''} flex items-center justify-center rounded border border-dashed border-slate-300 bg-white text-[11px] text-slate-500 ${imageClassName}`}>
          No image
        </div>
      )}
    </div>
  );
}

export default function WigRequestPage({ userProfile, isActivePage = true }) {
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState('new-request');

  const [hospitalId, setHospitalId] = useState(null);
  const [patients, setPatients] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [userDetailsByUserId, setUserDetailsByUserId] = useState({});
  const [wigRequests, setWigRequests] = useState([]);
  const [currentReleaseSchedules, setCurrentReleaseSchedules] = useState([]);
  const [safetyAssessmentsByReqId, setSafetyAssessmentsByReqId] = useState({});
  const [wigSpecifications, setWigSpecifications] = useState([]);

  const [form, setForm] = useState(EMPTY_FORM);
  const [patientSearchTerm, setPatientSearchTerm] = useState('');
  const [patientSearchOpen, setPatientSearchOpen] = useState(false);
  const [submittedStatusFilter, setSubmittedStatusFilter] = useState('all');
  const [submittedSearchTerm, setSubmittedSearchTerm] = useState('');
  const [submittedView, setSubmittedView] = useState('list');
  const [submittedMonth, setSubmittedMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [submittedDateFrom, setSubmittedDateFrom] = useState('');
  const [submittedDateTo, setSubmittedDateTo] = useState('');

  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isResolvingHospital, setIsResolvingHospital] = useState(false);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [isLoadingSubmitted, setIsLoadingSubmitted] = useState(false);
  const [isLoadingWigSpecifications, setIsLoadingWigSpecifications] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingPreview, setIsUploadingPreview] = useState(false);
  const [requestConfirmationOpen, setRequestConfirmationOpen] = useState(false);
  const [requestSuccessModal, setRequestSuccessModal] = useState({ open: false, requestCode: '', isWish: false });
  const [liveRequestPdfPreviewUrl, setLiveRequestPdfPreviewUrl] = useState('');
  const [isBuildingLivePdfPreview, setIsBuildingLivePdfPreview] = useState(false);
  const [selectedSubmittedRequest, setSelectedSubmittedRequest] = useState(null);

  const patientSearchContainerRef = useRef(null);
  const livePdfPreviewUrlRef = useRef('');

  const patientById = useMemo(() => {
    const map = new Map();
    patients.forEach((patient) => {
      map.set(Number(patient.Patient_ID), patient);
    });
    return map;
  }, [patients]);

  const selectedPatient = useMemo(
    () => patientById.get(Number(form.patientId || 0)) || null,
    [patientById, form.patientId],
  );

  const selectedPatientProfile = useMemo(() => {
    if (!selectedPatient) {
      return {
        fullName: '',
        patientCode: '',
        age: '',
        gender: '',
        email: '',
        contactNumber: '',
        address: '',
        medicalCondition: '',
        conditionCategory: '',
        conditionStage: '',
        attendingPhysician: '',
        attendingPhysicianContact: '',
        treatmentHospitalClinic: '',
        treatmentPlan: '',
        treatmentStatus: '',
        allergiesMedications: '',
        insurancePhilHealth: '',
        clinicalSpecialNote: '',
        guardian: '',
        guardianRelationship: '',
        guardianContact: '',
        secondaryGuardian: '',
        secondaryGuardianRelationship: '',
        secondaryGuardianContact: '',
        photoUrl: '',
      };
    }

    const linkedUserId = Number(selectedPatient.User_ID || 0);
    const linkedUser = linkedUserId ? usersById[linkedUserId] : null;
    const linkedUserDetails = linkedUserId ? userDetailsByUserId[linkedUserId] : null;

    const birthdate = getFirstPresentValue(linkedUserDetails, ['birthdate', 'Birthdate']);
    const resolvedAge = computeAgeFromBirthdate(birthdate);

    const detailsGender = String(getFirstPresentValue(linkedUserDetails, ['gender', 'Gender']) || '').trim();

    const patientPicturePath = String(selectedPatient.Patient_Picture || '').trim();
    const detailsPhotoPath = String(getFirstPresentValue(linkedUserDetails, ['photo_path', 'Photo_Path']) || '').trim();

    const resolvedPhotoUrl =
      resolveStoragePublicUrl(PATIENT_ASSETS_BUCKET, patientPicturePath)
      || resolveStoragePublicUrl(PROFILE_PICTURES_BUCKET, detailsPhotoPath)
      || '';

    return {
      fullName: getPatientFullName(selectedPatient, linkedUserDetails),
      patientCode: String(selectedPatient.Patient_Code || `Patient #${selectedPatient.Patient_ID}`).trim(),
      age: resolvedAge || 'N/A',
      gender: detailsGender || 'N/A',
      email: String(getFirstPresentValue(linkedUser, ['email', 'Email']) || '').trim() || 'N/A',
      contactNumber: String(getFirstPresentValue(linkedUserDetails, ['contact_number', 'Contact_Number']) || '').trim() || 'N/A',
      address: buildAddress(linkedUserDetails) || 'N/A',
      medicalCondition: String(selectedPatient.Medical_Condition || '').trim() || 'N/A',
      conditionCategory: String(selectedPatient.Condition_Category || '').trim() || 'N/A',
      conditionStage: String(selectedPatient.Condition_Stage_Severity || '').trim() || 'N/A',
      attendingPhysician: String(selectedPatient.Doctor_Name || '').trim() || 'N/A',
      attendingPhysicianContact: String(selectedPatient.Attending_Physician_Contact || '').trim() || 'N/A',
      treatmentHospitalClinic: String(selectedPatient.Treatment_Hospital_Clinic || '').trim() || 'N/A',
      treatmentPlan: String(selectedPatient.Treatment_Plan || '').trim() || 'N/A',
      treatmentStatus: String(selectedPatient.Current_Treatment_Status || '').trim() || 'N/A',
      allergiesMedications: String(selectedPatient.Allergies_Current_Medications || '').trim() || 'N/A',
      insurancePhilHealth: String(selectedPatient.Insurance_PhilHealth_Info || '').trim() || 'N/A',
      clinicalSpecialNote: String(selectedPatient.Clinical_Special_Note || '').trim() || 'N/A',
      guardian: String(selectedPatient.Guardian || '').trim() || 'N/A',
      guardianRelationship: String(selectedPatient.Guardian_Relationship || '').trim() || 'N/A',
      guardianContact: String(selectedPatient.Guardian_Contact_Number || '').trim() || 'N/A',
      secondaryGuardian: String(selectedPatient.Secondary_Guardian || '').trim() || 'N/A',
      secondaryGuardianRelationship: String(selectedPatient.Secondary_Guardian_Relationship || '').trim() || 'N/A',
      secondaryGuardianContact: String(selectedPatient.Secondary_Guardian_Contact_Number || '').trim() || 'N/A',
      photoUrl: resolvedPhotoUrl,
    };
  }, [selectedPatient, usersById, userDetailsByUserId]);

  const selectedRequestedSpecification = useMemo(() => {
    const targetSpecId = normalizeSpecNumber(form.wigSpecificationId);
    if (!targetSpecId) {
      return null;
    }

    return wigSpecifications.find((row) => normalizeSpecNumber(row.specificationId) === targetSpecId) || null;
  }, [form.wigSpecificationId, wigSpecifications]);

  const wigFamilies = useMemo(() => {
    const familyMap = new Map();

    wigSpecifications.forEach((specification) => {
      const familyKey = specification.familyNumber
        ? `family-${specification.familyNumber}`
        : `wig-${specification.wigId}`;
      const current = familyMap.get(familyKey) || {
        familyKey,
        familyNumber: specification.familyNumber || null,
        wigName: specification.wigName,
        style: specification.style,
        color: specification.color,
        texture: specification.texture,
        density: specification.density,
        hairLength: specification.hairLength,
        primaryImageCandidates: specification.primaryImageCandidates || [],
        variants: [],
      };

      current.variants.push(specification);
      if (!current.primaryImageCandidates.length && specification.primaryImageCandidates?.length) {
        current.primaryImageCandidates = specification.primaryImageCandidates;
      }
      familyMap.set(familyKey, current);
    });

    return Array.from(familyMap.values())
      .map((family) => ({
        ...family,
        variants: family.variants.sort((a, b) => (
          CAP_SIZE_OPTIONS.findIndex((item) => item.value === a.capSize)
          - CAP_SIZE_OPTIONS.findIndex((item) => item.value === b.capSize)
        )),
      }))
      .sort((a, b) => `${a.wigName} ${a.style}`.localeCompare(`${b.wigName} ${b.style}`));
  }, [wigSpecifications]);

  const selectedWigFamily = useMemo(() => {
    if (!selectedRequestedSpecification) return null;
    return wigFamilies.find((family) => family.variants.some(
      (variant) => variant.specificationId === selectedRequestedSpecification.specificationId,
    )) || null;
  }, [selectedRequestedSpecification, wigFamilies]);

  const filteredPatientOptions = useMemo(() => {
    const query = normalizeSearchText(patientSearchTerm);

    const sortedPatients = [...patients].sort((a, b) => {
      const aDetails = userDetailsByUserId[Number(a.User_ID || 0)] || null;
      const bDetails = userDetailsByUserId[Number(b.User_ID || 0)] || null;
      const aName = getPatientFullName(a, aDetails);
      const bName = getPatientFullName(b, bDetails);
      return aName.localeCompare(bName, 'en', { sensitivity: 'base' });
    });

    const matchedPatients = !query
      ? sortedPatients
      : sortedPatients.filter((patient) => {
        const linkedDetails = userDetailsByUserId[Number(patient.User_ID || 0)] || null;
        const fullName = getPatientFullName(patient, linkedDetails);
        const searchable = [fullName, patient.Patient_Code, patient.Medical_Condition]
          .map((value) => normalizeSearchText(value))
          .filter(Boolean)
          .join(' ');

        return searchable.includes(query);
      });

    // Keep list unique by visible identity so duplicate-looking names are not shown twice.
    const uniquePatients = [];
    const seenKeys = new Set();

    matchedPatients.forEach((patient) => {
      const linkedDetails = userDetailsByUserId[Number(patient.User_ID || 0)] || null;
      const dedupeKey = normalizeSearchText(
        `${patient.Patient_Code || ''}|${getPatientFullName(patient, linkedDetails)}|${patient.Medical_Condition || ''}`,
      );

      if (seenKeys.has(dedupeKey)) {
        return;
      }

      seenKeys.add(dedupeKey);
      uniquePatients.push(patient);
    });

    return uniquePatients;
  }, [patients, patientSearchTerm, userDetailsByUserId]);

  const submittedRows = useMemo(() => {
      return wigRequests.map((requestRow) => {
        const reqId = Number(requestRow.Req_ID || 0);
      const patient = patientById.get(Number(requestRow.Patient_ID)) || null;
      const linkedDetails = patient ? userDetailsByUserId[Number(patient.User_ID || 0)] : null;
      const linkedUser = patient ? usersById[Number(patient.User_ID || 0)] : null;
      const rawStatusReason = String(requestRow.Status_Reason || requestRow.status_reason || '').trim();
      const specialNotesPayload = rawStatusReason.startsWith('SSMETA:')
        ? parseSpecialNotesPayload(rawStatusReason)
        : {};
      const requestedWigId = normalizeSpecNumber(requestRow.Requested_Wig_ID);
      const requestedSpecificationId = normalizeSpecNumber(requestRow.Requested_Wig_Specification_ID);
      const requestedSpecRow = requestedSpecificationId
        ? (wigSpecifications.find((row) => normalizeSpecNumber(row.specificationId) === requestedSpecificationId) || null)
        : requestedWigId
          ? (wigSpecifications.find((row) => normalizeSpecNumber(row.wigId) === requestedWigId) || null)
          : null;

        return {
          reqId,
          requestId: formatRequestCode(requestRow.Request_Code || ''),
          patient: getPatientFullName(patient, linkedDetails),
        patientId: Number(patient?.Patient_ID || 0) || null,
        patientCode: String(patient?.Patient_Code || '').trim() || 'N/A',
        patientPhotoUrl: resolveStoragePublicUrl(PATIENT_ASSETS_BUCKET, patient?.Patient_Picture)
          || resolveStoragePublicUrl(PROFILE_PICTURES_BUCKET, getFirstPresentValue(linkedDetails, ['photo_path', 'Photo_Path'])),
        patientAge: computeAgeFromBirthdate(getFirstPresentValue(linkedDetails, ['birthdate', 'Birthdate'])) || 'N/A',
        patientBirthdate: String(getFirstPresentValue(linkedDetails, ['birthdate', 'Birthdate']) || '').trim() || 'N/A',
        patientGender: String(getFirstPresentValue(linkedDetails, ['gender', 'Gender']) || '').trim() || 'N/A',
        patientEmail: String(getFirstPresentValue(linkedUser, ['email', 'Email']) || '').trim() || 'N/A',
        patientContact: String(getFirstPresentValue(linkedDetails, ['contact_number', 'Contact_Number']) || '').trim() || 'N/A',
        patientAddress: buildAddress(linkedDetails) || 'N/A',
        medicalCondition: patient?.Medical_Condition || 'N/A',
        conditionCategory: String(patient?.Condition_Category || '').trim() || 'N/A',
        conditionStage: String(patient?.Condition_Stage_Severity || '').trim() || 'N/A',
        attendingPhysician: String(patient?.Doctor_Name || '').trim() || 'N/A',
        treatmentPlan: String(patient?.Treatment_Plan || '').trim() || 'N/A',
        treatmentStatus: String(patient?.Current_Treatment_Status || '').trim() || 'N/A',
        guardianName: String(patient?.Guardian || '').trim() || 'N/A',
        guardianRelationship: String(patient?.Guardian_Relationship || '').trim() || 'N/A',
        guardianContact: String(patient?.Guardian_Contact_Number || '').trim() || 'N/A',
        secondaryGuardianName: String(patient?.Secondary_Guardian || '').trim(),
        secondaryGuardianRelationship: String(patient?.Secondary_Guardian_Relationship || '').trim(),
        secondaryGuardianContact: String(patient?.Secondary_Guardian_Contact_Number || '').trim(),
        clinicalAllergiesMedications: String(patient?.Allergies_Current_Medications || '').trim() || 'N/A',
        safetyAssessment: safetyAssessmentsByReqId[reqId] || null,
        requestDate: requestRow.Request_Date,
        updatedAt: requestRow.Updated_At || requestRow.updated_at || requestRow.Request_Date,
        previewPdfUrl: String(requestRow.Pdf_Url || requestRow.Preview_Pdf_Url || '').trim(),
        statusReason: rawStatusReason.startsWith('SSMETA:') ? '' : rawStatusReason,
        status: requestRow.Status || REQUEST_STATUS.pending,
        statusKey: getCanonicalStatusKey(requestRow.Status || REQUEST_STATUS.pending),
        statusLabel: getStatusLabel(requestRow.Status || REQUEST_STATUS.pending),
        rawStatus: requestRow.Status || REQUEST_STATUS.pending,
          isWishRequest: Boolean(requestRow.Is_Wish_Request),
          fulfillmentStatus: String(requestRow.Fulfillment_Status || '').trim(),
          fulfillmentBundleId: Number(requestRow.Fulfillment_Bundle_ID || 0) || null,
          requestSpecId: requestedSpecRow?.specificationId || null,
          requestSpecWigName: String(requestedSpecRow?.wigName || '').trim() || 'N/A',
          requestSpecStyle: String(requestedSpecRow?.style || '').trim() || 'N/A',
          requestSpecColor: String(requestedSpecRow?.color || '').trim() || 'N/A',
          requestSpecLength: String(requestedSpecRow?.hairLength ?? '').trim() || 'N/A',
          requestSpecTexture: String(requestedSpecRow?.texture || '').trim() || 'N/A',
          requestSpecDensity: String(requestedSpecRow?.density || '').trim() || 'N/A',
          requestSpecCapSize: String(requestedSpecRow?.capSizeLabel || requestedSpecRow?.capSize || '').trim() || 'N/A',
        requestSpecSpecialNote: String(specialNotesPayload?.specialNoteTemplate || '').trim() || 'N/A',
        requestSpecFrontImageUrl: requestedSpecRow?.frontImageUrl || '',
        requestSpecSideImageUrl: requestedSpecRow?.sideImageUrl || '',
        requestSpecTopImageUrl: requestedSpecRow?.topImageUrl || '',
        requestSpecBackImageUrl: requestedSpecRow?.backImageUrl || '',
        requestSpecFrontImageCandidates: requestedSpecRow?.frontImageCandidates || [],
        requestSpecSideImageCandidates: requestedSpecRow?.sideImageCandidates || [],
        requestSpecTopImageCandidates: requestedSpecRow?.topImageCandidates || [],
        requestSpecBackImageCandidates: requestedSpecRow?.backImageCandidates || [],
        requestSpecPrimaryImageCandidates: requestedSpecRow?.primaryImageCandidates || [],
      };
    });
  }, [wigRequests, patientById, safetyAssessmentsByReqId, userDetailsByUserId, usersById, wigSpecifications]);

  const submittedQuickStats = useMemo(() => {
    const rescheduleRequestIds = new Set(
      currentReleaseSchedules
        .filter((schedule) => normalizeReleaseWorkflowKey(schedule.Hospital_Decision) === 'hospital_reschedule_requested')
        .map((schedule) => Number(schedule.Req_ID || 0))
        .filter((requestId) => requestId > 0),
    );

    return [
      {
        label: 'To Be Review',
        value: submittedRows.filter((row) => row.statusKey === 'pending').length,
      },
      {
        label: 'Accepted - In Production',
        value: submittedRows.filter((row) => row.statusKey === 'accepted_in_production').length,
      },
      {
        label: 'To Be Release',
        value: submittedRows.filter((row) => row.statusKey === 'to_be_release').length,
      },
      {
        label: 'Reschedule Requested',
        value: rescheduleRequestIds.size,
      },
      {
        label: 'Released',
        value: submittedRows.filter((row) => row.statusKey === 'released').length,
      },
    ];
  }, [currentReleaseSchedules, submittedRows]);

  const statusFilteredSubmittedRows = useMemo(() => {
    if (submittedStatusFilter === 'all') {
      return submittedRows;
    }

    return submittedRows.filter((row) => row.statusKey === submittedStatusFilter);
  }, [submittedRows, submittedStatusFilter]);

  const filteredSubmittedRows = useMemo(() => {
    const query = normalizeSearchText(submittedSearchTerm);
    return statusFilteredSubmittedRows.filter((row) => {
      const parsedDate = new Date(row.requestDate);
      if (submittedDateFrom && (!Number.isNaN(parsedDate.getTime())) && parsedDate < new Date(`${submittedDateFrom}T00:00:00`)) {
        return false;
      }
      if (submittedDateTo && (!Number.isNaN(parsedDate.getTime())) && parsedDate > new Date(`${submittedDateTo}T23:59:59`)) {
        return false;
      }
      if (!query) return true;

      const searchable = [
        row.requestId,
        row.patient,
        row.medicalCondition,
        row.statusLabel,
        row.statusReason,
        row.requestSpecId,
        row.requestSpecWigName,
        row.requestSpecStyle,
        row.requestSpecColor,
        row.requestSpecDensity,
        row.requestSpecTexture,
        row.requestSpecCapSize,
        formatRequestDateTime(row.requestDate),
      ]
        .map((value) => normalizeSearchText(value))
        .filter(Boolean)
        .join(' ');

      return searchable.includes(query);
    });
  }, [statusFilteredSubmittedRows, submittedSearchTerm, submittedDateFrom, submittedDateTo]);

  const submittedCalendarDays = useMemo(() => {
    const [yearValue, monthValue] = String(submittedMonth || '').split('-').map(Number);
    const year = Number.isFinite(yearValue) ? yearValue : new Date().getFullYear();
    const monthIndex = Number.isFinite(monthValue) ? monthValue - 1 : new Date().getMonth();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const leadingBlankCount = new Date(year, monthIndex, 1).getDay();
    const rowsByDay = new Map();

    filteredSubmittedRows.forEach((row) => {
      const parsed = new Date(row.requestDate);
      if (Number.isNaN(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() !== monthIndex) return;
      const day = parsed.getDate();
      const rows = rowsByDay.get(day) || [];
      rows.push(row);
      rowsByDay.set(day, rows);
    });

    return [
      ...Array.from({ length: leadingBlankCount }, (_, index) => ({ key: `blank-${index}`, blank: true })),
      ...Array.from({ length: daysInMonth }, (_, index) => ({
        key: `day-${index + 1}`,
        day: index + 1,
        rows: rowsByDay.get(index + 1) || [],
      })),
    ];
  }, [filteredSubmittedRows, submittedMonth]);

  const previewPayload = useMemo(() => {
    return {
      generatedAt: formatPreviewDate(Date.now()),
      hospitalRef: hospitalId ? `H-Representative #${hospitalId}` : 'Unassigned',
      patientName: selectedPatientProfile.fullName,
      patientCode: selectedPatientProfile.patientCode,
      age: selectedPatientProfile.age,
      gender: selectedPatientProfile.gender,
      email: selectedPatientProfile.email,
      contactNumber: selectedPatientProfile.contactNumber,
      address: selectedPatientProfile.address,
      medicalCondition: selectedPatientProfile.medicalCondition,
      conditionCategory: selectedPatientProfile.conditionCategory,
      conditionStage: selectedPatientProfile.conditionStage,
      attendingPhysician: selectedPatientProfile.attendingPhysician,
      attendingPhysicianContact: selectedPatientProfile.attendingPhysicianContact,
      treatmentHospitalClinic: selectedPatientProfile.treatmentHospitalClinic,
      treatmentPlan: selectedPatientProfile.treatmentPlan,
      treatmentStatus: selectedPatientProfile.treatmentStatus,
      allergiesMedications: selectedPatientProfile.allergiesMedications,
      insurancePhilHealth: selectedPatientProfile.insurancePhilHealth,
      clinicalSpecialNote: selectedPatientProfile.clinicalSpecialNote,
      guardian: selectedPatientProfile.guardian,
      guardianRelationship: selectedPatientProfile.guardianRelationship,
      guardianContact: selectedPatientProfile.guardianContact,
      secondaryGuardian: selectedPatientProfile.secondaryGuardian,
      secondaryGuardianRelationship: selectedPatientProfile.secondaryGuardianRelationship,
      secondaryGuardianContact: selectedPatientProfile.secondaryGuardianContact,
      wigSpecificationId: selectedRequestedSpecification?.specificationId || '',
      stylePreference: selectedRequestedSpecification?.style || '',
      preferredColor: selectedRequestedSpecification?.color || '',
      preferredLength: selectedRequestedSpecification?.hairLength ?? '',
      hairTexture: selectedRequestedSpecification?.texture || '',
      hairDensity: selectedRequestedSpecification?.density || '',
      capSize: selectedRequestedSpecification?.capSizeLabel || selectedRequestedSpecification?.capSize || '',
      wigName: selectedRequestedSpecification?.wigName || '',
      requestSpecFrontImageUrl: selectedRequestedSpecification?.frontImageUrl || '',
      requestSpecSideImageUrl: selectedRequestedSpecification?.sideImageUrl || '',
      requestSpecTopImageUrl: selectedRequestedSpecification?.topImageUrl || '',
      requestSpecBackImageUrl: selectedRequestedSpecification?.backImageUrl || '',
      requestSpecFrontImageCandidates: selectedRequestedSpecification?.frontImageCandidates || [],
      requestSpecSideImageCandidates: selectedRequestedSpecification?.sideImageCandidates || [],
      requestSpecTopImageCandidates: selectedRequestedSpecification?.topImageCandidates || [],
      requestSpecBackImageCandidates: selectedRequestedSpecification?.backImageCandidates || [],
      requestSpecPrimaryImageCandidates: selectedRequestedSpecification?.primaryImageCandidates || [],
      specialNote: form.specialNoteTemplate,
      hasKnownAllergies: yesNoValue(form.hasKnownAllergies),
      allergyDetails: form.allergyDetails || selectedPatientProfile.allergiesMedications,
      hasSensitiveScalp: yesNoValue(form.hasSensitiveScalp),
      hasScalpIrritation: yesNoValue(form.hasScalpIrritation),
      hasOpenScalpWounds: yesNoValue(form.hasOpenScalpWounds),
      hasMedicalRestriction: yesNoValue(form.hasMedicalRestriction),
      medicalRestrictionDetails: form.medicalRestrictionDetails,
      informationConfirmed: form.informationConfirmed ? 'Yes' : 'No',
      statusOnSubmit: REQUEST_STATUS.pending,
    };
  }, [hospitalId, selectedPatientProfile, selectedRequestedSpecification, form]);

  const selectedSubmittedRequestPreviewUrl = useMemo(() => {
    if (!selectedSubmittedRequest) {
      return '';
    }

    return resolveStoragePublicUrl(WIG_REQUEST_PREVIEWS_BUCKET, selectedSubmittedRequest.previewPdfUrl);
  }, [selectedSubmittedRequest]);

  const selectedSubmittedRequestJourney = useMemo(() => {
    if (!selectedSubmittedRequest) {
      return null;
    }

    return getJourneyPath(
      selectedSubmittedRequest.statusKey || getCanonicalStatusKey(selectedSubmittedRequest.status),
    );
  }, [selectedSubmittedRequest]);

  const previewBrandName = String(theme?.brandName || 'Donivra').trim() || 'Donivra';
  const previewLogoUrl = String(theme?.logoImage || '').trim();
  const previewLogoPath = String(theme?.logoImagePath || '').trim();
  const previewLogoCandidates = useMemo(() => {
    const nextCandidates = [];
    const pushCandidate = (value) => {
      const normalized = String(value || '').trim();
      if (!normalized || nextCandidates.includes(normalized)) {
        return;
      }
      nextCandidates.push(normalized);
    };

    pushCandidate(previewLogoUrl);

    if (previewLogoPath) {
      pushCandidate(resolveStoragePublicUrl(BRANDING_BUCKET, previewLogoPath));
    }

    if (
      previewLogoUrl
      && !isAbsoluteUrl(previewLogoUrl)
      && !isDataUrl(previewLogoUrl)
      && !String(previewLogoUrl).startsWith('blob:')
    ) {
      pushCandidate(resolveStoragePublicUrl(BRANDING_BUCKET, previewLogoUrl));
    }

    return nextCandidates;
  }, [previewLogoUrl, previewLogoPath]);
  const resolveAssignedHospital = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      return;
    }

    const activeUserId = Number(userProfile?.user_id);
    if (!activeUserId) {
      setHospitalId(null);
      setNotice({ kind: 'error', text: 'Unable to resolve your account ID. Please sign in again.' });
      return;
    }

    try {
      setIsResolvingHospital(true);

      const { data, error } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .select('Hospital_ID')
        .eq('User_ID', activeUserId)
        .maybeSingle();

      if (error) throw error;

      const nextHospitalId = Number(data?.Hospital_ID || 0) || null;
      setHospitalId(nextHospitalId);

      if (!nextHospitalId) {
        setNotice({
          kind: 'error',
          text: 'No hospital assignment found for your H-Representative account. Ask Admin to assign your account to a hospital first.',
        });
      }
    } catch (error) {
      setHospitalId(null);
      setNotice({ kind: 'error', text: error.message || 'Unable to load your hospital assignment.' });
    } finally {
      setIsResolvingHospital(false);
    }
  }, [userProfile?.user_id]);

  const fetchPatients = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) {
      setPatients([]);
      setUsersById({});
      setUserDetailsByUserId({});
      return;
    }

    try {
      setIsLoadingPatients(true);
      const { data, error } = await supabase
        .from(PATIENTS_TABLE)
        .select('*')
        .eq('Hospital_ID', hospitalId)
        .order('Created_At', { ascending: false });

      if (error) throw error;

      const nextPatients = data || [];
      setPatients(nextPatients);

      const linkedUserIds = Array.from(
        new Set(
          nextPatients
            .map((row) => Number(row.User_ID))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      if (linkedUserIds.length === 0) {
        setUsersById({});
        setUserDetailsByUserId({});
        return;
      }

      let usersRows = [];

      const userAttempts = [
        { tableName: USERS_TABLE, idColumn: 'user_id', select: 'user_id,email' },
        { tableName: LEGACY_USERS_TABLE, idColumn: 'User_ID', select: 'User_ID,Email' },
      ];

      for (const attempt of userAttempts) {
        const { data: rows, error: attemptError } = await supabase
          .from(attempt.tableName)
          .select(attempt.select)
          .in(attempt.idColumn, linkedUserIds);

        if (!attemptError) {
          usersRows = rows || [];
          break;
        }
      }

      const nextUsersById = {};
      usersRows.forEach((row) => {
        const userId = Number(row.user_id ?? row.User_ID);
        if (Number.isFinite(userId) && userId > 0) {
          nextUsersById[userId] = row;
        }
      });
      setUsersById(nextUsersById);

      let detailsRows = [];

      const detailAttempts = [
        {
          tableName: USER_DETAILS_TABLE,
          idColumn: 'user_id',
          select: 'user_id,first_name,middle_name,last_name,suffix,birthdate,gender,contact_number,street,barangay,city,province,region,country,photo_path',
        },
        {
          tableName: LEGACY_USER_DETAILS_TABLE,
          idColumn: 'User_ID',
          select: 'User_ID,First_Name,Middle_name,Last_Name,Suffix,Birthdate,Gender,Contact_Number,Street,Barangay,City,Province,Region,Country,Photo_Path',
        },
      ];

      for (const attempt of detailAttempts) {
        const { data: rows, error: attemptError } = await supabase
          .from(attempt.tableName)
          .select(attempt.select)
          .in(attempt.idColumn, linkedUserIds);

        if (!attemptError) {
          detailsRows = rows || [];
          break;
        }
      }

      const nextDetailsByUserId = {};
      detailsRows.forEach((row) => {
        const userId = Number(row.user_id ?? row.User_ID);
        if (!Number.isFinite(userId) || userId <= 0) {
          return;
        }

        const currentBest = nextDetailsByUserId[userId];
        if (!currentBest || scoreUserDetails(row) > scoreUserDetails(currentBest)) {
          nextDetailsByUserId[userId] = row;
        }
      });

      setUserDetailsByUserId(nextDetailsByUserId);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load hospital patients.' });
    } finally {
      setIsLoadingPatients(false);
    }
  }, [hospitalId]);

  const fetchSubmittedRequests = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) {
      setWigRequests([]);
      setCurrentReleaseSchedules([]);
      setSafetyAssessmentsByReqId({});
      return;
    }

    try {
      setIsLoadingSubmitted(true);

      const { data: requestRows, error: requestError } = await supabase
        .from(WIG_REQUESTS_TABLE)
        .select('*')
        .eq('Hospital_ID', hospitalId)
        .order('Request_Date', { ascending: false });

      if (requestError) throw requestError;

      const nextRequestRows = requestRows || [];
      setWigRequests(nextRequestRows);

      const requestIds = nextRequestRows
        .map((row) => Number(row.Req_ID || 0))
        .filter((requestId) => requestId > 0);

      if (requestIds.length === 0) {
        setCurrentReleaseSchedules([]);
        setSafetyAssessmentsByReqId({});
      } else {
        const [scheduleResult, safetyResult] = await Promise.all([
          supabase
            .from(RELEASE_SCHEDULES_TABLE)
            .select('Req_ID, Hospital_Decision, Is_Current')
            .in('Req_ID', requestIds)
            .eq('Is_Current', true),
          supabase
            .from(SAFETY_ASSESSMENTS_TABLE)
            .select('*')
            .in('req_id', requestIds),
        ]);

        if (scheduleResult.error) throw scheduleResult.error;
        if (safetyResult.error) throw safetyResult.error;
        setCurrentReleaseSchedules(scheduleResult.data || []);
        setSafetyAssessmentsByReqId((safetyResult.data || []).reduce((accumulator, row) => {
          accumulator[Number(row.req_id)] = row;
          return accumulator;
        }, {}));
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load submitted wig requests.' });
      setCurrentReleaseSchedules([]);
      setSafetyAssessmentsByReqId({});
    } finally {
      setIsLoadingSubmitted(false);
    }
  }, [hospitalId]);

  const loadWigSpecifications = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setWigSpecifications([]);
      return;
    }

    try {
      setIsLoadingWigSpecifications(true);

      const [specRes, wigsRes, filtersRes] = await Promise.all([
        supabase
          .from(WIG_SPECS_TABLE)
          .select('Wig_Specification_ID, Wig_ID, Hair_Length, Hair_Color, Hair_Texture, Hair_Density, Cap_Size, Style')
          .order('Wig_Specification_ID', { ascending: false }),
        supabase
          .from(WIGS_TABLE)
          .select('Wig_ID, Wig_Code, Wig_Name, Catalog_Family_Number, Catalog_Image_Path, Wig_Status, Stock_Count'),
        supabase
          .from(WIG_FILTERS_TABLE)
          .select('Wig_ID, Is_Active, Status, Source_Front_Path, Source_Side_Path, Source_Top_Path, Source_Back_Path, Updated_At')
          .order('Updated_At', { ascending: false }),
      ]);

      if (specRes.error) throw specRes.error;
      if (wigsRes.error) throw wigsRes.error;
      if (filtersRes.error) throw filtersRes.error;

      const wigById = new Map(
        (wigsRes.data || [])
          .map((row) => [Number(row.Wig_ID || 0), row])
          .filter(([wigId]) => wigId > 0),
      );

      const filterByWigId = new Map();
      (filtersRes.data || []).forEach((row) => {
        const wigId = Number(row.Wig_ID || 0);
        if (!wigId || filterByWigId.has(wigId)) {
          return;
        }

        const statusKey = normalizeStatusKey(row.Status);
        if (row.Is_Active || statusKey === 'approved' || statusKey === 'pendingreview') {
          filterByWigId.set(wigId, row);
        }
      });

      const sourcePathSet = new Set();
      (filtersRes.data || []).forEach((row) => {
        ['Source_Front_Path', 'Source_Side_Path', 'Source_Top_Path', 'Source_Back_Path'].forEach((col) => {
          const pathValue = String(row?.[col] || '').trim();
          if (pathValue) {
            sourcePathSet.add(pathValue);
          }
        });
      });

      const signedSourceUrlByPath = new Map();
      await Promise.all(
        Array.from(sourcePathSet).map(async (pathValue) => {
          const signedUrl = await resolveStorageSignedUrl(WIG_AI_SOURCES_BUCKET, pathValue, 3600);
          if (signedUrl) {
            signedSourceUrlByPath.set(pathValue, signedUrl);
            return;
          }
          const legacySignedUrl = await resolveStorageSignedUrl(WIG_AI_FILTERS_BUCKET, pathValue, 3600);
          if (legacySignedUrl) {
            signedSourceUrlByPath.set(pathValue, legacySignedUrl);
          }
        }),
      );

      const specificationRows = [];
      for (const specRow of (specRes.data || [])) {
        const wigId = Number(specRow.Wig_ID || 0);
        const wigRow = wigById.get(wigId) || null;
        const filterRow = filterByWigId.get(wigId) || null;

        const stockCount = Number(wigRow?.Stock_Count || 0);
        const wigStatus = String(wigRow?.Wig_Status || '').trim();
        const isAvailable = normalizeStatusKey(wigStatus) === 'available' && stockCount > 0;

        const sourceFrontPath = String(filterRow?.Source_Front_Path || '').trim();
        const sourceSidePath = String(filterRow?.Source_Side_Path || '').trim();
        const sourceTopPath = String(filterRow?.Source_Top_Path || '').trim();
        const sourceBackPath = String(filterRow?.Source_Back_Path || '').trim();
        const catalogImagePath = String(wigRow?.Catalog_Image_Path || '').trim();
        const capSizeCanonical = toCanonicalCapSize(specRow.Cap_Size);
        const capSizeValue = capSizeCanonical || String(specRow.Cap_Size || '').trim();

        const frontImageCandidates = [
          signedSourceUrlByPath.get(sourceFrontPath),
          resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, sourceFrontPath),
          resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, catalogImagePath),
        ].filter(Boolean);

        const sideImageCandidates = [
          signedSourceUrlByPath.get(sourceSidePath),
          resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, sourceSidePath),
        ].filter(Boolean);

        const topImageCandidates = [
          signedSourceUrlByPath.get(sourceTopPath),
          resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, sourceTopPath),
        ].filter(Boolean);

        const backImageCandidates = [
          signedSourceUrlByPath.get(sourceBackPath),
          resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, sourceBackPath),
        ].filter(Boolean);

        const row = {
          specificationId: Number(specRow.Wig_Specification_ID || 0),
          wigId,
          wigCode: String(wigRow?.Wig_Code || '').trim(),
          wigName: String(wigRow?.Wig_Name || '').trim(),
          familyNumber: Number(wigRow?.Catalog_Family_Number || 0) || null,
          wigStatus: wigStatus || 'N/A',
          stockCount,
          isAvailable,
          style: String(specRow.Style || '').trim(),
          color: String(specRow.Hair_Color || '').trim(),
          texture: String(specRow.Hair_Texture || '').trim(),
          density: String(specRow.Hair_Density || '').trim(),
          capSize: capSizeValue,
          capSizeLabel: getCapSizeLabel(capSizeValue) || capSizeValue,
          hairLength: specRow.Hair_Length,
          frontImageCandidates,
          sideImageCandidates,
          topImageCandidates,
          backImageCandidates,
          primaryImageCandidates: Array.from(new Set([
            ...frontImageCandidates,
            ...sideImageCandidates,
            ...topImageCandidates,
            ...backImageCandidates,
          ].filter(Boolean))),
          frontImageUrl: frontImageCandidates[0] || '',
          sideImageUrl: sideImageCandidates[0] || '',
          topImageUrl: topImageCandidates[0] || '',
          backImageUrl: backImageCandidates[0] || '',
        };

        if (normalizeSpecNumber(row.specificationId)) {
          specificationRows.push(row);
        }
      }

      specificationRows.sort((a, b) => {
        if (a.isAvailable !== b.isAvailable) {
          return a.isAvailable ? -1 : 1;
        }
        return `${a.wigName} ${a.color} ${a.capSize}`.localeCompare(`${b.wigName} ${b.color} ${b.capSize}`);
      });

      setWigSpecifications(specificationRows);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load available wig specifications.' });
      setWigSpecifications([]);
    } finally {
      setIsLoadingWigSpecifications(false);
    }
  }, []);

  useEffect(() => {
    resolveAssignedHospital();
  }, [resolveAssignedHospital]);

  useEffect(() => {
    if (!hospitalId) {
      setPatients([]);
      setUsersById({});
      setUserDetailsByUserId({});
      setWigRequests([]);
      setCurrentReleaseSchedules([]);
      setWigSpecifications([]);
      return;
    }

    fetchPatients();
    fetchSubmittedRequests();
    loadWigSpecifications();
  }, [hospitalId, fetchPatients, fetchSubmittedRequests, loadWigSpecifications]);

  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase || !hospitalId) {
      return undefined;
    }

    const channel = supabase
      .channel(`hrep-wig-requests-${hospitalId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: WIG_REQUESTS_TABLE,
          filter: `Hospital_ID=eq.${hospitalId}`,
        },
        () => {
          void fetchSubmittedRequests();
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: RELEASE_SCHEDULES_TABLE,
        },
        () => {
          void fetchSubmittedRequests();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [hospitalId, fetchSubmittedRequests, isActivePage]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (patientSearchContainerRef.current && !patientSearchContainerRef.current.contains(event.target)) {
        setPatientSearchOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, []);

  const handleSelectPatient = (patient) => {
    const selectedPatientId = Number(patient?.Patient_ID || 0);

    if (!selectedPatientId) {
      return;
    }

    const clinicalAllergyText = String(patient.Allergies_Current_Medications || '').trim();
    const clinicalAllergyKey = normalizeSearchText(clinicalAllergyText);
    const hasUsefulAllergyText = Boolean(clinicalAllergyText)
      && !['n/a', 'na', 'none', 'no known allergies', 'no known allergy'].includes(clinicalAllergyKey);

    setForm((prev) => ({
      ...prev,
      patientId: String(selectedPatientId),
      patientCode: String(patient.Patient_Code || ''),
      medicalCondition: String(patient.Medical_Condition || ''),
      hasKnownAllergies: hasUsefulAllergyText ? 'yes' : prev.hasKnownAllergies,
      allergyDetails: hasUsefulAllergyText ? clinicalAllergyText : prev.allergyDetails,
    }));

    setPatientSearchTerm(getPatientFullName(patient, userDetailsByUserId[Number(patient.User_ID || 0)] || null));
    setPatientSearchOpen(false);
  };

  const clearSelectedPatient = () => {
    setForm((prev) => ({
      ...prev,
      patientId: '',
      patientCode: '',
      medicalCondition: '',
    }));
    setPatientSearchTerm('');
    setPatientSearchOpen(false);
  };

  const handlePatientSearchChange = (event) => {
    const nextValue = event.target.value;
    setPatientSearchTerm(nextValue);
    setPatientSearchOpen(true);

    if (form.patientId) {
      setForm((previous) => ({
        ...previous,
        patientId: '',
        patientCode: '',
        medicalCondition: '',
      }));
    }
  };

  const handleFieldChange = (event) => {
    const { name, value, type, checked } = event.target;
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
      ...(name === 'hasKnownAllergies' && value === 'no' ? { allergyDetails: '' } : {}),
      ...(name === 'hasMedicalRestriction' && value === 'no' ? { medicalRestrictionDetails: '' } : {}),
    }));
  };

  const handleSelectWigFamily = (family) => {
    const preferredVariant = family?.variants?.find((variant) => variant.isAvailable)
      || family?.variants?.[0]
      || null;
    if (!preferredVariant) return;
    setForm((previous) => ({
      ...previous,
      wigSpecificationId: String(preferredVariant.specificationId),
    }));
  };

  const handleCapSizeChange = (event) => {
    setForm((previous) => ({
      ...previous,
      wigSpecificationId: event.target.value,
    }));
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setPatientSearchTerm('');
    setPatientSearchOpen(false);
  };

  const buildPreviewFileName = useCallback((reqIdValue = 0) => {
    const patientPart = sanitizeFileNamePart(selectedPatientProfile.fullName || form.patientCode || 'patient');
    const reqPart = sanitizeFileNamePart(formatRequestCode(reqIdValue || 0));
    const datePart = new Date().toISOString().slice(0, 10);
    return `wig_request_preview_${reqPart}_${patientPart}_${datePart}.pdf`;
  }, [selectedPatientProfile.fullName, form.patientCode]);

  const buildPreviewPdfDocument = useCallback(async () => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 16;
    const contentWidth = pageWidth - margin * 2;
    const pageBottom = pageHeight - margin;
    let y = 16;

    const ensureSpace = (spaceRequired = 8) => {
      if (y + spaceRequired <= pageBottom) {
        return;
      }
      doc.addPage();
      y = 16;
    };

    const addDivider = () => {
      ensureSpace(7);
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y, pageWidth - margin, y);
      y += 6;
    };

    const addSectionTitle = (title) => {
      ensureSpace(8);
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(margin, y - 4.5, contentWidth, 7.5, 1.2, 1.2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(30, 41, 59);
      doc.setFontSize(10.5);
      doc.text(String(title || ''), margin + 1.4, y);
      y += 5;
    };

    const addField = (label, value) => {
      ensureSpace(8);
      const safeLabel = String(label || 'Field').trim();
      const wrappedValue = doc.splitTextToSize(safePreviewValue(value), contentWidth - 42);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(`${safeLabel}:`, margin, y);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(30, 41, 59);
      doc.text(wrappedValue, margin + 42, y);
      y += Math.max(5, wrappedValue.length * 4.7);
    };

    const tryAddImage = (dataUrl, x, imageY, width, height) => {
      if (!dataUrl) return false;
      try {
        doc.addImage(dataUrl, getPdfImageFormat(dataUrl), x, imageY, width, height);
        return true;
      } catch {
        return false;
      }
    };

    const resolveFirstDataUrl = async (candidates = []) => {
      const uniqueCandidates = Array.from(
        new Set(
          (Array.isArray(candidates) ? candidates : [candidates])
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      );

      for (const candidate of uniqueCandidates) {
        const dataUrl = await fetchImageAsDataUrl(candidate);
        if (dataUrl) {
          return dataUrl;
        }
      }

      return '';
    };

    const logoDataUrl = await resolveFirstDataUrl(previewLogoCandidates);

    ensureSpace(30);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(margin, y, contentWidth, 23, 2.2, 2.2, 'FD');

    const logoX = margin + 3;
    const logoY = y + 3;
    if (!tryAddImage(logoDataUrl, logoX, logoY, 10, 10)) {
      doc.setFillColor(15, 23, 42);
      doc.roundedRect(logoX, logoY, 10, 10, 1.8, 1.8, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(getAvatarInitials(previewBrandName), logoX + 2, logoY + 6.2);
    }

    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.text(previewBrandName, margin + 16, y + 7.4);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Wig Request Preview', margin + 16, y + 14.1);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`Generated: ${previewPayload.generatedAt}`, margin + 16, y + 19.2);
    y += 28;

    addDivider();

    addSectionTitle('Patient Details');
    addField('Patient Name', previewPayload.patientName);
    addField('Patient Code', previewPayload.patientCode);
    addField('Age', previewPayload.age);
    addField('Gender', previewPayload.gender);
    addField('Email', previewPayload.email);
    addField('Contact Number', previewPayload.contactNumber);
    addField('Address', previewPayload.address);
    addField('Medical Condition', previewPayload.medicalCondition);

    addDivider();

    addSectionTitle('Clinical & Guardian Information');
    addField('Condition Category', previewPayload.conditionCategory);
    addField('Stage / Severity', previewPayload.conditionStage);
    addField('Attending Physician / Oncologist', previewPayload.attendingPhysician);
    addField('Physician Contact', previewPayload.attendingPhysicianContact);
    addField('Treatment Hospital / Clinic', previewPayload.treatmentHospitalClinic);
    addField('Treatment Plan', previewPayload.treatmentPlan);
    addField('Current Treatment Status', previewPayload.treatmentStatus);
    addField('Allergies & Medications', previewPayload.allergiesMedications);
    addField('Insurance / PhilHealth', previewPayload.insurancePhilHealth);
    addField('Clinical Special Note', previewPayload.clinicalSpecialNote);
    addField('Primary Guardian', `${safePreviewValue(previewPayload.guardian)} | ${safePreviewValue(previewPayload.guardianRelationship)} | ${safePreviewValue(previewPayload.guardianContact)}`);
    addField('Secondary Guardian', `${safePreviewValue(previewPayload.secondaryGuardian)} | ${safePreviewValue(previewPayload.secondaryGuardianRelationship)} | ${safePreviewValue(previewPayload.secondaryGuardianContact)}`);

    addDivider();

    addSectionTitle('Wig Safety Assessment');
    addField('Known Allergies', previewPayload.hasKnownAllergies);
    addField('Allergy Details', previewPayload.allergyDetails);
    addField('Sensitive Scalp', previewPayload.hasSensitiveScalp);
    addField('Scalp Irritation', previewPayload.hasScalpIrritation);
    addField('Open Scalp Wounds', previewPayload.hasOpenScalpWounds);
    addField('Medical Restriction', previewPayload.hasMedicalRestriction);
    addField('Restriction Details', previewPayload.medicalRestrictionDetails);
    addField('Information Confirmed', previewPayload.informationConfirmed);

    addDivider();

    addSectionTitle('Wig Specifications');
    addField('Wig Specification ID', previewPayload.wigSpecificationId);
    addField('Wig Name', previewPayload.wigName);
    addField('Style Preference', previewPayload.stylePreference);
    addField('Preferred Color', previewPayload.preferredColor);
    addField('Preferred Length', previewPayload.preferredLength);
    addField('Hair Texture', previewPayload.hairTexture);
    addField('Hair Density', previewPayload.hairDensity);
    addField('Cap Size', previewPayload.capSize);
    addField('Special Note', previewPayload.specialNote);

    addDivider();

    const wigImageSlots = [{
      label: 'Primary catalog image',
      candidates: [
        ...(previewPayload.requestSpecPrimaryImageCandidates || []),
        previewPayload.requestSpecFrontImageUrl,
      ],
    }];

    const wigImageData = await Promise.all(
      wigImageSlots.map(async (slot) => ({
        ...slot,
        dataUrl: await resolveFirstDataUrl(slot.candidates),
      })),
    );

    addSectionTitle('Requested Wig Preview');
    const cardWidth = contentWidth;
    const cardHeight = 76;

    for (let idx = 0; idx < wigImageData.length; idx += 1) {
      const rowSlots = wigImageData.slice(idx, idx + 1);
      ensureSpace(cardHeight + 4);

      for (let slotIndex = 0; slotIndex < rowSlots.length; slotIndex += 1) {
        const slot = rowSlots[slotIndex];
          const cardX = margin;
        const cardY = y;

        doc.setDrawColor(226, 232, 240);
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 1.5, 1.5, 'FD');

        doc.setTextColor(71, 85, 105);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text(slot.label, cardX + 2.5, cardY + 5);

        const imageX = cardX + 2.5;
        const imageY = cardY + 7;
        const imageW = cardWidth - 5;
        const imageH = cardHeight - 10;

        if (!tryAddImage(slot.dataUrl, imageX, imageY, imageW, imageH)) {
          doc.setDrawColor(203, 213, 225);
          doc.setFillColor(248, 250, 252);
          doc.roundedRect(imageX, imageY, imageW, imageH, 1, 1, 'FD');
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(148, 163, 184);
          doc.text('No image available', imageX + 7, imageY + imageH / 2);
        }
      }

      y += cardHeight + 4;
    }

    addDivider();

    addSectionTitle('Submission Metadata');
    addField('H-Representative Reference', previewPayload.hospitalRef);
    addField('Initial Status', previewPayload.statusOnSubmit);

    return doc;
  }, [previewPayload, previewBrandName, previewLogoCandidates]);

  useEffect(() => {
    let cancelled = false;

    if (!selectedPatient || !selectedRequestedSpecification) {
      if (livePdfPreviewUrlRef.current) URL.revokeObjectURL(livePdfPreviewUrlRef.current);
      livePdfPreviewUrlRef.current = '';
      setLiveRequestPdfPreviewUrl('');
      setIsBuildingLivePdfPreview(false);
      return undefined;
    }

    setIsBuildingLivePdfPreview(true);

    Promise.resolve().then(async () => {
      try {
        const previewDocument = await buildPreviewPdfDocument();
        if (cancelled) return;
        const nextObjectUrl = URL.createObjectURL(previewDocument.output('blob'));
        const previousObjectUrl = livePdfPreviewUrlRef.current;
        livePdfPreviewUrlRef.current = nextObjectUrl;
        setLiveRequestPdfPreviewUrl(nextObjectUrl);
        if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
      } catch {
        // Keep the last valid preview visible if a refresh fails.
      } finally {
        if (!cancelled) setIsBuildingLivePdfPreview(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [buildPreviewPdfDocument, selectedPatient, selectedRequestedSpecification]);

  useEffect(() => () => {
    if (livePdfPreviewUrlRef.current) URL.revokeObjectURL(livePdfPreviewUrlRef.current);
  }, []);

  const uploadPreviewPdfForRequest = useCallback(async (reqIdValue) => {
    if (!supabase) {
      throw new Error('Supabase client is unavailable for preview upload.');
    }

    const safeReqId = Number(reqIdValue || 0);
    if (!safeReqId) {
      throw new Error('Unable to resolve request ID for preview upload.');
    }

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) {
      throw authError;
    }

    const authUid = authData?.user?.id;
    if (!authUid) {
      throw new Error('Unable to resolve your authenticated account. Please sign in again.');
    }

    const doc = await buildPreviewPdfDocument();
    const fileName = buildPreviewFileName(safeReqId);
    const filePath = `${authUid}/preview-pdf/${Date.now()}_${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from(WIG_REQUEST_PREVIEWS_BUCKET)
      .upload(filePath, doc.output('blob'), {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data: urlData } = supabase.storage
      .from(WIG_REQUEST_PREVIEWS_BUCKET)
      .getPublicUrl(filePath);

    return urlData?.publicUrl || filePath;
  }, [buildPreviewFileName, buildPreviewPdfDocument]);

  const validateRequestForConfirmation = () => {
    if (!isSupabaseConfigured || !supabase) {
      return 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.';
    }

    if (!hospitalId) {
      return 'You are not assigned to any hospital. Ask Admin to assign your account first.';
    }

    const selectedPatientId = Number(form.patientId || 0);
    if (!selectedPatientId) {
      return 'Please choose an existing patient first.';
    }

    const selectedSpecId = normalizeSpecNumber(form.wigSpecificationId);
    const selectedSpec = selectedSpecId
      ? (wigSpecifications.find((row) => normalizeSpecNumber(row.specificationId) === selectedSpecId) || null)
      : null;
    if (!selectedSpec) {
      return 'Please select a target wig specification.';
    }

    const unansweredSafetyField = [
      form.hasKnownAllergies,
      form.hasSensitiveScalp,
      form.hasScalpIrritation,
      form.hasOpenScalpWounds,
      form.hasMedicalRestriction,
    ].some((value) => !['yes', 'no'].includes(value));
    if (unansweredSafetyField) return 'Answer every Yes/No field in the wig safety assessment.';
    if (form.hasKnownAllergies === 'yes' && !String(form.allergyDetails || '').trim()) return 'Enter the patient allergy details.';
    if (form.hasMedicalRestriction === 'yes' && !String(form.medicalRestrictionDetails || '').trim()) return 'Enter the medical restriction details.';
    if (!form.informationConfirmed) return 'Confirm that the wig safety information was reviewed with the patient or guardian.';
    return '';
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const validationError = validateRequestForConfirmation();
    if (validationError) {
      setNotice({ kind: 'error', text: validationError });
      return;
    }
    setNotice({ kind: '', text: '' });
    setRequestConfirmationOpen(true);
  };

  const submitRequestNow = async () => {
    const validationError = validateRequestForConfirmation();
    if (validationError) {
      setRequestConfirmationOpen(false);
      setNotice({ kind: 'error', text: validationError });
      return;
    }

    const selectedPatientId = Number(form.patientId || 0);
    const selectedSpecId = normalizeSpecNumber(form.wigSpecificationId);
    const selectedSpec = wigSpecifications.find((row) => normalizeSpecNumber(row.specificationId) === selectedSpecId) || null;
    let createdRequestId = 0;

    try {
      setIsSubmitting(true);
      setNotice({ kind: '', text: '' });

      const specialNotesPayload = serializeSpecialNotes({
        specialNoteTemplate: String(form.specialNoteTemplate || '').trim(),
        wigSpecificationId: selectedSpecId,
        requestedWigId: Number(selectedSpec.wigId || 0) || null,
        wigCode: String(selectedSpec.wigCode || '').trim() || null,
      });

      const rpcPayload = {
        p_hospital_id: Number(hospitalId),
        p_patient_id: selectedPatientId,
        p_wig_specification_id: selectedSpecId,
        p_special_notes: specialNotesPayload || null,
        p_preferred_color: String(selectedSpec.color || '').trim() || null,
        p_preferred_length: String(selectedSpec.hairLength ?? '').trim() || null,
        p_hair_texture: String(selectedSpec.texture || '').trim() || null,
        p_cap_size: toCanonicalCapSize(selectedSpec.capSize) || null,
        p_style_preference: String(selectedSpec.style || '').trim() || null,
      };

      const rpcResult = await supabase.rpc('create_wig_request_with_spec', rpcPayload);
      if (rpcResult.error) throw rpcResult.error;
      const newReqId = Number(rpcResult.data || 0);

      if (!newReqId) {
        throw new Error('Unable to resolve the saved wig request ID.');
      }
      createdRequestId = newReqId;

      const safetyResult = await supabase.rpc('save_wig_request_safety_assessment', {
        p_req_id: newReqId,
        p_has_known_allergies: toNullableBoolean(form.hasKnownAllergies),
        p_allergy_details: String(form.allergyDetails || '').trim() || null,
        p_has_sensitive_scalp: toNullableBoolean(form.hasSensitiveScalp),
        p_has_scalp_irritation: toNullableBoolean(form.hasScalpIrritation),
        p_has_open_scalp_wounds: toNullableBoolean(form.hasOpenScalpWounds),
        p_has_medical_restriction: toNullableBoolean(form.hasMedicalRestriction),
        p_medical_restriction_details: String(form.medicalRestrictionDetails || '').trim() || null,
        p_information_confirmed: Boolean(form.informationConfirmed),
      });
      if (safetyResult.error) {
        await supabase.from(WIG_REQUESTS_TABLE).delete().eq('Req_ID', newReqId);
        createdRequestId = 0;
        throw safetyResult.error;
      }

      try {
        setIsUploadingPreview(true);
        const previewPdfUrl = await uploadPreviewPdfForRequest(newReqId);

        if (!previewPdfUrl) {
          throw new Error('The request PDF could not be saved. Please retry.');
        }

        const { error: savePreviewUrlError } = await supabase
          .from(WIG_REQUESTS_TABLE)
          .update({
            Pdf_Url: previewPdfUrl,
            Updated_At: new Date().toISOString(),
          })
          .eq('Req_ID', newReqId);

        if (savePreviewUrlError) {
          const lowerSaveError = String(savePreviewUrlError.message || '').toLowerCase();

          // Backward compatibility for environments that still use Preview_Pdf_Url.
          if (lowerSaveError.includes('pdf_url') && lowerSaveError.includes('column')) {
            const { error: legacySaveError } = await supabase
              .from(WIG_REQUESTS_TABLE)
              .update({
                Preview_Pdf_Url: previewPdfUrl,
                Updated_At: new Date().toISOString(),
              })
              .eq('Req_ID', newReqId);

            if (legacySaveError) {
              throw legacySaveError;
            }
          } else {
            throw savePreviewUrlError;
          }
        }
      } finally {
        setIsUploadingPreview(false);
      }

      setRequestConfirmationOpen(false);
      setRequestSuccessModal({
        open: true,
        requestCode: formatRequestCode(newReqId),
        isWish: !selectedSpec.isAvailable,
      });
      resetForm();
      void fetchSubmittedRequests();
    } catch (error) {
      if (createdRequestId) {
        await supabase.from(WIG_REQUESTS_TABLE).delete().eq('Req_ID', createdRequestId);
      }
      setRequestConfirmationOpen(false);
      setNotice({ kind: 'error', text: mapWigRequestInsertError(error.message) });
    } finally {
      setIsUploadingPreview(false);
      setIsSubmitting(false);
    }
  };

  const handleOpenSubmittedRequestPreview = (row) => {
    setSelectedSubmittedRequest(row || null);
  };

  const handleCloseSubmittedRequestPreview = () => {
    setSelectedSubmittedRequest(null);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">H-Representative Workflow</p>
        <h1 className="role-page-title mt-1 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl">Wig Requests Workspace</h1>
        <p className="mt-1 text-sm text-slate-600">
          Submit visual wig preferences, track stock and production, and complete release approvals in one place.
        </p>
      </div>

      <div className="border-b border-slate-200 bg-white">
        <nav className="-mb-px flex flex-wrap gap-6 px-1" aria-label="Wig request sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-1 py-3 text-sm font-semibold transition-colors ${
              activeTab === tab.id
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
        </nav>
      </div>

      {notice.text && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm font-medium ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
        >
          {notice.text}
        </div>
      )}

      {activeTab === 'new-request' && (
        <section className="rounded-2xl border border-slate-200 bg-slate-100/70 p-3 shadow-sm md:p-4">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-12 xl:items-start">
            <form id="wig-request-form" onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 xl:col-span-9 xl:grid-cols-9 xl:items-start">
              <section ref={patientSearchContainerRef} className="overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm xl:col-span-3">
                <div className="border-b border-slate-200 px-3 py-2.5">
                  <h2 className="text-sm font-bold text-slate-900">1. Patient Info</h2>
                </div>
                <div className="p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className={`${LABEL_CLASS} mb-0`}>Search Existing Patient</label>
                  <span className="text-[11px] font-semibold text-slate-500">
                    {isLoadingPatients ? 'Loading...' : `${patients.length} available`}
                  </span>
                </div>
                <input
                  value={patientSearchTerm}
                  onChange={handlePatientSearchChange}
                  onFocus={() => setPatientSearchOpen(true)}
                  className={INPUT_CLASS}
                  placeholder="Search by patient name, code, or medical condition"
                  disabled={isLoadingPatients || isSubmitting || isResolvingHospital}
                  required={!form.patientId}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Choose from patients assigned to this hospital. Search by name, patient code, or medical condition.
                </p>

                {patientSearchOpen && (
                  <div className="mt-2 max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white">
                    {filteredPatientOptions.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-slate-500">
                        <p>No patients match â€œ{patientSearchTerm.trim()}â€.</p>
                        {patientSearchTerm.trim() && patients.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setPatientSearchTerm('')}
                            className="mt-2 font-semibold text-blue-700 hover:text-blue-800"
                          >
                            Clear search and show all {patients.length} patients
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      filteredPatientOptions.map((patient) => {
                        const isSelected = Number(form.patientId) === Number(patient.Patient_ID);
                        const linkedDetails = userDetailsByUserId[Number(patient.User_ID || 0)];
                        const patientName = getPatientFullName(patient, linkedDetails);
                        const patientPicUrl = resolveStoragePublicUrl(PATIENT_ASSETS_BUCKET, patient.Patient_Picture)
                          || resolveStoragePublicUrl(PROFILE_PICTURES_BUCKET, getFirstPresentValue(linkedDetails, ['photo_path', 'Photo_Path']))
                          || '';

                        return (
                          <button
                            key={patient.Patient_ID}
                            type="button"
                            onClick={() => handleSelectPatient(patient)}
                            className={`block w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50 ${
                              isSelected ? 'bg-slate-50' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <AvatarCircle photoUrl={patientPicUrl} name={patientName} sizeClass="h-9 w-9" />
                              <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-slate-900">{patientName}</p>
                                <p className="truncate text-xs text-slate-500">
                                  {patient.Patient_Code || `Patient #${patient.Patient_ID}`}
                                  {patient.Medical_Condition ? ` - ${patient.Medical_Condition}` : ''}
                                </p>
                              </div>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}

                {form.patientId && (
                  <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <AvatarCircle
                        photoUrl={selectedPatientProfile.photoUrl}
                        name={selectedPatientProfile.fullName}
                        sizeClass="h-12 w-12"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {selectedPatientProfile.fullName || 'Selected patient'}
                        </p>
                        <p className="truncate text-xs text-slate-500">{selectedPatientProfile.patientCode || 'No patient code'}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={clearSelectedPatient}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700"
                    >
                      Clear
                    </button>
                  </div>
                )}

                {form.patientId ? (
                  <div className="mt-4 border-t border-slate-200 pt-3">
                    <p className="mb-3 text-xs font-bold text-slate-900">Personal details</p>
                    <dl className="space-y-3">
                      <PatientDetailRow label="Patient ID" value={selectedPatientProfile.patientCode} />
                      <PatientDetailRow label="Name" value={selectedPatientProfile.fullName} />
                      <div className="grid grid-cols-2 gap-3">
                        <PatientDetailRow label="Age" value={selectedPatientProfile.age} />
                        <PatientDetailRow label="Gender" value={selectedPatientProfile.gender} />
                      </div>
                      <PatientDetailRow label="Email" value={selectedPatientProfile.email} />
                      <PatientDetailRow label="Contact" value={selectedPatientProfile.contactNumber} />
                      <PatientDetailRow label="Address" value={selectedPatientProfile.address} />
                      <PatientDetailRow label="Medical Condition" value={selectedPatientProfile.medicalCondition} />
                    </dl>
                  </div>
                ) : !patientSearchOpen ? (
                  <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                    <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                      <p className="text-xs font-bold text-slate-700">Hospital Patient Directory</p>
                      <span className="text-[11px] text-slate-500">{filteredPatientOptions.length} shown</span>
                    </div>
                    {isLoadingPatients ? (
                      <p className="px-3 py-5 text-center text-xs text-slate-500">Loading patients...</p>
                    ) : filteredPatientOptions.length === 0 ? (
                      <div className="px-3 py-5 text-center text-xs text-slate-500">
                        <p>{patients.length === 0 ? 'No patients are assigned to this hospital yet.' : 'No patients match the current search.'}</p>
                        {patientSearchTerm.trim() && patients.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setPatientSearchTerm('')}
                            className="mt-2 font-semibold text-blue-700 hover:text-blue-800"
                          >
                            Show all patients
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <div className="max-h-64 divide-y divide-slate-200 overflow-y-auto">
                        {filteredPatientOptions.map((patient) => {
                          const linkedDetails = userDetailsByUserId[Number(patient.User_ID || 0)];
                          const patientName = getPatientFullName(patient, linkedDetails);
                          const patientPicUrl = resolveStoragePublicUrl(PATIENT_ASSETS_BUCKET, patient.Patient_Picture)
                            || resolveStoragePublicUrl(PROFILE_PICTURES_BUCKET, getFirstPresentValue(linkedDetails, ['photo_path', 'Photo_Path']))
                            || '';

                          return (
                            <button
                              key={`directory-${patient.Patient_ID}`}
                              type="button"
                              onClick={() => handleSelectPatient(patient)}
                              className="flex w-full items-center gap-2 bg-white px-3 py-2 text-left hover:bg-blue-50"
                            >
                              <AvatarCircle photoUrl={patientPicUrl} name={patientName} sizeClass="h-9 w-9" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-bold text-slate-900">{patientName}</span>
                                <span className="block truncate text-[11px] text-slate-500">
                                  {patient.Patient_Code || `Patient #${patient.Patient_ID}`}
                                  {patient.Medical_Condition ? ` Â· ${patient.Medical_Condition}` : ''}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}
                </div>
              </section>

              <section className="grid grid-cols-1 gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-2 xl:col-span-6">
                <div className="-mx-3 -mt-3 border-b border-slate-200 px-3 py-2.5 md:col-span-2">
                  <h2 className="text-sm font-bold text-slate-900">2. Wig Specs</h2>
                </div>
                <div className="md:col-span-2">
                  <p className="text-xs text-slate-500">Choose one visual design, then adjust only its available cap-size preference. Other catalog details remain unchanged.</p>
                </div>

                <div className="md:col-span-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className={LABEL_CLASS}>Wig Catalog</label>
                    <button
                      type="button"
                      onClick={() => { void loadWigSpecifications(); }}
                      disabled={isLoadingWigSpecifications || isSubmitting || isUploadingPreview}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                    >
                      {isLoadingWigSpecifications ? 'Refreshing...' : 'Refresh list'}
                    </button>
                  </div>
                  <div className="grid max-h-[440px] grid-cols-2 gap-2 overflow-y-auto pr-1 2xl:grid-cols-3">
                    {wigFamilies.map((family) => {
                      const isSelected = selectedWigFamily?.familyKey === family.familyKey;
                      return (
                        <button
                          key={family.familyKey}
                          type="button"
                          onClick={() => handleSelectWigFamily(family)}
                          disabled={isSubmitting || isUploadingPreview}
                          className={`group overflow-hidden rounded-lg border p-1.5 text-left transition ${
                            isSelected
                              ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-100'
                              : 'border-slate-200 bg-white hover:border-blue-300 hover:shadow-sm'
                          }`}
                        >
                          <div className="relative overflow-hidden rounded-md bg-slate-100">
                            <WigPreviewImage
                              label={family.wigName || 'Catalog wig'}
                              candidates={family.primaryImageCandidates}
                              imageClassName="h-36 sm:h-40"
                              showLabel={false}
                              containerClassName="border-0 bg-transparent p-0"
                            />
                          </div>
                          <div className="px-1 pb-1 pt-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="line-clamp-2 text-xs font-bold text-slate-900">{family.wigName || 'Catalog wig'}</p>
                                <p className="mt-0.5 text-xs text-slate-500">{family.style || 'Style not labeled'} Â· {family.color || 'Color N/A'}</p>
                              </div>
                              {isSelected ? <CheckCircle2 size={16} className="shrink-0 text-blue-600" /> : null}
                            </div>
                            <p className="mt-2 text-[11px] text-slate-500">
                              {family.hairLength ? `${family.hairLength} in Â· ` : ''}{family.texture || 'Texture N/A'} Â· {family.density || 'Density N/A'}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {!isLoadingWigSpecifications && wigSpecifications.length === 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      No wig specification records found. Ask specialist to create wig specifications first.
                    </p>
                  )}
                </div>

                <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  {selectedWigFamily && selectedRequestedSpecification ? (
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <div className="w-full shrink-0 sm:w-28">
                        <WigPreviewImage
                          label={selectedWigFamily.wigName || 'Selected wig'}
                          candidates={selectedWigFamily.primaryImageCandidates}
                          imageClassName="h-32"
                          showLabel={false}
                          containerClassName="border-0 bg-transparent p-0"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Selected wig</p>
                        <h3 className="mt-0.5 text-sm font-bold text-slate-900">{selectedWigFamily.wigName || 'Catalog wig'}</h3>
                        <p className="mt-1 text-xs leading-5 text-slate-600">
                          {selectedRequestedSpecification.style || 'Style not labeled'} in {selectedRequestedSpecification.color || 'color not labeled'}.
                          {' '}The catalog design is fixed; only its cap-size variant can be changed.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-semibold text-slate-600">
                          <span className="rounded-full bg-white px-2 py-1">{selectedRequestedSpecification.hairLength || 'N/A'} in</span>
                          <span className="rounded-full bg-white px-2 py-1">{selectedRequestedSpecification.texture || 'Texture N/A'}</span>
                          <span className="rounded-full bg-white px-2 py-1">{selectedRequestedSpecification.density || 'Density N/A'}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="py-4 text-center text-xs font-medium text-slate-500">Select a wig above to see its specifications.</div>
                  )}
                </div>

                <div className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <label className={LABEL_CLASS}>Cap Size (editable preference)</label>
                  <select
                    name="wigSpecificationId"
                    value={form.wigSpecificationId}
                    onChange={handleCapSizeChange}
                    className={INPUT_CLASS}
                    disabled={!selectedWigFamily || isSubmitting || isUploadingPreview}
                  >
                    <option value="">Select a wig first</option>
                    {(selectedWigFamily?.variants || []).map((variant) => (
                      <option key={variant.specificationId} value={String(variant.specificationId)}>
                        {variant.capSizeLabel || variant.capSize || 'Cap size N/A'} â€” {variant.stockCount > 0 ? `${variant.stockCount} in stock` : 'No stock (wish request)'}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-500">Changing cap size selects the matching catalog variant; style, color, length, texture, and density stay unchanged.</p>
                </div>

                {selectedRequestedSpecification && !selectedRequestedSpecification.isAvailable ? (
                  <div className="md:col-span-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold">This cap-size variant is out of stock.</p>
                      <p className="mt-0.5 text-xs">You may still submit it as a wish request, but availability and completion dates are not guaranteed.</p>
                    </div>
                  </div>
                ) : null}

                <div>
                  <label className={LABEL_CLASS}>Style</label>
                  <input
                    value={selectedRequestedSpecification?.style || ''}
                    className={READONLY_INPUT_CLASS}
                    readOnly
                    disabled
                  />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Color</label>
                  <input
                    value={selectedRequestedSpecification?.color || ''}
                    className={READONLY_INPUT_CLASS}
                    readOnly
                    disabled
                  />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Length (inches)</label>
                  <input
                    value={selectedRequestedSpecification?.hairLength ?? ''}
                    className={READONLY_INPUT_CLASS}
                    readOnly
                    disabled
                  />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Texture</label>
                  <input
                    value={selectedRequestedSpecification?.texture || ''}
                    className={READONLY_INPUT_CLASS}
                    readOnly
                    disabled
                  />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Density</label>
                  <input
                    value={selectedRequestedSpecification?.density || ''}
                    className={READONLY_INPUT_CLASS}
                    readOnly
                    disabled
                  />
                </div>

                <div className="md:col-span-2">
                  <label className={LABEL_CLASS}>Special Note</label>
                  <textarea
                    name="specialNoteTemplate"
                    value={form.specialNoteTemplate}
                    onChange={handleFieldChange}
                    className={INPUT_CLASS}
                    rows={3}
                    placeholder="Write special notes as a list or comment (one per line)."
                  />
                </div>

                <div className="md:col-span-2 rounded-xl border border-sky-200 bg-sky-50/60 p-4">
                  <div>
                    <p className="text-sm font-bold text-slate-900">Wig Safety Assessment</p>
                    <p className="mt-1 text-xs text-slate-600">Confirm the patientâ€™s current scalp condition and restrictions. These answers appear in the PDF and Staff review.</p>
                    {selectedPatientProfile.allergiesMedications && selectedPatientProfile.allergiesMedications !== 'N/A' ? (
                      <p className="mt-2 rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs text-slate-700"><span className="font-bold">Saved clinical allergy/medication record:</span> {selectedPatientProfile.allergiesMedications}</p>
                    ) : null}
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {[
                      ['hasKnownAllergies', 'Known allergies?'],
                      ['hasSensitiveScalp', 'Sensitive scalp?'],
                      ['hasScalpIrritation', 'Current scalp irritation?'],
                      ['hasOpenScalpWounds', 'Open scalp wounds?'],
                      ['hasMedicalRestriction', 'Medical restriction for wig use?'],
                    ].map(([name, label]) => (
                      <div key={name}>
                        <label className={LABEL_CLASS}>{label}</label>
                        <select name={name} value={form[name]} onChange={handleFieldChange} className={INPUT_CLASS} required>
                          <option value="">Select Yes or No</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </div>
                    ))}
                  </div>

                  {form.hasKnownAllergies === 'yes' ? (
                    <div className="mt-3"><label className={LABEL_CLASS}>Allergy Details (required)</label><textarea name="allergyDetails" value={form.allergyDetails} onChange={handleFieldChange} rows={3} className={INPUT_CLASS} placeholder="Allergen, reaction, medication, or material to avoid" /></div>
                  ) : null}
                  {form.hasMedicalRestriction === 'yes' ? (
                    <div className="mt-3"><label className={LABEL_CLASS}>Medical Restriction Details (required)</label><textarea name="medicalRestrictionDetails" value={form.medicalRestrictionDetails} onChange={handleFieldChange} rows={3} className={INPUT_CLASS} placeholder="Describe the restriction or required clearance" /></div>
                  ) : null}

                  <label className="mt-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-white px-3 py-2.5 text-xs text-slate-700">
                    <input type="checkbox" name="informationConfirmed" checked={form.informationConfirmed} onChange={handleFieldChange} className="mt-0.5" />
                    <span>I confirm that these safety details were reviewed with the patient or guardian and are accurate.</span>
                  </label>
                </div>
              </section>
            </form>

            <aside className="xl:col-span-3">
              <div className="sticky top-3 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">3. Review</h3>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600">A4</span>
                </div>

                <div className="p-3">
                  <p className="mb-2 text-xs font-bold text-slate-900">PDF Preview</p>
                  <div className="relative overflow-hidden rounded-lg border border-slate-300 bg-slate-100 shadow-sm">
                    {liveRequestPdfPreviewUrl ? (
                      <>
                        <iframe
                          title="Exact wig request PDF preview"
                          src={`${liveRequestPdfPreviewUrl}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`}
                          className="aspect-[210/297] w-full bg-white"
                        />
                        {isBuildingLivePdfPreview ? (
                          <div className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-slate-900/85 px-2.5 py-1 text-[10px] font-bold text-white shadow">
                            <Loader2 size={11} className="animate-spin" /> Updating PDF
                          </div>
                        ) : null}
                      </>
                    ) : isBuildingLivePdfPreview ? (
                      <div className="flex aspect-[210/297] items-center justify-center bg-white px-4 text-center">
                        <p className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500"><Loader2 size={14} className="animate-spin" /> Building the A4 PDF preview...</p>
                      </div>
                    ) : (
                      <div className="flex aspect-[210/297] items-center justify-center bg-white px-5 text-center">
                        <div>
                          <FileText size={28} className="mx-auto text-slate-300" />
                          <p className="mt-2 text-xs font-semibold text-slate-600">Select a patient and wig to generate the PDF preview.</p>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 space-y-2">

                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600">
                      This is the exact A4 PDF that will be saved. It updates automatically as the patient, wig, cap size, or note changes.
                    </div>

                    <button
                      form="wig-request-form"
                      type="submit"
                      disabled={
                        isSubmitting
                        || isLoadingPatients
                        || isResolvingHospital
                        || isUploadingPreview
                        || !Number(form.patientId || 0)
                        || !normalizeSpecNumber(form.wigSpecificationId)
                      }
                      className="w-full rounded-lg px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ backgroundColor: theme.primaryColor }}
                    >
                      {isSubmitting || isUploadingPreview ? 'Submitting...' : 'Submit Request'}
                    </button>

                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={resetForm}
                        disabled={isSubmitting || isUploadingPreview}
                        className="font-semibold text-slate-500 hover:text-slate-900 disabled:opacity-50"
                      >
                        Clear
                      </button>
                      <span className="text-slate-500">
                        Initial Status <span className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800">{REQUEST_STATUS.pending}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>
      )}

      {requestConfirmationOpen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm sm:p-6">
          <section role="dialog" aria-modal="true" aria-labelledby="wig-request-confirmation-title" className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Final Review</p><h2 id="wig-request-confirmation-title" className="mt-1 text-xl font-bold text-slate-950">Confirm Wig Request</h2><p className="mt-1 text-sm text-slate-600">Check every detail and the exact PDF before continuing.</p></div>
              <button type="button" disabled={isSubmitting || isUploadingPreview} onClick={() => setRequestConfirmationOpen(false)} className="rounded-full border border-slate-200 p-2 text-slate-500"><X size={18} /></button>
            </header>
            <div className="grid flex-1 overflow-y-auto bg-slate-100 lg:grid-cols-[minmax(300px,0.8fr),minmax(440px,1.2fr)]">
              <div className="space-y-4 p-4 sm:p-5">
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-bold text-slate-900">Patient & Request</h3>
                  <dl className="mt-3 space-y-2 text-sm text-slate-700">
                    <PatientDetailRow label="Patient" value={selectedPatientProfile.fullName} />
                    <PatientDetailRow label="Patient Code" value={selectedPatientProfile.patientCode} />
                    <PatientDetailRow label="Medical Condition" value={selectedPatientProfile.medicalCondition} />
                    <PatientDetailRow label="Wig" value={selectedRequestedSpecification?.wigName} />
                    <PatientDetailRow label="Cap Size" value={selectedRequestedSpecification?.capSizeLabel || selectedRequestedSpecification?.capSize} />
                    <PatientDetailRow label="Stock" value={selectedRequestedSpecification?.isAvailable ? `${selectedRequestedSpecification.stockCount} available` : 'No stock â€” production request if accepted'} />
                    <PatientDetailRow label="Special Note" value={form.specialNoteTemplate || 'N/A'} />
                  </dl>
                  <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <WigPreviewImage label={selectedRequestedSpecification?.wigName || 'Selected wig'} candidates={selectedRequestedSpecification?.primaryImageCandidates || []} imageClassName="h-44" showLabel={false} containerClassName="border-0 bg-transparent p-0" />
                  </div>
                </section>
                <section className="rounded-xl border border-sky-200 bg-white p-4">
                  <h3 className="text-sm font-bold text-slate-900">Safety Assessment</h3>
                  <dl className="mt-3 space-y-2 text-sm text-slate-700">
                    <PatientDetailRow label="Known Allergies" value={yesNoValue(form.hasKnownAllergies)} />
                    <PatientDetailRow label="Allergy Details" value={form.allergyDetails || 'N/A'} />
                    <PatientDetailRow label="Sensitive Scalp" value={yesNoValue(form.hasSensitiveScalp)} />
                    <PatientDetailRow label="Scalp Irritation" value={yesNoValue(form.hasScalpIrritation)} />
                    <PatientDetailRow label="Open Scalp Wounds" value={yesNoValue(form.hasOpenScalpWounds)} />
                    <PatientDetailRow label="Medical Restriction" value={yesNoValue(form.hasMedicalRestriction)} />
                    <PatientDetailRow label="Restriction Details" value={form.medicalRestrictionDetails || 'N/A'} />
                  </dl>
                </section>
              </div>
              <div className="p-4 sm:p-5">
                <div className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
                  {liveRequestPdfPreviewUrl ? <iframe title="Final wig request PDF" src={`${liveRequestPdfPreviewUrl}#toolbar=0&navpanes=0&view=FitH`} className="h-[68vh] min-h-[560px] w-full bg-white" /> : <div className="flex min-h-[560px] items-center justify-center text-sm text-slate-500">Preparing PDF preview...</div>}
                </div>
              </div>
            </div>
            <footer className="flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">
              <button type="button" disabled={isSubmitting || isUploadingPreview} onClick={() => setRequestConfirmationOpen(false)} className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-bold text-slate-700 disabled:opacity-50">Cancel</button>
              <button type="button" disabled={isSubmitting || isUploadingPreview || isBuildingLivePdfPreview} onClick={() => void submitRequestNow()} className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50" style={{ backgroundColor: theme.primaryColor }}>{isSubmitting || isUploadingPreview ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Continue & Submit</button>
            </footer>
          </section>
        </div>,
        document.body,
      )}

      {requestSuccessModal.open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[10030] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <section role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><CheckCircle2 size={29} /></div>
            <h2 className="mt-4 text-xl font-bold text-slate-950">Request Submitted</h2>
            <p className="mt-2 text-sm text-slate-600"><span className="font-bold">{requestSuccessModal.requestCode}</span> was saved successfully with its safety assessment and PDF.</p>
            <p className={`mt-4 rounded-xl border px-4 py-3 text-sm ${requestSuccessModal.isWish ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{requestSuccessModal.isWish ? 'This cap size is currently out of stock. Staff must accept it for priority production before it appears in Specialist Bundling.' : 'Matching stock is currently available, subject to Staff review and immediate allocation.'}</p>
            <button type="button" onClick={() => setRequestSuccessModal({ open: false, requestCode: '', isWish: false })} className="mt-5 w-full rounded-lg px-4 py-2.5 text-sm font-bold text-white" style={{ backgroundColor: theme.primaryColor }}>Done</button>
          </section>
        </div>,
        document.body,
      )}

      {activeTab === 'submitted' && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
          <div className="grid grid-cols-2 gap-2 border-b border-slate-200 bg-slate-50 p-3 lg:grid-cols-3 xl:grid-cols-5">
            {submittedQuickStats.map((item) => (
              <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{item.label}</p>
                <p className="mt-1 flex min-h-7 items-center text-xl font-bold text-slate-900">
                  {isLoadingSubmitted ? (
                    <Loader2 size={19} className="animate-spin text-slate-400" aria-label="Loading request count" />
                  ) : item.value}
                </p>
              </article>
            ))}
          </div>

          <div className="border-b border-slate-200 bg-white px-4 py-3">
            <h2 className="text-lg font-semibold text-slate-900">Submitted Requests &amp; Release Approvals</h2>
            <p className="mt-0.5 text-xs text-slate-500">Filter submitted requests, review their current status, or switch to release-date actions.</p>

            <div className="mt-3 grid grid-cols-1 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2 md:grid-cols-2 xl:grid-cols-6">
              <div className="relative xl:col-span-2">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={submittedSearchTerm}
                  onChange={(event) => setSubmittedSearchTerm(event.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-8 pr-2 text-xs text-slate-800 outline-none focus:border-slate-500"
                  placeholder="Search requests, patients, wigs..."
                />
              </div>

              <select
                value={submittedStatusFilter}
                onChange={(event) => setSubmittedStatusFilter(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
                aria-label="Submitted request status"
              >
                {SUBMITTED_STATUS_FILTERS.map((filterItem) => (
                  <option key={filterItem.id} value={filterItem.id}>{filterItem.label}</option>
                ))}
              </select>

              <input
                type="date"
                value={submittedDateFrom}
                onChange={(event) => setSubmittedDateFrom(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
                aria-label="Submitted from date"
                title="From date"
              />

              <input
                type="date"
                value={submittedDateTo}
                onChange={(event) => setSubmittedDateTo(event.target.value)}
                min={submittedDateFrom || undefined}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs text-slate-700 outline-none focus:border-slate-500"
                aria-label="Submitted to date"
                title="To date"
              />

              <select
                value={submittedView}
                onChange={(event) => setSubmittedView(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 outline-none focus:border-slate-500"
                aria-label="Submitted request view"
              >
                <option value="list">Submitted Requests</option>
                <option value="calendar">Calendar</option>
                <option value="release">Release Date Approval</option>
              </select>
            </div>

            {submittedView === 'calendar' ? (
              <div className="mt-2 flex justify-end">
                <input
                  type="month"
                  value={submittedMonth}
                  onChange={(event) => setSubmittedMonth(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700"
                  aria-label="Calendar month"
                />
              </div>
            ) : null}
          </div>

          {submittedView === 'release' ? (
            <div className="bg-slate-50 p-4">
              <ReleaseDateApprovalPage userProfile={userProfile} embedded />
            </div>
          ) : submittedView === 'calendar' ? (
            <div className="p-4">
              <div className="grid grid-cols-7 border-b border-l border-slate-200 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayName) => (
                  <div key={dayName} className="border-r border-t border-slate-200 bg-slate-50 px-1 py-2">{dayName}</div>
                ))}
                {submittedCalendarDays.map((day) => (
                  <div key={day.key} className={`min-h-28 border-r border-t border-slate-200 p-1.5 text-left ${day.blank ? 'bg-slate-50' : 'bg-white'}`}>
                    {!day.blank ? (
                      <>
                        <p className="text-xs font-semibold text-slate-700">{day.day}</p>
                        <div className="mt-1 space-y-1">
                          {day.rows.slice(0, 3).map((row) => (
                            <button
                              key={row.reqId}
                              type="button"
                              onClick={() => handleOpenSubmittedRequestPreview(row)}
                              className={`block w-full truncate rounded px-1.5 py-1 text-left text-[10px] font-semibold ${statusClass(row.status)}`}
                              title={`${row.requestId} Â· ${row.patient} Â· ${row.statusLabel}`}
                            >
                              {row.requestId} Â· {row.patient}
                            </button>
                          ))}
                          {day.rows.length > 3 ? <p className="text-[10px] text-slate-500">+{day.rows.length - 3} more</p> : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : isLoadingSubmitted ? (
            <div className="px-4 py-6 text-sm text-slate-600">Loading submitted requests...</div>
          ) : filteredSubmittedRows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-600">No submitted requests matched your current filter/search.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Request ID</th>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Patient</th>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Wig Model</th>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Medical Condition</th>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Request Date</th>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Status</th>
                    <th className="px-4 py-3 text-left font-semibold text-slate-700">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSubmittedRows.map((row) => (
                    <tr
                      key={row.reqId}
                      onClick={() => handleOpenSubmittedRequestPreview(row)}
                      className="cursor-pointer border-t border-slate-200 hover:bg-slate-50"
                    >
                      <td className="px-4 py-3 font-semibold text-slate-800">{row.requestId}</td>
                      <td className="px-4 py-3 text-slate-700">{row.patient}</td>
                      <td className="px-4 py-3 text-slate-700">
                        <p className="font-medium text-slate-800">{row.requestSpecWigName}</p>
                        <p className="text-[11px] text-slate-500">{row.requestSpecCapSize}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{row.medicalCondition}</td>
                      <td className="px-4 py-3 text-slate-700">{formatRequestDateTime(row.requestDate)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>
                          {row.statusLabel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleOpenSubmittedRequestPreview(row);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          <Info size={13} /> View Details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {selectedSubmittedRequest && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-6">
          <button
            type="button"
            aria-label="Close request preview panel"
            className="absolute inset-0 m-0 p-0 border-0 appearance-none bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={handleCloseSubmittedRequestPreview}
          />

          <section className="relative flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="z-10 flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Wig Request Details</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {selectedSubmittedRequest.requestId} | {selectedSubmittedRequest.patient}
                </p>
              </div>
              <button type="button" onClick={handleCloseSubmittedRequestPreview} className="text-slate-400 hover:text-red-500">
                <X size={22} />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto bg-slate-100 p-5">
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
                  <div className="flex min-w-0 items-center gap-3">
                    {selectedSubmittedRequest.patientPhotoUrl ? (
                      <img src={selectedSubmittedRequest.patientPhotoUrl} alt={selectedSubmittedRequest.patient} className="h-16 w-16 shrink-0 rounded-full border border-slate-200 object-cover" />
                    ) : (
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-slate-900 text-lg font-bold text-white">{String(selectedSubmittedRequest.patient || 'P').charAt(0).toUpperCase()}</div>
                    )}
                    <div className="min-w-0"><p className="truncate text-lg font-bold text-slate-900">{selectedSubmittedRequest.patient}</p><p className="text-xs text-slate-500">{selectedSubmittedRequest.patientCode}</p></div>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass(selectedSubmittedRequest.status)}`}>{selectedSubmittedRequest.statusLabel || getStatusLabel(selectedSubmittedRequest.status)}</span>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <section><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Personal Information</p><div className="mt-2 space-y-1.5"><p><span className="font-semibold text-slate-900">Age:</span> {selectedSubmittedRequest.patientAge}</p><p><span className="font-semibold text-slate-900">Birthdate:</span> {selectedSubmittedRequest.patientBirthdate}</p><p><span className="font-semibold text-slate-900">Gender:</span> {selectedSubmittedRequest.patientGender}</p><p><span className="font-semibold text-slate-900">Email:</span> {selectedSubmittedRequest.patientEmail}</p><p><span className="font-semibold text-slate-900">Contact:</span> {selectedSubmittedRequest.patientContact}</p><p><span className="font-semibold text-slate-900">Address:</span> {selectedSubmittedRequest.patientAddress}</p></div></section>
                  <section><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Clinical Information</p><div className="mt-2 space-y-1.5"><p><span className="font-semibold text-slate-900">Condition:</span> {selectedSubmittedRequest.medicalCondition}</p><p><span className="font-semibold text-slate-900">Category / Stage:</span> {selectedSubmittedRequest.conditionCategory} / {selectedSubmittedRequest.conditionStage}</p><p><span className="font-semibold text-slate-900">Physician:</span> {selectedSubmittedRequest.attendingPhysician}</p><p><span className="font-semibold text-slate-900">Treatment:</span> {selectedSubmittedRequest.treatmentPlan}</p><p><span className="font-semibold text-slate-900">Current Status:</span> {selectedSubmittedRequest.treatmentStatus}</p></div></section>
                  <section><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Emergency Contacts</p><div className="mt-2 space-y-1.5"><p className="font-semibold text-slate-900">Primary</p><p>{selectedSubmittedRequest.guardianName} Â· {selectedSubmittedRequest.guardianRelationship}</p><p>{selectedSubmittedRequest.guardianContact}</p>{selectedSubmittedRequest.secondaryGuardianName || selectedSubmittedRequest.secondaryGuardianRelationship || selectedSubmittedRequest.secondaryGuardianContact ? <div className="border-t border-slate-100 pt-2"><p className="font-semibold text-slate-900">Secondary</p><p>{selectedSubmittedRequest.secondaryGuardianName || 'N/A'} Â· {selectedSubmittedRequest.secondaryGuardianRelationship || 'N/A'}</p><p>{selectedSubmittedRequest.secondaryGuardianContact || 'N/A'}</p></div> : null}</div></section>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-200 pt-3 text-xs"><p><span className="font-semibold text-slate-900">Request Date:</span> {formatRequestDateTime(selectedSubmittedRequest.requestDate)}</p><p><span className="font-semibold text-slate-900">Last Updated:</span> {formatRequestDateTime(selectedSubmittedRequest.updatedAt || selectedSubmittedRequest.requestDate)}</p></div>
                {selectedSubmittedRequest.isWishRequest ? (
                  <p className="mt-1">
                    <span className="font-semibold text-slate-900">No-stock fulfillment:</span>{' '}
                    {String(selectedSubmittedRequest.fulfillmentStatus || 'Awaiting review').replace(/_/g, ' ')}
                    {selectedSubmittedRequest.fulfillmentBundleId ? ` Â· Bundle #${selectedSubmittedRequest.fulfillmentBundleId}` : ''}
                  </p>
                ) : null}
                {selectedSubmittedRequest.statusReason && (
                  <p className="mt-1 whitespace-pre-line">
                    <span className="font-semibold text-slate-900">Status Reason:</span> {selectedSubmittedRequest.statusReason}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Requested Wig Preference</p>
                <div className="mt-3 flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row">
                  <div className="w-full shrink-0 sm:w-40">
                  <WigPreviewImage
                    label="Primary catalog image"
                    candidates={selectedSubmittedRequest.requestSpecPrimaryImageCandidates || []}
                    imageClassName="h-40 !object-contain"
                    showLabel={false}
                    containerClassName="border-0 bg-transparent p-0"
                  />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-bold text-slate-900">{selectedSubmittedRequest.requestSpecWigName}</p>
                    <p className="mt-0.5 text-xs text-slate-500">Specification #{selectedSubmittedRequest.requestSpecId || 'N/A'}</p>
                    <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 text-sm text-slate-700 md:grid-cols-3">
                      <p><span className="font-semibold text-slate-900">Style:</span> {selectedSubmittedRequest.requestSpecStyle}</p><p><span className="font-semibold text-slate-900">Color:</span> {selectedSubmittedRequest.requestSpecColor}</p><p><span className="font-semibold text-slate-900">Length:</span> {selectedSubmittedRequest.requestSpecLength}</p><p><span className="font-semibold text-slate-900">Density:</span> {selectedSubmittedRequest.requestSpecDensity}</p><p><span className="font-semibold text-slate-900">Texture:</span> {selectedSubmittedRequest.requestSpecTexture}</p><p><span className="font-semibold text-slate-900">Cap Size:</span> {selectedSubmittedRequest.requestSpecCapSize}</p>
                    </div>
                    <p className="mt-3 text-sm text-slate-700"><span className="font-semibold text-slate-900">Special Note:</span> {selectedSubmittedRequest.requestSpecSpecialNote}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Wig Safety Assessment</p>
                {selectedSubmittedRequest.safetyAssessment ? (
                  <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
                    <p><span className="font-semibold text-slate-900">Known allergies:</span> {selectedSubmittedRequest.safetyAssessment.has_known_allergies ? 'Yes' : 'No'}</p><p><span className="font-semibold text-slate-900">Sensitive scalp:</span> {selectedSubmittedRequest.safetyAssessment.has_sensitive_scalp ? 'Yes' : 'No'}</p><p><span className="font-semibold text-slate-900">Scalp irritation:</span> {selectedSubmittedRequest.safetyAssessment.has_scalp_irritation ? 'Yes' : 'No'}</p><p><span className="font-semibold text-slate-900">Open wounds:</span> {selectedSubmittedRequest.safetyAssessment.has_open_scalp_wounds ? 'Yes' : 'No'}</p><p><span className="font-semibold text-slate-900">Medical restriction:</span> {selectedSubmittedRequest.safetyAssessment.has_medical_restriction ? 'Yes' : 'No'}</p><p><span className="font-semibold text-slate-900">Review:</span> {selectedSubmittedRequest.safetyAssessment.review_status || 'Pending'}</p>
                    {selectedSubmittedRequest.safetyAssessment.allergy_details ? <p className="sm:col-span-2 lg:col-span-3"><span className="font-semibold text-slate-900">Allergy details:</span> {selectedSubmittedRequest.safetyAssessment.allergy_details}</p> : null}
                    <p className="sm:col-span-2 lg:col-span-3"><span className="font-semibold text-slate-900">Clinical allergies/current medications:</span> {selectedSubmittedRequest.clinicalAllergiesMedications}</p>
                  </div>
                ) : <p className="mt-2 text-sm text-slate-500">No safety assessment was saved for this request.</p>}
              </div>

              {selectedSubmittedRequestJourney && (
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-sm font-semibold text-slate-900">Patient Journey</p>
                  <p className="mt-1 text-xs text-slate-500">Current position in the request workflow.</p>

                  {(() => {
                    const currentIndex = selectedSubmittedRequestJourney.steps.findIndex(
                      (step) => step.id === selectedSubmittedRequestJourney.currentStepId,
                    );

                    return (
                      <div className="mt-3 space-y-2">
                        {selectedSubmittedRequestJourney.steps.map((step, index) => {
                          const isDone = currentIndex > index;
                          const isActive = currentIndex === index;

                          return (
                            <div
                              key={step.id}
                              className={`rounded-lg border px-3 py-2 ${
                                isActive
                                  ? 'border-slate-900 bg-slate-900 text-white'
                                  : isDone
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                    : 'border-slate-200 bg-slate-50 text-slate-700'
                              }`}
                            >
                              <p className="text-xs font-semibold">{step.title}</p>
                              <p className={`mt-0.5 text-[11px] ${isActive ? 'text-slate-200' : isDone ? 'text-emerald-700' : 'text-slate-500'}`}>
                                {step.note}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}

              {selectedSubmittedRequestPreviewUrl ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <iframe
                    title="Submitted request PDF preview"
                    src={selectedSubmittedRequestPreviewUrl}
                    className="h-[72vh] w-full rounded-lg border border-slate-200"
                  />
                  <a
                    href={selectedSubmittedRequestPreviewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs font-semibold text-blue-700 hover:underline"
                  >
                    Open PDF in new tab
                  </a>
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  No preview PDF URL is saved for this request yet.
                </div>
              )}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
