import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Building2,
  Info,
  Loader2,
  MapPin,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  CheckCircle2,
  X,
} from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { triggerSmtpNow } from '../../../lib/smtpTriggerClient';
import { invokeAdminAccountManagement } from '../../../lib/adminAccountManagement';

const HOSPITALS_TABLE = 'Hospitals';
const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const USERS_TABLE = 'users';
const HOSPITAL_LOGOS_BUCKET = 'hospital_logos';
const PSGC_BASE_URL = 'https://psgc.gitlab.io/api';
const PHILIPPINE_TIME_ZONE = 'Asia/Manila';

const PAGE_TABS = [
  { id: 'manage', label: 'Manage H-Representatives' },
  { id: 'applications', label: 'Hospital Applications' },
];

const EMPTY_FORM = {
  hospitalName: '',
  hospitalLogoPath: '',
  country: 'Philippines',
  region: '',
  city: '',
  barangay: '',
  street: '',
  contactNumber: '',
};

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function isBlobUrl(value) {
  return String(value || '').startsWith('blob:');
}

function toSafeFileName(fileName) {
  return String(fileName || 'logo.jpg')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '');
}

function toSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function normalizePhilippineMobile(value = '') {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.startsWith('63')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits.slice(0, 10);
}

function toStoredPhoneNumber(value = '') {
  const digits = normalizePhilippineMobile(value);
  return digits.length === 10
    ? `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`
    : '';
}

function getPhilippineTimestamp(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function mapStorageUploadError(rawMessage) {
  const message = String(rawMessage || 'Upload failed.');
  if (message.toLowerCase().includes('row-level security')) {
    return 'Upload blocked by Storage RLS policy. Apply the hospital_logos bucket policies and make sure your account has Admin role.';
  }
  return message;
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toLocaleString('en-PH', {
    timeZone: PHILIPPINE_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeApprovalStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function getHospitalApprovalStatus(hospital) {
  const normalized = normalizeApprovalStatus(hospital?.Approval_Status);
  if (normalized === 'approved') return 'approved';
  if (normalized === 'rejected') return 'rejected';
  if (normalized === 'pending') return 'pending';
  return hospital?.Is_Approved ? 'approved' : 'pending';
}

function getHospitalApprovalStatusLabel(statusKey) {
  if (statusKey === 'approved') return 'Approved';
  if (statusKey === 'rejected') return 'Rejected';
  return 'Pending';
}

function buildTemporaryPassword() {
  const numeric = Math.floor(100000 + (Math.random() * 900000));
  return `Strand-${numeric}!Aa`;
}

function formatHospitalAddress(hospital) {
  return [
    hospital?.Street,
    hospital?.Barangay,
    hospital?.City,
    hospital?.Province,
    hospital?.Region,
    hospital?.Country,
  ]
    .filter(Boolean)
    .join(', ') || 'No address provided';
}

function getUserDetails(user) {
  return Array.isArray(user?.user_details)
    ? user.user_details[0] || null
    : user?.user_details || null;
}

function getUserFullName(user) {
  const details = getUserDetails(user);
  return [
    details?.first_name,
    details?.middle_name,
    details?.last_name,
    details?.suffix,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getHospitalApplicantUserId(hospital) {
  return Number(hospital?.Created_By || 0);
}

function getHospitalManagerRoleLabel() {
  return 'H-Representative';
}

function matchesRegion(regionItem, regionValue) {
  const target = normalizeText(regionValue);
  if (!target) return false;

  const names = [regionItem?.name, regionItem?.regionName]
    .filter(Boolean)
    .map((item) => normalizeText(item));

  return names.includes(target);
}

function cardClass() {
  return 'rounded-xl border border-gray-200 bg-white p-4 md:p-5';
}

export default function ManageHospitalAccountsPage({ isActivePage = true }) {
  const { theme } = useTheme();
  const tableHeaderTextColor = theme?.primaryTextColor || '#111827';

  const [activeTab, setActiveTab] = useState('manage');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [detailsHospitalId, setDetailsHospitalId] = useState(null);
  const [applicationInfoHospitalId, setApplicationInfoHospitalId] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [applicantUsersById, setApplicantUsersById] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [applicationSearchTerm, setApplicationSearchTerm] = useState('');
  const [applicationStatusFilter, setApplicationStatusFilter] = useState('pending');

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingHospitalId, setEditingHospitalId] = useState(null);
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState('');
  const [logoInputKey, setLogoInputKey] = useState(0);

  const [regions, setRegions] = useState([]);
  const [provinces, setProvinces] = useState([]);
  const [cities, setCities] = useState([]);
  const [barangays, setBarangays] = useState([]);

  const [regionCode, setRegionCode] = useState('');
  const [provinceCode, setProvinceCode] = useState('');
  const [cityCode, setCityCode] = useState('');

  const [isLoadingHospitals, setIsLoadingHospitals] = useState(true);
  const [isLoadingRegions, setIsLoadingRegions] = useState(false);
  const [isLoadingRegionData, setIsLoadingRegionData] = useState(false);
  const [isLoadingBarangays, setIsLoadingBarangays] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [applicationActionHospitalId, setApplicationActionHospitalId] = useState(null);
  const [applicationActionType, setApplicationActionType] = useState('');
  const [accessActionHospitalId, setAccessActionHospitalId] = useState(null);
  const [deletingHospitalId, setDeletingHospitalId] = useState(null);

  // Modal state for approve/reject decision flow
  const [decisionTarget, setDecisionTarget] = useState(null); // { hospital, nextStatus }
  const [decisionReviewNotes, setDecisionReviewNotes] = useState('');

  // Modal state for delete confirmation
  const [deleteTarget, setDeleteTarget] = useState(null);

  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [toastKind, setToastKind] = useState('success');
  const toastTimerRef = useRef(null);

  const showToast = useCallback((message, kind = 'success') => {
    const text = String(message || '').trim();
    if (!text) {
      return;
    }

    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    setToastKind(kind === 'error' ? 'error' : 'success');
    setToastMessage(text);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage('');
    }, 2200);
  }, []);

  useEffect(() => {
    if (!errorMessage) {
      return;
    }
    showToast(errorMessage, 'error');
    setErrorMessage('');
  }, [errorMessage, showToast]);

  useEffect(() => {
    if (!successMessage) {
      return;
    }
    showToast(successMessage, 'success');
    setSuccessMessage('');
  }, [successMessage, showToast]);

  useEffect(() => () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (isBlobUrl(logoPreviewUrl)) {
        URL.revokeObjectURL(logoPreviewUrl);
      }
    };
  }, [logoPreviewUrl]);

  const filteredHospitals = useMemo(() => {
    const query = normalizeText(searchTerm);

    const approvedOnly = hospitals.filter((hospital) => (
      getHospitalApprovalStatus(hospital) === 'approved'
    ));

    if (!query) return approvedOnly;

    return approvedOnly.filter((hospital) => {
      const applicantUser = applicantUsersById[getHospitalApplicantUserId(hospital)] || null;
      const values = [
        hospital.Hospital_Name,
        hospital.Contact_Number,
        hospital.Region,
        hospital.City,
        hospital.Barangay,
        hospital.Street,
        applicantUser?.email,
        getUserFullName(applicantUser),
      ]
        .map((item) => normalizeText(item))
        .filter(Boolean);

      return values.some((value) => value.includes(query));
    });
  }, [applicantUsersById, hospitals, searchTerm]);

  const filteredHospitalApplications = useMemo(() => {
    const query = normalizeText(applicationSearchTerm);

    return hospitals
      .filter((hospital) => {
        const statusKey = getHospitalApprovalStatus(hospital);
        if (applicationStatusFilter === 'pending' && statusKey !== 'pending') return false;
        if (applicationStatusFilter === 'approved' && statusKey !== 'approved') return false;
        if (applicationStatusFilter === 'rejected' && statusKey !== 'rejected') return false;

        if (!query) return true;

        const applicantUser = applicantUsersById[getHospitalApplicantUserId(hospital)] || null;
        const searchable = [
          hospital.Hospital_Name,
          hospital.Hospital_Head_Name,
          hospital.Hospital_Head_Title,
          hospital.Hospital_Head_Email,
          hospital.Contact_Number,
          hospital.Region,
          hospital.City,
          hospital.Barangay,
          hospital.Street,
          applicantUser?.email,
          getUserFullName(applicantUser),
        ]
          .map((item) => normalizeText(item))
          .filter(Boolean);

        return searchable.some((value) => value.includes(query));
      })
      .sort((a, b) => {
        const aTime = new Date(a?.Created_At || a?.Updated_At || 0).getTime();
        const bTime = new Date(b?.Created_At || b?.Updated_At || 0).getTime();
        return bTime - aTime;
      });
  }, [applicantUsersById, hospitals, applicationSearchTerm, applicationStatusFilter]);

  const hospitalsById = useMemo(() => {
    const map = new Map();
    hospitals.forEach((hospital) => {
      map.set(Number(hospital.Hospital_ID), hospital);
    });
    return map;
  }, [hospitals]);

  const detailsHospital = useMemo(
    () => (detailsHospitalId ? hospitalsById.get(Number(detailsHospitalId)) || null : null),
    [detailsHospitalId, hospitalsById],
  );

  const applicationInfoHospital = useMemo(
    () => (applicationInfoHospitalId ? hospitalsById.get(Number(applicationInfoHospitalId)) || null : null),
    [applicationInfoHospitalId, hospitalsById],
  );

  const getApplicantUserForHospital = useCallback((hospital) => (
    applicantUsersById[getHospitalApplicantUserId(hospital)] || null
  ), [applicantUsersById]);

  const visibleCities = useMemo(() => {
    if (!provinceCode) {
      return cities;
    }
    return cities.filter((city) => city.provinceCode === provinceCode);
  }, [cities, provinceCode]);

  const provinceFilterHint = useMemo(() => {
    if (!regionCode) return 'Select a region first.';
    if (provinces.length === 0) return 'No province-level division for this region.';
    return 'Optional: pick a province to narrow city/municipality options.';
  }, [regionCode, provinces.length]);

  const fetchLocationData = async (endpoint) => {
    const response = await fetch(`${PSGC_BASE_URL}${endpoint}`);
    if (!response.ok) {
      throw new Error(`Unable to load location data (${response.status})`);
    }
    return response.json();
  };

  const resolveHospitalLogoUrl = (logoValue) => {
    const source = String(logoValue || '').trim();
    if (!source) {
      return '';
    }

    if (isAbsoluteUrl(source)) {
      return source;
    }

    if (!supabase) {
      return '';
    }

    const { data } = supabase.storage.from(HOSPITAL_LOGOS_BUCKET).getPublicUrl(source);
    return data?.publicUrl || '';
  };

  const currentLogoPreview = useMemo(() => {
    if (logoPreviewUrl) {
      return logoPreviewUrl;
    }
    return resolveHospitalLogoUrl(form.hospitalLogoPath);
  }, [logoPreviewUrl, form.hospitalLogoPath]);

  const setNextLogoPreview = (nextPreview) => {
    setLogoPreviewUrl((previousPreview) => {
      if (isBlobUrl(previousPreview)) {
        URL.revokeObjectURL(previousPreview);
      }
      return nextPreview || '';
    });
  };

  const resetLogoInput = () => {
    setLogoFile(null);
    setLogoInputKey((value) => value + 1);
  };

  const resetForm = (keepSuccess = false) => {
    setForm(EMPTY_FORM);
    setEditingHospitalId(null);
    resetLogoInput();
    setNextLogoPreview('');
    setRegionCode('');
    setProvinceCode('');
    setCityCode('');
    setProvinces([]);
    setCities([]);
    setBarangays([]);
    setErrorMessage('');
    if (!keepSuccess) {
      setSuccessMessage('');
    }
  };

  const fetchHospitals = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      setIsLoadingHospitals(false);
      return;
    }

    try {
      setIsLoadingHospitals(true);
      const { data, error } = await supabase
        .from(HOSPITALS_TABLE)
        .select('*')
        .order('Created_At', { ascending: false });

      if (error) throw error;

      const hospitalRows = data || [];
      setHospitals(hospitalRows);

      const applicantIds = [...new Set(
        hospitalRows
          .map((hospital) => getHospitalApplicantUserId(hospital))
          .filter((userId) => userId > 0),
      )];

      if (applicantIds.length === 0) {
        setApplicantUsersById({});
        return;
      }

      const applicantResult = await supabase
        .from(USERS_TABLE)
        .select(`
          user_id,
          email,
          auth_user_id,
          role,
          is_active,
          user_details:user_details (
            first_name,
            middle_name,
            last_name,
            suffix,
            birthdate,
            gender,
            street,
            barangay,
            city,
            province,
            region,
            country,
            contact_number,
            joined_date
          )
        `)
        .in('user_id', applicantIds);

      if (applicantResult.error) throw applicantResult.error;

      const nextApplicantsById = {};
      (applicantResult.data || []).forEach((user) => {
        nextApplicantsById[Number(user.user_id)] = user;
      });
      setApplicantUsersById(nextApplicantsById);
    } catch (error) {
      setErrorMessage(error.message || 'Unable to load hospitals.');
    } finally {
      setIsLoadingHospitals(false);
    }
  }, []);

  const loadRegions = useCallback(async () => {
    try {
      setIsLoadingRegions(true);
      const data = await fetchLocationData('/regions/');
      const ordered = [...(data || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }),
      );
      setRegions(ordered);
    } catch (error) {
      setErrorMessage('Unable to load complete Philippines regions right now. Please check your network and try again.');
    } finally {
      setIsLoadingRegions(false);
    }
  }, []);

  useEffect(() => {
    fetchHospitals();
    loadRegions();
  }, [fetchHospitals, loadRegions]);

  useEffect(() => {
    if (!isActivePage || !isSupabaseConfigured || !supabase) {
      return undefined;
    }

    const refreshHospitals = () => void fetchHospitals();
    const channel = supabase
      .channel('admin-hospital-accounts-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: HOSPITALS_TABLE }, refreshHospitals)
      .on('postgres_changes', { event: '*', schema: 'public', table: HOSPITAL_STAFF_TABLE }, refreshHospitals)
      .on('postgres_changes', { event: '*', schema: 'public', table: USERS_TABLE }, refreshHospitals)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_details' }, refreshHospitals)
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [fetchHospitals, isActivePage]);

  const openHospitalDetails = (hospital) => {
    setDetailsHospitalId(Number(hospital.Hospital_ID));
  };

  const closeHospitalDetails = () => {
    setDetailsHospitalId(null);
  };

  const openApplicationInfoModal = (hospital) => {
    const hospitalId = Number(hospital?.Hospital_ID || 0);
    if (!hospitalId) {
      setErrorMessage('Invalid hospital application selected.');
      return;
    }

    setApplicationInfoHospitalId(hospitalId);
  };

  const closeApplicationInfoModal = () => {
    if (applicationActionHospitalId) return;
    setApplicationInfoHospitalId(null);
  };

  const getHospitalActionResultRow = (resultData) => {
    const row = Array.isArray(resultData) ? resultData[0] : resultData;
    if (!row?.hospital_id) {
      throw new Error('Database update did not return the updated hospital row.');
    }
    return row;
  };

  const applyHospitalActionResult = (actionRow, fallbackHospital) => {
    const hospitalId = Number(actionRow.hospital_id || fallbackHospital?.Hospital_ID || 0);
    if (!hospitalId) {
      throw new Error('Database update returned an invalid hospital row.');
    }

    const hospitalPatch = {
      Hospital_ID: hospitalId,
      Approval_Status: actionRow.approval_status,
      Is_Approved: Boolean(actionRow.is_approved),
      Review_Notes: actionRow.review_notes || null,
      Approved_At: actionRow.approved_at || null,
      Approved_By: actionRow.approved_by || null,
      Updated_At: actionRow.updated_at || fallbackHospital?.Updated_At || null,
    };

    setHospitals((currentRows) => currentRows.map((row) => (
      Number(row.Hospital_ID) === hospitalId
        ? { ...row, ...hospitalPatch }
        : row
    )));

    const applicantUserId = Number(actionRow.applicant_user_id || 0);
    if (applicantUserId) {
      setApplicantUsersById((currentUsers) => ({
        ...currentUsers,
        [applicantUserId]: {
          ...(currentUsers[applicantUserId] || {}),
          user_id: applicantUserId,
          email: actionRow.applicant_user_email || currentUsers[applicantUserId]?.email || '',
          auth_user_id: actionRow.applicant_auth_user_id || currentUsers[applicantUserId]?.auth_user_id || null,
          role: actionRow.applicant_user_role || currentUsers[applicantUserId]?.role || 'h_representative',
          is_active: Boolean(actionRow.applicant_user_is_active),
        },
      }));
    }

    return hospitalPatch;
  };

  const updateHospitalManagerAuthPassword = async (hospital, tempPassword) => {
    const applicantUser = getApplicantUserForHospital(hospital);
    const authUserId = String(applicantUser?.auth_user_id || '').trim();
    if (!authUserId) {
      throw new Error('The manager Auth account is missing. The applicant must verify email before approval can send login credentials.');
    }

    await invokeAdminAccountManagement({
      action: 'set-hospital-manager-credentials',
      authUserId,
      temporaryPassword: tempPassword,
      hospitalId: Number(hospital?.Hospital_ID || 0),
    });
  };

  const handleHospitalApplicationDecision = (hospital, nextStatus) => {
    if (!['Approved', 'Rejected'].includes(nextStatus)) {
      setErrorMessage('Unsupported application decision.');
      return;
    }

    const hospitalId = Number(hospital?.Hospital_ID);
    if (!hospitalId) {
      setErrorMessage('Invalid hospital application selected.');
      return;
    }

    setDecisionReviewNotes('');
    setDecisionTarget({ hospital, nextStatus });
  };

  const closeDecisionModal = () => {
    if (applicationActionHospitalId) return;
    setDecisionTarget(null);
    setDecisionReviewNotes('');
  };

  const confirmHospitalApplicationDecision = async () => {
    if (!decisionTarget) return;
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const { hospital, nextStatus } = decisionTarget;
    const hospitalId = Number(hospital?.Hospital_ID);
    if (!hospitalId) {
      setErrorMessage('Invalid hospital application selected.');
      return;
    }

    const statusVerb = nextStatus.toLowerCase();
    const reviewNotes = String(decisionReviewNotes || '').trim() || null;
    const tempPassword = nextStatus === 'Approved' ? buildTemporaryPassword() : '';

    try {
      setApplicationActionHospitalId(hospitalId);
      setApplicationActionType(nextStatus);

      if (nextStatus === 'Approved') {
        await updateHospitalManagerAuthPassword(hospital, tempPassword);
      }

      const result = await supabase.rpc('admin_update_hospital_application', {
        p_hospital_id: hospitalId,
        p_action: nextStatus === 'Approved' ? 'approve' : 'reject',
        p_review_notes: reviewNotes,
        p_temporary_password: tempPassword || null,
        p_login_url: `${window.location.origin}/login`,
      });

      if (result.error) throw result.error;

      const actionRow = getHospitalActionResultRow(result.data);
      applyHospitalActionResult(actionRow, hospital);

      setSuccessMessage(`Hospital application ${statusVerb} successfully.`);
      setDecisionTarget(null);
      setApplicationInfoHospitalId(null);
      setDecisionReviewNotes('');

      const smtpKickResult = await triggerSmtpNow(`partner_hospital_${statusVerb}`);
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after hospital application decision failed:', smtpKickResult.message || smtpKickResult);
      }
    } catch (error) {
      setErrorMessage(error.message || `Unable to ${statusVerb} hospital application.`);
    } finally {
      setApplicationActionHospitalId(null);
      setApplicationActionType('');
    }
  };

  const toggleHospitalAccess = async (hospital, nextAccessValue) => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const hospitalId = Number(hospital?.Hospital_ID || 0);
    if (!hospitalId) {
      setErrorMessage('Invalid hospital selected.');
      return;
    }

    try {
      setAccessActionHospitalId(hospitalId);

      const hospitalUpdateResult = await supabase.rpc('admin_update_hospital_application', {
        p_hospital_id: hospitalId,
        p_action: nextAccessValue ? 'turn_on_access' : 'turn_off_access',
        p_review_notes: null,
        p_temporary_password: null,
        p_login_url: `${window.location.origin}/login`,
      });

      if (hospitalUpdateResult.error) throw hospitalUpdateResult.error;

      const actionRow = getHospitalActionResultRow(hospitalUpdateResult.data);
      applyHospitalActionResult(actionRow, hospital);

      setSuccessMessage(nextAccessValue ? 'Hospital account access turned on.' : 'Hospital account access turned off.');

      const smtpKickResult = await triggerSmtpNow(nextAccessValue ? 'partner_hospital_access_on' : 'partner_hospital_access_off');
      if (!smtpKickResult.ok) {
        console.warn('[SMTP] Trigger after hospital access update failed:', smtpKickResult.message || smtpKickResult);
      }
    } catch (error) {
      setErrorMessage(error.message || 'Unable to update hospital account access.');
    } finally {
      setAccessActionHospitalId(null);
    }
  };

  const handleRegionChange = async (nextRegionCode, options = {}) => {
    const preserveMessages = options.preserveMessages === true;
    const keepProvinceCode = options.keepProvinceCode || '';
    const keepCityCode = options.keepCityCode || '';
    const sourceRegions = Array.isArray(options.regionList) ? options.regionList : regions;

    const selectedRegion = sourceRegions.find((region) => region.code === nextRegionCode) || null;

    setRegionCode(nextRegionCode);
    setProvinceCode(keepProvinceCode || '');
    setCityCode(keepCityCode || '');
    setBarangays([]);

    setForm((prev) => ({
      ...prev,
      region: selectedRegion?.name || '',
      city: options.keepCityName || '',
      barangay: options.keepBarangayName || '',
    }));

    if (!nextRegionCode) {
      setProvinces([]);
      setCities([]);
      if (!preserveMessages) {
        setErrorMessage('');
        setSuccessMessage('');
      }
      return;
    }

    try {
      setIsLoadingRegionData(true);
      const [nextProvinces, nextCities] = await Promise.all([
        fetchLocationData(`/regions/${nextRegionCode}/provinces/`),
        fetchLocationData(`/regions/${nextRegionCode}/cities-municipalities/`),
      ]);

      const orderedProvinces = [...(nextProvinces || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }),
      );
      const orderedCities = [...(nextCities || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }),
      );

      setProvinces(orderedProvinces);
      setCities(orderedCities);

      if (!preserveMessages) {
        setErrorMessage('');
        setSuccessMessage('');
      }
    } catch (error) {
      setProvinces([]);
      setCities([]);
      setErrorMessage('Unable to load provinces and cities for the selected region.');
    } finally {
      setIsLoadingRegionData(false);
    }
  };

  const handleProvinceChange = (nextProvinceCode) => {
    setProvinceCode(nextProvinceCode);

    if (!nextProvinceCode) {
      return;
    }

    const activeCity = cities.find((city) => city.code === cityCode);
    if (activeCity && activeCity.provinceCode !== nextProvinceCode) {
      setCityCode('');
      setBarangays([]);
      setForm((prev) => ({
        ...prev,
        city: '',
        barangay: '',
      }));
    }
  };

  const handleCityChange = async (nextCityCode, options = {}) => {
    const preserveMessages = options.preserveMessages === true;
    const keepBarangayCode = options.keepBarangayCode || '';
    const keepBarangayName = options.keepBarangayName || '';
    const sourceCities = Array.isArray(options.cityList) ? options.cityList : cities;

    const selectedCity = options.selectedCity
      || sourceCities.find((city) => city.code === nextCityCode)
      || null;

    setCityCode(nextCityCode);
    setBarangays([]);

    if (selectedCity?.provinceCode) {
      setProvinceCode(selectedCity.provinceCode);
    }

    setForm((prev) => ({
      ...prev,
      city: selectedCity?.name || '',
      barangay: keepBarangayName,
    }));

    if (!nextCityCode) {
      if (!preserveMessages) {
        setErrorMessage('');
        setSuccessMessage('');
      }
      return;
    }

    try {
      setIsLoadingBarangays(true);
      const nextBarangays = await fetchLocationData(`/cities-municipalities/${nextCityCode}/barangays/`);
      const orderedBarangays = [...(nextBarangays || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }),
      );

      setBarangays(orderedBarangays);

      if (keepBarangayCode) {
        const selectedBarangay = orderedBarangays.find((barangay) => barangay.code === keepBarangayCode);
        if (selectedBarangay) {
          setForm((prev) => ({
            ...prev,
            barangay: selectedBarangay.name,
          }));
        }
      }

      if (!preserveMessages) {
        setErrorMessage('');
        setSuccessMessage('');
      }
    } catch (error) {
      setErrorMessage('Unable to load barangays for the selected city/municipality.');
    } finally {
      setIsLoadingBarangays(false);
    }
  };

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleLogoFileChange = (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length > 1) {
      setErrorMessage('Only one logo image is allowed. Please select a single file.');
      resetLogoInput();
      return;
    }

    const file = selectedFiles[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMessage('H-Representative logo must be an image file.');
      resetLogoInput();
      return;
    }

    const preview = URL.createObjectURL(file);
    setLogoFile(file);
    setNextLogoPreview(preview);
    setErrorMessage('');
    setSuccessMessage('');
  };

  const handleRemoveLogo = () => {
    resetLogoInput();
    setNextLogoPreview('');
    setForm((prev) => ({
      ...prev,
      hospitalLogoPath: '',
    }));
    setErrorMessage('');
    setSuccessMessage('');
  };

  const uploadHospitalLogo = async (file) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const authUserId = session?.user?.id;
    if (!authUserId) {
      throw new Error('You must be logged in to upload hospital logos.');
    }

    const safeFileName = toSafeFileName(file.name);
    const hospitalSlug = toSlug(form.hospitalName) || 'hospital';
    const filePath = `${authUserId}/hospital-logo/${hospitalSlug}/${Date.now()}-${safeFileName}`;

    const { error: uploadError } = await supabase.storage
      .from(HOSPITAL_LOGOS_BUCKET)
      .upload(filePath, file, { upsert: true, contentType: file.type || 'image/jpeg' });

    if (uploadError) {
      throw uploadError;
    }

    const { data: publicUrlData } = supabase.storage
      .from(HOSPITAL_LOGOS_BUCKET)
      .getPublicUrl(filePath);

    return {
      filePath,
      publicUrl: publicUrlData?.publicUrl || '',
    };
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const hasProvinces = provinces.length > 0;
    const isEditing = Boolean(editingHospitalId);
    const hasRegionValue = Boolean(String(form.region || '').trim());
    const hasCityValue = Boolean(String(form.city || '').trim());
    const hasBarangayValue = Boolean(String(form.barangay || '').trim());

    if (!form.hospitalName.trim()) {
      setErrorMessage('H-Representative name is required.');
      return;
    }

    if (!hasRegionValue || (!regionCode && !isEditing)) {
      setErrorMessage('Please choose a valid region.');
      return;
    }

    if (hasProvinces && !provinceCode && !isEditing) {
      setErrorMessage('Please choose a province for better address precision.');
      return;
    }

    if (!hasCityValue || (!cityCode && !isEditing)) {
      setErrorMessage('Please choose a city/municipality.');
      return;
    }

    if (!hasBarangayValue) {
      setErrorMessage('Please choose a barangay.');
      return;
    }

    if (!form.street.trim()) {
      setErrorMessage('Street address is required.');
      return;
    }

    const previousLogoPath = String(form.hospitalLogoPath || '').trim();
    let nextLogoPath = previousLogoPath || null;
    let uploadedLogoPath = '';

    try {
      setIsSaving(true);

      if (logoFile) {
        setIsUploadingLogo(true);
        const { filePath, publicUrl } = await uploadHospitalLogo(logoFile);
        uploadedLogoPath = filePath;
        nextLogoPath = filePath;

        setForm((prev) => ({
          ...prev,
          hospitalLogoPath: filePath,
        }));

        setNextLogoPreview(publicUrl);
        resetLogoInput();
      }

      const payload = {
        Hospital_Name: form.hospitalName.trim(),
        Hospital_Logo: nextLogoPath,
        Country: form.country.trim() || 'Philippines',
        Region: form.region,
        City: form.city,
        Barangay: form.barangay,
        Street: form.street.trim(),
        Contact_Number: toStoredPhoneNumber(form.contactNumber) || null,
      };

      if (editingHospitalId) {
        const { error } = await supabase
          .from(HOSPITALS_TABLE)
          .update({
            ...payload,
            Updated_At: getPhilippineTimestamp(),
          })
          .eq('Hospital_ID', editingHospitalId);

        if (error) throw error;

        if (
          previousLogoPath
          && previousLogoPath !== nextLogoPath
          && !isAbsoluteUrl(previousLogoPath)
        ) {
            await supabase.storage.from(HOSPITAL_LOGOS_BUCKET).remove([previousLogoPath]);
        }

        setSuccessMessage('H-Representative updated successfully.');
      } else {
        const nowIso = getPhilippineTimestamp();
        const { error } = await supabase
          .from(HOSPITALS_TABLE)
          .insert({
            ...payload,
            Created_At: nowIso,
            Updated_At: nowIso,
          });

        if (error) throw error;

        setSuccessMessage('H-Representative added successfully.');
      }

      setErrorMessage('');
      await fetchHospitals();
      resetForm(true);
      setIsModalOpen(false);
    } catch (error) {
      if (uploadedLogoPath && uploadedLogoPath !== previousLogoPath && !isAbsoluteUrl(uploadedLogoPath)) {
        try {
          await supabase.storage.from(HOSPITAL_LOGOS_BUCKET).remove([uploadedLogoPath]);
        } catch {
          // Best effort rollback of orphan upload.
        }
      }

      setErrorMessage(mapStorageUploadError(error.message) || 'Unable to save hospital record.');
    } finally {
      setIsUploadingLogo(false);
      setIsSaving(false);
    }
  };

  const handleEditHospital = async (hospital) => {
    setIsModalOpen(true);
    setSuccessMessage('');
    setErrorMessage('');

    const nextForm = {
      hospitalName: hospital.Hospital_Name || '',
      hospitalLogoPath: hospital.Hospital_Logo || '',
      country: hospital.Country || 'Philippines',
      region: hospital.Region || '',
      city: hospital.City || '',
      barangay: hospital.Barangay || '',
      street: hospital.Street || '',
      contactNumber: hospital.Contact_Number || '',
    };

    setForm(nextForm);
    setEditingHospitalId(hospital.Hospital_ID);
    resetLogoInput();
    setNextLogoPreview(resolveHospitalLogoUrl(hospital.Hospital_Logo));

    try {
      if (regions.length === 0) {
        await loadRegions();
      }

      const availableRegions = regions.length > 0 ? regions : await fetchLocationData('/regions/');
      if (regions.length === 0) {
        setRegions(availableRegions);
      }

      const matchedRegion = availableRegions.find((region) => matchesRegion(region, hospital.Region));

      if (!matchedRegion) {
        setRegionCode('');
        setProvinceCode('');
        setCityCode('');
        setProvinces([]);
        setCities([]);
        setBarangays([]);
        return;
      }

      await handleRegionChange(matchedRegion.code, {
        preserveMessages: true,
        keepCityName: hospital.City || '',
        keepBarangayName: hospital.Barangay || '',
        regionList: availableRegions,
      });

      const regionCities = await fetchLocationData(`/regions/${matchedRegion.code}/cities-municipalities/`);
      const orderedCities = [...(regionCities || [])].sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }),
      );
      setCities(orderedCities);

      const normalizedHospitalCity = normalizeText(hospital.City);
      const matchedCity = orderedCities.find((city) => {
        const possibleNames = [city?.name, city?.oldName, city?.description]
          .filter(Boolean)
          .map((value) => normalizeText(value));

        return possibleNames.some(
          (name) => name === normalizedHospitalCity || name.includes(normalizedHospitalCity) || normalizedHospitalCity.includes(name),
        );
      });

      if (!matchedCity) {
        setProvinceCode('');
        setCityCode('');
        setBarangays([]);
        return;
      }

      if (matchedCity.provinceCode) {
        setProvinceCode(matchedCity.provinceCode);
      }

      await handleCityChange(matchedCity.code, {
        preserveMessages: true,
        keepBarangayName: hospital.Barangay || '',
        cityList: orderedCities,
        selectedCity: matchedCity,
      });
    } catch {
      setErrorMessage('Unable to fully preload address options for this hospital. You can still update details manually.');
    }
  };

  const handleDeleteHospital = (hospital) => {
    setDeleteTarget(hospital);
  };

  const closeDeleteModal = () => {
    if (deletingHospitalId) return;
    setDeleteTarget(null);
  };

  const confirmDeleteHospital = async () => {
    const hospital = deleteTarget;
    if (!hospital) return;
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    try {
      setDeletingHospitalId(hospital.Hospital_ID);
      const logoPath = String(hospital.Hospital_Logo || '').trim();

      const { error: unlinkError } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .delete()
        .eq('Hospital_ID', hospital.Hospital_ID);

      if (unlinkError) throw unlinkError;

      const { error } = await supabase
        .from(HOSPITALS_TABLE)
        .delete()
        .eq('Hospital_ID', hospital.Hospital_ID);

      if (error) throw error;

      if (logoPath && !isAbsoluteUrl(logoPath)) {
        try {
          await supabase.storage.from(HOSPITAL_LOGOS_BUCKET).remove([logoPath]);
        } catch {
          // Best effort cleanup; hospital row has already been deleted.
        }
      }

      setSuccessMessage('H-Representative deleted successfully.');
      setErrorMessage('');
      await fetchHospitals();

      if (editingHospitalId === hospital.Hospital_ID) {
        resetForm(true);
      }

      setDeleteTarget(null);
    } catch (error) {
      setErrorMessage(error.message || 'Unable to delete hospital.');
    } finally {
      setDeletingHospitalId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div>
          <h1 className="role-page-title text-3xl font-bold text-gray-900">Manage H-Representative Accounts</h1>
          <p className="text-sm text-gray-600 mt-1">
            Review and maintain hospital records used by H-Representatives, patients, and wig request routing.
          </p>
        </div>
      </div>

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-x-6 gap-y-1" aria-label="Section tabs">
          {PAGE_TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative -mb-px border-b-2 px-1 pb-3 pt-2 text-sm font-semibold transition-colors ${
                  isActive
                    ? ''
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                }`}
                style={isActive
                  ? { borderColor: theme.primaryColor, color: theme.primaryColor }
                  : undefined}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === 'manage' && (
        <section className={cardClass()}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
            <div className="relative w-full md:max-w-sm">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by name, location, or contact number"
                className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm bg-white focus:ring-2 outline-none"
                style={{ '--tw-ring-color': theme.primaryColor }}
              />
            </div>

            <button
              type="button"
              onClick={fetchHospitals}
              className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
              style={{
                borderColor: `${theme.primaryColor}33`,
                backgroundColor: `${theme.primaryColor}12`,
                color: theme.primaryColor,
              }}
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>

          {isLoadingHospitals ? (
            <div className="py-10 text-gray-700 flex items-center justify-center gap-2">
              <Loader2 className="animate-spin" size={18} /> Loading hospitals...
            </div>
          ) : filteredHospitals.length === 0 ? (
            <div className="py-10 text-center text-gray-500">
              <Building2 size={40} className="mx-auto mb-2 text-gray-300" />
              <p>No hospitals found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm text-center">
                <thead className="text-sm" style={{ backgroundColor: `${theme.primaryColor}20`, color: tableHeaderTextColor }}>
                  <tr>
                    <th className="px-4 py-3 text-center font-semibold">H-Representative</th>
                    <th className="px-4 py-3 text-center font-semibold">Contact</th>
                    <th className="px-4 py-3 text-center font-semibold">Address</th>
                    <th className="px-4 py-3 text-center font-semibold">Access</th>
                    <th className="px-4 py-3 text-center font-semibold">Updated</th>
                    <th className="px-4 py-3 text-center font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHospitals.map((hospital) => (
                    <tr key={hospital.Hospital_ID} className="border-t border-gray-200 align-middle">
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-center gap-2 text-center">
                          {resolveHospitalLogoUrl(hospital.Hospital_Logo) ? (
                            <img
                              src={resolveHospitalLogoUrl(hospital.Hospital_Logo)}
                              alt="H-Representative logo"
                              className="h-10 w-10 rounded-md border border-gray-200 object-cover"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded-md border border-gray-200 bg-gray-50 flex items-center justify-center text-gray-400">
                              <Building2 size={16} />
                            </div>
                          )}
                          <div>
                            <div className="font-semibold text-gray-900">{hospital.Hospital_Name || 'N/A'}</div>
                            <div className="text-xs text-gray-500 mt-1">ID: {hospital.Hospital_ID}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 text-center">{hospital.Contact_Number || 'N/A'}</td>
                      <td className="px-4 py-3 text-gray-700 text-center">
                        {[hospital.Street, hospital.Barangay, hospital.City, hospital.Region, hospital.Country]
                          .filter(Boolean)
                          .join(', ') || 'N/A'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                          hospital.Is_Approved ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'
                        }`}>
                          {hospital.Is_Approved ? 'On' : 'Off'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700 text-center">{formatDateTime(hospital.Updated_At || hospital.Created_At)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => openHospitalDetails(hospital)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                            title="View hospital details"
                          >
                            <Info size={13} /> View Information
                          </button>

                          <button
                            type="button"
                            onClick={() => handleEditHospital(hospital)}
                            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-semibold"
                            style={{
                              borderColor: `${theme.primaryColor}33`,
                              backgroundColor: `${theme.primaryColor}12`,
                              color: theme.primaryColor,
                            }}
                          >
                            <Pencil size={13} /> Edit
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDeleteHospital(hospital)}
                            disabled={deletingHospitalId === hospital.Hospital_ID}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                          >
                            {deletingHospitalId === hospital.Hospital_ID ? (
                              <Loader2 className="animate-spin" size={13} />
                            ) : (
                              <Trash2 size={13} />
                            )}
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === 'applications' && (
        <section className={cardClass()}>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Hospital Applications</h3>
              <p className="mt-1 text-xs text-gray-500">
                Review hospital partnership submissions and decide whether to approve or reject.
              </p>
            </div>

            <button
              type="button"
              onClick={fetchHospitals}
              className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"
              style={{
                borderColor: `${theme.primaryColor}33`,
                backgroundColor: `${theme.primaryColor}12`,
                color: theme.primaryColor,
              }}
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr,220px]">
            <div className="relative w-full">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={applicationSearchTerm}
                onChange={(event) => setApplicationSearchTerm(event.target.value)}
                placeholder="Search by hospital, head/owner, manager, email, contact, or location"
                className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm bg-white focus:ring-2 outline-none"
                style={{ '--tw-ring-color': theme.primaryColor }}
              />
            </div>

            <select
              value={applicationStatusFilter}
              onChange={(event) => setApplicationStatusFilter(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-sm focus:ring-2 outline-none"
              style={{ '--tw-ring-color': theme.primaryColor }}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="all">All</option>
            </select>
          </div>

          {isLoadingHospitals ? (
            <div className="py-10 text-gray-700 flex items-center justify-center gap-2">
              <Loader2 className="animate-spin" size={18} /> Loading hospital applications...
            </div>
          ) : filteredHospitalApplications.length === 0 ? (
            <div className="py-10 text-center text-gray-500">
              <Building2 size={40} className="mx-auto mb-2 text-gray-300" />
              <p>No hospital applications found for this filter.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-sm" style={{ backgroundColor: `${theme.primaryColor}20`, color: tableHeaderTextColor }}>
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Hospital</th>
                    <th className="px-4 py-3 text-left font-semibold">Head / Owner</th>
                    <th className="px-4 py-3 text-left font-semibold">Contact</th>
                    <th className="px-4 py-3 text-left font-semibold">Submitted</th>
                    <th className="px-4 py-3 text-left font-semibold">Status</th>
                    <th className="px-4 py-3 text-center font-semibold">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHospitalApplications.map((hospital) => {
                    const statusKey = getHospitalApprovalStatus(hospital);
                    const statusLabel = getHospitalApprovalStatusLabel(statusKey);
                    const isApproved = statusKey === 'approved';
                    const isRejected = statusKey === 'rejected';
                    const isProcessing = applicationActionHospitalId === hospital.Hospital_ID;
                    const isApprovingRow = isProcessing && applicationActionType === 'Approved';
                    const isRejectingRow = isProcessing && applicationActionType === 'Rejected';

                    return (
                      <tr key={hospital.Hospital_ID} className="border-t border-gray-200 align-top">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-gray-900">{hospital.Hospital_Name || 'N/A'}</p>
                          <p className="mt-1 text-xs text-gray-500">ID: {hospital.Hospital_ID}</p>
                          <p className="mt-2 text-xs text-gray-600">
                            {formatHospitalAddress(hospital)}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          <p className="font-medium text-gray-900">{hospital.Hospital_Head_Name || 'N/A'}</p>
                          <p className="mt-1 text-xs text-gray-500">{hospital.Hospital_Head_Title || 'No role provided'}</p>
                          <p className="mt-1 text-xs text-gray-600">{hospital.Hospital_Head_Email || 'No email provided'}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          <p>{hospital.Contact_Number || 'No contact number'}</p>
                          <p className="mt-1 text-xs text-gray-600">{hospital.Hospital_Head_Contact_Number || 'No head contact number'}</p>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          <p>{formatDateTime(hospital.Created_At)}</p>
                          <p className="mt-1 text-xs text-gray-500">Updated: {formatDateTime(hospital.Updated_At)}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                              isApproved
                                ? 'bg-emerald-100 text-emerald-700'
                                : isRejected
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-amber-100 text-amber-700'
                            }`}
                          >
                            {statusLabel}
                          </span>
                          <p className="mt-2 text-xs text-gray-500">Reviewed: {formatDateTime(hospital.Approved_At)}</p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => openApplicationInfoModal(hospital)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              <Info size={13} />
                              View Information
                            </button>

                            <button
                              type="button"
                              onClick={() => handleHospitalApplicationDecision(hospital, 'Approved')}
                              disabled={isProcessing || isApproved}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                            >
                              {isApprovingRow ? <Loader2 className="animate-spin" size={13} /> : <CheckCircle2 size={13} />}
                              Approve
                            </button>

                            <button
                              type="button"
                              onClick={() => handleHospitalApplicationDecision(hospital, 'Rejected')}
                              disabled={isProcessing || isRejected}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                            >
                              {isRejectingRow ? <Loader2 className="animate-spin" size={13} /> : <X size={13} />}
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {applicationInfoHospital && typeof document !== 'undefined' && createPortal(
        (() => {
          const statusKey = getHospitalApprovalStatus(applicationInfoHospital);
          const statusLabel = getHospitalApprovalStatusLabel(statusKey);
          const isApproved = statusKey === 'approved';
          const isRejected = statusKey === 'rejected';
          const isProcessing = Number(applicationActionHospitalId) === Number(applicationInfoHospital.Hospital_ID);
          const isApprovingApplication = isProcessing && applicationActionType === 'Approved';
          const isRejectingApplication = isProcessing && applicationActionType === 'Rejected';
          const logoUrl = resolveHospitalLogoUrl(applicationInfoHospital.Hospital_Logo);
          const applicantUser = getApplicantUserForHospital(applicationInfoHospital);
          const applicantDetails = getUserDetails(applicantUser);
          const applicantAddress = [
            applicantDetails?.street,
            applicantDetails?.barangay,
            applicantDetails?.city,
            applicantDetails?.province,
            applicantDetails?.region,
            applicantDetails?.country,
          ].filter(Boolean).join(', ');
          const coordinates = applicationInfoHospital.Latitude && applicationInfoHospital.Longitude
            ? `${applicationInfoHospital.Latitude}, ${applicationInfoHospital.Longitude}`
            : 'No coordinates provided';
          const mapUrl = applicationInfoHospital.Latitude && applicationInfoHospital.Longitude
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${applicationInfoHospital.Latitude},${applicationInfoHospital.Longitude}`)}`
            : '';
          const InfoField = ({ label, value, full = false }) => (
            <div className={full ? 'md:col-span-2' : ''}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 break-words text-sm font-medium leading-relaxed text-slate-900">{value || 'N/A'}</p>
            </div>
          );

          return (
            <div className="fixed inset-0 z-[115] flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close application information"
                onClick={closeApplicationInfoModal}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />

              <div className="relative flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Hospital Application</p>
                    <h3 className="mt-1 break-words text-xl font-bold text-slate-900">
                      {applicationInfoHospital.Hospital_Name || `Hospital #${applicationInfoHospital.Hospital_ID}`}
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">Application ID: {applicationInfoHospital.Hospital_ID}</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${
                        isApproved
                          ? 'bg-emerald-100 text-emerald-700'
                          : isRejected
                            ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {statusLabel}
                    </span>
                    <button
                      type="button"
                      onClick={closeApplicationInfoModal}
                      disabled={isProcessing}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60"
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px,minmax(0,1fr)]">
                    <aside className="space-y-4">
                      <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                        {logoUrl ? (
                          <img
                            src={logoUrl}
                            alt={`${applicationInfoHospital.Hospital_Name || 'Hospital'} logo`}
                            className="h-56 w-full bg-white object-contain"
                          />
                        ) : (
                          <div className="flex h-56 items-center justify-center bg-white text-slate-400">
                            <Building2 size={42} />
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Review Summary</p>
                        <div className="mt-3 space-y-2 text-sm text-slate-700">
                          <p><span className="font-semibold text-slate-900">Submitted:</span> {formatDateTime(applicationInfoHospital.Created_At)}</p>
                          <p><span className="font-semibold text-slate-900">Updated:</span> {formatDateTime(applicationInfoHospital.Updated_At)}</p>
                          <p><span className="font-semibold text-slate-900">Reviewed:</span> {formatDateTime(applicationInfoHospital.Approved_At)}</p>
                        </div>
                      </div>
                    </aside>

                    <div className="space-y-4">
                      <section className="rounded-xl border border-slate-200 p-4">
                        <h4 className="text-sm font-bold text-slate-900">Hospital Profile</h4>
                        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                          <InfoField label="Hospital Name" value={applicationInfoHospital.Hospital_Name} />
                          <InfoField label="Hospital Contact" value={applicationInfoHospital.Contact_Number} />
                          <InfoField label="Full Address" value={formatHospitalAddress(applicationInfoHospital)} full />
                          <InfoField label="Coordinates" value={coordinates} />
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Map</p>
                            {mapUrl ? (
                              <a
                                href={mapUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-flex text-sm font-semibold text-blue-700 underline"
                              >
                                Open pinned location
                              </a>
                            ) : (
                              <p className="mt-1 text-sm font-medium text-slate-900">N/A</p>
                            )}
                          </div>
                        </div>
                      </section>

                      <section className="rounded-xl border border-slate-200 p-4">
                        <h4 className="text-sm font-bold text-slate-900">Head / Owner</h4>
                        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                          <InfoField label="Name" value={applicationInfoHospital.Hospital_Head_Name} />
                          <InfoField label="Position" value={applicationInfoHospital.Hospital_Head_Title} />
                          <InfoField label="Email" value={applicationInfoHospital.Hospital_Head_Email} />
                          <InfoField label="Contact Number" value={applicationInfoHospital.Hospital_Head_Contact_Number} />
                        </div>
                      </section>

                      <section className="rounded-xl border border-slate-200 p-4">
                        <h4 className="text-sm font-bold text-slate-900">Managing Account</h4>
                        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                          <InfoField label="Manager Name" value={getUserFullName(applicantUser) || applicationInfoHospital.Hospital_Head_Name} />
                          <InfoField label="Account Email" value={applicantUser?.email || applicationInfoHospital.Hospital_Head_Email} />
                          <InfoField label="Role" value={getHospitalManagerRoleLabel(applicantUser)} />
                          <InfoField label="Contact Number" value={applicantDetails?.contact_number || applicationInfoHospital.Hospital_Head_Contact_Number} />
                          <InfoField label="Birthdate" value={applicantDetails?.birthdate} />
                          <InfoField label="Gender" value={applicantDetails?.gender} />
                          <InfoField label="Address" value={applicantAddress || 'N/A'} full />
                        </div>
                      </section>
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-slate-600">Decision</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleHospitalApplicationDecision(applicationInfoHospital, 'Approved')}
                        disabled={isProcessing || isApproved}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                      >
                        {isApprovingApplication ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => handleHospitalApplicationDecision(applicationInfoHospital, 'Rejected')}
                        disabled={isProcessing || isRejected}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                      >
                        {isRejectingApplication ? <Loader2 className="animate-spin" size={14} /> : <X size={14} />}
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {/* Approve / Reject decision modal */}
      {decisionTarget && typeof document !== 'undefined' && createPortal(
        (() => {
          const isApproving = decisionTarget.nextStatus === 'Approved';
          const isSubmitting = Number(applicationActionHospitalId) === Number(decisionTarget.hospital?.Hospital_ID);
          const accentColor = isApproving ? '#10b981' : '#e11d48';
          const accentBgClass = isApproving ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800';
          return (
            <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close"
                onClick={closeDecisionModal}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />
              <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 flex-none items-center justify-center rounded-xl text-white"
                      style={{ backgroundColor: accentColor }}
                    >
                      {isApproving ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900">
                        {isApproving ? 'Approve hospital application' : 'Reject hospital application'}
                      </h3>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {decisionTarget.hospital?.Hospital_Name || `Hospital #${decisionTarget.hospital?.Hospital_ID}`}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeDecisionModal}
                    disabled={isSubmitting}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="space-y-4 px-5 py-4">
                  <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${accentBgClass}`}>
                    {isApproving ? <CheckCircle2 size={16} className="mt-0.5 flex-none" /> : <AlertTriangle size={16} className="mt-0.5 flex-none" />}
                    <span>
                      {isApproving
                        ? 'Approving will activate this hospital and prepare the applicant account for H-Representative access.'
                        : 'Rejecting will mark this application as rejected. The applicant can submit a new application if needed.'}
                    </span>
                  </div>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600">
                      Review Notes <span className="font-medium normal-case tracking-normal text-slate-400">(optional)</span>
                    </span>
                    <textarea
                      value={decisionReviewNotes}
                      onChange={(event) => setDecisionReviewNotes(event.target.value)}
                      rows={4}
                      disabled={isSubmitting}
                      placeholder={isApproving ? 'Optional note for this approval.' : 'Optional reason or note for this rejection.'}
                      className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 disabled:bg-slate-50"
                      autoFocus
                    />
                    <span className="text-[11px] text-slate-500">Leave blank to save no review note.</span>
                  </label>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
                  <button
                    type="button"
                    onClick={closeDecisionModal}
                    disabled={isSubmitting}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmHospitalApplicationDecision}
                    disabled={isSubmitting}
                    className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
                    style={{ backgroundColor: accentColor }}
                  >
                    {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : (isApproving ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />)}
                    {isApproving ? 'Confirm Approval' : 'Confirm Rejection'}
                  </button>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && typeof document !== 'undefined' && createPortal(
        (() => {
          const isDeleting = Number(deletingHospitalId) === Number(deleteTarget?.Hospital_ID);
          return (
            <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close"
                onClick={closeDeleteModal}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />
              <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-rose-600 text-white">
                      <Trash2 size={18} />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-slate-900">Delete H-Representative</h3>
                      <p className="mt-0.5 text-sm text-slate-600">
                        {deleteTarget.Hospital_Name || `Hospital #${deleteTarget.Hospital_ID}`}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeDeleteModal}
                    disabled={isDeleting}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="space-y-3 px-5 py-4">
                  <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
                    <AlertTriangle size={16} className="mt-0.5 flex-none" />
                    <span>
                      <strong>This action cannot be undone.</strong> The hospital record, its logo, and all H-Representative assignments will be permanently removed.
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
                  <button
                    type="button"
                    onClick={closeDeleteModal}
                    disabled={isDeleting}
                    className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmDeleteHospital}
                    disabled={isDeleting}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
                  >
                    {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {detailsHospital && typeof document !== 'undefined' && createPortal(
        (() => {
          const managerUser = getApplicantUserForHospital(detailsHospital);
          const managerDetails = getUserDetails(managerUser);
          const logoUrl = resolveHospitalLogoUrl(detailsHospital.Hospital_Logo);
          const coordinates = detailsHospital.Latitude && detailsHospital.Longitude
            ? `${detailsHospital.Latitude}, ${detailsHospital.Longitude}`
            : 'N/A';
          const mapUrl = detailsHospital.Latitude && detailsHospital.Longitude
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${detailsHospital.Latitude},${detailsHospital.Longitude}`)}`
            : '';
          const isAccessUpdating = Number(accessActionHospitalId) === Number(detailsHospital.Hospital_ID);
          const InfoField = ({ label, value, full = false }) => (
            <div className={full ? 'md:col-span-2' : ''}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-1 break-words text-sm font-medium leading-relaxed text-slate-900">{value || 'N/A'}</p>
            </div>
          );

          return (
            <div className="fixed inset-0 z-[115] flex items-center justify-center p-4">
              <button
                type="button"
                aria-label="Close hospital information"
                onClick={closeHospitalDetails}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />

              <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">H-Representative Account</p>
                    <h3 className="mt-1 break-words text-xl font-bold text-slate-900">
                      {detailsHospital.Hospital_Name || `Hospital #${detailsHospital.Hospital_ID}`}
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">Hospital ID: {detailsHospital.Hospital_ID}</p>
                  </div>

                  <button
                    type="button"
                    onClick={closeHospitalDetails}
                    disabled={isAccessUpdating}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px,minmax(0,1fr)]">
                    <aside className="space-y-4">
                      <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                        {logoUrl ? (
                          <img
                            src={logoUrl}
                            alt={`${detailsHospital.Hospital_Name || 'Hospital'} logo`}
                            className="h-56 w-full bg-white object-contain"
                          />
                        ) : (
                          <div className="flex h-56 items-center justify-center bg-white text-slate-400">
                            <Building2 size={42} />
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Record Summary</p>
                        <div className="mt-3 space-y-2">
                          <p><span className="font-semibold text-slate-900">Submitted:</span> {formatDateTime(detailsHospital.Created_At)}</p>
                          <p><span className="font-semibold text-slate-900">Updated:</span> {formatDateTime(detailsHospital.Updated_At)}</p>
                        </div>
                      </div>
                    </aside>

                    <div className="space-y-4">
                      <section className="rounded-xl border border-slate-200 p-4">
                        <h4 className="text-sm font-bold text-slate-900">Hospital Information</h4>
                        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                          <InfoField label="Hospital Name" value={detailsHospital.Hospital_Name} />
                          <InfoField label="Hospital Contact" value={detailsHospital.Contact_Number} />
                          <InfoField label="Head / Owner" value={detailsHospital.Hospital_Head_Name} />
                          <InfoField label="Head Position" value={detailsHospital.Hospital_Head_Title} />
                          <InfoField label="Head Email" value={detailsHospital.Hospital_Head_Email} />
                          <InfoField label="Head Contact" value={detailsHospital.Hospital_Head_Contact_Number} />
                          <InfoField label="Full Address" value={formatHospitalAddress(detailsHospital)} full />
                          <InfoField label="Coordinates" value={coordinates} />
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Map</p>
                            {mapUrl ? (
                              <a
                                href={mapUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-flex text-sm font-semibold text-blue-700 underline"
                              >
                                Open pinned location
                              </a>
                            ) : (
                              <p className="mt-1 text-sm font-medium text-slate-900">N/A</p>
                            )}
                          </div>
                        </div>
                      </section>

                      <section className="rounded-xl border border-slate-200 p-4">
                        <h4 className="text-sm font-bold text-slate-900">Managing Account</h4>
                        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                          <InfoField label="Manager Name" value={getUserFullName(managerUser) || detailsHospital.Hospital_Head_Name} />
                          <InfoField label="Account Email" value={managerUser?.email || detailsHospital.Hospital_Head_Email} />
                          <InfoField label="Role" value={getHospitalManagerRoleLabel(managerUser)} />
                          <InfoField label="Contact Number" value={managerDetails?.contact_number || detailsHospital.Hospital_Head_Contact_Number} />
                          <InfoField label="Birthdate" value={managerDetails?.birthdate} />
                          <InfoField label="Gender" value={managerDetails?.gender} />
                        </div>
                      </section>
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => toggleHospitalAccess(detailsHospital, !detailsHospital.Is_Approved)}
                      disabled={isAccessUpdating}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
                        detailsHospital.Is_Approved
                          ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                          : 'border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      }`}
                    >
                      {isAccessUpdating
                        ? 'Updating access...'
                        : detailsHospital.Is_Approved
                          ? 'Turn Off Access'
                          : 'Turn On Access'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {isModalOpen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[90] backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6 border-b border-gray-200 pb-4">
              <div>
                <h3 className="text-xl font-bold text-gray-800">
                  {editingHospitalId ? 'Edit H-Representative' : 'Add New H-Representative'}
                </h3>
                <p className="text-xs text-gray-500 mt-1 flex items-center gap-1.5">
                  <MapPin size={14} />
                  Address selectors use complete Philippines JSON from PSGC.
                </p>
              </div>
              <button type="button" onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-red-500">
                <X size={24} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4" style={{ '--tw-ring-color': theme.primaryColor }}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">H-Representative Name</label>
                  <input
                    name="hospitalName"
                    value={form.hospitalName}
                    onChange={handleInputChange}
                    required
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                    placeholder="e.g., Jose B. Lingad Memorial General H-Representative"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Contact Number</label>
                  <input
                    name="contactNumber"
                    value={form.contactNumber}
                    onChange={handleInputChange}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                    placeholder="e.g., +63 912 345 6789"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">H-Representative Logo</label>
                  <input
                    key={logoInputKey}
                    type="file"
                    accept="image/*"
                    multiple={false}
                    onChange={handleLogoFileChange}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Only one image is allowed. Uploads to Supabase bucket: hospital_logos.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                  <input
                    name="country"
                    value={form.country}
                    onChange={handleInputChange}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                  />
                </div>
              </div>

              <div
                className="rounded-xl border p-4"
                style={{
                  borderColor: `${theme.primaryColor}33`,
                  backgroundColor: `${theme.primaryColor}08`,
                }}
              >
                <div className="flex flex-col gap-1 mb-3">
                  <p className="text-sm font-semibold text-gray-800">Logo Preview</p>
                  <p className="text-xs text-gray-500">Single logo image only. Choosing a new file replaces the previous one.</p>
                </div>

                {currentLogoPreview ? (
                  <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                    <img
                      src={currentLogoPreview}
                      alt="H-Representative logo preview"
                      className="h-56 w-full object-contain bg-white"
                    />
                  </div>
                ) : (
                  <div className="h-56 rounded-lg border border-dashed border-gray-300 bg-white flex items-center justify-center text-sm text-gray-400">
                    No logo selected yet
                  </div>
                )}

                {logoFile?.name && (
                  <p className="mt-2 text-xs text-gray-600">Selected file: {logoFile.name}</p>
                )}

                {form.hospitalLogoPath && (
                  <p className="mt-2 text-[11px] text-gray-600 break-all">
                    Stored path: {form.hospitalLogoPath}
                  </p>
                )}

                {(currentLogoPreview || form.hospitalLogoPath) && (
                  <button
                    type="button"
                    onClick={handleRemoveLogo}
                    className="mt-3 inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
                  >
                    <Trash2 size={12} /> Remove Logo
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
                  <select
                    value={regionCode}
                    onChange={(event) => {
                      handleRegionChange(event.target.value);
                    }}
                    disabled={isLoadingRegions}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                  >
                    <option value="">
                      {isLoadingRegions ? 'Loading regions...' : 'Select region'}
                    </option>
                    {regions.map((region) => (
                      <option key={region.code} value={region.code}>
                        {region.name}
                        {region.regionName && region.regionName !== region.name ? ` (${region.regionName})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Province</label>
                  <select
                    value={provinceCode}
                    onChange={(event) => handleProvinceChange(event.target.value)}
                    disabled={!regionCode || isLoadingRegionData || provinces.length === 0}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="">
                      {isLoadingRegionData
                        ? 'Loading provinces...'
                        : provinces.length > 0
                          ? 'Select province (optional filter)'
                          : 'No provinces for this region'}
                    </option>
                    {provinces.map((province) => (
                      <option key={province.code} value={province.code}>
                        {province.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500">{provinceFilterHint}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">City / Municipality</label>
                  <select
                    value={cityCode}
                    onChange={(event) => {
                      handleCityChange(event.target.value);
                    }}
                    disabled={!regionCode || isLoadingRegionData}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="">
                      {isLoadingRegionData
                        ? 'Loading cities/municipalities...'
                        : regionCode
                          ? 'Select city/municipality'
                          : 'Select region first'}
                    </option>
                    {visibleCities.map((city) => (
                      <option key={city.code} value={city.code}>
                        {city.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Barangay</label>
                  <select
                    value={
                      barangays.find((barangay) => normalizeText(barangay.name) === normalizeText(form.barangay))?.code || ''
                    }
                    onChange={(event) => {
                      const selectedBarangay = barangays.find((barangay) => barangay.code === event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        barangay: selectedBarangay?.name || '',
                      }));
                    }}
                    disabled={!cityCode || isLoadingBarangays}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="">
                      {isLoadingBarangays
                        ? 'Loading barangays...'
                        : cityCode
                          ? 'Select barangay'
                          : 'Select city/municipality first'}
                    </option>
                    {barangays.map((barangay) => (
                      <option key={barangay.code} value={barangay.code}>
                        {barangay.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Street Address</label>
                <input
                  name="street"
                  value={form.street}
                  onChange={handleInputChange}
                  required
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                  placeholder="House/Building No., Street, Subdivision"
                />
              </div>

              <div className="flex gap-3 mt-8 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setIsModalOpen(false);
                  }}
                  className="flex-1 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={isSaving || isUploadingLogo}
                  className="flex-1 py-2 text-white rounded-lg flex justify-center items-center gap-2 disabled:opacity-60"
                  style={{ backgroundColor: theme.primaryColor }}
                >
                  {isSaving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                  {isSaving
                    ? (isUploadingLogo ? 'Uploading...' : 'Saving...')
                    : editingHospitalId
                      ? 'Update H-Representative'
                      : 'Add H-Representative'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}

      {toastMessage && (
        <div
          className={`fixed right-6 bottom-6 z-[60] rounded-lg border px-4 py-2.5 text-sm font-semibold shadow-lg flex items-center gap-2 ${
            toastKind === 'error'
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-emerald-300 bg-emerald-50 text-emerald-900'
          }`}
        >
          {toastKind === 'error' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
