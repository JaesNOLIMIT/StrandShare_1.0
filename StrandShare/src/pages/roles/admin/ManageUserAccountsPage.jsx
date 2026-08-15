import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@supabase/supabase-js';
import {
  Plus,
  Search,
  Info,
  Shield,
  X,
  Calendar,
  Loader2,
  Mail,
  CheckCircle,
  AlertTriangle,
  Power,
} from 'lucide-react';
import Select from 'react-select';
import { useTheme } from '../../../context/ThemeContext';
import philippineAddressOptions from '../../../data/philippineAddressOptions.json';
import {
  supabase,
  isSupabaseConfigured,
} from '../../../lib/supabaseClient';
import { toCanonicalRole, toRoleLabel } from '../../../lib/roleUtils';
import UserAccountDetailsModal from './UserAccountDetailsModal';

const DEFAULT_ROLES = ['admin', 'staff', 'specialist', 'h_representative'];
const ADMIN_CREATABLE_ROLES = ['staff', 'specialist'];
const PHILIPPINE_TIME_ZONE = 'Asia/Manila';
let manageUsersInviteAdminClient = null;

function mapInviteErrorMessage(rawMessage) {
  const message = String(rawMessage || 'Unexpected error while sending invitation email.');
  const lower = message.toLowerCase();

  if (!message || lower.includes('missing-service-role')) {
    return 'Invite email service is not configured. Add REACT_APP_SUPABASE_SERVICE_ROLE_KEY in .env.local and restart the app.';
  }

  if (
    message.includes('after 25 seconds') ||
    message.includes('after 60 seconds') ||
    message.includes('For security purposes')
  ) {
    return 'Rate limit reached. Please wait around 60 seconds before sending another invitation.';
  }

  if (message.includes('User already registered')) {
    return 'This email already exists in Auth. Use a different email address.';
  }

  if (message.includes('Invalid email')) {
    return 'Please enter a valid email address.';
  }

  if (message.includes('Error sending confirmation email')) {
    return 'Supabase could not send the confirmation email. Check Auth > Email settings (SMTP/provider) and make sure your Site URL/Redirect URLs are configured.';
  }

  return message;
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function toDateTimeLocalValue(value) {
  if (!value) return '';
  const normalized = String(value).trim().replace(' ', 'T');
  return normalized.length >= 16 ? normalized.slice(0, 16) : '';
}

function normalizeRoleSlug(roleValue) {
  return String(roleValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildTemporaryPassword() {
  const numeric = Math.floor(100000 + (Math.random() * 900000));
  return `Strand-${numeric}!Aa`;
}

function formatPhilippineContactNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';

  let local = digits;

  if (local.startsWith('63')) local = local.slice(2);
  if (local.startsWith('0')) local = local.slice(1);
  local = local.slice(0, 10);

  const part1 = local.slice(0, 3);
  const part2 = local.slice(3, 6);
  const part3 = local.slice(6, 10);

  let formatted = '+63';
  if (part1) formatted += ` ${part1}`;
  if (part2) formatted += ` ${part2}`;
  if (part3) formatted += ` ${part3}`;
  return formatted.trim();
}

function isValidPhilippineContactNumber(value) {
  return /^\+63 9\d{2} \d{3} \d{4}$/.test(String(value || '').trim());
}

function getPhilippineSqlTimestamp(date = new Date()) {
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
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

function getPhilippineDateString(date = new Date()) {
  return getPhilippineSqlTimestamp(date).slice(0, 10);
}

function toPhilippineSqlTimestampOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const dateTimeMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:(\d{2}))?$/);
  if (dateTimeMatch) {
    const seconds = dateTimeMatch[7] || '00';
    return `${dateTimeMatch[1]}-${dateTimeMatch[2]}-${dateTimeMatch[3]} ${dateTimeMatch[4]}:${dateTimeMatch[5]}:${seconds}`;
  }

  const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} 00:00:00`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return getPhilippineSqlTimestamp(parsed);
}

function toPhilippineDateOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return getPhilippineDateString(parsed);
}

function buildDisplayName({ firstName, middleName, lastName, suffix }) {
  return [firstName, middleName, lastName, suffix]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createManageUsersInviteAdminClient() {
  if (manageUsersInviteAdminClient) {
    return manageUsersInviteAdminClient;
  }

  const url = process.env.REACT_APP_SUPABASE_URL;
  const serviceRoleKey = process.env.REACT_APP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return null;
  }

  manageUsersInviteAdminClient = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'Donivra-manage-users-invite-admin-client',
    },
  });

  return manageUsersInviteAdminClient;
}

function getInitialFormData() {
  return {
    firstName: '',
    middleName: '',
    lastName: '',
    suffix: '',
    birthdate: '',
    gender: '',
    contactNumber: '',
    street: '',
    region: '',
    barangay: '',
    city: '',
    province: '',
    country: 'Philippines',
    email: '',
    role: 'staff',
    accessStart: '',
    accessEnd: '',
  };
}

export default function ManageUserAccountsPage() {
  const { theme } = useTheme();
  const tableHeaderTextColor = theme?.primaryTextColor || '#000000';
  const [users, setUsers] = useState([]);
  const [allRoles, setAllRoles] = useState([]);
  const [roleFilter, setRoleFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState([]);
  const [loading, setLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [invitedEmail, setInvitedEmail] = useState('');
  const [invitedRoleLabel, setInvitedRoleLabel] = useState('');
  const [invitedDisplayName, setInvitedDisplayName] = useState('');
  const [temporaryPasswordIssued, setTemporaryPasswordIssued] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [detailsUserId, setDetailsUserId] = useState(null);
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [isSavingDetails, setIsSavingDetails] = useState(false);
  const [togglingUserId, setTogglingUserId] = useState(null);
  const [detailsNotice, setDetailsNotice] = useState({ kind: '', text: '' });
  const [detailsForm, setDetailsForm] = useState(getInitialFormData());

  const [formData, setFormData] = useState(getInitialFormData());

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Please set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      setShowErrorModal(true);
      setLoading(false);
      return;
    }

    fetchUsers();
    fetchAllRoles();

    const subscription = supabase
      .channel('public:users-hospital')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, () => {
        fetchUsers();
      })
      .subscribe();
    const fallbackInterval = window.setInterval(() => {
      void fetchUsers();
    }, 30000);

    return () => {
      window.clearInterval(fallbackInterval);
      void supabase.removeChannel(subscription);
    };
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('users')
        .select(`
          user_id, email, role, access_start, access_end, is_active, created_at, updated_at,
          user_details:user_details (
            photo_path, first_name, middle_name, last_name, suffix, birthdate, gender,
            street, region, barangay, city, province, country, contact_number, joined_date
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const formattedData = (data || []).map((user) => {
        const details = Array.isArray(user.user_details) ? user.user_details[0] : user.user_details;
        const canonicalRole = toCanonicalRole(user.role);
        return {
          id: user.user_id,
          email: user.email,
          role: canonicalRole || 'N/A',
          accessStart: formatDateTime(user.access_start),
          accessEnd: formatDateTime(user.access_end),
          rawAccessStart: user.access_start || '',
          rawAccessEnd: user.access_end || '',
          createdAt: user.created_at || '',
          updatedAt: user.updated_at || '',
          status: user.is_active ? 'Active' : 'Inactive',
          firstName: details?.first_name || 'N/A',
          lastName: details?.last_name || '',
          joinedDate: details?.joined_date || user.created_at || '',
          details: details || {},
        };
      });

      setUsers(formattedData);
    } catch (error) {
      setErrorMessage(error.message || 'Error fetching users.');
      setShowErrorModal(true);
    } finally {
      setLoading(false);
    }
  };

  const fetchAllRoles = async () => {
    const { data, error } = await supabase.from('users').select('role');

    if (!error && data) {
      const uniqueRoles = Array.from(
        new Set(
          data
            .map((u) => toCanonicalRole(u.role))
            .filter((role) => DEFAULT_ROLES.includes(role)),
        ),
      );
      setAllRoles(uniqueRoles.length > 0 ? uniqueRoles : DEFAULT_ROLES);
    } else {
      setAllRoles(DEFAULT_ROLES);
    }
  };

  const handleInviteUser = async (e) => {
    e.preventDefault();
    setSaving(true);

    let createdPublicUserId = null;
    let createdAuthUserId = null;

    try {
      const normalizedEmail = formData.email.toLowerCase().trim();
      const requestedRole = toCanonicalRole(formData.role) || '';
      const requestedRoleSlug = normalizeRoleSlug(requestedRole);
      const normalizedRole = requestedRoleSlug === 'specialist' ? 'specialist' : 'staff';
      const accessStart = toPhilippineSqlTimestampOrNull(formData.accessStart);
      const accessEnd = toPhilippineSqlTimestampOrNull(formData.accessEnd);
      const birthdate = toPhilippineDateOrNull(formData.birthdate);
      const joinedDate = getPhilippineDateString();
      const nowSql = getPhilippineSqlTimestamp();
      const displayName = buildDisplayName({
        firstName: formData.firstName,
        middleName: formData.middleName,
        lastName: formData.lastName,
        suffix: formData.suffix,
      });

      if (!normalizedEmail) {
        throw new Error('Email is required.');
      }

      if (!ADMIN_CREATABLE_ROLES.includes(normalizedRole)) {
        throw new Error('Only Staff and Specialist roles are allowed for Add User.');
      }

      if (!String(formData.firstName || '').trim() || !String(formData.lastName || '').trim()) {
        throw new Error('First Name and Last Name are required.');
      }

      if (!birthdate) {
        throw new Error('Birthdate is required.');
      }

      if (!String(formData.gender || '').trim()) {
        throw new Error('Gender is required.');
      }

      if (!isValidPhilippineContactNumber(formData.contactNumber)) {
        throw new Error('Contact Number is required and must follow +63 912 345 6789.');
      }

      if (!String(formData.street || '').trim()) {
        throw new Error('Street is required.');
      }

      if (!String(formData.region || '').trim()) {
        throw new Error('Region is required.');
      }

      if (!String(formData.province || '').trim()) {
        throw new Error('Province is required.');
      }

      if (!String(formData.city || '').trim()) {
        throw new Error('City is required.');
      }

      if (!String(formData.barangay || '').trim()) {
        throw new Error('Barangay is required.');
      }

      if (!String(formData.country || '').trim()) {
        throw new Error('Country is required.');
      }

      if ((formData.accessStart && !accessStart) || (formData.accessEnd && !accessEnd)) {
        throw new Error('Invalid access date/time value.');
      }

      if ((accessStart && !accessEnd) || (!accessStart && accessEnd)) {
        throw new Error('Access Start and Access End must both be provided when setting an access window.');
      }

      if (accessStart && accessEnd) {
        const startDate = new Date(`${accessStart.replace(' ', 'T')}+08:00`);
        const endDate = new Date(`${accessEnd.replace(' ', 'T')}+08:00`);
        if (endDate <= startDate) {
          throw new Error('Access End must be later than Access Start.');
        }
      }

      const adminInviteClient = createManageUsersInviteAdminClient();
      if (!adminInviteClient) {
        throw new Error('missing-service-role');
      }

      const { data: existingUser, error: checkError } = await supabase
        .from('users')
        .select('user_id')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (checkError && checkError.code !== 'PGRST116') {
        throw checkError;
      }

      if (existingUser) {
        throw new Error(`Email ${formData.email} is already registered in the system.`);
      }

      const createResult = await supabase.rpc('admin_create_internal_user_account', {
        p_email: normalizedEmail,
        p_role: normalizedRole,
        p_access_start: accessStart,
        p_access_end: accessEnd,
        p_is_active: true,
        p_photo_path: null,
        p_first_name: String(formData.firstName || '').trim() || null,
        p_middle_name: String(formData.middleName || '').trim() || null,
        p_last_name: String(formData.lastName || '').trim() || null,
        p_suffix: String(formData.suffix || '').trim() || null,
        p_birthdate: birthdate,
        p_gender: String(formData.gender || '').trim() || null,
        p_street: String(formData.street || '').trim() || null,
        p_region: String(formData.region || '').trim() || null,
        p_barangay: String(formData.barangay || '').trim() || null,
        p_city: String(formData.city || '').trim() || null,
        p_province: String(formData.province || '').trim() || null,
        p_country: String(formData.country || '').trim() || 'Philippines',
        p_contact_number: formatPhilippineContactNumber(formData.contactNumber),
      });

      if (createResult.error) {
        throw createResult.error;
      }

      const createdRow = Array.isArray(createResult.data) ? createResult.data[0] : createResult.data;
      createdPublicUserId = Number(createdRow?.user_id || 0);
      if (!createdPublicUserId) {
        throw new Error('Unable to create users/user_details records.');
      }

      const tempPassword = buildTemporaryPassword();
      const roleLabel = toRoleLabel(normalizedRole);
      const metadata = {
        account_type: 'internal_web_user',
        decision: 'approved',
        role_label: roleLabel,
        account_label: 'Role',
        account_value: roleLabel,
        recipient_email: normalizedEmail,
        recipient_name: displayName || '',
        review_notes: '',
        has_access_window: Boolean(accessStart && accessEnd),
        access_window: accessStart && accessEnd ? `${formatDateTime(accessStart)} to ${formatDateTime(accessEnd)}` : '',
        temporary_password: tempPassword,
        display_name: displayName || '',
        full_name: displayName || '',
        name: displayName || '',
        staff_or_specialist_role: normalizedRole,
      };

      const inviteResult = await adminInviteClient.auth.admin.inviteUserByEmail(normalizedEmail, {
        redirectTo: `${window.location.origin}/login`,
        data: metadata,
      });

      if (inviteResult.error) {
        throw new Error(mapInviteErrorMessage(inviteResult.error.message));
      }

      createdAuthUserId = String(inviteResult.data?.user?.id || '').trim() || null;
      if (!createdAuthUserId) {
        throw new Error('Invite email was sent but auth user id could not be resolved.');
      }

      const updateAuthResult = await adminInviteClient.auth.admin.updateUserById(createdAuthUserId, {
        email_confirm: true,
        password: tempPassword,
        user_metadata: {
          account_type: 'internal_web_user',
          role: normalizedRole,
          full_name: displayName || null,
          updated_at: nowSql,
        },
      });

      if (updateAuthResult.error) {
        throw new Error(mapInviteErrorMessage(updateAuthResult.error.message));
      }

      const linkResult = await supabase
        .from('users')
        .update({
          auth_user_id: createdAuthUserId,
          role: normalizedRole,
          is_active: true,
          updated_at: nowSql,
          access_start: accessStart,
          access_end: accessEnd,
        })
        .eq('user_id', createdPublicUserId);

      if (linkResult.error) {
        throw linkResult.error;
      }

      const detailsResult = await supabase
        .from('user_details')
        .update({
          joined_date: joinedDate,
          updated_at: nowSql,
        })
        .eq('user_id', createdPublicUserId);

      if (detailsResult.error) {
        throw detailsResult.error;
      }

      setIsModalOpen(false);
      setInvitedEmail(normalizedEmail);
      setInvitedRoleLabel(roleLabel);
      setInvitedDisplayName(displayName);
      setTemporaryPasswordIssued(tempPassword);
      setShowSuccessModal(true);
      setFormData(getInitialFormData());

      fetchUsers();
    } catch (error) {
      if (createdAuthUserId) {
        try {
          const adminInviteClient = createManageUsersInviteAdminClient();
          if (adminInviteClient) {
            await adminInviteClient.auth.admin.deleteUser(createdAuthUserId);
          }
        } catch {
          // Keep original error.
        }
      }

      if (createdPublicUserId) {
        try {
          await supabase.from('user_details').delete().eq('user_id', createdPublicUserId);
          await supabase.from('users').delete().eq('user_id', createdPublicUserId);
        } catch {
          // Keep original error.
        }
      }

      const msg = mapInviteErrorMessage(error?.message);
      setErrorMessage(msg);
      setShowErrorModal(true);
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      if (name === 'contactNumber') {
        return { ...prev, contactNumber: formatPhilippineContactNumber(value) };
      }

      if (name === 'region') {
        return {
          ...prev,
          region: value,
          province: '',
          city: '',
          barangay: '',
        };
      }

      if (name === 'province') {
        return {
          ...prev,
          province: value,
          city: '',
          barangay: '',
        };
      }

      if (name === 'city') {
        return {
          ...prev,
          city: value,
          barangay: '',
        };
      }

      return { ...prev, [name]: value };
    });
  };

  const filteredUsers = useMemo(
    () =>
      users.filter((user) => {
        const roleMatch = roleFilter.length === 0 || roleFilter.some((r) => r.value === user.role);
        const statusMatch =
          statusFilter.length === 0 || statusFilter.some((s) => s.value === user.status);
        return roleMatch && statusMatch;
      }),
    [users, roleFilter, statusFilter],
  );

  const detailsUser = useMemo(
    () => (detailsUserId ? users.find((user) => Number(user.id) === Number(detailsUserId)) || null : null),
    [users, detailsUserId],
  );

  const openUserDetails = (user) => {
    setDetailsUserId(user?.id || null);
    setIsEditingDetails(false);
    setDetailsNotice({ kind: '', text: '' });
  };

  const closeUserDetails = () => {
    if (isSavingDetails) return;
    setDetailsUserId(null);
    setIsEditingDetails(false);
    setDetailsNotice({ kind: '', text: '' });
  };

  const beginEditingDetails = () => {
    if (!detailsUser) return;
    const profile = detailsUser.details || {};
    setDetailsForm({
      firstName: profile.first_name || '',
      middleName: profile.middle_name || '',
      lastName: profile.last_name || '',
      suffix: profile.suffix || '',
      birthdate: profile.birthdate || '',
      gender: profile.gender || '',
      contactNumber: profile.contact_number || '',
      street: profile.street || '',
      region: profile.region || '',
      barangay: profile.barangay || '',
      city: profile.city || '',
      province: profile.province || '',
      country: profile.country || 'Philippines',
      email: detailsUser.email || '',
      role: detailsUser.role || '',
      accessStart: toDateTimeLocalValue(detailsUser.rawAccessStart),
      accessEnd: toDateTimeLocalValue(detailsUser.rawAccessEnd),
    });
    setDetailsNotice({ kind: '', text: '' });
    setIsEditingDetails(true);
  };

  const handleDetailsInputChange = (event) => {
    const { name, value } = event.target;
    setDetailsForm((current) => ({
      ...current,
      [name]: name === 'contactNumber' ? formatPhilippineContactNumber(value) : value,
    }));
  };

  const saveUserDetails = async () => {
    if (!detailsUser || !supabase) return;
    const canChangeRole = ADMIN_CREATABLE_ROLES.includes(detailsUser.role);
    const nextRole = canChangeRole ? toCanonicalRole(detailsForm.role) : detailsUser.role;
    const accessStart = toPhilippineSqlTimestampOrNull(detailsForm.accessStart);
    const accessEnd = toPhilippineSqlTimestampOrNull(detailsForm.accessEnd);

    if (!String(detailsForm.firstName || '').trim() || !String(detailsForm.lastName || '').trim()) {
      setDetailsNotice({ kind: 'error', text: 'First name and last name are required.' });
      return;
    }
    if (canChangeRole && !ADMIN_CREATABLE_ROLES.includes(nextRole)) {
      setDetailsNotice({ kind: 'error', text: 'This account can only be Staff or Specialist.' });
      return;
    }
    if ((detailsForm.accessStart && !accessStart) || (detailsForm.accessEnd && !accessEnd)) {
      setDetailsNotice({ kind: 'error', text: 'Enter a valid access date and time.' });
      return;
    }
    if ((accessStart && !accessEnd) || (!accessStart && accessEnd)) {
      setDetailsNotice({ kind: 'error', text: 'Access start and end must both be provided, or both left empty.' });
      return;
    }
    if (accessStart && accessEnd && new Date(`${accessEnd.replace(' ', 'T')}+08:00`) <= new Date(`${accessStart.replace(' ', 'T')}+08:00`)) {
      setDetailsNotice({ kind: 'error', text: 'Access end must be later than access start.' });
      return;
    }
    if (detailsForm.contactNumber && !isValidPhilippineContactNumber(detailsForm.contactNumber)) {
      setDetailsNotice({ kind: 'error', text: 'Contact number must follow +63 912 345 6789.' });
      return;
    }

    setIsSavingDetails(true);
    setDetailsNotice({ kind: '', text: '' });
    try {
      const accountUpdate = {
        access_start: accessStart,
        access_end: accessEnd,
        updated_at: getPhilippineSqlTimestamp(),
      };
      if (canChangeRole) accountUpdate.role = nextRole;

      const [accountResult, profileResult] = await Promise.all([
        supabase.from('users').update(accountUpdate).eq('user_id', detailsUser.id),
        supabase.from('user_details').update({
          first_name: String(detailsForm.firstName || '').trim(),
          middle_name: String(detailsForm.middleName || '').trim() || null,
          last_name: String(detailsForm.lastName || '').trim(),
          suffix: String(detailsForm.suffix || '').trim() || null,
          birthdate: toPhilippineDateOrNull(detailsForm.birthdate),
          gender: String(detailsForm.gender || '').trim() || null,
          contact_number: detailsForm.contactNumber || null,
          street: String(detailsForm.street || '').trim() || null,
          barangay: String(detailsForm.barangay || '').trim() || null,
          city: String(detailsForm.city || '').trim() || null,
          province: String(detailsForm.province || '').trim() || null,
          region: String(detailsForm.region || '').trim() || null,
          country: String(detailsForm.country || '').trim() || 'Philippines',
          updated_at: getPhilippineSqlTimestamp(),
        }).eq('user_id', detailsUser.id),
      ]);
      if (accountResult.error) throw accountResult.error;
      if (profileResult.error) throw profileResult.error;

      await fetchUsers();
      setIsEditingDetails(false);
      setDetailsNotice({ kind: 'success', text: 'User account details saved successfully.' });
    } catch (error) {
      setDetailsNotice({ kind: 'error', text: error.message || 'Unable to save user details.' });
    } finally {
      setIsSavingDetails(false);
    }
  };

  const toggleUserStatus = async (user) => {
    if (!user || !supabase) return;
    const nextActive = user.status !== 'Active';
    setTogglingUserId(user.id);
    try {
      const result = await supabase
        .from('users')
        .update({ is_active: nextActive, updated_at: getPhilippineSqlTimestamp() })
        .eq('user_id', user.id);
      if (result.error) throw result.error;
      await fetchUsers();
      if (Number(detailsUserId) === Number(user.id)) {
        setDetailsNotice({ kind: 'success', text: `Account ${nextActive ? 'activated' : 'deactivated'} successfully.` });
      }
    } catch (error) {
      setErrorMessage(error.message || 'Unable to update account status.');
      setShowErrorModal(true);
    } finally {
      setTogglingUserId(null);
    }
  };

  const roleOptions = allRoles.map((role) => ({ value: role, label: toRoleLabel(role) }));
  const statusOptions = ['Active', 'Inactive'].map((status) => ({ value: status, label: status }));
  const regionList = useMemo(
    () =>
      Object.values(philippineAddressOptions)
        .map((region) => region.region_name)
        .sort((a, b) => a.localeCompare(b)),
    [],
  );
  const selectedRegion = useMemo(
    () =>
      Object.values(philippineAddressOptions).find(
        (region) => region.region_name === formData.region,
      ) || null,
    [formData.region],
  );
  const provinceList = useMemo(
    () => Object.keys(selectedRegion?.province_list || {}).sort((a, b) => a.localeCompare(b)),
    [selectedRegion],
  );
  const selectedProvince = useMemo(
    () => selectedRegion?.province_list?.[formData.province] || null,
    [selectedRegion, formData.province],
  );
  const cityList = useMemo(
    () => Object.keys(selectedProvince?.municipality_list || {}).sort((a, b) => a.localeCompare(b)),
    [selectedProvince],
  );
  const barangayList = useMemo(
    () => selectedProvince?.municipality_list?.[formData.city]?.barangay_list || [],
    [selectedProvince, formData.city],
  );

  const selectStyles = {
    control: (base, state) => ({
      ...base,
      borderColor: state.isFocused ? theme.primaryColor : base.borderColor,
      boxShadow: state.isFocused ? `0 0 0 1px ${theme.primaryColor}` : 'none',
      '&:hover': {
        borderColor: theme.primaryColor,
      },
    }),
    multiValue: (base) => ({
      ...base,
      backgroundColor: `${theme.primaryColor}20`,
    }),
    multiValueLabel: (base) => ({
      ...base,
      color: theme.primaryColor,
    }),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="role-page-title text-3xl font-bold text-gray-900">Manage User Accounts</h1>
          <p className="mt-1 text-sm text-gray-600">Add and manage staff/specialist web accounts and monitor account access windows.</p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors shadow-sm"
          style={{ backgroundColor: theme.primaryColor }}
        >
          <Plus size={18} />
          <span>Add User</span>
        </button>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4 md:p-5">
        <div className="mb-4 flex flex-wrap gap-4">
          <div className="w-64">
            <label className="block text-sm font-medium text-gray-700 mb-1">Filter by Role</label>
            <Select
              isMulti
              options={roleOptions}
              value={roleFilter}
              onChange={(value) => setRoleFilter(value || [])}
              placeholder="All Roles"
              classNamePrefix="react-select"
              styles={selectStyles}
            />
          </div>
          <div className="w-64">
            <label className="block text-sm font-medium text-gray-700 mb-1">Filter by Status</label>
            <Select
              isMulti
              options={statusOptions}
              value={statusFilter}
              onChange={(value) => setStatusFilter(value || [])}
              placeholder="All Status"
              classNamePrefix="react-select"
              styles={selectStyles}
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-gray-200">
        {loading ? (
          <div className="p-10 flex justify-center text-gray-700 gap-2">
            <Loader2 className="animate-spin" /> Loading...
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="text-sm" style={{ backgroundColor: `${theme.primaryColor}20`, color: tableHeaderTextColor }}>
              <tr>
                <th className="p-4">User Name</th>
                <th className="p-4">Role</th>
                <th className="p-4">Joined Date</th>
                <th className="p-4">Role Duration</th>
                <th className="p-4">Status</th>
                <th className="p-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan="6" className="p-10 text-center text-gray-500">
                    <div className="flex flex-col items-center gap-2">
                      <Search size={40} className="text-gray-300" />
                      <p>No users found for selected filters.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                    <td className="p-4 font-medium text-gray-800 flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs uppercase"
                        style={{ backgroundColor: `${theme.primaryColor}22`, color: theme.primaryColor }}
                      >
                        {user.firstName.charAt(0)}
                      </div>
                      <div>
                        <div className="font-bold">{user.firstName} {user.lastName}</div>
                        <div className="text-xs text-gray-500">{user.email}</div>
                      </div>
                    </td>
                    <td className="p-4">
                      <span
                        className="px-3 py-1 rounded-full text-xs font-medium border flex items-center gap-1 w-fit"
                        style={{ backgroundColor: `${theme.primaryColor}18`, color: theme.primaryColor, borderColor: `${theme.primaryColor}33` }}
                      >
                        <Shield size={12} /> {toRoleLabel(user.role)}
                      </span>
                    </td>
                    <td className="p-4 text-gray-700">
                      {user.joinedDate
                        ? new Date(user.joinedDate).toLocaleDateString('en-US', {
                            timeZone: 'Asia/Manila',
                            month: 'long',
                            day: 'numeric',
                            year: 'numeric',
                          })
                        : 'â€”'}
                    </td>
                    <td className="p-4 text-gray-600 text-sm">
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="text-gray-400" />
                        <span>{user.accessStart || 'N/A'}</span>
                        <span className="text-gray-400">to</span>
                        <span>{user.accessEnd || 'N/A'}</span>
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${user.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {user.status}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => openUserDetails(user)}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-gray-50 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                          title="View user details"
                        >
                          <Info size={13} /> Info
                        </button>

                        <button
                          type="button"
                          onClick={() => void toggleUserStatus(user)}
                          disabled={togglingUserId === user.id}
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:cursor-wait disabled:opacity-60 ${
                            user.status === 'Active'
                              ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          }`}
                        >
                          {togglingUserId === user.id ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                          {user.status === 'Active' ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        </div>
      </section>

      <UserAccountDetailsModal
        open={Boolean(detailsUser)}
        user={detailsUser}
        theme={theme}
        editing={isEditingDetails}
        form={detailsForm}
        notice={detailsNotice}
        saving={isSavingDetails}
        toggling={togglingUserId === detailsUser?.id}
        onClose={closeUserDetails}
        onBeginEdit={beginEditingDetails}
        onCancelEdit={() => setIsEditingDetails(false)}
        onChange={handleDetailsInputChange}
        onSave={() => void saveUserDetails()}
        onToggleStatus={() => void toggleUserStatus(detailsUser)}
      />

      {showSuccessModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 text-green-600">
              <CheckCircle size={40} />
            </div>
            <h3 className="text-2xl font-bold text-gray-800 mb-2">
              User Account Created
            </h3>
            <div>
              <p className="text-gray-600 text-sm mb-4">Credentials email was sent to:</p>
              <p className="font-bold text-lg mb-1" style={{ color: theme.primaryColor }}>{invitedEmail}</p>
              {invitedDisplayName ? (
                <p className="text-xs text-gray-500 mb-1">{invitedDisplayName}</p>
              ) : null}
              {invitedRoleLabel ? (
                <p className="text-xs text-gray-500 mb-4">Role: {invitedRoleLabel}</p>
              ) : null}
              {temporaryPasswordIssued ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 mb-4 text-left">
                  <p className="text-[11px] uppercase tracking-wide text-blue-700 font-semibold mb-1">Temporary Login Credentials</p>
                  <p className="text-xs text-blue-900"><strong>Email:</strong> {invitedEmail}</p>
                  <p className="text-xs text-blue-900"><strong>Password:</strong> {temporaryPasswordIssued}</p>
                </div>
              ) : null}
              <p className="text-gray-500 text-xs mb-6">
                This account can login immediately using the temporary credentials.
              </p>
            </div>

            <button
              onClick={() => setShowSuccessModal(false)}
              className="w-full py-3 text-white rounded-xl font-bold"
              style={{ backgroundColor: theme.primaryColor }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {showErrorModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-sm w-full text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4 text-red-600">
              <AlertTriangle size={40} />
            </div>
            <h3 className="text-2xl font-bold text-gray-800 mb-2">Error</h3>
            <p className="text-gray-600 mb-6 text-sm">{errorMessage}</p>
            <button
              onClick={() => setShowErrorModal(false)}
              className="w-full py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700"
            >
              Try Again
            </button>
          </div>
        </div>
      )}

      {isModalOpen && typeof document !== 'undefined'
        ? createPortal(
            <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
              <div className="w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-2xl">
                <div className="max-h-[90vh] overflow-y-auto p-6">
                  <div className="mb-6 flex items-center justify-between border-b border-gray-200 pb-4">
                    <h3 className="text-xl font-bold text-gray-800">Add New User</h3>
                    <button onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-red-500">
                      <X size={24} />
                    </button>
                  </div>

                  <form onSubmit={handleInviteUser} className="space-y-4">
                    <div className="rounded-lg border p-3 text-xs" style={{ backgroundColor: `${theme.primaryColor}12`, color: theme.primaryColor, borderColor: `${theme.primaryColor}33` }}>
                      Creates auth account + users + user_details in one submit. Optional fields: Access Start, Access End, Middle Name, Suffix.
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Email Address *</label>
                        <input required name="email" value={formData.email} onChange={handleInputChange} type="email" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Role *</label>
                        <select required name="role" value={formData.role} onChange={handleInputChange} className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }}>
                          <option value="staff">Staff</option>
                          <option value="specialist">Specialist</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Access Start (UTC+8, optional)</label>
                        <input name="accessStart" value={formData.accessStart} onChange={handleInputChange} type="datetime-local" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Access End (UTC+8, optional)</label>
                        <input name="accessEnd" value={formData.accessEnd} onChange={handleInputChange} type="datetime-local" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                    </div>

                    <div className="border-t border-gray-200 pt-2">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">User Details</p>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">First Name *</label>
                        <input required name="firstName" value={formData.firstName} onChange={handleInputChange} type="text" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Middle Name (optional)</label>
                        <input name="middleName" value={formData.middleName} onChange={handleInputChange} type="text" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Last Name *</label>
                        <input required name="lastName" value={formData.lastName} onChange={handleInputChange} type="text" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Suffix (optional)</label>
                        <input name="suffix" value={formData.suffix} onChange={handleInputChange} type="text" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Birthdate *</label>
                        <input required name="birthdate" value={formData.birthdate} onChange={handleInputChange} type="date" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Gender *</label>
                        <select required name="gender" value={formData.gender} onChange={handleInputChange} className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }}>
                          <option value="">Select gender</option>
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                          <option value="Prefer not to say">Prefer not to say</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-sm font-medium text-gray-700">Contact Number *</label>
                      <input
                        required
                        name="contactNumber"
                        value={formData.contactNumber}
                        onChange={handleInputChange}
                        type="text"
                        inputMode="numeric"
                        placeholder="+63 912 345 6789"
                        maxLength={16}
                        title="Use +63 912 345 6789 format."
                        className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2"
                        style={{ '--tw-ring-color': theme.primaryColor }}
                      />
                    </div>

                    <div className="border-t border-gray-200 pt-2">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Address</p>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Street *</label>
                        <input required name="street" value={formData.street} onChange={handleInputChange} type="text" className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }} />
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Region *</label>
                        <select required name="region" value={formData.region} onChange={handleInputChange} className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2" style={{ '--tw-ring-color': theme.primaryColor }}>
                          <option value="">Select region</option>
                          {regionList.map((regionName) => (
                            <option key={regionName} value={regionName}>{regionName}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Province *</label>
                        <select required name="province" value={formData.province} onChange={handleInputChange} disabled={!formData.region} className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-gray-100" style={{ '--tw-ring-color': theme.primaryColor }}>
                          <option value="">Select province</option>
                          {provinceList.map((provinceName) => (
                            <option key={provinceName} value={provinceName}>{provinceName}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">City / Municipality *</label>
                        <select required name="city" value={formData.city} onChange={handleInputChange} disabled={!formData.province} className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-gray-100" style={{ '--tw-ring-color': theme.primaryColor }}>
                          <option value="">Select city/municipality</option>
                          {cityList.map((cityName) => (
                            <option key={cityName} value={cityName}>{cityName}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Barangay *</label>
                        <select required name="barangay" value={formData.barangay} onChange={handleInputChange} disabled={!formData.city} className="w-full rounded-lg border border-gray-300 bg-white p-2 text-gray-900 outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-gray-100" style={{ '--tw-ring-color': theme.primaryColor }}>
                          <option value="">Select barangay</option>
                          {barangayList.map((barangayName) => (
                            <option key={barangayName} value={barangayName}>{barangayName}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700">Country *</label>
                        <input required readOnly name="country" value={formData.country} onChange={handleInputChange} type="text" className="w-full rounded-lg border border-gray-300 bg-gray-100 p-2 text-gray-700 outline-none" />
                      </div>
                    </div>

                    <div className="mt-8 flex gap-3 pt-2">
                      <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 rounded-lg border border-gray-300 py-2 text-gray-700 hover:bg-gray-50">Cancel</button>
                      <button type="submit" disabled={saving} className="flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-white" style={{ backgroundColor: theme.primaryColor }}>
                        {saving ? <Loader2 className="animate-spin" size={18} /> : <Mail size={18} />}
                        {saving ? 'Creating...' : 'Add User'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
