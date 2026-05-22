import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { jsPDF } from 'jspdf';
import { Info, X } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

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

const PATIENT_ASSETS_BUCKET = 'patient_assets';
const PROFILE_PICTURES_BUCKET = 'profile_pictures';
const WIG_REQUEST_PREVIEWS_BUCKET = 'wig_request_previews';
const WIG_AI_FILTERS_BUCKET = 'wig_ai_filters';
const WIG_AI_SOURCES_BUCKET = 'wig_ai_sources';
const BRANDING_BUCKET = 'branding_assests';

const REQUEST_STATUS = {
  pending: 'Pending',
  acceptedWithAllocatedWig: 'Accepted - Wig Allocated',
  acceptedNoWigAvailable: 'Accepted - No Wig Available',
  toBeRelease: 'To Be Release',
  releasing: 'Releasing',
  released: 'Released',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const tabs = [
  { id: 'new-request', label: 'New Request' },
  { id: 'submitted', label: 'Submitted' },
];

const SUBMITTED_STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted_allocated', label: 'Accepted - Wig Allocated' },
  { id: 'accepted_no_wig', label: 'Accepted - No Wig Available' },
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
};

const LABEL_CLASS = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-600';
const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 transition focus:border-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-200';
const READONLY_INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 border-dashed bg-slate-100 px-2.5 py-1.5 text-sm text-slate-500 cursor-not-allowed';

function tabClass(isActive) {
  return isActive
    ? 'rounded-lg border border-slate-900 bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white'
    : 'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50';
}

function normalizeStatusKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
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

function isSameDay(timestampValue, dateValue = new Date()) {
  if (!timestampValue) return false;
  const parsed = new Date(timestampValue);
  if (Number.isNaN(parsed.getTime())) return false;

  return parsed.toDateString() === dateValue.toDateString();
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

  if (['acceptedbutnowigavailable', 'acceptednowigavailable', 'nowigavailable', 'findingmatchingwig', 'formatching', 'matching', 'findingallocatingwig', 'findingandallocatingwig'].includes(key)) {
    return 'accepted_no_wig';
  }

  if (['inproduction', 'production', 'inprocess'].includes(key)) {
    return 'accepted_no_wig';
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
  if (key === 'accepted_no_wig') return REQUEST_STATUS.acceptedNoWigAvailable;
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
  if (key === 'accepted_no_wig') return 'bg-lime-100 text-lime-700';
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

  const noWigPath = [
    {
      id: 'pending',
      title: REQUEST_STATUS.pending,
      note: 'Request submitted and queued for review.',
    },
    {
      id: 'accepted_no_wig',
      title: REQUEST_STATUS.acceptedNoWigAvailable,
      note: 'Request accepted but no suitable wig is currently available yet.',
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

  if (statusKey === 'accepted_no_wig') {
    return { steps: noWigPath, currentStepId: 'accepted_no_wig' };
  }

  if (statusKey === 'to_be_release') {
    return { steps: noWigPath, currentStepId: 'to_be_release' };
  }

  if (statusKey === 'releasing') {
    return { steps: noWigPath, currentStepId: 'releasing' };
  }

  if (statusKey === 'released') {
    return { steps: noWigPath, currentStepId: 'released' };
  }

  if (statusKey === 'rejected') {
    return { steps: rejectedPath, currentStepId: 'rejected' };
  }

  if (statusKey === 'cancelled') {
    return { steps: cancelledPath, currentStepId: 'cancelled' };
  }

  return { steps: noWigPath, currentStepId: 'pending' };
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

function isRlsBlockedError(rawMessage) {
  const lowerMessage = String(rawMessage || '').toLowerCase();
  return lowerMessage.includes('row-level security')
    || (lowerMessage.includes('permission denied') && lowerMessage.includes('wig_request'));
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

function PreviewRow({ label, value }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 text-[11px] leading-4">
      <span className="font-semibold text-slate-600">{label}</span>
      <span className="whitespace-pre-line break-words text-slate-800">{safePreviewValue(value)}</span>
    </div>
  );
}

function WigPreviewImage({ label, candidates = [] }) {
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
    <div className="rounded-md border border-slate-200 bg-slate-50 p-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {currentSrc ? (
        <img
          src={currentSrc}
          alt={`${label} wig preview`}
          className="mt-1 h-24 w-full rounded object-cover"
          onError={() => {
            setCandidateIndex((prev) => (prev < normalizedCandidates.length - 1 ? prev + 1 : prev));
          }}
        />
      ) : (
        <div className="mt-1 flex h-24 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-[11px] text-slate-500">
          No image
        </div>
      )}
    </div>
  );
}

export default function WigRequestPage({ userProfile }) {
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState('new-request');

  const [hospitalId, setHospitalId] = useState(null);
  const [patients, setPatients] = useState([]);
  const [usersById, setUsersById] = useState({});
  const [userDetailsByUserId, setUserDetailsByUserId] = useState({});
  const [wigRequests, setWigRequests] = useState([]);
  const [wigSpecifications, setWigSpecifications] = useState([]);

  const [form, setForm] = useState(EMPTY_FORM);
  const [patientSearchTerm, setPatientSearchTerm] = useState('');
  const [patientSearchOpen, setPatientSearchOpen] = useState(false);
  const [submittedStatusFilter, setSubmittedStatusFilter] = useState('all');
  const [submittedSearchTerm, setSubmittedSearchTerm] = useState('');
  const [capSizeFilter, setCapSizeFilter] = useState('all');

  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [isResolvingHospital, setIsResolvingHospital] = useState(false);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [isLoadingSubmitted, setIsLoadingSubmitted] = useState(false);
  const [isLoadingWigSpecifications, setIsLoadingWigSpecifications] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingPreview, setIsUploadingPreview] = useState(false);
  const [selectedSubmittedRequest, setSelectedSubmittedRequest] = useState(null);

  const patientSearchContainerRef = useRef(null);

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

  const filteredWigSpecifications = useMemo(() => {
    if (capSizeFilter === 'all') {
      return wigSpecifications;
    }

    return wigSpecifications.filter((row) => normalizeCapSizeKey(row.capSize) === capSizeFilter);
  }, [wigSpecifications, capSizeFilter]);

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
      const rawStatusReason = String(requestRow.Status_Reason || requestRow.status_reason || '').trim();
      const specialNotesPayload = rawStatusReason.startsWith('SSMETA:')
        ? parseSpecialNotesPayload(rawStatusReason)
        : {};
      const requestedWigId = normalizeSpecNumber(requestRow.Requested_Wig_ID);
      const requestedSpecRow = requestedWigId
        ? (wigSpecifications.find((row) => normalizeSpecNumber(row.wigId) === requestedWigId) || null)
        : null;

        return {
          reqId,
          requestId: formatRequestCode(requestRow.Request_Code || ''),
          patient: getPatientFullName(patient, linkedDetails),
        medicalCondition: patient?.Medical_Condition || 'N/A',
        requestDate: requestRow.Request_Date,
        updatedAt: requestRow.Updated_At || requestRow.updated_at || requestRow.Request_Date,
        previewPdfUrl: String(requestRow.Pdf_Url || requestRow.Preview_Pdf_Url || '').trim(),
        statusReason: rawStatusReason.startsWith('SSMETA:') ? '' : rawStatusReason,
        status: requestRow.Status || REQUEST_STATUS.pending,
        statusKey: getCanonicalStatusKey(requestRow.Status || REQUEST_STATUS.pending),
        statusLabel: getStatusLabel(requestRow.Status || REQUEST_STATUS.pending),
        rawStatus: requestRow.Status || REQUEST_STATUS.pending,
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
      };
    });
  }, [wigRequests, patientById, userDetailsByUserId, wigSpecifications]);

  const statusFilteredSubmittedRows = useMemo(() => {
    if (submittedStatusFilter === 'all') {
      return submittedRows;
    }

    return submittedRows.filter((row) => row.statusKey === submittedStatusFilter);
  }, [submittedRows, submittedStatusFilter]);

  const filteredSubmittedRows = useMemo(() => {
    const query = normalizeSearchText(submittedSearchTerm);
    if (!query) {
      return statusFilteredSubmittedRows;
    }

    return statusFilteredSubmittedRows.filter((row) => {
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
  }, [statusFilteredSubmittedRows, submittedSearchTerm]);

  const quickStats = useMemo(() => {
    const newToday = wigRequests.filter((row) => isSameDay(row.Request_Date)).length;
    const pendingCount = wigRequests.filter((row) => getCanonicalStatusKey(row.Status) === 'pending').length;
    const acceptedAllocatedCount = wigRequests.filter((row) => getCanonicalStatusKey(row.Status) === 'accepted_allocated').length;
    const toBeReleaseCount = wigRequests.filter((row) => getCanonicalStatusKey(row.Status) === 'to_be_release').length;

    return [
      { label: 'New Today', value: String(newToday) },
      { label: 'Pending', value: String(pendingCount) },
      { label: 'Accepted + Allocated', value: String(acceptedAllocatedCount) },
      { label: 'To Be Release', value: String(toBeReleaseCount) },
    ];
  }, [wigRequests]);

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
      specialNote: form.specialNoteTemplate,
      statusOnSubmit: REQUEST_STATUS.pending,
    };
  }, [hospitalId, selectedPatientProfile, selectedRequestedSpecification, form.specialNoteTemplate]);

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
  const previewLogoResolvedUrl = previewLogoCandidates[0] || '';

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

      setWigRequests(requestRows || []);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load submitted wig requests.' });
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
          .select('Wig_ID, Wig_Code, Wig_Name, Wig_Status, Stock_Count'),
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
        const capSizeCanonical = toCanonicalCapSize(specRow.Cap_Size);
        const capSizeValue = capSizeCanonical || String(specRow.Cap_Size || '').trim();

        const frontImageCandidates = [
          signedSourceUrlByPath.get(sourceFrontPath),
          resolveStoragePublicUrl(WIG_AI_FILTERS_BUCKET, sourceFrontPath),
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
      setWigSpecifications([]);
      return;
    }

    fetchPatients();
    fetchSubmittedRequests();
    loadWigSpecifications();
  }, [hospitalId, fetchPatients, fetchSubmittedRequests, loadWigSpecifications]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) {
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
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [hospitalId, fetchSubmittedRequests]);

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

    setForm((prev) => ({
      ...prev,
      patientId: String(selectedPatientId),
      patientCode: String(patient.Patient_Code || ''),
      medicalCondition: String(patient.Medical_Condition || ''),
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

    if (!nextValue.trim() && form.patientId) {
      clearSelectedPatient();
    }
  };

  const handleFieldChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
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

    const wigImageSlots = [
      {
        label: 'Front',
        candidates: [previewPayload.requestSpecFrontImageUrl, ...(previewPayload.requestSpecFrontImageCandidates || [])],
      },
      {
        label: 'Side',
        candidates: [previewPayload.requestSpecSideImageUrl, ...(previewPayload.requestSpecSideImageCandidates || [])],
      },
      {
        label: 'Top',
        candidates: [previewPayload.requestSpecTopImageUrl, ...(previewPayload.requestSpecTopImageCandidates || [])],
      },
      {
        label: 'Back',
        candidates: [previewPayload.requestSpecBackImageUrl, ...(previewPayload.requestSpecBackImageCandidates || [])],
      },
    ];

    const wigImageData = await Promise.all(
      wigImageSlots.map(async (slot) => ({
        ...slot,
        dataUrl: await resolveFirstDataUrl(slot.candidates),
      })),
    );

    addSectionTitle('Requested Wig Preview');
    const cardGap = 4;
    const cardWidth = (contentWidth - cardGap) / 2;
    const cardHeight = 50;

    for (let idx = 0; idx < wigImageData.length; idx += 2) {
      const rowSlots = wigImageData.slice(idx, idx + 2);
      ensureSpace(cardHeight + 4);

      for (let slotIndex = 0; slotIndex < rowSlots.length; slotIndex += 1) {
        const slot = rowSlots[slotIndex];
        const cardX = margin + slotIndex * (cardWidth + cardGap);
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

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      return;
    }

    if (!hospitalId) {
      setNotice({
        kind: 'error',
        text: 'You are not assigned to any hospital. Ask Admin to assign your account first.',
      });
      return;
    }

    const selectedPatientId = Number(form.patientId || 0);
    if (!selectedPatientId) {
      setNotice({ kind: 'error', text: 'Please choose an existing patient first.' });
      return;
    }

    const selectedSpecId = normalizeSpecNumber(form.wigSpecificationId);
    const selectedSpec = selectedSpecId
      ? (wigSpecifications.find((row) => normalizeSpecNumber(row.specificationId) === selectedSpecId) || null)
      : null;
    if (!selectedSpec) {
      setNotice({ kind: 'error', text: 'Please select a target wig specification.' });
      return;
    }

    const requestedBy = Number(userProfile?.user_id || 0) || null;

    try {
      setIsSubmitting(true);
      setNotice({ kind: '', text: '' });

      const requestPayload = {
        Hospital_ID: Number(hospitalId),
        Patient_ID: selectedPatientId,
        Status: REQUEST_STATUS.pending,
        Requested_By: requestedBy,
        Requested_Wig_ID: Number(selectedSpec.wigId || 0) || null,
      };

      const specialNotesPayload = serializeSpecialNotes({
        specialNoteTemplate: String(form.specialNoteTemplate || '').trim(),
        wigSpecificationId: selectedSpecId,
        requestedWigId: Number(selectedSpec.wigId || 0) || null,
        wigCode: String(selectedSpec.wigCode || '').trim() || null,
      });

      let newReqId = 0;

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

      const { data: insertedRequest, error: requestError } = await supabase
        .from(WIG_REQUESTS_TABLE)
        .insert(requestPayload)
        .select('Req_ID')
        .maybeSingle();

      if (requestError) {
        if (isRlsBlockedError(requestError.message)) {
          const rpcResult = await supabase.rpc('create_wig_request_with_spec', rpcPayload);
          if (rpcResult.error) {
            throw rpcResult.error;
          }

          const rpcReqId = Number(rpcResult.data || 0);
          if (!rpcReqId) {
            throw new Error('RPC submit completed without returning Req_ID.');
          }

          newReqId = rpcReqId;
        } else {
          throw requestError;
        }
      } else {
        newReqId = Number(insertedRequest?.Req_ID || 0);
      }

      if (!newReqId) {
        throw new Error('Unable to resolve the saved wig request ID.');
      }

      try {
        setIsUploadingPreview(true);
        const previewPdfUrl = await uploadPreviewPdfForRequest(newReqId);

        if (previewPdfUrl) {
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
        }
      } catch (_previewError) {
        // Non-blocking: request row is already saved.
      } finally {
        setIsUploadingPreview(false);
      }

      setNotice({
        kind: 'success',
        text: 'Wig request submitted successfully.',
      });
      resetForm();
      void fetchSubmittedRequests();
    } catch (error) {
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
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 md:text-3xl">Wig Request Form</h1>
        <p className="mt-1 text-sm text-slate-600">
          Select patient, choose one existing wig specification, then submit a request with auto-generated PDF preview.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {quickStats.map((item) => (
          <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{item.value}</p>
          </article>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={tabClass(activeTab === tab.id)}
          >
            {tab.label}
          </button>
        ))}
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
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <form onSubmit={handleSubmit} className="space-y-4 xl:col-span-7">
              <div ref={patientSearchContainerRef} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <label className={LABEL_CLASS}>Search Existing Patient</label>
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
                  You can only select existing patients with saved patient data. If no results appear, add a new patient first in Manage Patients.
                </p>

                {patientSearchOpen && (
                  <div className="mt-2 max-h-44 overflow-auto rounded-lg border border-slate-200 bg-white">
                    {filteredPatientOptions.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-slate-500">No matching patients found.</p>
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
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="md:col-span-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Personal Details</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">Auto-filled from selected patient record (read-only).</p>
                  <div className="mt-2 flex items-center gap-3">
                    <AvatarCircle
                      photoUrl={selectedPatientProfile.photoUrl}
                      name={selectedPatientProfile.fullName}
                      sizeClass="h-16 w-16"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {selectedPatientProfile.fullName || 'No patient selected'}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {selectedPatientProfile.patientCode || 'Patient code will appear here'}
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <label className={LABEL_CLASS}>Age</label>
                  <input value={selectedPatientProfile.age} className={READONLY_INPUT_CLASS} readOnly disabled />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Gender</label>
                  <input value={selectedPatientProfile.gender} className={READONLY_INPUT_CLASS} readOnly disabled />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Email</label>
                  <input value={selectedPatientProfile.email} className={READONLY_INPUT_CLASS} readOnly disabled />
                </div>

                <div>
                  <label className={LABEL_CLASS}>Contact Number</label>
                  <input value={selectedPatientProfile.contactNumber} className={READONLY_INPUT_CLASS} readOnly disabled />
                </div>

                <div className="md:col-span-2">
                  <label className={LABEL_CLASS}>Address</label>
                  <input value={selectedPatientProfile.address} className={READONLY_INPUT_CLASS} readOnly disabled />
                </div>

                <div className="md:col-span-2">
                  <label className={LABEL_CLASS}>Medical Condition</label>
                  <input name="medicalCondition" value={form.medicalCondition} className={READONLY_INPUT_CLASS} readOnly disabled />
                </div>

                <div className="md:col-span-2 border-t border-slate-200 pt-2">
                  <p className="text-sm font-semibold text-slate-800">Request Specifications</p>
                  <p className="text-xs text-slate-500">Choose one existing wig specification only. Staff cannot edit this after submission.</p>
                </div>

                <div className="md:col-span-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className={LABEL_CLASS}>Target Wig Specification</label>
                    <button
                      type="button"
                      onClick={() => { void loadWigSpecifications(); }}
                      disabled={isLoadingWigSpecifications || isSubmitting || isUploadingPreview}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                    >
                      {isLoadingWigSpecifications ? 'Refreshing...' : 'Refresh list'}
                    </button>
                  </div>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cap size filter</span>
                    <select
                      value={capSizeFilter}
                      onChange={(event) => setCapSizeFilter(event.target.value)}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
                      disabled={isLoadingWigSpecifications || isSubmitting || isUploadingPreview}
                    >
                      <option value="all">All cap sizes</option>
                      {CAP_SIZE_OPTIONS.map((size) => (
                        <option key={size.value} value={normalizeCapSizeKey(size.value)}>{size.label}</option>
                      ))}
                    </select>
                  </div>
                  <select
                    name="wigSpecificationId"
                    value={form.wigSpecificationId}
                    onChange={handleFieldChange}
                    className={INPUT_CLASS}
                    disabled={isLoadingWigSpecifications || isSubmitting || isUploadingPreview}
                  >
                    <option value="">
                      {isLoadingWigSpecifications ? 'Loading specifications...' : 'Select wig specification'}
                    </option>
                    {filteredWigSpecifications.map((specRow) => (
                      <option key={specRow.specificationId} value={String(specRow.specificationId)}>
                        Spec #{specRow.specificationId} | {specRow.wigCode || `Wig #${specRow.wigId}`} | {specRow.style || 'No style'} | {specRow.capSizeLabel || specRow.capSize || 'No cap'}
                      </option>
                    ))}
                  </select>
                  {!isLoadingWigSpecifications && wigSpecifications.length === 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      No wig specification records found. Ask specialist to create wig specifications first.
                    </p>
                  )}
                </div>

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

                <div>
                  <label className={LABEL_CLASS}>Cap Size</label>
                  <input
                    value={selectedRequestedSpecification?.capSizeLabel || selectedRequestedSpecification?.capSize || ''}
                    className={READONLY_INPUT_CLASS}
                    readOnly
                    disabled
                  />
                </div>

                <div className="md:col-span-2">
                  <label className={LABEL_CLASS}>Selected Wig Preview</label>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <WigPreviewImage
                      label="Front"
                      candidates={selectedRequestedSpecification?.frontImageCandidates || []}
                    />
                    <WigPreviewImage
                      label="Side"
                      candidates={selectedRequestedSpecification?.sideImageCandidates || []}
                    />
                    <WigPreviewImage
                      label="Top"
                      candidates={selectedRequestedSpecification?.topImageCandidates || []}
                    />
                    <WigPreviewImage
                      label="Back"
                      candidates={selectedRequestedSpecification?.backImageCandidates || []}
                    />
                  </div>
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
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={resetForm}
                  disabled={isSubmitting}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700"
                >
                  Clear
                </button>

                <button
                  type="submit"
                  disabled={
                    isSubmitting
                    || isLoadingPatients
                    || isResolvingHospital
                    || isUploadingPreview
                    || !Number(form.patientId || 0)
                    || !normalizeSpecNumber(form.wigSpecificationId)
                  }
                  className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {isSubmitting || isUploadingPreview ? 'Submitting...' : 'Submit Request'}
                </button>

                <span className="text-xs text-slate-500">
                  Initial status: <span className="font-semibold text-slate-700">{REQUEST_STATUS.pending}</span>
                </span>
              </div>
            </form>

            <aside className="xl:col-span-5">
              <div className="sticky top-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">PDF Preview</h3>
                    <p className="text-xs text-slate-500">Preview generated from form data and auto-uploaded on submit.</p>
                  </div>
                  <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600">A4</span>
                </div>

                <div className="rounded-lg border border-slate-300 bg-white p-3 shadow-sm">
                  <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
                    {previewLogoResolvedUrl ? (
                      <img
                        src={previewLogoResolvedUrl}
                        alt={`${previewBrandName} logo`}
                        className="h-9 w-9 rounded-md border border-slate-200 object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-slate-900 text-[10px] font-bold text-white">
                        {getAvatarInitials(previewBrandName)}
                      </div>
                    )}
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-900">{previewBrandName}</p>
                      <p className="text-[10px] text-slate-500">Wig Request Preview</p>
                    </div>
                  </div>

                  <div className="mt-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <AvatarCircle
                        photoUrl={selectedPatientProfile.photoUrl}
                        name={selectedPatientProfile.fullName}
                        sizeClass="h-12 w-12"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-slate-900">
                          {selectedPatientProfile.fullName || 'No patient selected'}
                        </p>
                        <p className="truncate text-[11px] text-slate-500">
                          {selectedPatientProfile.patientCode || 'Patient code not selected'}
                        </p>
                      </div>
                    </div>

                    <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Personal Details</p>

                    <PreviewRow label="Age" value={selectedPatientProfile.age} />
                    <PreviewRow label="Gender" value={selectedPatientProfile.gender} />
                    <PreviewRow label="Medical Condition" value={selectedPatientProfile.medicalCondition} />

                    <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Request Specifications</p>
                    <PreviewRow label="Spec ID" value={selectedRequestedSpecification?.specificationId || ''} />
                    <PreviewRow label="Style" value={selectedRequestedSpecification?.style || ''} />
                    <PreviewRow label="Color" value={selectedRequestedSpecification?.color || ''} />
                    <PreviewRow label="Length" value={selectedRequestedSpecification?.hairLength ?? ''} />
                    <PreviewRow label="Texture" value={selectedRequestedSpecification?.texture || ''} />
                    <PreviewRow label="Cap Size" value={selectedRequestedSpecification?.capSizeLabel || selectedRequestedSpecification?.capSize || ''} />
                    <PreviewRow label="Special Note" value={form.specialNoteTemplate} />
                    <PreviewRow label="Status" value={REQUEST_STATUS.pending} />
                  </div>
                </div>

                <div className="mt-3 rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-2 text-xs text-slate-600">
                  Preview PDF is automatically generated when you submit this request.
                </div>
              </div>
            </aside>
          </div>
        </section>
      )}

      {activeTab === 'submitted' && (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-slate-900">Submitted Requests</h2>
            <p className="mt-0.5 text-xs text-slate-500">Use sliding status options to focus on one workflow stage.</p>

            <div className="mt-3 overflow-x-auto">
              <div className="flex min-w-max items-center gap-2 pb-1">
                {SUBMITTED_STATUS_FILTERS.map((filterItem) => (
                  <button
                    key={filterItem.id}
                    type="button"
                    onClick={() => setSubmittedStatusFilter(filterItem.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      submittedStatusFilter === filterItem.id
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {filterItem.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3">
              <input
                value={submittedSearchTerm}
                onChange={(event) => setSubmittedSearchTerm(event.target.value)}
                className={INPUT_CLASS}
                placeholder="Search by request ID, patient, medical condition, status, or date"
              />
            </div>
          </div>

          {isLoadingSubmitted ? (
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
                          <Info size={13} /> Info
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
        <div className="fixed inset-0 z-[90] m-0 p-0">
          <button
            type="button"
            aria-label="Close request preview panel"
            className="absolute inset-0 m-0 p-0 border-0 appearance-none bg-black bg-opacity-50 backdrop-blur-sm"
            onClick={handleCloseSubmittedRequestPreview}
          />

          <aside
            className="absolute right-0 top-0 h-full w-full max-w-3xl overflow-y-auto border-l border-slate-200 bg-white shadow-2xl"
            style={{ animation: 'submittedRequestPreviewSlideIn 0.25s ease-out' }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Request PDF Preview</h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {selectedSubmittedRequest.requestId} | {selectedSubmittedRequest.patient}
                </p>
              </div>
              <button type="button" onClick={handleCloseSubmittedRequestPreview} className="text-slate-400 hover:text-red-500">
                <X size={22} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p><span className="font-semibold text-slate-900">Medical Condition:</span> {selectedSubmittedRequest.medicalCondition}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Request Date:</span> {formatRequestDateTime(selectedSubmittedRequest.requestDate)}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Status:</span> {selectedSubmittedRequest.statusLabel || getStatusLabel(selectedSubmittedRequest.status)}</p>
                <p className="mt-1"><span className="font-semibold text-slate-900">Last Updated:</span> {formatRequestDateTime(selectedSubmittedRequest.updatedAt || selectedSubmittedRequest.requestDate)}</p>
                {selectedSubmittedRequest.statusReason && (
                  <p className="mt-1 whitespace-pre-line">
                    <span className="font-semibold text-slate-900">Status Reason:</span> {selectedSubmittedRequest.statusReason}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">Requested Wig Preference</p>
                <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-700 sm:grid-cols-2">
                  <p><span className="font-semibold text-slate-900">Spec ID:</span> {selectedSubmittedRequest.requestSpecId || 'N/A'}</p>
                  <p><span className="font-semibold text-slate-900">Wig Name:</span> {selectedSubmittedRequest.requestSpecWigName}</p>
                  <p><span className="font-semibold text-slate-900">Color:</span> {selectedSubmittedRequest.requestSpecColor}</p>
                  <p><span className="font-semibold text-slate-900">Length:</span> {selectedSubmittedRequest.requestSpecLength}</p>
                  <p><span className="font-semibold text-slate-900">Density:</span> {selectedSubmittedRequest.requestSpecDensity}</p>
                  <p><span className="font-semibold text-slate-900">Style:</span> {selectedSubmittedRequest.requestSpecStyle}</p>
                  <p><span className="font-semibold text-slate-900">Texture:</span> {selectedSubmittedRequest.requestSpecTexture}</p>
                  <p><span className="font-semibold text-slate-900">Cap Size:</span> {selectedSubmittedRequest.requestSpecCapSize}</p>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">Special Note:</span> {selectedSubmittedRequest.requestSpecSpecialNote}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {[
                    ['Front', selectedSubmittedRequest.requestSpecFrontImageUrl],
                    ['Side', selectedSubmittedRequest.requestSpecSideImageUrl],
                    ['Top', selectedSubmittedRequest.requestSpecTopImageUrl],
                    ['Back', selectedSubmittedRequest.requestSpecBackImageUrl],
                  ].map(([label, imageUrl]) => (
                    <div key={label} className="rounded-md border border-slate-200 bg-slate-50 p-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                      {imageUrl ? (
                        <img src={imageUrl} alt={`${label} requested wig`} className="mt-1 h-24 w-full rounded object-cover" />
                      ) : (
                        <div className="mt-1 flex h-24 items-center justify-center rounded border border-dashed border-slate-300 bg-white text-[11px] text-slate-500">
                          No image
                        </div>
                      )}
                    </div>
                  ))}
                </div>
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
          </aside>
        </div>,
        document.body,
      )}

      <style>{`
        @keyframes submittedRequestPreviewSlideIn {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
      `}</style>
    </div>
  );
}


