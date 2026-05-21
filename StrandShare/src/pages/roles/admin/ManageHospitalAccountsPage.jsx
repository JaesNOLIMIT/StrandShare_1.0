import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRightLeft,
  Building2,
  Info,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  CheckCircle2,
  X,
} from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const HOSPITALS_TABLE = 'Hospitals';
const HOSPITAL_STAFF_TABLE = 'Hospital_Representative';
const USERS_TABLE = 'users';
const HOSPITAL_LOGOS_BUCKET = 'hospital_logos';
const PSGC_BASE_URL = 'https://psgc.gitlab.io/api';
const PHILIPPINE_TIME_ZONE = 'Asia/Manila';
let hospitalInviteAdminClient = null;

const PAGE_TABS = [
  { id: 'manage', label: 'Manage H-Representatives' },
  { id: 'assign', label: 'Assign H-Representative' },
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

function normalizeRoleSlug(roleValue) {
  return String(roleValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isHStaffRole(roleValue) {
  const roleSlug = normalizeRoleSlug(roleValue);
  return roleSlug === 'hospital' || roleSlug === 'hstaff' || roleSlug === 'hrepresentative';
}

function mapHospitalStaffError(rawMessage) {
  const message = String(rawMessage || 'Unable to update hospital staff assignment.');
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('duplicate key value')) {
    return 'This H-Representative is already assigned to a hospital.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Action blocked by database policy. Make sure your account has Admin permissions.';
  }

  return message;
}

function mapHospitalInviteError(rawMessage) {
  const message = String(rawMessage || 'Unable to send hospital invite email.');
  const lowerMessage = message.toLowerCase();

  if (!message || lowerMessage.includes('missing-service-role')) {
    return 'Invite email service is not configured. Add REACT_APP_SUPABASE_SERVICE_ROLE_KEY in .env.local and restart the app.';
  }

  if (lowerMessage.includes('already registered') || lowerMessage.includes('already been registered') || lowerMessage.includes('user already exists')) {
    return 'Account already exists in Auth. Invite email will be re-created and resent using the invite-user template.';
  }

  if (lowerMessage.includes('invalid email')) {
    return 'Invalid H-Representative email address.';
  }

  if (lowerMessage.includes('row-level security')) {
    return 'Invite email action blocked by database/auth policy.';
  }

  return message;
}

function buildTemporaryPassword() {
  const numeric = Math.floor(100000 + (Math.random() * 900000));
  return `Strand-${numeric}!Aa`;
}

function createHospitalInviteAdminClient() {
  if (hospitalInviteAdminClient) {
    return hospitalInviteAdminClient;
  }

  const url = process.env.REACT_APP_SUPABASE_URL;
  const serviceRoleKey = process.env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return null;
  }

  hospitalInviteAdminClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'strandshare-hospital-invite-admin-client',
    },
  });

  return hospitalInviteAdminClient;
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

function getHStaffDisplayName(user) {
  if (!user) return 'Unknown user';

  const details = Array.isArray(user.user_details)
    ? user.user_details[0]
    : user.user_details;

  const fullName = [details?.first_name, details?.middle_name, details?.last_name, details?.suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (fullName && user.email) {
    return `${fullName} (${user.email})`;
  }

  return fullName || user.email || `User #${user.user_id || 'N/A'}`;
}

export default function ManageHospitalAccountsPage() {
  const { theme } = useTheme();
  const tableHeaderTextColor = theme?.primaryTextColor || '#111827';
  const primaryTextColor = theme?.primaryTextColor || '#111827';
  const secondaryTextColor = theme?.secondaryTextColor || '#6b7280';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const [activeTab, setActiveTab] = useState('manage');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [detailsHospitalId, setDetailsHospitalId] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [hospitalStaffLinks, setHospitalStaffLinks] = useState([]);
  const [hStaffUsers, setHStaffUsers] = useState([]);
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
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [isLoadingRegions, setIsLoadingRegions] = useState(false);
  const [isLoadingRegionData, setIsLoadingRegionData] = useState(false);
  const [isLoadingBarangays, setIsLoadingBarangays] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingAssignment, setIsSavingAssignment] = useState(false);
  const [isReassigning, setIsReassigning] = useState(false);
  const [applicationActionHospitalId, setApplicationActionHospitalId] = useState(null);
  const [adminUserId, setAdminUserId] = useState(null);
  const [deletingHospitalId, setDeletingHospitalId] = useState(null);
  const [removingLinkId, setRemovingLinkId] = useState(null);

  const [assignmentHospitalId, setAssignmentHospitalId] = useState('');
  const [assignmentUserId, setAssignmentUserId] = useState('');
  const [panelAssignUserId, setPanelAssignUserId] = useState('');
  const [isReassignModalOpen, setIsReassignModalOpen] = useState(false);
  const [reassignHospitalId, setReassignHospitalId] = useState('');
  const [reassigningLink, setReassigningLink] = useState(null);

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
      const values = [
        hospital.Hospital_Name,
        hospital.Contact_Number,
        hospital.Region,
        hospital.City,
        hospital.Barangay,
        hospital.Street,
      ]
        .map((item) => normalizeText(item))
        .filter(Boolean);

      return values.some((value) => value.includes(query));
    });
  }, [hospitals, searchTerm]);

  const filteredHospitalApplications = useMemo(() => {
    const query = normalizeText(applicationSearchTerm);

    return hospitals
      .filter((hospital) => {
        const statusKey = getHospitalApprovalStatus(hospital);
        if (applicationStatusFilter === 'pending' && statusKey !== 'pending') return false;
        if (applicationStatusFilter === 'approved' && statusKey !== 'approved') return false;
        if (applicationStatusFilter === 'rejected' && statusKey !== 'rejected') return false;

        if (!query) return true;

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
          hospital.Review_Notes,
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
  }, [hospitals, applicationSearchTerm, applicationStatusFilter]);

  const hospitalsById = useMemo(() => {
    const map = new Map();
    hospitals.forEach((hospital) => {
      map.set(Number(hospital.Hospital_ID), hospital);
    });
    return map;
  }, [hospitals]);

  const hStaffUsersById = useMemo(() => {
    const map = new Map();
    hStaffUsers.forEach((user) => {
      map.set(Number(user.user_id), user);
    });
    return map;
  }, [hStaffUsers]);

  const assignedHospitalByUserId = useMemo(() => {
    const map = new Map();
    hospitalStaffLinks.forEach((link) => {
      map.set(Number(link.User_ID), Number(link.Hospital_ID));
    });
    return map;
  }, [hospitalStaffLinks]);

  const unassignedHStaffUsers = useMemo(
    () => hStaffUsers.filter((user) => !assignedHospitalByUserId.has(Number(user.user_id))),
    [hStaffUsers, assignedHospitalByUserId],
  );

  const assignedHStaffCount = useMemo(
    () => hStaffUsers.filter((user) => assignedHospitalByUserId.has(Number(user.user_id))).length,
    [hStaffUsers, assignedHospitalByUserId],
  );

  const detailsHospital = useMemo(
    () => (detailsHospitalId ? hospitalsById.get(Number(detailsHospitalId)) || null : null),
    [detailsHospitalId, hospitalsById],
  );

  const detailsHospitalStaffLinks = useMemo(
    () => hospitalStaffLinks.filter((link) => Number(link.Hospital_ID) === Number(detailsHospitalId)),
    [hospitalStaffLinks, detailsHospitalId],
  );

  const availableReassignHospitals = useMemo(() => {
    if (!reassigningLink) {
      return hospitals;
    }

    const currentHospitalId = Number(reassigningLink.Hospital_ID);
    return hospitals.filter((hospital) => Number(hospital.Hospital_ID) !== currentHospitalId);
  }, [hospitals, reassigningLink]);

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

      setHospitals(data || []);
    } catch (error) {
      setErrorMessage(error.message || 'Unable to load hospitals.');
    } finally {
      setIsLoadingHospitals(false);
    }
  }, []);

  const fetchHStaffUsers = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setHStaffUsers([]);
      return;
    }

    try {
      const { data, error } = await supabase
        .from(USERS_TABLE)
        .select(`
          user_id,
          email,
          role,
          is_active,
          user_details:user_details (
            first_name,
            middle_name,
            last_name,
            suffix
          )
        `)
        .order('email', { ascending: true });

      if (error) throw error;

      const hStaffList = (data || [])
        .filter((user) => isHStaffRole(user?.role))
        .sort((a, b) => getHStaffDisplayName(a).localeCompare(getHStaffDisplayName(b), 'en', { sensitivity: 'base' }));

      setHStaffUsers(hStaffList);
    } catch (error) {
      setErrorMessage(error.message || 'Unable to load available H-Representative users.');
    }
  }, []);

  const fetchHospitalStaffLinks = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setHospitalStaffLinks([]);
      return;
    }

    try {
      setIsLoadingAssignments(true);
      const { data, error } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .select('*')
        .order('Assigned_Date', { ascending: false });

      if (error) throw error;
      setHospitalStaffLinks(data || []);
    } catch (error) {
      setErrorMessage(error.message || 'Unable to load hospital staff assignments.');
    } finally {
      setIsLoadingAssignments(false);
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
    fetchHStaffUsers();
    fetchHospitalStaffLinks();
    loadRegions();
  }, [fetchHospitals, fetchHStaffUsers, fetchHospitalStaffLinks, loadRegions]);

  const openHospitalDetails = (hospital) => {
    setDetailsHospitalId(Number(hospital.Hospital_ID));
    setPanelAssignUserId('');
  };

  const closeHospitalDetails = () => {
    setDetailsHospitalId(null);
    setPanelAssignUserId('');
  };

  const refreshAssignmentData = async () => {
    await Promise.all([fetchHospitals(), fetchHStaffUsers(), fetchHospitalStaffLinks()]);
  };

  const resolveAdminUserId = useCallback(async () => {
    if (adminUserId) {
      return adminUserId;
    }

    if (!supabase) {
      return null;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData?.session?.user?.id) {
      return null;
    }

    const authUserId = sessionData.session.user.id;
    const profileResult = await supabase
      .from(USERS_TABLE)
      .select('user_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    const resolvedUserId = profileResult?.data?.user_id || null;
    if (resolvedUserId) {
      setAdminUserId(resolvedUserId);
    }
    return resolvedUserId;
  }, [adminUserId]);

  const ensureHospitalRepresentativeAssignment = useCallback(async (hospitalId, userId, assignedAt) => {
    const targetHospitalId = Number(hospitalId || 0);
    const targetUserId = Number(userId || 0);
    if (!targetHospitalId || !targetUserId) {
      throw new Error('Unable to assign H-Representative: missing Hospital_ID or User_ID.');
    }

    const existingLinkResult = await supabase
      .from(HOSPITAL_STAFF_TABLE)
      .select('Link_ID,Hospital_ID,User_ID')
      .eq('User_ID', targetUserId)
      .maybeSingle();

    if (existingLinkResult.error) {
      throw new Error(mapHospitalStaffError(existingLinkResult.error.message));
    }

    const existingLink = existingLinkResult.data || null;

    if (!existingLink?.Link_ID) {
      const insertResult = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .insert({
          Hospital_ID: targetHospitalId,
          User_ID: targetUserId,
          Assigned_Date: assignedAt,
        });
      if (insertResult.error) {
        throw new Error(mapHospitalStaffError(insertResult.error.message));
      }
      return;
    }

    if (Number(existingLink.Hospital_ID || 0) === targetHospitalId) {
      return;
    }

    const updateResult = await supabase
      .from(HOSPITAL_STAFF_TABLE)
      .update({
        Hospital_ID: targetHospitalId,
        Assigned_Date: assignedAt,
      })
      .eq('Link_ID', existingLink.Link_ID);

    if (updateResult.error) {
      throw new Error(mapHospitalStaffError(updateResult.error.message));
    }
  }, []);

const sendHospitalRepresentativeInvite = useCallback(async ({
    hospital,
    applicantUser,
    reviewedAt,
  }) => {
    const adminInviteClient = createHospitalInviteAdminClient();
    if (!adminInviteClient) {
      throw new Error(mapHospitalInviteError('missing-service-role'));
    }

    const email = String(applicantUser?.email || hospital?.Hospital_Head_Email || '').trim().toLowerCase();
    if (!email) {
      throw new Error('H-Representative email is missing. Please ensure applicant email exists before approval.');
    }

    const details = Array.isArray(applicantUser?.user_details)
      ? applicantUser.user_details[0]
      : applicantUser?.user_details || null;
    const fullName = [
      details?.first_name,
      details?.middle_name,
      details?.last_name,
      details?.suffix,
    ].map((part) => String(part || '').trim()).filter(Boolean).join(' ') || String(hospital?.Hospital_Head_Name || '').trim();

    const temporaryPassword = buildTemporaryPassword();
    const accountLabel = 'Hospital';
    const accountValue = String(hospital?.Hospital_Name || `Hospital #${hospital?.Hospital_ID || 'N/A'}`).trim();
    const metadata = {
      account_type: 'partner_hospital',
      decision: 'approved',
      role_label: 'H-Representative',
      account_label: accountLabel,
      account_value: accountValue,
      recipient_email: email,
      recipient_name: fullName || '',
      review_notes: '',
      has_access_window: false,
      access_window: '',
      temporary_password: temporaryPassword,
      display_name: fullName || '',
      full_name: fullName || '',
      name: fullName || '',
      hospital_id: Number(hospital?.Hospital_ID || 0) || null,
      hospital_name: String(hospital?.Hospital_Name || '').trim(),
      approved_at: reviewedAt,
    };

    let authUserId = String(applicantUser?.auth_user_id || '').trim() || null;
    if (authUserId) {
      const updateAuthResult = await adminInviteClient.auth.admin.updateUserById(authUserId, {
        email_confirm: true,
        password: temporaryPassword,
        user_metadata: {
          role: 'h_representative',
          hospital_id: Number(hospital?.Hospital_ID || 0) || null,
          account_type: 'partner_hospital',
        },
      });

      if (updateAuthResult.error) {
        throw new Error(mapHospitalInviteError(updateAuthResult.error.message));
      }
    }

    const invitePayload = {
      redirectTo: `${window.location.origin}/complete-account`,
      data: metadata,
    };

    const isAlreadyRegisteredError = (errorMessage = '') => {
      const lower = String(errorMessage || '').toLowerCase();
      return lower.includes('already registered')
        || lower.includes('already been registered')
        || lower.includes('user already exists');
    };

    const findAuthUserIdByEmail = async (targetEmail) => {
      let page = 1;
      const perPage = 200;
      while (page <= 50) {
        const listResult = await adminInviteClient.auth.admin.listUsers({ page, perPage });
        if (listResult.error) {
          throw new Error(mapHospitalInviteError(listResult.error.message));
        }

        const users = Array.isArray(listResult.data?.users) ? listResult.data.users : [];
        if (users.length === 0) break;

        const match = users.find((item) => String(item?.email || '').trim().toLowerCase() === targetEmail);
        if (match?.id) {
          return String(match.id).trim();
        }

        if (users.length < perPage) break;
        page += 1;
      }
      return null;
    };

    let inviteResult = await adminInviteClient.auth.admin.inviteUserByEmail(email, invitePayload);
    if (inviteResult.error && isAlreadyRegisteredError(inviteResult.error.message)) {
      const existingAuthUserId = authUserId || await findAuthUserIdByEmail(email);
      if (existingAuthUserId) {
        const deleteResult = await adminInviteClient.auth.admin.deleteUser(existingAuthUserId);
        if (deleteResult.error) {
          throw new Error(mapHospitalInviteError(deleteResult.error.message));
        }
      }
      authUserId = null;
      inviteResult = await adminInviteClient.auth.admin.inviteUserByEmail(email, invitePayload);
    }

    if (inviteResult.error) {
      throw new Error(mapHospitalInviteError(inviteResult.error.message));
    }

    const invitedAuthUserId = String(inviteResult.data?.user?.id || '').trim() || null;
    if (invitedAuthUserId) {
      authUserId = invitedAuthUserId;
    }

    if (!authUserId) {
      throw new Error('Invite email was sent but auth user id could not be resolved.');
    }

    const updateAuthResult = await adminInviteClient.auth.admin.updateUserById(authUserId, {
      email_confirm: true,
      password: temporaryPassword,
      user_metadata: {
        role: 'h_representative',
        hospital_id: Number(hospital?.Hospital_ID || 0) || null,
        account_type: 'partner_hospital',
      },
    });

    if (updateAuthResult.error) {
      throw new Error(mapHospitalInviteError(updateAuthResult.error.message));
    }

    return {
      authUserId,
      inviteMode: 'invite',
    };
  }, []);

  const provisionApprovedHospitalAccount = useCallback(async (hospital, reviewedAt) => {
    const hospitalId = Number(hospital?.Hospital_ID || 0);
    if (!hospitalId) {
      throw new Error('Hospital approval provisioning failed: missing Hospital_ID.');
    }

    const applicantUserId = Number(hospital?.Created_By || 0);
    if (!applicantUserId) {
      throw new Error('Hospital approval provisioning failed: Created_By is missing.');
    }

    const applicantUserResult = await supabase
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
          suffix
        )
      `)
      .eq('user_id', applicantUserId)
      .maybeSingle();

    if (applicantUserResult.error) {
      throw new Error(applicantUserResult.error.message || 'Unable to resolve H-Representative applicant user.');
    }

    const applicantUser = applicantUserResult.data || null;
    if (!applicantUser?.user_id) {
      throw new Error('Hospital approval provisioning failed: applicant user record was not found.');
    }

    await ensureHospitalRepresentativeAssignment(hospitalId, applicantUser.user_id, reviewedAt);

    const currentRoleKey = normalizeRoleSlug(applicantUser.role);
    const shouldSetRepresentativeRole = [
      '',
      'user',
      'partner',
      'hospital',
      'hstaff',
      'hrepresentative',
      'hospitalrepresentative',
    ].includes(currentRoleKey);

    const userUpdatePayload = {
      is_active: true,
      updated_at: reviewedAt,
    };
    if (shouldSetRepresentativeRole && currentRoleKey !== 'hrepresentative') {
      userUpdatePayload.role = 'h_representative';
    }

    const baseUserUpdateResult = await supabase
      .from(USERS_TABLE)
      .update(userUpdatePayload)
      .eq('user_id', applicantUser.user_id);

    if (baseUserUpdateResult.error) {
      throw new Error(baseUserUpdateResult.error.message || 'Unable to activate approved H-Representative account.');
    }

    const inviteOutcome = await sendHospitalRepresentativeInvite({
      hospital,
      applicantUser,
      reviewedAt,
    });

    if (!applicantUser.auth_user_id && inviteOutcome?.authUserId) {
      const authLinkUpdateResult = await supabase
        .from(USERS_TABLE)
        .update({
          auth_user_id: inviteOutcome.authUserId,
          updated_at: reviewedAt,
        })
        .eq('user_id', applicantUser.user_id);

      if (authLinkUpdateResult.error) {
        throw new Error(authLinkUpdateResult.error.message || 'Unable to link auth_user_id after invite.');
      }
    }

    return inviteOutcome;
  }, [ensureHospitalRepresentativeAssignment, sendHospitalRepresentativeInvite]);

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

    setDecisionReviewNotes(nextStatus === 'Rejected' ? String(hospital?.Review_Notes || '').trim() : '');
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
    let reviewNotes = null;
    if (nextStatus === 'Rejected') {
      reviewNotes = String(decisionReviewNotes || '').trim();
      if (!reviewNotes) {
        setErrorMessage('Rejection reason is required.');
        return;
      }
    }

    if (nextStatus === 'Approved' && !createHospitalInviteAdminClient()) {
      setErrorMessage(mapHospitalInviteError('missing-service-role'));
      return;
    }

    try {
      setApplicationActionHospitalId(hospitalId);
      const reviewerUserId = await resolveAdminUserId();
      const reviewedAt = getPhilippineTimestamp();

      const updatePayload = {
        Approval_Status: nextStatus,
        Is_Approved: nextStatus === 'Approved',
        Review_Notes: nextStatus === 'Rejected' ? reviewNotes : null,
        Approved_At: reviewedAt,
        Approved_By: reviewerUserId,
        Updated_At: reviewedAt,
      };

      const result = await supabase
        .from(HOSPITALS_TABLE)
        .update(updatePayload)
        .eq('Hospital_ID', hospitalId)
        .select('*')
        .single();

      if (result.error) throw result.error;

      const updatedHospital = result.data;
      setHospitals((currentRows) => currentRows.map((row) => (
        Number(row.Hospital_ID) === hospitalId ? updatedHospital : row
      )));

      let inviteNote = '';
      if (nextStatus === 'Approved') {
        await provisionApprovedHospitalAccount(updatedHospital, reviewedAt);
        await Promise.all([fetchHospitalStaffLinks(), fetchHStaffUsers()]);
        inviteNote = ' H-Representative was assigned and invite email with credentials was sent.';
      }

      setSuccessMessage(`Hospital application ${statusVerb} successfully.${inviteNote}`);
      setDecisionTarget(null);
      setDecisionReviewNotes('');
    } catch (error) {
      setErrorMessage(error.message || `Unable to ${statusVerb} hospital application.`);
    } finally {
      setApplicationActionHospitalId(null);
    }
  };

  const assignHStaffToHospital = async (hospitalIdValue, userIdValue) => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const hospitalId = Number(hospitalIdValue);
    const userId = Number(userIdValue);

    if (!hospitalId || !userId) {
      setErrorMessage('Please select both a hospital and an H-Representative user.');
      return;
    }

    const existingUserLink = hospitalStaffLinks.find((link) => Number(link.User_ID) === userId);
    if (existingUserLink) {
      const linkedHospital = hospitalsById.get(Number(existingUserLink.Hospital_ID));
      if (Number(existingUserLink.Hospital_ID) === hospitalId) {
        setErrorMessage('This H-Representative is already assigned to the selected hospital.');
      } else {
        setErrorMessage(`This H-Representative is already assigned to ${linkedHospital?.Hospital_Name || 'another hospital'}.`);
      }
      return;
    }

    try {
      setIsSavingAssignment(true);
      const { error } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .insert({
          Hospital_ID: hospitalId,
          User_ID: userId,
        });

      if (error) throw error;

      setSuccessMessage('H-Representative assigned to hospital successfully.');
      setAssignmentUserId('');
      setPanelAssignUserId('');
      await fetchHospitalStaffLinks();
    } catch (error) {
      setErrorMessage(mapHospitalStaffError(error.message));
    } finally {
      setIsSavingAssignment(false);
    }
  };

  const removeHospitalStaffLink = async (link) => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const linkId = Number(link?.Link_ID);
    if (!linkId) {
      setErrorMessage('Invalid assignment link selected.');
      return;
    }

    try {
      setRemovingLinkId(linkId);
      const { error } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .delete()
        .eq('Link_ID', linkId);

      if (error) throw error;

      setSuccessMessage('H-Representative assignment removed successfully.');
      await fetchHospitalStaffLinks();
    } catch (error) {
      setErrorMessage(mapHospitalStaffError(error.message));
    } finally {
      setRemovingLinkId(null);
    }
  };

  const openReassignModal = (link) => {
    if (!link?.Link_ID) {
      setErrorMessage('Invalid assignment link selected.');
      return;
    }

    setReassigningLink(link);
    setReassignHospitalId('');
    setIsReassignModalOpen(true);
  };

  const closeReassignModal = () => {
    if (isReassigning) {
      return;
    }

    setIsReassignModalOpen(false);
    setReassignHospitalId('');
    setReassigningLink(null);
  };

  const handleReassignStaff = async () => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    const linkId = Number(reassigningLink?.Link_ID);
    const currentHospitalId = Number(reassigningLink?.Hospital_ID);
    const nextHospitalId = Number(reassignHospitalId);

    if (!linkId) {
      setErrorMessage('Invalid assignment link selected.');
      return;
    }

    if (!nextHospitalId) {
      setErrorMessage('Please choose a hospital for reassignment.');
      return;
    }

    if (currentHospitalId === nextHospitalId) {
      setErrorMessage('Please choose a different hospital for reassignment.');
      return;
    }

    try {
      setIsReassigning(true);
      const { error } = await supabase
        .from(HOSPITAL_STAFF_TABLE)
        .update({
          Hospital_ID: nextHospitalId,
          Assigned_Date: new Date().toISOString(),
        })
        .eq('Link_ID', linkId);

      if (error) throw error;

      setSuccessMessage('H-Representative reassigned successfully.');
      setIsReassignModalOpen(false);
      setReassignHospitalId('');
      setReassigningLink(null);
      await fetchHospitalStaffLinks();
    } catch (error) {
      setErrorMessage(mapHospitalStaffError(error.message));
    } finally {
      setIsReassigning(false);
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
      await fetchHospitalStaffLinks();

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
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Manage H-Representative Accounts</h1>
          <p className="text-sm text-gray-600 mt-1">
            Add and maintain hospital records used by H-Representative, patients, and wig request routing.
          </p>
        </div>

        {activeTab !== 'applications' && (
          <button
            type="button"
            onClick={() => {
              resetForm();
              setIsModalOpen(true);
            }}
            className="text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors shadow-sm"
            style={{ backgroundColor: theme.primaryColor }}
          >
            <Plus size={18} />
            Add H-Representative
          </button>
        )}
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
                      <td className="px-4 py-3 text-gray-700 text-center">{formatDateTime(hospital.Updated_At || hospital.Created_At)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => openHospitalDetails(hospital)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                            title="View hospital details"
                          >
                            <Info size={13} /> Info
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
                placeholder="Search by hospital, head/owner, email, contact, location, or notes"
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
                    <th className="px-4 py-3 text-left font-semibold">Review Notes</th>
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

                    return (
                      <tr key={hospital.Hospital_ID} className="border-t border-gray-200 align-top">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-gray-900">{hospital.Hospital_Name || 'N/A'}</p>
                          <p className="mt-1 text-xs text-gray-500">ID: {hospital.Hospital_ID}</p>
                          <p className="mt-2 text-xs text-gray-600">
                            {[hospital.Street, hospital.Barangay, hospital.City, hospital.Province, hospital.Region, hospital.Country]
                              .filter(Boolean)
                              .join(', ') || 'No address provided'}
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
                        <td className="px-4 py-3 text-gray-700">
                          <p className="text-xs leading-relaxed text-gray-600">
                            {hospital.Review_Notes || 'No review notes yet.'}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleHospitalApplicationDecision(hospital, 'Approved')}
                              disabled={isProcessing || isApproved}
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                            >
                              {isProcessing ? <Loader2 className="animate-spin" size={13} /> : <CheckCircle2 size={13} />}
                              Approve
                            </button>

                            <button
                              type="button"
                              onClick={() => handleHospitalApplicationDecision(hospital, 'Rejected')}
                              disabled={isProcessing || isRejected}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                            >
                              {isProcessing ? <Loader2 className="animate-spin" size={13} /> : <X size={13} />}
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

      {activeTab === 'assign' && (
        <section className={cardClass()}>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">Assign H-Representative To H-Representative</h3>
              <p className="text-xs text-gray-500 mt-1">
                Source: public.users with linked public.user_details. Role accepted: H-Representative or hospital.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Available: {unassignedHStaffUsers.length} | Assigned: {assignedHStaffCount} | Total H-Representative: {hStaffUsers.length}
              </p>
            </div>

            <button
              type="button"
              onClick={refreshAssignmentData}
              disabled={isLoadingHospitals || isLoadingAssignments || isSavingAssignment}
              className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-60"
              style={{
                borderColor: `${theme.primaryColor}33`,
                backgroundColor: `${theme.primaryColor}12`,
                color: theme.primaryColor,
              }}
            >
              <RefreshCw size={14} /> Refresh H-Representative Data
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">H-Representative</label>
              <select
                value={assignmentHospitalId}
                onChange={(event) => setAssignmentHospitalId(event.target.value)}
                disabled={hospitals.length === 0}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                style={{ '--tw-ring-color': theme.primaryColor }}
              >
                <option value="">{hospitals.length === 0 ? 'No hospitals available' : 'Select hospital'}</option>
                {hospitals.map((hospital) => (
                  <option key={hospital.Hospital_ID} value={hospital.Hospital_ID}>
                    {hospital.Hospital_Name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">H-Representative</label>
              <select
                value={assignmentUserId}
                onChange={(event) => setAssignmentUserId(event.target.value)}
                disabled={unassignedHStaffUsers.length === 0}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white focus:ring-2 outline-none"
                style={{ '--tw-ring-color': theme.primaryColor }}
              >
                <option value="">
                  {hStaffUsers.length === 0
                    ? 'No H-Representative users found in users/user_details'
                    : unassignedHStaffUsers.length === 0
                      ? 'All H-Representative users are already assigned'
                      : 'Select H-Representative'}
                </option>
                {unassignedHStaffUsers.map((user) => (
                  <option key={user.user_id} value={user.user_id}>
                    {getHStaffDisplayName(user)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => assignHStaffToHospital(assignmentHospitalId, assignmentUserId)}
                disabled={
                  isSavingAssignment
                  || !assignmentHospitalId
                  || !assignmentUserId
                  || hospitals.length === 0
                  || unassignedHStaffUsers.length === 0
                }
                className="w-full rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: theme.primaryColor }}
              >
                {isSavingAssignment ? 'Assigning...' : 'Assign H-Representative'}
              </button>
            </div>
          </div>

          {hStaffUsers.length === 0 && (
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              No H-Representative users were found. Check public.users.role values and ensure matching records exist in public.user_details.
            </div>
          )}

          {isLoadingAssignments ? (
            <div className="py-10 text-gray-700 flex items-center justify-center gap-2">
              <Loader2 className="animate-spin" size={18} /> Loading assignments...
            </div>
          ) : hospitalStaffLinks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
              No H-Representative assignments yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-sm" style={{ backgroundColor: `${theme.primaryColor}20`, color: tableHeaderTextColor }}>
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">H-Representative</th>
                    <th className="px-4 py-3 text-left font-semibold">H-Representative</th>
                    <th className="px-4 py-3 text-left font-semibold">Assigned Date</th>
                    <th className="px-4 py-3 text-center font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {hospitalStaffLinks.map((link) => {
                    const linkedHospital = hospitalsById.get(Number(link.Hospital_ID));
                    const linkedUser = hStaffUsersById.get(Number(link.User_ID));

                    return (
                      <tr key={link.Link_ID} className="border-t border-gray-200">
                        <td className="px-4 py-3 text-gray-800">{linkedHospital?.Hospital_Name || `H-Representative #${link.Hospital_ID}`}</td>
                        <td className="px-4 py-3 text-gray-700">{getHStaffDisplayName(linkedUser)}</td>
                        <td className="px-4 py-3 text-gray-700">{formatDateTime(link.Assigned_Date)}</td>
                        <td className="px-4 py-3 text-center">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openReassignModal(link)}
                              disabled={isReassigning || hospitals.length < 2}
                              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-60"
                            >
                              <ArrowRightLeft size={12} />
                              Reassign
                            </button>

                            <button
                              type="button"
                              onClick={() => removeHospitalStaffLink(link)}
                              disabled={removingLinkId === link.Link_ID}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                            >
                              {removingLinkId === link.Link_ID ? <Loader2 className="animate-spin" size={12} /> : <Trash2 size={12} />}
                              Unassign
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

      {isReassignModalOpen && reassigningLink && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[110] bg-black bg-opacity-50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-2xl border border-gray-200">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Reassign H-Representative</h3>
                <p className="mt-1 text-xs text-gray-500">Move this staff member to a different hospital.</p>
              </div>
              <button
                type="button"
                onClick={closeReassignModal}
                disabled={isReassigning}
                className="text-gray-400 hover:text-red-500 disabled:opacity-60"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-3 px-5 py-4">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                <p className="font-medium text-gray-900">{getHStaffDisplayName(hStaffUsersById.get(Number(reassigningLink.User_ID)))}</p>
                <p className="mt-1 text-xs text-gray-500">
                  Current hospital: {hospitalsById.get(Number(reassigningLink.Hospital_ID))?.Hospital_Name || `H-Representative #${reassigningLink.Hospital_ID}`}
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">New hospital</label>
                <select
                  value={reassignHospitalId}
                  onChange={(event) => setReassignHospitalId(event.target.value)}
                  disabled={availableReassignHospitals.length === 0 || isReassigning}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 focus:ring-2 outline-none disabled:bg-gray-50 disabled:text-gray-500"
                  style={{ '--tw-ring-color': theme.primaryColor }}
                >
                  <option value="">
                    {availableReassignHospitals.length === 0 ? 'No other hospital available' : 'Select target hospital'}
                  </option>
                  {availableReassignHospitals.map((hospital) => (
                    <option key={hospital.Hospital_ID} value={hospital.Hospital_ID}>
                      {hospital.Hospital_Name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
              <button
                type="button"
                onClick={closeReassignModal}
                disabled={isReassigning}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReassignStaff}
                disabled={
                  isReassigning
                  || !reassignHospitalId
                  || availableReassignHospitals.length === 0
                }
                className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: theme.primaryColor }}
              >
                {isReassigning ? <Loader2 className="animate-spin" size={14} /> : <ArrowRightLeft size={14} />}
                {isReassigning ? 'Reassigning...' : 'Confirm Reassign'}
              </button>
            </div>
          </div>
        </div>,
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
                        ? 'Approving will activate this hospital and allow assignment of an H-Representative.'
                        : 'Rejecting will mark this application as rejected. The applicant can submit a new application if needed.'}
                    </span>
                  </div>

                  {!isApproving && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600">
                        Rejection Reason <span className="text-rose-600">*</span>
                      </span>
                      <textarea
                        value={decisionReviewNotes}
                        onChange={(event) => setDecisionReviewNotes(event.target.value)}
                        rows={4}
                        disabled={isSubmitting}
                        placeholder="Explain why this application cannot be approved. The applicant will see this reason."
                        className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900 outline-none transition focus:border-rose-400 focus:ring-2 focus:ring-rose-100 disabled:bg-slate-50"
                        autoFocus
                      />
                      <span className="text-[11px] text-slate-500">Required. Be specific so the applicant understands what to address.</span>
                    </label>
                  )}
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
                    disabled={isSubmitting || (!isApproving && !decisionReviewNotes.trim())}
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

      {detailsHospital && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[95]">
              <button
                type="button"
                aria-label="Close hospital details panel"
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={closeHospitalDetails}
              />

              <aside
                className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l bg-white shadow-2xl"
                style={{
                  animation: 'manageHospitalInfoSlideIn 0.25s ease-out',
                  borderColor: `${theme.secondaryColor}35`,
                  backgroundColor: '#ffffff',
                  opacity: 1,
                  backdropFilter: 'none',
                  color: primaryTextColor,
                  fontFamily: `${bodyFont}, sans-serif`,
                }}
              >
                <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-gray-200 bg-white px-5 py-4">
                  <div>
                    <h3 className="text-lg font-semibold" style={{ color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` }}>
                      H-Representative Details
                    </h3>
                    <p className="mt-0.5 text-xs" style={{ color: secondaryTextColor }}>
                      View and manage assigned H-Representative.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={closeHospitalDetails}
                    aria-label="Close hospital details panel"
                    className="rounded-md border p-1"
                    style={{ borderColor: `${theme.secondaryColor}44`, color: secondaryTextColor }}
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="space-y-4 p-5">
                  <div className="rounded-xl border bg-slate-50 p-4" style={{ borderColor: `${theme.secondaryColor}30` }}>
            <div className="flex items-start gap-3">
              {resolveHospitalLogoUrl(detailsHospital.Hospital_Logo) ? (
                <img
                  src={resolveHospitalLogoUrl(detailsHospital.Hospital_Logo)}
                  alt="H-Representative logo"
                  className="h-14 w-14 rounded-lg border object-cover bg-white"
                  style={{ borderColor: `${theme.secondaryColor}30` }}
                />
              ) : (
                <div className="h-14 w-14 rounded-lg border bg-white flex items-center justify-center" style={{ borderColor: `${theme.secondaryColor}30`, color: secondaryTextColor }}>
                  <Building2 size={20} />
                </div>
              )}

              <div className="min-w-0">
                <p className="text-sm font-semibold break-words" style={{ color: primaryTextColor }}>{detailsHospital.Hospital_Name || 'N/A'}</p>
                <p className="mt-1 text-xs" style={{ color: secondaryTextColor }}>H-Representative ID: {detailsHospital.Hospital_ID}</p>
                <p className="mt-2 text-xs" style={{ color: secondaryTextColor }}>Contact: {detailsHospital.Contact_Number || 'N/A'}</p>
              </div>
            </div>

            <p className="mt-3 text-xs leading-relaxed" style={{ color: secondaryTextColor }}>
              {[detailsHospital.Street, detailsHospital.Barangay, detailsHospital.City, detailsHospital.Region, detailsHospital.Country]
                .filter(Boolean)
                .join(', ') || 'No address on record.'}
            </p>
                  </div>

                  <div className="rounded-xl border p-4" style={{ borderColor: `${theme.secondaryColor}30` }}>
            <p className="mb-3 text-sm font-semibold" style={{ color: primaryTextColor }}>Quick Assign H-Representative</p>
            <div className="space-y-2">
              <select
                value={panelAssignUserId}
                onChange={(event) => setPanelAssignUserId(event.target.value)}
                disabled={unassignedHStaffUsers.length === 0}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-sm focus:ring-2 outline-none"
                style={{ '--tw-ring-color': theme.primaryColor, color: primaryTextColor }}
              >
                <option value="">
                  {hStaffUsers.length === 0
                    ? 'No H-Representative users found in users/user_details'
                    : unassignedHStaffUsers.length === 0
                      ? 'All H-Representative users are already assigned'
                      : 'Select unassigned H-Representative'}
                </option>
                {unassignedHStaffUsers.map((user) => (
                  <option key={user.user_id} value={user.user_id}>
                    {getHStaffDisplayName(user)}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => assignHStaffToHospital(detailsHospital.Hospital_ID, panelAssignUserId)}
                disabled={isSavingAssignment || !panelAssignUserId || unassignedHStaffUsers.length === 0}
                className="w-full rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: theme.primaryColor }}
              >
                {isSavingAssignment ? 'Assigning...' : 'Assign To This H-Representative'}
              </button>
            </div>
                  </div>

                  <div className="rounded-xl border p-4" style={{ borderColor: `${theme.secondaryColor}30` }}>
            <p className="mb-3 text-sm font-semibold" style={{ color: primaryTextColor }}>Assigned H-Representative</p>

            {detailsHospitalStaffLinks.length === 0 ? (
              <p className="text-sm" style={{ color: secondaryTextColor }}>No H-Representative assigned yet.</p>
            ) : (
              <div className="space-y-2">
                {detailsHospitalStaffLinks.map((link) => {
                  const linkedUser = hStaffUsersById.get(Number(link.User_ID));

                  return (
                    <div key={link.Link_ID} className="rounded-lg border bg-gray-50 px-3 py-2" style={{ borderColor: `${theme.secondaryColor}30` }}>
                      <p className="text-sm font-medium break-words" style={{ color: primaryTextColor }}>
                        {getHStaffDisplayName(linkedUser)}
                      </p>
                      <p className="mt-1 text-xs" style={{ color: secondaryTextColor }}>Assigned: {formatDateTime(link.Assigned_Date)}</p>

                      <button
                        type="button"
                        onClick={() => removeHospitalStaffLink(link)}
                        disabled={removingLinkId === link.Link_ID}
                        className="mt-2 inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                      >
                        {removingLinkId === link.Link_ID ? <Loader2 className="animate-spin" size={11} /> : <Trash2 size={11} />}
                        Unassign
                      </button>

                      <button
                        type="button"
                        onClick={() => openReassignModal(link)}
                        disabled={isReassigning || hospitals.length < 2}
                        className="mt-2 ml-2 inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-60"
                      >
                        <ArrowRightLeft size={11} />
                        Reassign
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
                  </div>
                </div>
              </aside>

              <style>{`
                @keyframes manageHospitalInfoSlideIn {
                  from {
                    transform: translateX(100%);
                  }
                  to {
                    transform: translateX(0);
                  }
                }
              `}</style>
            </div>,
            document.body,
          )
        : null}

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

