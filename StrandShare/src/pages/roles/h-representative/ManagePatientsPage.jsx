import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  UploadCloud,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import {
  isSupabaseConfigured,
  supabase,
} from '../../../lib/supabaseClient';
import {
  extractMedicalDocumentText,
  parseMedicalDocumentFields,
} from '../../../lib/medicalDocumentAutofill';

const PATIENTS_TABLE = 'Patients';
const USERS_TABLE = 'users';
const USER_DETAILS_TABLE = 'user_details';
const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const PATIENT_ASSETS_BUCKET = 'patient_assets';
const PH_MOBILE_REGEX = /^\+63 9\d{2} \d{3} \d{4}$/;
const PST_TIMEZONE = 'Asia/Manila';
const PST_OFFSET = '+08:00';

const EMPTY_FORM = {
  email: '',
  accessStart: '',
  accessEnd: '',
  firstName: '',
  middleName: '',
  lastName: '',
  suffix: '',
  birthdate: '',
  gender: '',
  dateOfDiagnosis: '',
  guardian: '',
  guardianContactNumber: '',
  guardianRelationship: '',
  medicalCondition: '',
};

const GENDER_OPTIONS = [
  { id: 'Male', label: 'Male' },
  { id: 'Female', label: 'Female' },
  { id: 'Other', label: 'Other' },
  { id: 'Prefer not to say', label: 'Prefer not to say' },
];

const AUTOFILL_FIELD_LABELS = {
  email: 'Email',
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
  suffix: 'Suffix',
  birthdate: 'Birthdate',
  gender: 'Gender',
  dateOfDiagnosis: 'Diagnosis date',
  guardian: 'Guardian',
  guardianContactNumber: 'Guardian contact',
  guardianRelationship: 'Guardian relationship',
  medicalCondition: 'Medical condition',
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function getFirstPresentValue(source, keys) {
  for (const key of keys) {
    const rawValue = source?.[key];
    if (rawValue === null || rawValue === undefined) {
      continue;
    }

    const normalizedValue = String(rawValue).trim();
    if (normalizedValue) {
      return rawValue;
    }
  }

  return '';
}

function pickPreferredUserDetails(detailsValue) {
  const detailsArray = Array.isArray(detailsValue)
    ? detailsValue
    : detailsValue
      ? [detailsValue]
      : [];

  if (detailsArray.length === 0) {
    return null;
  }

  return detailsArray[0];
}

function normalizePatientGender(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');

  if (!normalized) {
    return '';
  }

  if (normalized === 'm' || normalized === 'male') {
    return 'Male';
  }

  if (normalized === 'f' || normalized === 'female') {
    return 'Female';
  }

  if (normalized === 'other' || normalized === 'non binary' || normalized === 'non-binary' || normalized === 'nonbinary') {
    return 'Other';
  }

  if (normalized === 'prefer not to say' || normalized === 'prefer-not-to-say') {
    return 'Prefer not to say';
  }

  return '';
}

function toSafeFileName(fileName) {
  return String(fileName || 'file')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';

  return `${parsed.toLocaleString('en-PH', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })} PST`;
}

function computeAgeFromBirthdate(birthdateValue) {
  if (!birthdateValue) {
    return '';
  }

  let birthDate;

  if (typeof birthdateValue === 'string') {
    const normalizedValue = birthdateValue.trim().split('T')[0];
    const dateMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (dateMatch) {
      const year = Number(dateMatch[1]);
      const month = Number(dateMatch[2]);
      const day = Number(dateMatch[3]);
      birthDate = new Date(year, month - 1, day);
    } else {
      birthDate = new Date(birthdateValue);
    }
  } else {
    birthDate = new Date(birthdateValue);
  }

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

  return years;
}

function shuffleArray(values) {
  const output = [...values];

  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = output[index];
    output[index] = output[swapIndex];
    output[swapIndex] = temp;
  }

  return output;
}

function buildRandomPatientCode() {
  return `PT${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
}

function generateTemporaryPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const numbers = '23456789';
  const symbols = '!@#$%*';
  const all = `${upper}${lower}${numbers}${symbols}`;

  const required = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    numbers[Math.floor(Math.random() * numbers.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];

  const remaining = Array.from({ length: 8 }, () => all[Math.floor(Math.random() * all.length)]);
  return shuffleArray([...required, ...remaining]).join('');
}

function formatPhilippineMobileInput(value) {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.startsWith('63')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  digits = digits.slice(0, 10);

  if (!digits) {
    return '';
  }

  const part1 = digits.slice(0, 3);
  const part2 = digits.slice(3, 6);
  const part3 = digits.slice(6, 10);

  let formatted = '+63';
  if (part1) formatted += ` ${part1}`;
  if (part2) formatted += ` ${part2}`;
  if (part3) formatted += ` ${part3}`;

  return formatted;
}

function isValidPhilippineMobileNumber(value) {
  return PH_MOBILE_REGEX.test(String(value || '').trim());
}

function formatDateForInput(value) {
  if (!value) return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(parsed).map((part) => [part.type, part.value]),
  );

  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

function phtDateTimeLocalToDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2}))?$/);
  if (match) {
    const seconds = match[7] || '00';
    const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${seconds}${PST_OFFSET}`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function toIsoOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2}))?$/);
  if (match) {
    const seconds = match[7] || '00';
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${seconds}+08:00`;
  }

  const parsed = phtDateTimeLocalToDate(raw);
  if (!parsed) return null;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(parsed).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+08:00`;
}

function getPstTimestamp(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+08:00`;
}

function buildDisplayName({ firstName, middleName, lastName, suffix }) {
  return [firstName, middleName, lastName, suffix]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPatientFullName(userRow, patientRow = null) {
  const details = pickPreferredUserDetails(userRow?.user_details);

  const fullName = [details?.first_name, details?.middle_name, details?.last_name, details?.suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (fullName) {
    return fullName;
  }

  const email = String(userRow?.email || '').trim();
  if (email) {
    return email;
  }

  if (patientRow?.Patient_Code) {
    return patientRow.Patient_Code;
  }

  return `Patient #${patientRow?.Patient_ID || 'N/A'}`;
}

function mapStorageUploadError(rawMessage) {
  const message = String(rawMessage || 'Upload failed.');
  if (message.toLowerCase().includes('row-level security')) {
    return 'Upload blocked by Storage RLS policy. Apply patient_assets storage policies first.';
  }
  return message;
}

function mapAuthSignupError(rawMessage) {
  const message = String(rawMessage || 'Unable to create authentication account.');
  const lowerMessage = message.toLowerCase();

  if (
    !message
    || lowerMessage.includes('failed to send a request')
    || lowerMessage.includes('function not found')
    || lowerMessage.includes('non-2xx status')
  ) {
    return 'Patient invite service is not active. Deploy the invite-patient-account Edge Function, then retry.';
  }

  if (lowerMessage.includes('already registered') || lowerMessage.includes('already been registered')) {
    return 'Email is already registered. Use a different email address.';
  }

  if (lowerMessage.includes('invalid email')) {
    return 'Please enter a valid patient email address.';
  }

  if (lowerMessage.includes('password')) {
    return 'Unable to create auth account due to password policy. Please retry.';
  }

  if (lowerMessage.includes('rate limit')) {
    return 'Too many signup attempts. Please wait a moment and try again.';
  }

  return message;
}

function mapPatientInsertError(rawMessage) {
  const message = String(rawMessage || 'Unable to save patient record.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('duplicate key value') && lowerMessage.includes('patient_code')) {
    return 'Patient code already exists. Please generate a new PT code.';
  }

  if (
    lowerMessage.includes('duplicate key value')
    && (
      lowerMessage.includes('patients_user_id_unique')
      || lowerMessage.includes('patients_user_id_key')
      || (lowerMessage.includes('patients') && lowerMessage.includes('user_id'))
    )
  ) {
    return 'This user is already linked to another patient record.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Patient creation was denied by the database. Refresh the page and try again. If it continues, sign out and back in so your hospital assignment is refreshed.';
  }

  return message;
}

function extractReadableErrorText(error, fallback = 'Unable to process this request.') {
  if (!error) {
    return fallback;
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || fallback;
  }

  if (error instanceof Error) {
    const trimmed = String(error.message || '').trim();
    return trimmed || fallback;
  }

  const message = String(error?.message || '').trim();
  const details = String(error?.details || '').trim();
  const hint = String(error?.hint || '').trim();
  const code = String(error?.code || '').trim();

  const parts = [message, details, hint].filter(Boolean);
  const composed = parts.join(' | ');
  if (composed) {
    return code ? `${composed} (code: ${code})` : composed;
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') {
      return serialized;
    }
  } catch {
    // Ignore stringify issues and fall through.
  }

  return fallback;
}

export default function ManagePatientsPage({ userProfile }) {
  const { theme } = useTheme();
  const submitLockRef = useRef(false);
  const errorToastIdRef = useRef(0);
  const documentAutofillRunRef = useRef(0);
  const formRef = useRef({ ...EMPTY_FORM });

  const [hospitalId, setHospitalId] = useState(null);
  const [hospitalName, setHospitalName] = useState('');

  const [patients, setPatients] = useState([]);
  const [patientUsers, setPatientUsers] = useState([]);

  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
  }));

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const [patientPictureFile, setPatientPictureFile] = useState(null);
  const [medicalDocumentFile, setMedicalDocumentFile] = useState(null);
  const [patientPicturePreviewUrl, setPatientPicturePreviewUrl] = useState('');
  const [medicalDocumentPreviewUrl, setMedicalDocumentPreviewUrl] = useState('');
  const [documentAutofill, setDocumentAutofill] = useState({
    status: 'idle',
    message: '',
    fieldNames: [],
    progress: 0,
  });

  const [isResolvingHospital, setIsResolvingHospital] = useState(false);
  const [isLoadingPatients, setIsLoadingPatients] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [notice, setNotice] = useState({ kind: '', text: '' });
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [successPopup, setSuccessPopup] = useState({ open: false, text: '' });
  const [errorToasts, setErrorToasts] = useState([]);
  const [patientSearchTerm, setPatientSearchTerm] = useState('');

  const [activeTab, setActiveTab] = useState('directory');
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [genderFilter, setGenderFilter] = useState('all');
  const [filesFilter, setFilesFilter] = useState('all');

  useEffect(() => {
    if (notice.kind !== 'error' || !notice.text) return;

    errorToastIdRef.current += 1;
    const errorToast = {
      id: errorToastIdRef.current,
      text: notice.text,
    };

    setErrorToasts((previous) => [...previous, errorToast].slice(-5));
    setNotice({ kind: '', text: '' });
  }, [notice.kind, notice.text]);

  const dismissErrorToast = useCallback((toastId) => {
    setErrorToasts((previous) => previous.filter((toast) => toast.id !== toastId));
  }, []);

  const patientUsersById = useMemo(() => {
    const map = new Map();
    patientUsers.forEach((user) => {
      map.set(Number(user.user_id), user);
    });
    return map;
  }, [patientUsers]);

  const computedAgeFromForm = useMemo(() => {
    const age = computeAgeFromBirthdate(form.birthdate);
    return age === '' ? '' : String(age);
  }, [form.birthdate]);
  const confirmationPatientName = useMemo(() => buildDisplayName({
    firstName: form.firstName,
    middleName: form.middleName,
    lastName: form.lastName,
    suffix: form.suffix,
  }), [form.firstName, form.middleName, form.lastName, form.suffix]);
  const nowLocalDateTimeValue = useMemo(() => formatDateForInput(new Date()), []);
  const todayDateValue = useMemo(() => formatDateForInput(new Date()).slice(0, 10), []);

  const isMedicalDocumentImage = useMemo(
    () => String(medicalDocumentFile?.type || '').toLowerCase().startsWith('image/'),
    [medicalDocumentFile],
  );

  const isMedicalDocumentPdf = useMemo(() => {
    const fileType = String(medicalDocumentFile?.type || '').toLowerCase();
    const fileName = String(medicalDocumentFile?.name || '').toLowerCase();
    return fileType === 'application/pdf' || fileName.endsWith('.pdf');
  }, [medicalDocumentFile]);

  const resolveAssetUrl = useCallback((assetPath) => {
    const path = String(assetPath || '').trim();
    if (!path || !supabase) {
      return '';
    }

    const { data } = supabase.storage.from(PATIENT_ASSETS_BUCKET).getPublicUrl(path);
    return data?.publicUrl || '';
  }, []);

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
      setHospitalName('');
      setNotice({
        kind: 'error',
        text: 'Unable to resolve your account ID. Please sign in again.',
      });
      return;
    }

    try {
      setIsResolvingHospital(true);
      const { data, error } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .select('Hospital_ID, hRepresentatives:Hospitals(Hospital_Name)')
        .eq('User_ID', activeUserId)
        .maybeSingle();

      if (error) throw error;

      const nextHospitalId = Number(data?.Hospital_ID || 0) || null;
      const linkedHospital = Array.isArray(data?.hRepresentatives) ? data.hRepresentatives[0] : data?.hRepresentatives;

      setHospitalId(nextHospitalId);
      setHospitalName(String(linkedHospital?.Hospital_Name || '').trim());

      if (!nextHospitalId) {
        setNotice({
          kind: 'error',
          text: 'No hospital assignment found for your account. Ask Admin to assign your account first.',
        });
      }
    } catch (error) {
      setHospitalId(null);
      setHospitalName('');
      setNotice({
        kind: 'error',
        text: error.message || 'Unable to load your hospital assignment.',
      });
    } finally {
      setIsResolvingHospital(false);
    }
  }, [userProfile?.user_id]);

  const fetchPatients = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !hospitalId) {
      setPatients([]);
      setPatientUsers([]);
      return;
    }

    try {
      setIsLoadingPatients(true);

      const { data: patientRows, error: patientError } = await supabase
        .from(PATIENTS_TABLE)
        .select('*')
        .eq('Hospital_ID', hospitalId)
        .order('Created_At', { ascending: false });

      if (patientError) throw patientError;

      const nextPatients = patientRows || [];
      setPatients(nextPatients);

      const userIds = Array.from(
        new Set(
          nextPatients
            .map((row) => Number(row.User_ID || 0))
            .filter((id) => Number.isFinite(id) && id > 0),
        ),
      );

      if (userIds.length === 0) {
        setPatientUsers([]);
        return;
      }

      const { data: linkedUsers, error: linkedUsersError } = await supabase
        .from(USERS_TABLE)
        .select(`
          user_id,
          email,
          role,
          user_details:user_details (
            first_name,
            middle_name,
            last_name,
            suffix,
            birthdate,
            gender
          )
        `)
        .in('user_id', userIds);

      if (linkedUsersError) throw linkedUsersError;
      setPatientUsers(linkedUsers || []);
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Unable to load patients.' });
    } finally {
      setIsLoadingPatients(false);
    }
  }, [hospitalId]);

  useEffect(() => {
    resolveAssignedHospital();
  }, [resolveAssignedHospital]);

  useEffect(() => {
    if (!hospitalId) {
      setPatients([]);
      setPatientUsers([]);
      return;
    }

    fetchPatients();
  }, [hospitalId, fetchPatients]);

  useEffect(() => {
    if (!patientPictureFile) {
      setPatientPicturePreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(patientPictureFile);
    setPatientPicturePreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [patientPictureFile]);

  useEffect(() => {
    if (!medicalDocumentFile) {
      setMedicalDocumentPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(medicalDocumentFile);
    setMedicalDocumentPreviewUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [medicalDocumentFile]);

  const enrichedPatients = useMemo(() => {
    return patients.map((patient) => {
      const linkedUser = patientUsersById.get(Number(patient.User_ID || 0)) || null;
      const details = pickPreferredUserDetails(linkedUser?.user_details);

      const birthdateValue = getFirstPresentValue(details, ['birthdate', 'Birthdate']);
      const ageValue = computeAgeFromBirthdate(birthdateValue);
      const genderValue = normalizePatientGender(getFirstPresentValue(details, ['gender', 'Gender']));

      return {
        ...patient,
        fullName: getPatientFullName(linkedUser, patient),
        age: ageValue === '' ? 'N/A' : String(ageValue),
        gender: genderValue || 'N/A',
        pictureUrl: resolveAssetUrl(patient.Patient_Picture),
        documentUrl: resolveAssetUrl(patient.Medical_Document),
      };
    });
  }, [patients, patientUsersById, resolveAssetUrl]);

  const filteredPatients = useMemo(() => {
    let results = enrichedPatients;

    if (genderFilter !== 'all') {
      results = results.filter((patient) => patient.gender === genderFilter);
    }

    if (filesFilter === 'with_picture') {
      results = results.filter((patient) => Boolean(patient.Patient_Picture));
    } else if (filesFilter === 'with_document') {
      results = results.filter((patient) => Boolean(patient.Medical_Document));
    } else if (filesFilter === 'with_both') {
      results = results.filter((patient) => Boolean(patient.Patient_Picture) && Boolean(patient.Medical_Document));
    } else if (filesFilter === 'missing') {
      results = results.filter((patient) => !patient.Patient_Picture || !patient.Medical_Document);
    }

    const query = normalizeText(patientSearchTerm);
    if (query) {
      results = results.filter((patient) => {
        const searchableValues = [
          patient.fullName,
          patient.age,
          patient.gender,
          patient.Medical_Condition,
          patient.Patient_Code,
        ]
          .map((value) => normalizeText(value))
          .filter(Boolean);

        return searchableValues.some((value) => value.includes(query));
      });
    }

    return results;
  }, [enrichedPatients, patientSearchTerm, genderFilter, filesFilter]);

  const resetForm = useCallback(() => {
    documentAutofillRunRef.current += 1;
    const emptyForm = {
      ...EMPTY_FORM,
    };
    formRef.current = emptyForm;
    setForm(emptyForm);
    setPatientPictureFile(null);
    setMedicalDocumentFile(null);
    setConfirmationOpen(false);
    setDocumentAutofill({ status: 'idle', message: '', fieldNames: [], progress: 0 });
  }, []);

  const handleInputChange = useCallback((event) => {
    const { name, value } = event.target;

    if (name === 'guardianContactNumber') {
      const formattedContactNumber = formatPhilippineMobileInput(value);
      setForm((previous) => ({
        ...previous,
        guardianContactNumber: formattedContactNumber,
      }));
      return;
    }

    setForm((previous) => ({
      ...previous,
      [name]: value,
    }));
  }, []);

  const handleMedicalDocumentChange = useCallback(async (event) => {
    const file = event.target.files?.[0] || null;
    const runId = documentAutofillRunRef.current + 1;
    documentAutofillRunRef.current = runId;
    setMedicalDocumentFile(file);

    if (!file) {
      setDocumentAutofill({ status: 'idle', message: '', fieldNames: [], progress: 0 });
      return;
    }

    setDocumentAutofill({
      status: 'processing',
      message: 'Reading the medical document and looking for patient details...',
      fieldNames: [],
      progress: 0,
    });

    try {
      const documentText = await extractMedicalDocumentText(file, {
        onProgress: ({ stage, progress }) => {
          if (documentAutofillRunRef.current !== runId) return;
          const percent = Math.max(0, Math.min(100, Math.round(Number(progress || 0) * 100)));
          const stageLabel = stage === 'reading-pdf'
            ? 'Reading PDF text'
            : stage === 'scanning-pdf'
              ? 'Preparing scanned PDF page'
              : 'Recognizing document text';
          setDocumentAutofill((previous) => ({
            ...previous,
            status: 'processing',
            message: `${stageLabel}${percent ? ` (${percent}%)` : ''}...`,
            progress: percent,
          }));
        },
      });

      if (documentAutofillRunRef.current !== runId) return;

      const recognizedFields = parseMedicalDocumentFields(documentText);
      const appliedFieldNames = [];
      const nextForm = { ...formRef.current };

      Object.entries(recognizedFields).forEach(([fieldName, value]) => {
        if (!String(formRef.current[fieldName] || '').trim() && String(value || '').trim()) {
          nextForm[fieldName] = value;
          appliedFieldNames.push(fieldName);
        }
      });

      if (appliedFieldNames.length > 0) {
        formRef.current = nextForm;
        setForm(nextForm);
      }

      if (appliedFieldNames.length > 0) {
        setDocumentAutofill({
          status: 'success',
          message: `Filled ${appliedFieldNames.length} empty field${appliedFieldNames.length === 1 ? '' : 's'}. Please review the recognized details before saving.`,
          fieldNames: appliedFieldNames,
          progress: 100,
        });
      } else if (Object.keys(recognizedFields).length > 0) {
        setDocumentAutofill({
          status: 'info',
          message: 'Patient details were recognized, but the matching form fields already contain values. Nothing was overwritten.',
          fieldNames: [],
          progress: 100,
        });
      } else {
        setDocumentAutofill({
          status: 'info',
          message: 'The document is attached, but no clearly labeled patient details could be recognized. You can complete the form manually.',
          fieldNames: [],
          progress: 100,
        });
      }
    } catch (error) {
      if (documentAutofillRunRef.current !== runId) return;
      setDocumentAutofill({
        status: 'info',
        message: 'The file is still attached. Complete or review the patient details manually.',
        fieldNames: [],
        progress: 0,
      });
      setNotice({
        kind: 'error',
        text: error.message || 'Unable to read this document automatically.',
      });
    }
  }, []);

  const uploadAsset = useCallback(async (file, subFolder) => {
    if (!file || !supabase) {
      return '';
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user?.id) {
      throw new Error('Unable to resolve authenticated user for file upload.');
    }

    const path = `${user.id}/${subFolder}/${Date.now()}-${toSafeFileName(file.name)}`;

    const { error } = await supabase.storage
      .from(PATIENT_ASSETS_BUCKET)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      throw new Error(mapStorageUploadError(error.message));
    }

    return path;
  }, []);

  const cleanupUploadedAssets = useCallback(async (paths) => {
    if (!supabase || !Array.isArray(paths) || paths.length === 0) {
      return;
    }

    try {
      await supabase.storage.from(PATIENT_ASSETS_BUCKET).remove(paths);
    } catch {
      // Ignore cleanup failures so main workflow error is still shown.
    }
  }, []);

  const resolveUniquePatientCode = useCallback(async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = buildRandomPatientCode();

      const { data: duplicateRow, error: duplicateError } = await supabase
        .from(PATIENTS_TABLE)
        .select('Patient_ID')
        .eq('Patient_Code', candidate)
        .maybeSingle();

      if (duplicateError) throw duplicateError;

      if (!duplicateRow) {
        return candidate;
      }
    }

    throw new Error('Unable to generate unique patient code right now. Please try again.');
  }, []);

  const sendPatientInviteEmail = useCallback(async ({
    email,
    temporaryPassword,
    patientCode,
    displayName,
    accessStart,
    accessEnd,
  }) => {
    const metadata = {
      account_type: 'patient',
      decision: 'approved',
      role_label: 'Patient',
      account_label: 'Patient Code',
      account_value: patientCode || '-',
      recipient_email: email || '-',
      recipient_name: displayName || '',
      review_notes: '',
      has_access_window: Boolean(accessStart || accessEnd),
      access_window: accessStart && accessEnd ? `${formatDateTime(accessStart)} to ${formatDateTime(accessEnd)}` : '',
      temporary_password: temporaryPassword || '',
      display_name: displayName || '',
      full_name: displayName || '',
      name: displayName || '',
    };

    const { data, error } = await supabase.functions.invoke('invite-patient-account', {
      body: {
        action: 'invite',
        hospitalId: Number(hospitalId),
        email,
        temporaryPassword,
        metadata,
      },
    });

    if (error) {
      throw new Error(mapAuthSignupError(error.message));
    }
    if (data?.error) throw new Error(mapAuthSignupError(data.error));

    const authUserId = data?.authUserId || null;
    if (!authUserId) {
      throw new Error('Invite was sent but auth user id was not returned.');
    }

    return authUserId;
  }, [hospitalId]);

  const deleteInvitedPatientAuthUser = useCallback(async (authUserId) => {
    if (!authUserId || !supabase) return;
    await supabase.functions.invoke('invite-patient-account', {
      body: { action: 'delete', hospitalId: Number(hospitalId), authUserId },
    });
  }, [hospitalId]);

  const ensurePatientInviteServiceAvailable = useCallback(async () => {
    const { data, error } = await supabase.functions.invoke('invite-patient-account', {
      body: { action: 'authorize', hospitalId: Number(hospitalId) },
    });

    if (error) throw new Error(mapAuthSignupError(error.message));
    if (data?.error) throw new Error(mapAuthSignupError(data.error));
    if (data?.authorized !== true) {
      throw new Error('Patient invite service did not authorize this hospital account.');
    }
  }, [hospitalId]);

  const resolveOrCreatePublicUser = useCallback(async ({
    email,
    authUserId,
    accessStartIso,
    accessEndIso,
  }) => {
    let publicUserRow = null;

    if (authUserId) {
      const { data, error } = await supabase
        .from(USERS_TABLE)
        .select('user_id,email,role,auth_user_id,is_active')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      if (error) throw error;
      publicUserRow = data || null;
    }

    if (!publicUserRow) {
      const { data, error } = await supabase
        .from(USERS_TABLE)
        .select('user_id,email,role,auth_user_id,is_active')
        .eq('email', email)
        .maybeSingle();

      if (error) throw error;
      publicUserRow = data || null;
    }

    if (!publicUserRow) {
      const { data, error } = await supabase
        .from(USERS_TABLE)
        .insert({
          auth_user_id: authUserId,
          email,
          role: 'tentative',
          access_start: accessStartIso,
          access_end: accessEndIso,
          is_active: true,
        })
        .select('user_id,email,role,auth_user_id,is_active')
        .maybeSingle();

      if (error) throw error;
      if (!data?.user_id) {
        throw new Error('Unable to create users record for this patient account.');
      }

      return data;
    }

    const updatePayload = {};
    if (!publicUserRow.auth_user_id && authUserId) {
      updatePayload.auth_user_id = authUserId;
    }

    if (normalizeText(publicUserRow.role) !== 'tentative') {
      updatePayload.role = 'tentative';
    }

    if (publicUserRow.is_active !== true) {
      updatePayload.is_active = true;
    }

    if (accessStartIso) {
      updatePayload.access_start = accessStartIso;
    }

    if (accessEndIso) {
      updatePayload.access_end = accessEndIso;
    }

    if (Object.keys(updatePayload).length === 0) {
      return publicUserRow;
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from(USERS_TABLE)
      .update(updatePayload)
      .eq('user_id', publicUserRow.user_id)
      .select('user_id,email,role,auth_user_id,is_active')
      .maybeSingle();

    if (updateError) throw updateError;

    return updatedRow || {
      ...publicUserRow,
      ...updatePayload,
    };
  }, []);

  const upsertPublicUserDetails = useCallback(async ({
    userId,
    firstName,
    middleName,
    lastName,
    suffix,
    birthdate,
    gender,
  }) => {
    const joinedDateValue = getPstTimestamp().slice(0, 10);
    const payload = {
      first_name: firstName,
      middle_name: middleName || null,
      last_name: lastName,
      suffix: suffix || null,
      birthdate,
      gender,
      updated_at: getPstTimestamp(),
    };

    const { data: existingDetailsRows, error: findError } = await supabase
      .from(USER_DETAILS_TABLE)
      .select('user_details_id,joined_date')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (findError) throw findError;

    const existingDetails = Array.isArray(existingDetailsRows) && existingDetailsRows.length > 0
      ? existingDetailsRows[0]
      : null;

    if (!existingDetails) {
      const { error: insertError } = await supabase
        .from(USER_DETAILS_TABLE)
        .insert({
          user_id: userId,
          joined_date: joinedDateValue,
          ...payload,
        });

      if (insertError) throw insertError;
      return;
    }

    const updatePayload = {
      ...payload,
      ...(existingDetails.joined_date ? {} : { joined_date: joinedDateValue }),
    };

    const { error: updateError } = await supabase
      .from(USER_DETAILS_TABLE)
      .update(updatePayload)
      .eq('user_details_id', existingDetails.user_details_id);

    if (updateError) throw updateError;
  }, []);

  const isUserAlreadyLinkedAsPatient = useCallback(async (userId) => {
    const { data, error } = await supabase
      .from(PATIENTS_TABLE)
      .select('Patient_ID')
      .eq('User_ID', userId)
      .maybeSingle();

    if (error) throw error;
    return Boolean(data?.Patient_ID);
  }, []);

  const createPatientAccount = async () => {
    if (submitLockRef.current || isSaving) {
      return;
    }
    submitLockRef.current = true;

    if (!isSupabaseConfigured || !supabase) {
      setNotice({
        kind: 'error',
        text: 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.',
      });
      submitLockRef.current = false;
      return;
    }

    if (!hospitalId) {
      setNotice({
        kind: 'error',
        text: 'You are not assigned to any hospital. Ask Admin to assign your account first.',
      });
      submitLockRef.current = false;
      return;
    }

    const normalizedEmail = String(form.email || '').trim().toLowerCase();
    const normalizedFirstName = String(form.firstName || '').trim();
    const normalizedMiddleName = String(form.middleName || '').trim();
    const normalizedLastName = String(form.lastName || '').trim();
    const normalizedSuffix = String(form.suffix || '').trim();
    const normalizedBirthdate = String(form.birthdate || '').trim();
    const normalizedGender = normalizePatientGender(form.gender);
    const normalizedDisplayName = buildDisplayName({
      firstName: normalizedFirstName,
      middleName: normalizedMiddleName,
      lastName: normalizedLastName,
      suffix: normalizedSuffix,
    });
    const normalizedGuardianContactNumber = String(form.guardianContactNumber || '').trim();
    const normalizedAccessStart = String(form.accessStart || '').trim();
    const normalizedAccessEnd = String(form.accessEnd || '').trim();
    const accessStartIso = toIsoOrNull(normalizedAccessStart);
    const accessEndIso = toIsoOrNull(normalizedAccessEnd);

    if (!normalizedEmail) {
      setNotice({ kind: 'error', text: 'Patient email is required for invite email delivery.' });
      submitLockRef.current = false;
      return;
    }

    if (!normalizedFirstName || !normalizedLastName) {
      setNotice({ kind: 'error', text: 'First name and last name are required.' });
      submitLockRef.current = false;
      return;
    }

    if (!normalizedBirthdate) {
      setNotice({ kind: 'error', text: 'Birthdate is required to compute age.' });
      submitLockRef.current = false;
      return;
    }

    if (!normalizedGender) {
      setNotice({ kind: 'error', text: 'Gender is required.' });
      submitLockRef.current = false;
      return;
    }

    if (normalizedGuardianContactNumber && !isValidPhilippineMobileNumber(normalizedGuardianContactNumber)) {
      setNotice({ kind: 'error', text: 'Guardian contact number must use +63 912 345 6789 format.' });
      submitLockRef.current = false;
      return;
    }

    if ((normalizedAccessStart && !normalizedAccessEnd) || (!normalizedAccessStart && normalizedAccessEnd)) {
      setNotice({ kind: 'error', text: 'Access Start and Access End are both required when setting access time.' });
      submitLockRef.current = false;
      return;
    }

    if ((normalizedAccessStart && !accessStartIso) || (normalizedAccessEnd && !accessEndIso)) {
      setNotice({ kind: 'error', text: 'Invalid access date/time value.' });
      submitLockRef.current = false;
      return;
    }

    if (accessStartIso && new Date(accessStartIso) < new Date(getPstTimestamp())) {
      setNotice({ kind: 'error', text: 'Access Start cannot be in the past (PST).' });
      submitLockRef.current = false;
      return;
    }

    if (accessStartIso && accessEndIso && new Date(accessEndIso) <= new Date(accessStartIso)) {
      setNotice({ kind: 'error', text: 'Access End must be later than Access Start.' });
      submitLockRef.current = false;
      return;
    }

    if (new Date(normalizedBirthdate) > new Date()) {
      setNotice({ kind: 'error', text: 'Birthdate cannot be in the future.' });
      submitLockRef.current = false;
      return;
    }

    if (String(form.dateOfDiagnosis || '').trim() && new Date(form.dateOfDiagnosis) > new Date()) {
      setNotice({ kind: 'error', text: 'Date of diagnosis cannot be in the future.' });
      submitLockRef.current = false;
      return;
    }

    const uploadedPaths = [];
    let authAccountCreated = false;
    let createdAuthUserId = null;
    let createdPublicUserId = null;
    let createdPatientId = null;

    try {
      setIsSaving(true);
      setNotice({ kind: '', text: '' });

      await ensurePatientInviteServiceAvailable();

      const patientCode = await resolveUniquePatientCode();
      const temporaryPassword = generateTemporaryPassword();
      const {
        data: { session: activeHospitalSession },
      } = await supabase.auth.getSession();

      const { data: existingPublicUserByEmail, error: existingPublicUserError } = await supabase
        .from(USERS_TABLE)
        .select('user_id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (existingPublicUserError && existingPublicUserError.code !== 'PGRST116') {
        throw existingPublicUserError;
      }

      if (existingPublicUserByEmail?.user_id) {
        throw new Error('Patient email already exists in users table. Use a different email.');
      }

      const publicUserRow = await resolveOrCreatePublicUser({
        email: normalizedEmail,
        authUserId: null,
        accessStartIso,
        accessEndIso,
      });

      const publicUserId = Number(publicUserRow?.user_id || 0);
      if (!publicUserId) {
        throw new Error('Unable to resolve newly created users record.');
      }
      createdPublicUserId = publicUserId;

      const alreadyLinked = await isUserAlreadyLinkedAsPatient(publicUserId);
      if (alreadyLinked) {
        throw new Error('This user is already linked to another patient record.');
      }

      await upsertPublicUserDetails({
        userId: publicUserId,
        firstName: normalizedFirstName,
        middleName: normalizedMiddleName,
        lastName: normalizedLastName,
        suffix: normalizedSuffix,
        birthdate: normalizedBirthdate,
        gender: normalizedGender,
      });

      const patientPicturePath = patientPictureFile
        ? await uploadAsset(patientPictureFile, 'patient-picture')
        : '';

      if (patientPicturePath) {
        uploadedPaths.push(patientPicturePath);
      }

      const medicalDocumentPath = medicalDocumentFile
        ? await uploadAsset(medicalDocumentFile, 'medical-document')
        : '';

      if (medicalDocumentPath) {
        uploadedPaths.push(medicalDocumentPath);
      }

      const patientPayload = {
        User_ID: publicUserId,
        Hospital_ID: Number(hospitalId),
        Patient_Code: patientCode,
        Date_of_Diagnosis: String(form.dateOfDiagnosis || '').trim() || null,
        Guardian: String(form.guardian || '').trim() || null,
        Guardian_Contact_Number: normalizedGuardianContactNumber || null,
        Guardian_Relationship: String(form.guardianRelationship || '').trim() || null,
        Medical_Condition: String(form.medicalCondition || '').trim() || null,
        Patient_Picture: patientPicturePath || null,
        Medical_Document: medicalDocumentPath || null,
      };

      const { data: insertedPatientRow, error: patientInsertError } = await supabase
        .from(PATIENTS_TABLE)
        .insert(patientPayload)
        .select('Patient_ID')
        .maybeSingle();

      if (patientInsertError) {
        const mappedInsertError = mapPatientInsertError(
          extractReadableErrorText(patientInsertError, 'Unable to save patient record.'),
        );
        throw new Error(`Patients insert failed: ${mappedInsertError}`);
      }
      createdPatientId = Number(insertedPatientRow?.Patient_ID || 0) || createdPatientId;

      const authUserId = await sendPatientInviteEmail({
        email: normalizedEmail,
        temporaryPassword,
        patientCode,
        displayName: normalizedDisplayName,
        accessStart: accessStartIso,
        accessEnd: accessEndIso,
      });
      createdAuthUserId = authUserId;
      authAccountCreated = Boolean(authUserId);

      // Keep hospital user session stable after invite workflow.
      if (activeHospitalSession?.access_token && activeHospitalSession?.refresh_token) {
        const { error: restoreSessionError } = await supabase.auth.setSession({
          access_token: activeHospitalSession.access_token,
          refresh_token: activeHospitalSession.refresh_token,
        });

        if (restoreSessionError) {
          throw new Error(restoreSessionError.message || 'Unable to restore hospital session after invite.');
        }
      }

      const { error: linkAuthError } = await supabase
        .from(USERS_TABLE)
        .update({
          auth_user_id: authUserId,
          updated_at: getPstTimestamp(),
        })
        .eq('user_id', publicUserId);

      if (linkAuthError) {
        throw new Error(`Unable to link users.auth_user_id: ${extractReadableErrorText(linkAuthError, 'Unknown error')}`);
      }

      resetForm();
      setNotice({ kind: '', text: '' });
      setActiveTab('directory');
      setSuccessPopup({
        open: true,
        text: `The patient account was created and the invitation email was sent to ${normalizedEmail}.`,
      });

      await fetchPatients();
    } catch (error) {
      await cleanupUploadedAssets(uploadedPaths);

      if (createdPatientId) {
        try {
          await supabase.from(PATIENTS_TABLE).delete().eq('Patient_ID', createdPatientId);
        } catch {
          // Keep original error as primary response.
        }
      }

      if (createdPublicUserId) {
        try {
          await supabase.from(USER_DETAILS_TABLE).delete().eq('user_id', createdPublicUserId);
          await supabase.from(USERS_TABLE).delete().eq('user_id', createdPublicUserId);
        } catch {
          // Keep original error as primary response.
        }
      }

      if (createdAuthUserId) {
        try {
          await deleteInvitedPatientAuthUser(createdAuthUserId);
        } catch {
          // Keep original error as primary response.
        }
      }

      const message = extractReadableErrorText(error, 'Unable to create patient account and record.');
      const fallback = mapPatientInsertError(message);
      const suffix = authAccountCreated
        ? ' Auth account may already exist for this email. Check users and auth records before retrying.'
        : '';

      setNotice({ kind: 'error', text: `${fallback}${suffix}`.trim() });
    } finally {
      setIsSaving(false);
      submitLockRef.current = false;
    }
  };

  const validatePatientFormForConfirmation = useCallback(() => {
    if (!isSupabaseConfigured || !supabase) {
      return 'Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.';
    }
    if (!hospitalId) return 'You are not assigned to any hospital. Ask Admin to assign your account first.';
    if (documentAutofill.status === 'processing') return 'Please wait until the medical document has finished processing.';

    const email = String(form.email || '').trim();
    const guardianContactNumber = String(form.guardianContactNumber || '').trim();
    const accessStart = String(form.accessStart || '').trim();
    const accessEnd = String(form.accessEnd || '').trim();
    const accessStartIso = toIsoOrNull(accessStart);
    const accessEndIso = toIsoOrNull(accessEnd);

    if (!email) return 'Patient email is required for invite email delivery.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid patient email address.';
    if (!String(form.firstName || '').trim() || !String(form.lastName || '').trim()) {
      return 'First name and last name are required.';
    }
    if (!String(form.birthdate || '').trim()) return 'Birthdate is required to compute age.';
    if (!normalizePatientGender(form.gender)) return 'Gender is required.';
    if (guardianContactNumber && !isValidPhilippineMobileNumber(guardianContactNumber)) {
      return 'Guardian contact number must use +63 912 345 6789 format.';
    }
    if ((accessStart && !accessEnd) || (!accessStart && accessEnd)) {
      return 'Access Start and Access End are both required when setting access time.';
    }
    if ((accessStart && !accessStartIso) || (accessEnd && !accessEndIso)) return 'Invalid access date/time value.';
    if (accessStartIso && new Date(accessStartIso) < new Date(getPstTimestamp())) {
      return 'Access Start cannot be in the past (PST).';
    }
    if (accessStartIso && accessEndIso && new Date(accessEndIso) <= new Date(accessStartIso)) {
      return 'Access End must be later than Access Start.';
    }
    if (new Date(form.birthdate) > new Date()) return 'Birthdate cannot be in the future.';
    if (String(form.dateOfDiagnosis || '').trim() && new Date(form.dateOfDiagnosis) > new Date()) {
      return 'Date of diagnosis cannot be in the future.';
    }
    return '';
  }, [documentAutofill.status, form, hospitalId]);

  const handleSubmit = (event) => {
    event.preventDefault();
    if (submitLockRef.current || isSaving) return;

    const validationError = validatePatientFormForConfirmation();
    if (validationError) {
      setNotice({ kind: 'error', text: validationError });
      return;
    }

    setConfirmationOpen(true);
  };

  const refreshPageData = async () => {
    await resolveAssignedHospital();
    await fetchPatients();
  };


  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Manage Patients</h1>
          <p className="mt-1 text-sm text-gray-600">
            Create patient account, user details, and patient record in one flow with invite email credential delivery.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
            {isResolvingHospital ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={13} className="animate-spin" /> Resolving hospital...
              </span>
            ) : hospitalId ? (
              <span>
                Hospital: <span className="font-semibold text-gray-800">{hospitalName || 'Assigned Hospital'}</span>
              </span>
            ) : (
              <span className="font-medium text-red-700">No hospital assignment found</span>
            )}
          </div>

          <button
            type="button"
            onClick={refreshPageData}
            disabled={isResolvingHospital || isLoadingPatients || isSaving}
            className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-60"
            style={{
              borderColor: `${theme.primaryColor}33`,
              backgroundColor: `${theme.primaryColor}12`,
              color: theme.primaryColor,
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-1">
          {[
            { id: 'directory', label: 'Patient Directory', icon: Users },
            { id: 'add', label: 'Add New Patient', icon: UserPlus },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className="inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors"
                style={{
                  borderColor: isActive ? theme.primaryColor : 'transparent',
                  color: isActive ? theme.primaryColor : '#4b5563',
                }}
              >
                <TabIcon size={16} />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === 'directory' && (
        <div className="space-y-5">
          <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Patient Directory</h2>
                <p className="mt-1 text-xs text-gray-500">Click a row to view the full patient profile. All times shown in Philippine Standard Time (PST).</p>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-500">Showing {filteredPatients.length} of {enrichedPatients.length}</p>
                <button
                  type="button"
                  onClick={() => setActiveTab('add')}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white"
                  style={{ backgroundColor: theme.primaryColor }}
                >
                  <Plus size={14} /> Add Patient
                </button>
              </div>
            </div>

            <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={patientSearchTerm}
                  onChange={(event) => setPatientSearchTerm(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:ring-2"
                  style={{ '--tw-ring-color': theme.primaryColor }}
                  placeholder="Search by name, age, gender, medical condition, or PT code"
                />
              </div>

              <div className="flex gap-2">
                <select
                  value={genderFilter}
                  onChange={(event) => setGenderFilter(event.target.value)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:ring-2"
                  style={{ '--tw-ring-color': theme.primaryColor }}
                  aria-label="Filter by gender"
                >
                  <option value="all">All Genders</option>
                  {GENDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>

                <select
                  value={filesFilter}
                  onChange={(event) => setFilesFilter(event.target.value)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:ring-2"
                  style={{ '--tw-ring-color': theme.primaryColor }}
                  aria-label="Filter by attachments"
                >
                  <option value="all">All Files</option>
                  <option value="with_picture">With Picture</option>
                  <option value="with_document">With Document</option>
                  <option value="with_both">With Both</option>
                  <option value="missing">Missing Files</option>
                </select>

                {(genderFilter !== 'all' || filesFilter !== 'all' || patientSearchTerm) && (
                  <button
                    type="button"
                    onClick={() => {
                      setGenderFilter('all');
                      setFilesFilter('all');
                      setPatientSearchTerm('');
                    }}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {isLoadingPatients ? (
              <div className="flex items-center justify-center gap-2 py-10 text-gray-700">
                <Loader2 className="animate-spin" size={18} /> Loading patients...
              </div>
            ) : filteredPatients.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center">
                <Users size={28} className="mx-auto text-gray-300" />
                <p className="mt-2 text-sm font-semibold text-gray-700">No patients found</p>
                <p className="mt-1 text-xs text-gray-500">
                  {patientSearchTerm ? 'Try a different search term.' : 'Start by adding your first patient.'}
                </p>
                {!patientSearchTerm && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('add')}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white"
                    style={{ backgroundColor: theme.primaryColor }}
                  >
                    <Plus size={14} /> Add First Patient
                  </button>
                )}
              </div>
            ) : (
              <div className="max-h-[650px] overflow-auto rounded-lg border border-gray-200">
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 z-[1] text-sm" style={{ backgroundColor: `${theme.primaryColor}20`, color: theme.primaryTextColor || '#111827' }}>
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold">PT Code</th>
                      <th className="px-4 py-3 text-left font-semibold">Patient Full Name</th>
                      <th className="px-4 py-3 text-left font-semibold">Age</th>
                      <th className="px-4 py-3 text-left font-semibold">Gender</th>
                      <th className="px-4 py-3 text-left font-semibold">Medical Condition</th>
                      <th className="px-4 py-3 text-left font-semibold">Created</th>
                      <th className="px-4 py-3 text-right font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPatients.map((patient) => (
                      <tr
                        key={patient.Patient_ID}
                        className="cursor-pointer border-t border-gray-200 align-top transition-colors hover:bg-gray-50"
                        onClick={() => setSelectedPatient(patient)}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-gray-700">{patient.Patient_Code || 'N/A'}</td>
                        <td className="px-4 py-3 font-medium text-gray-800">{patient.fullName}</td>
                        <td className="px-4 py-3 text-gray-700">{patient.age}</td>
                        <td className="px-4 py-3 text-gray-700">{patient.gender}</td>
                        <td className="max-w-xs break-words px-4 py-3 text-gray-700">{patient.Medical_Condition || 'N/A'}</td>
                        <td className="px-4 py-3 text-xs text-gray-600">{formatDateTime(patient.Created_At)}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedPatient(patient);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === 'add' && (
        <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-6">
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-gray-900">Create Patient Account and Record</h2>
            <p className="mt-1 text-xs text-gray-500">
              Upload available files first, then review and complete the patient details before submitting.
            </p>
          </div>

          <form noValidate onSubmit={handleSubmit} className="space-y-5" style={{ '--tw-ring-color': theme.primaryColor }}>
            <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Attachments</h3>
                <p className="text-xs text-gray-500">
                  Upload a medical document first to fill clearly recognized empty fields automatically. All recognized details must be reviewed.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Patient Picture</label>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2 hover:bg-gray-50">
                    <UploadCloud size={15} className="text-gray-600" />
                    <span className="text-sm text-gray-700">Choose image</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => setPatientPictureFile(event.target.files?.[0] || null)}
                      className="hidden"
                    />
                  </label>
                  <p className="mt-1 break-all text-xs text-gray-500">{patientPictureFile?.name || 'No file selected.'}</p>

                  {patientPicturePreviewUrl && (
                    <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
                      <img
                        src={patientPicturePreviewUrl}
                        alt="Patient preview"
                        className="h-36 w-full object-cover"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Medical Document</label>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2 hover:bg-gray-50">
                    {documentAutofill.status === 'processing' ? (
                      <Loader2 size={15} className="animate-spin text-blue-600" />
                    ) : (
                      <FileText size={15} className="text-gray-600" />
                    )}
                    <span className="text-sm text-gray-700">Choose file (PDF/image)</span>
                    <input
                      type="file"
                      accept=".pdf,image/*"
                      onChange={handleMedicalDocumentChange}
                      className="hidden"
                    />
                  </label>
                  <p className="mt-1 break-all text-xs text-gray-500">{medicalDocumentFile?.name || 'No file selected.'}</p>

                  {documentAutofill.status !== 'idle' && documentAutofill.message && (
                    <div
                      className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                        documentAutofill.status === 'success'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                          : documentAutofill.status === 'error'
                            ? 'border-red-200 bg-red-50 text-red-800'
                            : documentAutofill.status === 'processing'
                              ? 'border-blue-200 bg-blue-50 text-blue-800'
                              : 'border-amber-200 bg-amber-50 text-amber-800'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {documentAutofill.status === 'processing' ? (
                          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
                        ) : documentAutofill.status === 'success' ? (
                          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                        ) : (
                          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        )}
                        <span>{documentAutofill.message}</span>
                      </div>

                      {documentAutofill.fieldNames.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {documentAutofill.fieldNames.map((fieldName) => (
                            <span key={fieldName} className="rounded-full bg-white/80 px-2 py-0.5 font-medium">
                              {AUTOFILL_FIELD_LABELS[fieldName] || fieldName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {medicalDocumentPreviewUrl && isMedicalDocumentImage && (
                    <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
                      <img
                        src={medicalDocumentPreviewUrl}
                        alt="Medical document preview"
                        className="h-36 w-full object-cover"
                      />
                    </div>
                  )}

                  {medicalDocumentPreviewUrl && !isMedicalDocumentImage && isMedicalDocumentPdf && (
                    <div className="mt-2 rounded-lg border border-gray-200 bg-white p-2">
                      <iframe
                        title="Medical document PDF preview"
                        src={medicalDocumentPreviewUrl}
                        className="h-40 w-full rounded border border-gray-100"
                      />
                      <a
                        href={medicalDocumentPreviewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-xs font-semibold text-blue-700 hover:underline"
                      >
                        Open PDF preview
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {(
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Account Setup</h3>
                  <p className="text-xs text-gray-500">Email is used for the invite. Temporary password is generated automatically on save.</p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="mb-1 block text-sm font-medium text-gray-700">Patient Email (required)</label>
                    <input
                      type="email"
                      name="email"
                      value={form.email}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="patient@example.com"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Access Start (optional)</label>
                    <input
                      type="datetime-local"
                      name="accessStart"
                      value={form.accessStart}
                      onChange={handleInputChange}
                      min={nowLocalDateTimeValue}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Access End (optional)</label>
                    <input
                      type="datetime-local"
                      name="accessEnd"
                      value={form.accessEnd}
                      onChange={handleInputChange}
                      min={form.accessStart || nowLocalDateTimeValue}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                    />
                    <p className="mt-1 text-[11px] text-gray-500">Set both Access Start and Access End, or leave both empty.</p>
                  </div>
                </div>
              </div>
            )}

            {(
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Identity Details</h3>
                  <p className="text-xs text-gray-500">Used for patient profile and computed age.</p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">First Name (required)</label>
                    <input
                      name="firstName"
                      value={form.firstName}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="First name"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Middle Name</label>
                    <input
                      name="middleName"
                      value={form.middleName}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="Middle name"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Last Name (required)</label>
                    <input
                      name="lastName"
                      value={form.lastName}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="Last name"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Suffix</label>
                    <input
                      name="suffix"
                      value={form.suffix}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="Jr, Sr, III"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Birthdate (required)</label>
                    <input
                      type="date"
                      name="birthdate"
                      value={form.birthdate}
                      onChange={handleInputChange}
                      max={todayDateValue}
                      required
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Gender (required)</label>
                    <select
                      name="gender"
                      value={form.gender}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                    >
                      <option value="">Select gender</option>
                      {GENDER_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Age (computed)</label>
                    <input
                      value={computedAgeFromForm}
                      readOnly
                      className="w-full cursor-not-allowed rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-gray-700 outline-none"
                      placeholder="Select a birthdate"
                      aria-label="Computed patient age"
                    />
                  </div>
                </div>
              </div>
            )}

            {(
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Clinical Details</h3>
                  <p className="text-xs text-gray-500">Optional fields. Add what is available.</p>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Date of Diagnosis</label>
                    <input
                      name="dateOfDiagnosis"
                      value={form.dateOfDiagnosis}
                      onChange={handleInputChange}
                      type="date"
                      max={todayDateValue}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Full Name of Guardian</label>
                    <input
                      name="guardian"
                      value={form.guardian}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="Guardian full name"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Guardian Contact Number</label>
                    <input
                      name="guardianContactNumber"
                      value={form.guardianContactNumber}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="+63 912 345 6789"
                      maxLength={16}
                    />
                    <p className="mt-1 text-[11px] text-gray-500">Format: +63 912 345 6789</p>
                  </div>

                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Guardian Relationship</label>
                    <input
                      name="guardianRelationship"
                      value={form.guardianRelationship}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                      placeholder="e.g., Mother"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Medical Condition</label>
                  <input
                    name="medicalCondition"
                    value={form.medicalCondition}
                    onChange={handleInputChange}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 outline-none focus:ring-2"
                    placeholder="Medical condition summary"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col-reverse gap-2 border-t border-gray-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={resetForm}
                disabled={isSaving}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Clear All
              </button>

              <button
                type="submit"
                disabled={isSaving || !hospitalId || documentAutofill.status === 'processing'}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: theme.primaryColor }}
              >
                {isSaving || documentAutofill.status === 'processing' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                {isSaving
                  ? 'Creating Patient...'
                  : documentAutofill.status === 'processing'
                    ? 'Reading Document...'
                    : 'Create Patient Account'}
              </button>
            </div>
          </form>
        </section>
      )}

      {confirmationOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-[1px]">
          <button
            type="button"
            aria-label="Close patient account confirmation"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setConfirmationOpen(false)}
          />

          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="patient-confirmation-title"
            className="relative max-h-full w-full max-w-xl overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-5 py-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Final confirmation</p>
                <h3 id="patient-confirmation-title" className="mt-1 text-lg font-bold text-gray-900">
                  Check the patient details
                </h3>
                <p className="mt-1 text-sm text-gray-600">Confirm these details before the account and patient record are created.</p>
              </div>
              <button
                type="button"
                onClick={() => setConfirmationOpen(false)}
                className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                aria-label="Close confirmation"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <dl className="grid grid-cols-1 gap-2 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:grid-cols-2">
                <DrawerRow label="Patient" value={confirmationPatientName || 'Not provided'} />
                <DrawerRow label="Email" value={String(form.email || '').trim() || 'Not provided'} />
                <DrawerRow label="Hospital" value={hospitalName || `Hospital #${hospitalId}`} />
                <DrawerRow label="Birthdate" value={form.birthdate || 'Not provided'} />
                <DrawerRow label="Age" value={computedAgeFromForm || 'N/A'} />
                <DrawerRow label="Gender" value={form.gender || 'Not provided'} />
                <DrawerRow label="Medical condition" value={form.medicalCondition || 'Not provided'} />
                <DrawerRow label="Guardian" value={form.guardian || 'Not provided'} />
                <DrawerRow label="Patient picture" value={patientPictureFile?.name || 'Not attached'} />
                <DrawerRow label="Medical document" value={medicalDocumentFile?.name || 'Not attached'} />
              </dl>

              <div className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0" />
                <p>
                  Creating this account will also send the patient invitation email to{' '}
                  <span className="font-semibold">{String(form.email || '').trim()}</span>.
                </p>
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-gray-200 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmationOpen(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Back to Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmationOpen(false);
                  void createPatientAccount();
                }}
                className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: theme.primaryColor }}
              >
                <UserPlus size={16} /> Confirm and Create
              </button>
            </div>
          </section>
        </div>
      )}

      {selectedPatient && (
        <div className="fixed inset-0 z-[9998] flex">
          <button
            type="button"
            aria-label="Close patient details"
            className="flex-1 bg-black/50"
            onClick={() => setSelectedPatient(null)}
          />
          <aside className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl">
            <div
              className="flex items-start justify-between gap-3 border-b border-gray-200 p-5"
              style={{ backgroundColor: `${theme.primaryColor}10` }}
            >
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Patient Profile</p>
                <h3 className="mt-1 text-lg font-bold text-gray-900">{selectedPatient.fullName}</h3>
                <p className="mt-0.5 font-mono text-xs text-gray-600">{selectedPatient.Patient_Code || 'No code'}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedPatient(null)}
                className="rounded-md p-1 text-gray-500 hover:bg-white hover:text-gray-900"
                aria-label="Close drawer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 space-y-5 p-5">
              {selectedPatient.pictureUrl && (
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <img
                    src={selectedPatient.pictureUrl}
                    alt={selectedPatient.fullName}
                    className="h-48 w-full object-cover"
                  />
                </div>
              )}

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Demographics</h4>
                <dl className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                  <DrawerRow label="Age" value={selectedPatient.age} />
                  <DrawerRow label="Gender" value={selectedPatient.gender} />
                </dl>
              </div>

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Clinical</h4>
                <dl className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                  <DrawerRow label="Medical Condition" value={selectedPatient.Medical_Condition || 'N/A'} />
                  <DrawerRow label="Date of Diagnosis" value={selectedPatient.Date_of_Diagnosis || 'N/A'} />
                </dl>
              </div>

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Guardian</h4>
                <dl className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                  <DrawerRow label="Name" value={selectedPatient.Guardian || 'N/A'} />
                  <DrawerRow label="Relationship" value={selectedPatient.Guardian_Relationship || 'N/A'} />
                  <DrawerRow label="Contact" value={selectedPatient.Guardian_Contact_Number || 'N/A'} />
                </dl>
              </div>

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Documents</h4>
                <div className="space-y-2">
                  {selectedPatient.pictureUrl ? (
                    <a
                      href={selectedPatient.pictureUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      <UploadCloud size={15} /> View Patient Picture
                    </a>
                  ) : (
                    <p className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">No patient picture uploaded.</p>
                  )}

                  {selectedPatient.documentUrl ? (
                    <a
                      href={selectedPatient.documentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      <FileText size={15} /> View Medical Document
                    </a>
                  ) : (
                    <p className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">No medical document uploaded.</p>
                  )}
                </div>
              </div>

              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Record</h4>
                <dl className="space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                  <DrawerRow label="Created" value={formatDateTime(selectedPatient.Created_At)} />
                </dl>
              </div>
            </div>
          </aside>
        </div>
      )}

      {successPopup.open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 px-4 backdrop-blur-[1px]">
          <button
            type="button"
            aria-label="Close success popup"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setSuccessPopup({ open: false, text: '' })}
          />

          <section
            role="dialog"
            aria-modal="true"
            aria-label="Patient account creation success"
            className="relative w-full max-w-md rounded-2xl border border-emerald-100 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-emerald-100 p-2 text-emerald-700">
                <CheckCircle2 size={20} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900">Patient Created</h3>
                <p className="mt-1 text-sm text-gray-700">{successPopup.text}</p>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 size={16} /> Invitation email sent successfully
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setSuccessPopup({ open: false, text: '' })}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
                style={{ backgroundColor: theme.primaryColor }}
              >
                OK
              </button>
            </div>
          </section>
        </div>
      )}

      {errorToasts.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[10020] flex w-[min(92vw,390px)] flex-col gap-2" aria-live="assertive">
          {errorToasts.map((toast) => (
            <div
              key={toast.id}
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-red-200 bg-white px-4 py-3 text-red-900 shadow-xl"
            >
              <div className="mt-0.5 rounded-full bg-red-100 p-1.5 text-red-700">
                <AlertTriangle size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold uppercase tracking-wide text-red-700">Unable to continue</p>
                <p className="mt-0.5 break-words text-sm text-gray-800">{toast.text}</p>
              </div>
              <button
                type="button"
                onClick={() => dismissErrorToast(toast.id)}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DrawerRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-right text-xs font-semibold text-gray-800">{value}</dd>
    </div>
  );
}


