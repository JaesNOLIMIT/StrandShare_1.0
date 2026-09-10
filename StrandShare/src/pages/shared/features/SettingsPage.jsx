import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTheme } from '../../../context/ThemeContext';
import { Camera, Check, Eye, EyeOff, Mail, MapPin, Phone, Plus, Save, ShieldCheck, Trash2, User, X } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { logAuditAction } from '../../../lib/auditLogger';
import {
  PERSON_SUFFIX_OPTIONS,
  formatPhilippineMobile,
  getAdultBirthdateMax,
  isAtLeastAge,
  isValidPhilippineMobile,
  normalizePersonSuffix,
} from '../../../lib/personIdentity';

const TAB_ITEMS = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'branding', label: 'Branding' },
];

const BRANDING_EDITOR_TABS = [
  { id: 'appearance', label: 'Colors & Typography' },
  { id: 'branding', label: 'Branding' },
];

const DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='64' fill='#f1f5f9'/><circle cx='64' cy='46' r='20' fill='#374151'/><path d='M18 116c4-22 21-35 46-35s42 13 46 35' fill='#374151'/></svg>",
)}`;

const USER_PROFILE_STORAGE_KEY = 'Donivra_user_profile';
const USER_PROFILE_READY_EVENT = 'Donivra-profile-ready';
const SETTINGS_PROFILE_CACHE_KEY = 'Donivra_settings_profile_cache';
const BRANDING_BUCKET = 'branding_assests';

function normalizeGenderOption(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-');

  if (['male', 'female'].includes(normalized)) {
    return normalized;
  }

  return '';
}

function mapGenderForStorage(value) {
  const option = normalizeGenderOption(value);
  if (option === 'female') return 'Female';
  if (option === 'male') return 'Male';
  return '';
}

function formatRoleLabel(value) {
  return String(value || 'User')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAdminRole(value) {
  const roleKey = lowerCaseRoleKey(value);
  return roleKey === 'admin' || roleKey === 'superadmin';
}

function lowerCaseRoleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_\s-]+/g, '');
}

function isAal2RequiredError(error) {
  const value = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return value.includes('aal2') || value.includes('mfa verification');
}

function isMfaFactorNameConflict(error) {
  const value = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return value.includes('mfa_factor_name_conflict') || value.includes('friendly name');
}

function isPasswordReauthenticationRequired(error) {
  const value = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return value.includes('reauthentication')
    || value.includes('reauthenticate')
    || (value.includes('nonce') && (value.includes('required') || value.includes('invalid')));
}

function getPasswordUpdateErrorMessage(error) {
  const value = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (value.includes('current password')) return 'The current password is incorrect.';
  if (value.includes('different from the old') || value.includes('same password') || value.includes('same as old')) {
    return 'Choose a new password that is different from your current password.';
  }
  if (value.includes('weak password')) return 'The new password does not meet the project password requirements.';
  return error?.message || 'Unable to update the password.';
}

function getNextMfaFriendlyName(factors = []) {
  const usedNames = new Set(
    factors
      .map((factor) => String(factor?.friendly_name || '').trim().toLowerCase())
      .filter(Boolean),
  );

  if (!usedNames.has('google authenticator')) return 'Google Authenticator';

  let index = 2;
  while (usedNames.has(`google authenticator ${index}`)) index += 1;
  return `Google Authenticator ${index}`;
}

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function isBlobUrl(value) {
  return String(value || '').startsWith('blob:');
}

function getStoragePublicUrl(bucket, path) {
  if (!path || !supabase) {
    return '';
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || '';
}

function resolveAvatarUrl(photoPath) {
  if (!photoPath) {
    return DEFAULT_AVATAR;
  }

  if (isAbsoluteUrl(photoPath)) {
    return photoPath;
  }

  if (!supabase) {
    return DEFAULT_AVATAR;
  }

  const { data } = supabase.storage.from('profile_pictures').getPublicUrl(photoPath);
  return data?.publicUrl || DEFAULT_AVATAR;
}

function formatActivityTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value || '-');
  }

  const datePart = parsed.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timePart = parsed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

function currentDeviceLabel() {
  const ua = navigator.userAgent || '';

  if (/edg/i.test(ua)) return 'Edge on Windows';
  if (/chrome/i.test(ua) && /windows/i.test(ua)) return 'Chrome on Windows';
  if (/safari/i.test(ua) && /iphone/i.test(ua)) return 'Safari on iPhone';
  if (/safari/i.test(ua) && /mac/i.test(ua)) return 'Safari on macOS';
  if (/firefox/i.test(ua)) return 'Firefox';

  return 'Current device';
}

function actionLabel(actionValue = '') {
  const normalized = String(actionValue || '').replace(/[._]+/g, ' ').trim();
  return normalized ? normalized.replace(/\b\w/g, (char) => char.toUpperCase()) : 'Activity';
}

function extractDeviceFromDescription(description = '') {
  const match = String(description).match(/from\s([^[]+)/i);
  if (!match?.[1]) {
    return 'Recent device';
  }

  return match[1].trim();
}

function mapStorageUploadError(rawMessage) {
  const message = String(rawMessage || 'Upload failed.');
  if (message.toLowerCase().includes('row-level security')) {
    return 'Upload blocked by Storage RLS policy. Apply the profile_pictures bucket policies and make sure you are logged in.';
  }
  return message;
}

function colorValueToHex(value, expandShortHex = false) {
  const input = String(value || '').trim();
  if (!input) return '#000000';

  if (/^#[0-9a-f]{6}$/i.test(input)) {
    return input.toLowerCase();
  }

  if (/^#[0-9a-f]{3}$/i.test(input)) {
    if (!expandShortHex) {
      return input.toLowerCase();
    }

    const r = input[1];
    const g = input[2];
    const b = input[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  const match = input.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (!match) {
    return input;
  }

  const [r, g, b] = match.slice(1, 4).map((part) => {
    const valueNumber = Number(part);
    return Math.max(0, Math.min(255, Number.isFinite(valueNumber) ? valueNumber : 0));
  });

  const toHex = (num) => num.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colorValueToRgb(value) {
  const input = String(value || '').trim();
  if (!input) return 'rgb(0, 0, 0)';

  const rgbMatch = input.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1, 4).map((part) => {
      const valueNumber = Number(part);
      return Math.max(0, Math.min(255, Number.isFinite(valueNumber) ? valueNumber : 0));
    });
    return `rgb(${r}, ${g}, ${b})`;
  }

  const hex = colorValueToHex(input, true);
  const hexMatch = hex.match(/^#([0-9a-f]{6})$/i);
  if (!hexMatch) {
    return input;
  }

  const hexValue = hexMatch[1];
  const r = parseInt(hexValue.slice(0, 2), 16);
  const g = parseInt(hexValue.slice(2, 4), 16);
  const b = parseInt(hexValue.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function ColorPickerPanel({ color, onColorChange, onEnter }) {
  return (
    <div className="brand-picker-dropdown relative w-[272px] rounded-2xl border border-slate-300 bg-white p-3 shadow-[0_20px_40px_rgba(15,23,42,0.20)]">
      <span className="absolute -top-1.5 left-4 h-3 w-3 rotate-45 border-l border-t border-slate-300 bg-white" aria-hidden="true" />
      <HexColorPicker color={color} onChange={onColorChange} className="!w-full" />
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1 text-sm font-bold uppercase tracking-wide text-slate-700">
          {colorValueToHex(color, true)}
        </span>
        <button
          type="button"
          onClick={onEnter}
          className="rounded-md border border-slate-400 bg-white px-4 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Enter
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const {
    theme,
    saveThemeGlobally,
    themePresets,
    refreshThemePresets,
    createThemePreset,
    softDeleteThemePreset,
    googleFonts,
  } = useTheme();

  const readCachedProfile = () => {
    let settingsParsed = null;
    let userParsed = null;

    try {
      const settingsRaw = localStorage.getItem(SETTINGS_PROFILE_CACHE_KEY);
      settingsParsed = settingsRaw ? JSON.parse(settingsRaw) : null;
    } catch {
      // ignore cache parse errors
    }

    try {
      const userRaw = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
      userParsed = userRaw ? JSON.parse(userRaw) : null;
    } catch {
      userParsed = null;
    }

    if (!settingsParsed && !userParsed) {
      return null;
    }

    // Merge both caches so profile photo path from shell cache is not lost.
    return {
      ...(userParsed || {}),
      ...(settingsParsed || {}),
      photo_path: settingsParsed?.photo_path || userParsed?.photo_path || '',
    };
  };

  const [activeTab, setActiveTab] = useState('profile');
  const [previewView, setPreviewView] = useState('login');
  const [brandingEditorTab, setBrandingEditorTab] = useState('appearance');
  const [selectedThemeId, setSelectedThemeId] = useState('');
  const [newPresetName, setNewPresetName] = useState('');
  const [isSavingPreset, setIsSavingPreset] = useState(false);
  const [isDeletingPresetId, setIsDeletingPresetId] = useState(null);
  const [toast, setToast] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [authUserId, setAuthUserId] = useState('');
  const [userId, setUserId] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [isOtpSent, setIsOtpSent] = useState(false);
  const [isVerifyingPasswordOtp, setIsVerifyingPasswordOtp] = useState(false);
  const [passwordMfaRequired, setPasswordMfaRequired] = useState(false);
  const [passwordMfaCode, setPasswordMfaCode] = useState('');
  const [passwordMfaFactorId, setPasswordMfaFactorId] = useState('');
  const [isVerifyingPasswordMfa, setIsVerifyingPasswordMfa] = useState(false);
  const [showPasswordSuccessModal, setShowPasswordSuccessModal] = useState(false);
  const [isProfileHydrated, setIsProfileHydrated] = useState(false);
  const [mfaSetup, setMfaSetup] = useState({
    enrolling: false,
    factorId: '',
    qrSvg: '',
    secret: '',
    code: '',
  });
  const [mfaFactors, setMfaFactors] = useState([]);
  const [isManagingMfa, setIsManagingMfa] = useState(false);
  const [mfaStepUp, setMfaStepUp] = useState({ required: false, factorId: '', code: '' });
  const [showMfaRecoveryHelp, setShowMfaRecoveryHelp] = useState(false);
  const [isVerifyingMfaStepUp, setIsVerifyingMfaStepUp] = useState(false);
  const [isVerifyingMfaCode, setIsVerifyingMfaCode] = useState(false);
  const [isLoadingMfaStatus, setIsLoadingMfaStatus] = useState(true);
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  const [profile, setProfile] = useState(() => {
    const storedProfile = readCachedProfile();
    const storedPhotoPath = storedProfile?.photo_path || '';
    const cachedAvatar = isAbsoluteUrl(storedProfile?.avatar) ? storedProfile.avatar : '';
    const resolvedAvatar = storedPhotoPath ? resolveAvatarUrl(storedPhotoPath) : cachedAvatar;

    return {
      firstName: storedProfile?.first_name || storedProfile?.firstName || '',
      middleName: storedProfile?.middle_name || storedProfile?.middleName || '',
      lastName: storedProfile?.last_name || storedProfile?.lastName || '',
      suffix: storedProfile?.suffix || '',
      gender: normalizeGenderOption(storedProfile?.gender || ''),
      birthdate: storedProfile?.birthdate || '',
      contactNumber: storedProfile?.contact_number || storedProfile?.contactNumber || '',
      street: storedProfile?.street || '',
      barangay: storedProfile?.barangay || '',
      city: storedProfile?.city || '',
      province: storedProfile?.province || '',
      region: storedProfile?.region || '',
      country: storedProfile?.country || 'Philippines',
      joinedDate: storedProfile?.joined_date || storedProfile?.joinedDate || '',
      email: storedProfile?.email || '',
      role: storedProfile?.role || '',
      avatar: resolvedAvatar || '',
    };
  });
  const [avatarStoragePath, setAvatarStoragePath] = useState(() => {
    const storedProfile = readCachedProfile();
    const storedPhotoPath = storedProfile?.photo_path || '';
    return storedPhotoPath && !isAbsoluteUrl(storedPhotoPath) ? storedPhotoPath : '';
  });

  const [security, setSecurity] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    passwordOtp: '',
    twoFactorEnabled: false,
    activeSessions: [],
    loginSessions: [],
  });

  const loadSecurityActivity = useCallback(async (targetUserId) => {
    if (!isSupabaseConfigured || !supabase || !targetUserId) {
      return;
    }

    const { data: logs, error } = await supabase
      .from('audit_logs')
      .select('time, action, description, resource, status')
      .eq('user_id', targetUserId)
      .order('time', { ascending: false })
      .limit(80);

    if (error) {
      return;
    }

    const loginRows = (logs || []).map((row) => ({
      time: formatActivityTime(row.time),
      action: actionLabel(row.action),
      ip: row.resource || row.status || 'N/A',
    }));

    const signInLogs = (logs || []).filter((row) => row.action === 'auth.sign_in').slice(0, 6);
    const historicalSessions = signInLogs.map((row, index) => ({
      device: extractDeviceFromDescription(row.description),
      location: 'Recorded from activity logs',
      lastActive: index === 0 ? 'Latest sign-in' : formatActivityTime(row.time),
      current: false,
    }));

    const sessions = [
      {
        device: currentDeviceLabel(),
        location: 'Current browser session',
        lastActive: 'Now',
        current: true,
      },
      ...historicalSessions,
    ];

    const uniqueSessions = sessions.filter((session, index, arr) => {
      const key = `${session.device}-${session.lastActive}`;
      return arr.findIndex((entry) => `${entry.device}-${entry.lastActive}` === key) === index;
    });

    setSecurity((prev) => ({
      ...prev,
      activeSessions: uniqueSessions,
      loginSessions: loginRows,
    }));
  // Run once on mount; bootstrap flow is intentionally not re-triggered by helper identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passwordRuleChecks = useMemo(() => {
    const value = security.newPassword || '';
    return {
      minLength: value.length >= 8,
      uppercase: /[A-Z]/.test(value),
      lowercase: /[a-z]/.test(value),
      number: /\d/.test(value),
      special: /[^A-Za-z0-9]/.test(value),
    };
  }, [security.newPassword]);

  const isPasswordChecklistComplete =
    passwordRuleChecks.minLength &&
    passwordRuleChecks.uppercase &&
    passwordRuleChecks.lowercase &&
    passwordRuleChecks.number &&
    passwordRuleChecks.special;

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_PROFILE_CACHE_KEY, JSON.stringify(profile));
    } catch {
      // ignore cache write errors
    }
  }, [profile]);

  const [tempColors, setTempColors] = useState({
    primary: theme.primaryColor,
    primaryDark: theme.primaryColorDark,
    primaryLight: theme.primaryColorLight,
    secondary: theme.secondaryColor,
    secondaryDark: theme.secondaryColorDark,
    secondaryLight: theme.secondaryColorLight,
    tertiary: theme.tertiaryColor,
    tertiaryDark: theme.tertiaryColorDark,
    tertiaryLight: theme.tertiaryColorLight,
    background: theme.backgroundColor || '#f4f7fb',
    fontPrimary: theme.primaryTextColor || '#0f172a',
    fontSecondary: theme.secondaryTextColor || '#64748b',
    fontTertiary: theme.tertiaryTextColor || '#94a3b8',
  });

  const [brandingMeta, setBrandingMeta] = useState({
    brandName: theme.brandName || 'Donivra',
    brandTagline: theme.brandTagline || 'Every Strand Counts',
    loginTitle: 'Welcome Back',
    loginSubtitle: 'Login to continue supporting our beautyAI community.',
    primaryFontFamily: theme.selectedFont || theme.fontFamily || 'Poppins',
    secondaryFontFamily: theme.secondaryFontFamily || theme.selectedFont || theme.fontFamily || 'Poppins',
    cornerStyle: 'rounded',
  });

  const [brandingAssets, setBrandingAssets] = useState({
    logoImage: theme.logoImage || '',
    loginBackgroundImage: theme.loginBackgroundImage || '',
  });
  const [brandingAssetPaths, setBrandingAssetPaths] = useState({
    logoImagePath: theme.logoImagePath || '',
    loginBackgroundImagePath: theme.loginBackgroundImagePath || '',
  });
  const [brandingUploadStatus, setBrandingUploadStatus] = useState({
    logoImage: false,
    loginBackgroundImage: false,
  });
  const [colorInputMode, setColorInputMode] = useState('hex');
  const [activeColorPickerKey, setActiveColorPickerKey] = useState('');
  const [pickerDraftColor, setPickerDraftColor] = useState('#000000');
  const [showAllPresets, setShowAllPresets] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1536 : window.innerWidth));

  const openColorPicker = useCallback((colorKey) => {
    setColorInputMode('hex');
    const nextHex = colorValueToHex(tempColors[colorKey], true);
    setPickerDraftColor(/^#[0-9a-f]{6}$/i.test(nextHex) ? nextHex : '#000000');
    setActiveColorPickerKey((prev) => (prev === colorKey ? '' : colorKey));
  }, [tempColors]);

  const applyPickerColor = useCallback((colorKey) => {
    setTempColors((prev) => ({ ...prev, [colorKey]: colorValueToHex(pickerDraftColor, true) }));
    setActiveColorPickerKey('');
  }, [pickerDraftColor]);

  useEffect(() => {
    if (!activeColorPickerKey) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (event.target instanceof Element && event.target.closest('[data-color-dropdown-root="true"]')) {
        return;
      }
      setActiveColorPickerKey('');
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setActiveColorPickerKey('');
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [activeColorPickerKey]);

  const previewStyle = useMemo(
    () => ({
      background: `linear-gradient(130deg, ${tempColors.primaryLight}20, ${tempColors.primary}12, ${tempColors.secondary}14), ${tempColors.background}`,
    }),
    [tempColors],
  );

  const canManageBranding = useMemo(() => isAdminRole(profile.role), [profile.role]);

  useEffect(() => {
    if (!canManageBranding) {
      return;
    }

    void refreshThemePresets();
  }, [canManageBranding, refreshThemePresets]);

  const presetHighlightColor = theme.primaryColor || '#0275d8';
  const visibleTabs = useMemo(
    () => TAB_ITEMS.filter((tab) => tab.id !== 'branding' || canManageBranding),
    [canManageBranding],
  );

  const themePresetCards = useMemo(() => {
    return (themePresets || []).map((preset) => ({
      id: String(preset.Preset_ID),
      name: preset.Preset_Name || 'Untitled Preset',
      isDefault: Boolean(preset.Is_Default),
      colors: {
        primary: preset.Primary_Color,
        secondary: preset.Secondary_Color,
        tertiary: preset.Tertiary_Color,
        background: preset.Background_Color || '#f4f7fb',
        fontPrimary: preset.Primary_Text_Color,
        fontSecondary: preset.Secondary_Text_Color,
        fontTertiary: preset.Tertiary_Text_Color,
      },
      fontFamily: preset.Font_Family || 'Poppins',
      secondaryFontFamily: preset.Secondary_Font_Family || preset.Font_Family || 'Poppins',
      rawPresetId: preset.Preset_ID,
    }));
  }, [themePresets]);

  const allPresetCards = useMemo(() => ([...themePresetCards, { id: 'custom', name: 'Custom', isCustom: true }]), [themePresetCards]);

  const presetColumns = useMemo(() => {
    if (viewportWidth >= 1536) return 5;
    if (viewportWidth >= 1280) return 4;
    if (viewportWidth >= 768) return 3;
    return 2;
  }, [viewportWidth]);

  const maxCollapsedPresetCount = presetColumns * 2;
  const hasMorePresetRows = allPresetCards.length > maxCollapsedPresetCount;
  const visiblePresetCards = showAllPresets ? allPresetCards : allPresetCards.slice(0, maxCollapsedPresetCount);

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (!hasMorePresetRows) {
      setShowAllPresets(false);
    }
  }, [hasMorePresetRows]);

  useEffect(() => {
    if ((themePresetCards || []).length === 0) {
      return;
    }

    const defaultPreset = themePresetCards.find((preset) => preset.isDefault);
    if (!defaultPreset) {
      return;
    }

    if (!selectedThemeId) {
      setSelectedThemeId(defaultPreset.id);
      return;
    }

    const hasRealPresetSelection = themePresetCards.some((preset) => preset.id === selectedThemeId);
    if (!hasRealPresetSelection && selectedThemeId !== 'custom') {
      setSelectedThemeId(defaultPreset.id);
    }
  }, [themePresetCards, selectedThemeId]);

  useEffect(() => {
    if (activeTab === 'branding' && !canManageBranding) {
      setActiveTab('profile');
    }
  }, [activeTab, canManageBranding]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    loadSecurityActivity(userId);
  }, [userId, loadSecurityActivity]);

  const showToast = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast(''), 2200);
  }, []);

  const pushUserProfileToShell = (nextProfile) => {
    try {
      const raw = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const merged = {
        ...parsed,
        ...nextProfile,
        auth_user_id: authUserId || parsed?.auth_user_id,
      };

      localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(merged));
      if (merged?.auth_user_id) {
        window.dispatchEvent(
          new CustomEvent(USER_PROFILE_READY_EVENT, {
            detail: {
              authUserId: merged.auth_user_id,
              profile: merged,
              source: 'profile-update',
            },
          }),
        );
      }
    } catch {
      // no-op to avoid blocking user updates when local storage is unavailable
    }
  };

  const hydrateProfileFromDb = async (nextAuthUserId, nextEmail) => {
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('user_id, role, email, access_start, access_end, is_active, created_at, updated_at')
      .eq('auth_user_id', nextAuthUserId)
      .maybeSingle();

    if (userError && userError.code !== 'PGRST116') {
      throw userError;
    }

    const resolvedUserId = userRow?.user_id || null;
    setUserId(resolvedUserId);

    const nextRole = userRow?.role || profile.role;
    const nextResolvedEmail = userRow?.email || nextEmail || '';

    setProfile((prev) => ({
      ...prev,
      email: nextResolvedEmail,
      role: nextRole,
    }));

    let resolvedDetails = null;

    if (resolvedUserId) {
      const { data: detailsRow, error: detailsError } = await supabase
        .from('user_details')
        .select('first_name, middle_name, last_name, suffix, birthdate, gender, contact_number, street, barangay, city, province, region, country, joined_date, photo_path')
        .eq('user_id', resolvedUserId)
        .maybeSingle();

      if (detailsError && detailsError.code !== 'PGRST116') {
        throw detailsError;
      }

      if (detailsRow) {
        resolvedDetails = detailsRow;
        const resolvedPhotoPath = detailsRow.photo_path || '';

        if (resolvedPhotoPath && !isAbsoluteUrl(resolvedPhotoPath)) {
          setAvatarStoragePath(resolvedPhotoPath);
        }

        setProfile((prev) => ({
          ...prev,
          firstName: detailsRow.first_name || prev.firstName,
          middleName: detailsRow.middle_name || '',
          lastName: detailsRow.last_name || prev.lastName,
          suffix: normalizePersonSuffix(detailsRow.suffix),
          birthdate: detailsRow.birthdate || '',
          gender: normalizeGenderOption(detailsRow.gender || prev.gender),
          contactNumber: detailsRow.contact_number || '',
          street: detailsRow.street || '',
          barangay: detailsRow.barangay || '',
          city: detailsRow.city || '',
          province: detailsRow.province || '',
          region: detailsRow.region || '',
          country: detailsRow.country || 'Philippines',
          joinedDate: detailsRow.joined_date || '',
          avatar: resolveAvatarUrl(resolvedPhotoPath) || prev.avatar,
          role: nextRole,
          email: nextResolvedEmail,
        }));
      }
    }

    pushUserProfileToShell({
      first_name: resolvedDetails?.first_name || profile.firstName,
      middle_name: resolvedDetails?.middle_name || profile.middleName,
      last_name: resolvedDetails?.last_name || profile.lastName,
      suffix: resolvedDetails?.suffix || profile.suffix,
      birthdate: resolvedDetails?.birthdate || profile.birthdate,
      gender: resolvedDetails?.gender || mapGenderForStorage(profile.gender),
      contact_number: resolvedDetails?.contact_number || profile.contactNumber,
      street: resolvedDetails?.street || profile.street,
      barangay: resolvedDetails?.barangay || profile.barangay,
      city: resolvedDetails?.city || profile.city,
      province: resolvedDetails?.province || profile.province,
      region: resolvedDetails?.region || profile.region,
      country: resolvedDetails?.country || profile.country,
      joined_date: resolvedDetails?.joined_date || profile.joinedDate,
      photo_path: resolvedDetails?.photo_path || avatarStoragePath || null,
      role: nextRole,
      email: nextResolvedEmail,
    });
  };

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      showToast('Supabase is not configured. Settings sync is disabled.');
      setIsProfileHydrated(true);
      return;
    }

    let isMounted = true;

    const bootstrap = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) return;

      if (error || !data?.session?.user?.id) {
        showToast('Could not load current account session.');
        setIsLoadingMfaStatus(false);
        return;
      }

      const currentUser = data.session.user;
      setAuthUserId(currentUser.id);
      setAuthEmail(currentUser.email || '');

      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (!isMounted) return;

      if (factorsError) {
        showToast(factorsError.message || 'Could not load Google Authenticator status.');
      }

      const hasVerifiedTotp = (factorsData?.totp || []).some((factor) => factor.status === 'verified');
      setMfaFactors((factorsData?.totp || []).filter((factor) => factor.status === 'verified'));
      setSecurity((prev) => ({ ...prev, twoFactorEnabled: hasVerifiedTotp }));
      setIsLoadingMfaStatus(false);

      setProfile((prev) => ({
        ...prev,
        email: currentUser.email || prev.email,
      }));

      try {
        await hydrateProfileFromDb(currentUser.id, currentUser.email || '');
      } catch (hydrateError) {
        showToast(hydrateError.message || 'Failed to sync profile data.');
      } finally {
        setIsProfileHydrated(true);
      }
    };

    bootstrap();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextUser = nextSession?.user;
      if (!nextUser?.id) return;

      setAuthUserId(nextUser.id);
      setAuthEmail(nextUser.email || '');
      setProfile((prev) => ({ ...prev, email: nextUser.email || prev.email }));
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
    // Bootstrap should run once on mount for this page lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleProfileImage = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    setProfile((prev) => ({ ...prev, avatar: objectUrl }));

    if (!isSupabaseConfigured || !supabase || !authUserId) {
      showToast('Preview updated. Login and Supabase config are required to save image.');
      return;
    }

    try {
      const safeName = file.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
      const filePath = `${authUserId}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from('profile_pictures')
        .upload(filePath, file, { upsert: true, contentType: file.type || 'image/jpeg' });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from('profile_pictures')
        .getPublicUrl(filePath);

      const publicUrl = publicUrlData?.publicUrl;
      if (!publicUrl) {
        throw new Error('Could not resolve uploaded profile image URL.');
      }

      setAvatarStoragePath(filePath);
      setProfile((prev) => ({ ...prev, avatar: publicUrl }));
      pushUserProfileToShell({
        first_name: profile.firstName,
        middle_name: profile.middleName,
        last_name: profile.lastName,
        suffix: profile.suffix,
        birthdate: profile.birthdate,
        gender: mapGenderForStorage(profile.gender),
        contact_number: profile.contactNumber,
        street: profile.street,
        barangay: profile.barangay,
        city: profile.city,
        province: profile.province,
        region: profile.region,
        country: profile.country,
        photo_path: filePath,
        email: authEmail || profile.email,
        role: profile.role,
      });
      showToast('Profile picture uploaded to storage bucket.');
    } catch (error) {
      showToast(mapStorageUploadError(error?.message) || 'Failed to upload profile image to storage.');
    }
  };

  const handleBrandingAssetFileChange = async (field, event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const previousAssetUrl = brandingAssets[field] || '';
    const previousAssetPath =
      brandingAssetPaths[field === 'logoImage' ? 'logoImagePath' : 'loginBackgroundImagePath'] || '';
    const localPreview = URL.createObjectURL(file);
    setBrandingAssets((prev) => ({ ...prev, [field]: localPreview }));
    setBrandingUploadStatus((prev) => ({ ...prev, [field]: true }));

    if (!isSupabaseConfigured || !supabase || !authUserId) {
      setBrandingUploadStatus((prev) => ({ ...prev, [field]: false }));
      URL.revokeObjectURL(localPreview);
      showToast('You must be logged in with Supabase configured to upload branding assets.');
      return;
    }

    try {
      const safeName = file.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
      const assetFolder = field === 'logoImage' ? 'logo' : 'login background';
      const filePath = `${authUserId}/${assetFolder}/${Date.now()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(BRANDING_BUCKET)
        .upload(filePath, file, { upsert: true, contentType: file.type || 'image/jpeg' });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage.from(BRANDING_BUCKET).getPublicUrl(filePath);
      const publicUrl = publicUrlData?.publicUrl;

      if (!publicUrl) {
        throw new Error('Could not resolve uploaded branding image URL.');
      }

      setBrandingAssets((prev) => ({ ...prev, [field]: publicUrl }));
      setBrandingAssetPaths((prev) => ({
        ...prev,
        [field === 'logoImage' ? 'logoImagePath' : 'loginBackgroundImagePath']: filePath,
      }));
      showToast(`${field === 'logoImage' ? 'Logo' : 'Login background'} uploaded successfully.`);
    } catch (error) {
      setBrandingAssets((prev) => ({ ...prev, [field]: previousAssetUrl }));
      setBrandingAssetPaths((prev) => ({
        ...prev,
        [field === 'logoImage' ? 'logoImagePath' : 'loginBackgroundImagePath']: previousAssetPath,
      }));
      showToast(mapStorageUploadError(error?.message) || 'Failed to upload branding asset.');
    } finally {
      setBrandingUploadStatus((prev) => ({ ...prev, [field]: false }));
      URL.revokeObjectURL(localPreview);
    }
  };

  const ensureUserRow = useCallback(async () => {
    if (userId) {
      return userId;
    }

    const { data: createdOrExistingUser, error } = await supabase
      .from('users')
      .upsert(
        {
          auth_user_id: authUserId,
          email: profile.email || authEmail,
          role: profile.role || 'Staff',
          is_active: true,
        },
        { onConflict: 'auth_user_id' },
      )
      .select('user_id')
      .single();

    if (error || !createdOrExistingUser?.user_id) {
      throw error || new Error('Unable to load profile user row.');
    }

    setUserId(createdOrExistingUser.user_id);
    return createdOrExistingUser.user_id;
  }, [userId, authUserId, profile.email, authEmail, profile.role]);

  const appendSecurityLog = async (action, description, resource = 'security/settings') => {
    const targetUserId = userId || await ensureUserRow();

    const result = await logAuditAction({
      action,
      description,
      resource,
      status: 'success',
    });

    if (result.logged) {
      await loadSecurityActivity(targetUserId);
    }
  };

  const handleSaveProfile = async () => {
    if (!isSupabaseConfigured || !supabase || !authUserId) {
      showToast('You must be logged in to update profile settings.');
      return;
    }

    try {
      const normalizedEmail = String(profile.email || authEmail || '').trim().toLowerCase();
      const normalizedContactNumber = formatPhilippineMobile(profile.contactNumber);
      if (!String(profile.firstName || '').trim() || !String(profile.lastName || '').trim()) {
        throw new Error('First name and last name are required.');
      }
      if (!profile.birthdate) {
        throw new Error('Birthdate is required.');
      }
      if (!isAtLeastAge(profile.birthdate, 18)) {
        throw new Error('You must be at least 18 years old.');
      }
      if (!profile.gender) {
        throw new Error('Gender is required.');
      }
      if (profile.contactNumber && !isValidPhilippineMobile(normalizedContactNumber)) {
        throw new Error('Contact number must use +63 912 345 6789 format.');
      }
      if (!normalizedEmail) {
        throw new Error('Email address is required.');
      }

      const ensuredUserId = await ensureUserRow();

      if (normalizedEmail !== String(authEmail || '').trim().toLowerCase()) {
        const { error: authEmailError } = await supabase.auth.updateUser({ email: normalizedEmail });
        if (authEmailError) throw authEmailError;
      }

      const { error: userUpdateError } = await supabase
        .from('users')
        .update({ email: normalizedEmail })
        .eq('user_id', ensuredUserId);

      if (userUpdateError) {
        throw userUpdateError;
      }

      const { data: existingDetails, error: detailsLookupError } = await supabase
        .from('user_details')
        .select('user_details_id')
        .eq('user_id', ensuredUserId)
        .maybeSingle();

      if (detailsLookupError) {
        throw detailsLookupError;
      }

      const safePhotoPath =
        avatarStoragePath || (profile.avatar && profile.avatar.length <= 255 ? profile.avatar : null);

      const detailsPayload = {
        user_id: ensuredUserId,
        first_name: String(profile.firstName || '').trim(),
        middle_name: String(profile.middleName || '').trim() || null,
        last_name: String(profile.lastName || '').trim(),
        suffix: normalizePersonSuffix(profile.suffix) || null,
        birthdate: profile.birthdate,
        gender: mapGenderForStorage(profile.gender),
        contact_number: normalizedContactNumber || null,
        street: String(profile.street || '').trim() || null,
        barangay: String(profile.barangay || '').trim() || null,
        city: String(profile.city || '').trim() || null,
        province: String(profile.province || '').trim() || null,
        region: String(profile.region || '').trim() || null,
        country: String(profile.country || '').trim() || 'Philippines',
        photo_path: safePhotoPath,
        updated_at: new Date().toISOString(),
      };

      if (existingDetails?.user_details_id) {
        const { error: updateError } = await supabase
          .from('user_details')
          .update(detailsPayload)
          .eq('user_details_id', existingDetails.user_details_id);

        if (updateError) {
          throw updateError;
        }
      } else {
        const { error: insertError } = await supabase.from('user_details').insert(detailsPayload);

        if (insertError) {
          throw insertError;
        }
      }

      setProfile((prev) => ({
        ...prev,
        email: normalizedEmail,
        contactNumber: normalizedContactNumber,
        suffix: normalizePersonSuffix(prev.suffix),
        gender: normalizeGenderOption(prev.gender),
      }));

      pushUserProfileToShell({
        email: normalizedEmail,
        role: profile.role,
        first_name: String(profile.firstName || '').trim(),
        middle_name: String(profile.middleName || '').trim(),
        last_name: String(profile.lastName || '').trim(),
        suffix: normalizePersonSuffix(profile.suffix),
        birthdate: profile.birthdate,
        gender: mapGenderForStorage(profile.gender),
        contact_number: normalizedContactNumber,
        street: String(profile.street || '').trim(),
        barangay: String(profile.barangay || '').trim(),
        city: String(profile.city || '').trim(),
        province: String(profile.province || '').trim(),
        region: String(profile.region || '').trim(),
        country: String(profile.country || '').trim() || 'Philippines',
        joined_date: profile.joinedDate,
        photo_path: safePhotoPath,
      });

      showToast(normalizedEmail !== String(authEmail || '').trim().toLowerCase()
        ? 'Profile saved. Check your new email address to confirm the change.'
        : 'Profile saved successfully.');
    } catch (saveError) {
      showToast(saveError?.message || 'Failed to save profile settings.');
    }
  };

  const validatePasswordForm = () => {
    if (!isSupabaseConfigured || !supabase) {
      showToast('Supabase is not configured.');
      return false;
    }

    if (!security.currentPassword) {
      showToast('Current password is required.');
      return false;
    }

    if (!security.newPassword || !security.confirmPassword) {
      showToast('New password and confirmation are required.');
      return false;
    }

    if (!isPasswordChecklistComplete) {
      showToast('New password does not meet all requirements.');
      return false;
    }

    if (security.newPassword !== security.confirmPassword) {
      showToast('New password and confirmation do not match.');
      return false;
    }

    if (security.currentPassword === security.newPassword) {
      showToast('Choose a new password that is different from your current password.');
      return false;
    }

    return true;
  };

  const beginPasswordEmailReauthentication = async () => {
    const { error } = await supabase.auth.reauthenticate();
    if (error) throw error;

    setIsOtpSent(true);
    setSecurity((prev) => ({ ...prev, passwordOtp: '' }));
    showToast('A password-change verification code was sent to your registered email.');
  };

  const completePasswordUpdate = async (nonceValue = '') => {
    const attributes = {
      password: security.newPassword,
      current_password: security.currentPassword,
    };
    if (nonceValue) attributes.nonce = nonceValue;

    const { error } = await supabase.auth.updateUser(attributes);
    if (error) throw error;
  };

  const handleRequestPasswordOtp = async () => {
    if (!validatePasswordForm() || isUpdatingPassword) return;

    setIsUpdatingPassword(true);
    try {
      await completePasswordUpdate();
      finalizePasswordUpdateSuccess();
    } catch (passwordError) {
      if (isAal2RequiredError(passwordError)) {
        try {
          const factorId = await resolvePasswordMfaFactor();
          setPasswordMfaFactorId(factorId);
          setPasswordMfaRequired(true);
          setPasswordMfaCode('');
          showToast('Enter your authenticator code to authorize this password change.');
        } catch (mfaError) {
          showToast(mfaError?.message || 'Authenticator verification could not be started.');
        }
      } else if (isPasswordReauthenticationRequired(passwordError)) {
        try {
          await beginPasswordEmailReauthentication();
        } catch (reauthError) {
          showToast(reauthError?.message || 'Unable to send the password-change verification code.');
        }
      } else {
        showToast(getPasswordUpdateErrorMessage(passwordError));
      }
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  const resolvePasswordMfaFactor = async () => {
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) {
      throw factorsError;
    }

    const verifiedTotp = (factorsData?.totp || []).find((factor) => factor.status === 'verified');
    if (!verifiedTotp?.id) {
      throw new Error('MFA is enabled but no verified authenticator factor was found.');
    }

    return verifiedTotp.id;
  };

  const finalizePasswordUpdateSuccess = () => {
    void appendSecurityLog('security.password_update', 'Updated account password.', 'security/password');
    setSecurity((prev) => ({
      ...prev,
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
      passwordOtp: '',
    }));
    setIsOtpSent(false);
    setPasswordMfaRequired(false);
    setPasswordMfaCode('');
    setPasswordMfaFactorId('');
    setShowPasswordSuccessModal(true);
    showToast('Password updated successfully.');
  };

  const handleVerifyPasswordMfaAndRetry = async (mfaCodeValue) => {
    if (!passwordMfaRequired || !passwordMfaFactorId || !mfaCodeValue || mfaCodeValue.length < 6 || isVerifyingPasswordMfa) {
      return;
    }

    setIsVerifyingPasswordMfa(true);

    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: passwordMfaFactorId,
      });

      if (challengeError) {
        throw challengeError;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: passwordMfaFactorId,
        challengeId: challengeData.id,
        code: mfaCodeValue,
      });

      if (verifyError) {
        throw verifyError;
      }

      try {
        await completePasswordUpdate(security.passwordOtp.trim());
        finalizePasswordUpdateSuccess();
      } catch (passwordError) {
        if (isPasswordReauthenticationRequired(passwordError) && !security.passwordOtp.trim()) {
          await beginPasswordEmailReauthentication();
        } else {
          throw passwordError;
        }
      }
    } catch (error) {
      showToast(getPasswordUpdateErrorMessage(error) || 'Authenticator verification failed.');
    } finally {
      setIsVerifyingPasswordMfa(false);
    }
  };

  const handleVerifyPasswordOtpAndUpdate = async (otpValue) => {
    if (!otpValue || otpValue.length < 6 || isVerifyingPasswordOtp) {
      return;
    }

    setIsVerifyingPasswordOtp(true);
    try {
      await completePasswordUpdate(otpValue);
      finalizePasswordUpdateSuccess();
    } catch (verifyError) {
      if (isAal2RequiredError(verifyError)) {
        try {
          const factorId = await resolvePasswordMfaFactor();
          setPasswordMfaFactorId(factorId);
          setPasswordMfaRequired(true);
          setPasswordMfaCode('');
          showToast('Authenticator verification is required. Enter your 6-digit app code below.');
        } catch (mfaError) {
          showToast(mfaError?.message || 'MFA is required but could not be started.');
        }
      } else {
        showToast(isPasswordReauthenticationRequired(verifyError)
          ? 'The email verification code is invalid or expired. Request a new code and try again.'
          : getPasswordUpdateErrorMessage(verifyError));
      }
    } finally {
      setIsVerifyingPasswordOtp(false);
    }
  };

  useEffect(() => {
    if (!isOtpSent || !security.passwordOtp || security.passwordOtp.length < 6) {
      return;
    }

    handleVerifyPasswordOtpAndUpdate(security.passwordOtp.trim());
  // Intentionally trigger only on OTP field/state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [security.passwordOtp, isOtpSent]);

  useEffect(() => {
    if (!passwordMfaRequired || !passwordMfaCode || passwordMfaCode.length < 6) {
      return;
    }

    handleVerifyPasswordMfaAndRetry(passwordMfaCode.trim());
  // Intentionally trigger only on MFA input/state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passwordMfaCode, passwordMfaRequired]);

  const refreshMfaFactors = async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) throw error;
    const verified = (data?.totp || []).filter((factor) => factor.status === 'verified');
    setMfaFactors(verified);
    setSecurity((prev) => ({ ...prev, twoFactorEnabled: verified.length > 0 }));
    return verified;
  };

  const startMfaEnrollment = async () => {
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) {
      throw factorsError;
    }

    const verifiedFactors = (factorsData?.totp || []).filter((factor) => factor.status === 'verified');
    if (verifiedFactors.length > 0) {
      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) throw assuranceError;
      if (assurance?.currentLevel !== 'aal2') {
        setMfaFactors(verifiedFactors);
        setMfaStepUp({ required: true, factorId: verifiedFactors[0].id, code: '' });
        showToast('Verify one of your existing authenticators before adding a backup.');
        return;
      }
    }

    const allTotpFactors = factorsData?.totp || [];
    const friendlyName = getNextMfaFriendlyName(allTotpFactors);
    const unverifiedFactors = allTotpFactors.filter((factor) => factor.status !== 'verified');
    for (const factor of unverifiedFactors) {
      const { error: cleanupError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (cleanupError && cleanupError.code !== 'mfa_factor_not_found') {
        // Continue with a new unique name. A stale unverified factor must not block recovery setup.
      }
    }

    let { data: enrollData, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName,
      issuer: 'Donivra',
    });

    if (enrollError && isMfaFactorNameConflict(enrollError)) {
      const uniqueSuffix = `${Date.now()}`.slice(-6);
      const retryResult = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Google Authenticator ${uniqueSuffix}`,
        issuer: 'Donivra',
      });
      enrollData = retryResult.data;
      enrollError = retryResult.error;
    }

    if (enrollError || !enrollData?.id) {
      throw enrollError || new Error('Unable to start Google Authenticator enrollment.');
    }

    setMfaSetup({
      enrolling: true,
      factorId: enrollData.id,
      qrSvg: enrollData?.totp?.qr_code || '',
      secret: enrollData?.totp?.secret || '',
      code: '',
    });
    showToast('Scan the QR code in Google Authenticator and enter the 6-digit code.');
  };

  const verifyMfaEnrollment = async (codeValue) => {
    if (!mfaSetup.factorId || !codeValue || codeValue.length < 6 || isVerifyingMfaCode) {
      return;
    }

    setIsVerifyingMfaCode(true);
    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaSetup.factorId,
      });

      if (challengeError) {
        throw challengeError;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaSetup.factorId,
        challengeId: challengeData.id,
        code: codeValue,
      });

      if (verifyError) {
        throw verifyError;
      }

      setSecurity((prev) => ({ ...prev, twoFactorEnabled: true }));
      setMfaSetup({ enrolling: false, factorId: '', qrSvg: '', secret: '', code: '' });
      await refreshMfaFactors();
      void appendSecurityLog('security.2fa_enable', 'Enabled two-factor authentication.', 'security/2fa');
      showToast('Google Authenticator is now enabled.');
    } catch (error) {
      showToast(error?.message || 'Invalid authenticator code.');
    } finally {
      setIsVerifyingMfaCode(false);
    }
  };

  useEffect(() => {
    if (!mfaSetup.enrolling || !mfaSetup.code || mfaSetup.code.length < 6) {
      return;
    }

    verifyMfaEnrollment(mfaSetup.code.trim());
  // Intentionally trigger only on enrollment code/state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mfaSetup.code, mfaSetup.enrolling]);

  const handleEnsureMfaEnabled = async () => {
    if (!isSupabaseConfigured || !supabase) {
      showToast('Supabase is not configured.');
      return;
    }

    try {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError) {
        throw factorsError;
      }

      const verifiedFactor = (factorsData?.totp || []).find((factor) => factor.status === 'verified');
      if (verifiedFactor) {
        setMfaFactors((factorsData?.totp || []).filter((factor) => factor.status === 'verified'));
        setSecurity((prev) => ({ ...prev, twoFactorEnabled: true }));
        showToast('Google Authenticator is already active. Use Add backup authenticator to register another device.');
        return;
      }

      await startMfaEnrollment();
    } catch (mfaError) {
      showToast(mfaError?.message || 'Unable to start Google Authenticator setup.');
    }
  };

  const handleStartMfaEnrollment = async () => {
    if (mfaSetup.enrolling || isManagingMfa) return;
    setIsManagingMfa(true);
    try {
      await startMfaEnrollment();
    } catch (error) {
      showToast(error?.message || 'Unable to start Google Authenticator setup.');
    } finally {
      setIsManagingMfa(false);
    }
  };

  const verifyMfaStepUpAndEnroll = async () => {
    if (!mfaStepUp.factorId || mfaStepUp.code.length !== 6 || isVerifyingMfaStepUp) return;
    setIsVerifyingMfaStepUp(true);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaStepUp.factorId,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaStepUp.factorId,
        challengeId: challenge.id,
        code: mfaStepUp.code,
      });
      if (verifyError) throw verifyError;

      setMfaStepUp({ required: false, factorId: '', code: '' });
      await startMfaEnrollment();
    } catch (error) {
      showToast(error?.message || 'Authenticator verification failed. Wait for a new code and try again.');
    } finally {
      setIsVerifyingMfaStepUp(false);
    }
  };

  const cancelMfaEnrollment = async () => {
    const factorId = mfaSetup.factorId;
    setMfaSetup({ enrolling: false, factorId: '', qrSvg: '', secret: '', code: '' });
    if (!factorId) return;
    try {
      await supabase.auth.mfa.unenroll({ factorId });
    } catch {
      // The unverified factor will be cleaned up before the next enrollment attempt.
    }
  };

  const handleRemoveMfaFactor = async (factor) => {
    if (!factor?.id || isManagingMfa) return;
    if (mfaFactors.length <= 1) {
      showToast('Add and verify a backup authenticator before removing your only active factor.');
      return;
    }
    if (!window.confirm(`Remove ${factor.friendly_name || 'this authenticator'}? You will no longer be able to use its codes.`)) return;

    setIsManagingMfa(true);
    try {
      const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) throw assuranceError;
      if (assurance?.currentLevel !== 'aal2') {
        throw new Error('Verify an active authenticator during sign-in before removing a factor.');
      }

      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
      await refreshMfaFactors();
      void appendSecurityLog('security.2fa_remove', 'Removed an authenticator factor.', 'security/2fa');
      showToast('Authenticator removed successfully.');
    } catch (error) {
      showToast(error?.message || 'Unable to remove the authenticator.');
    } finally {
      setIsManagingMfa(false);
    }
  };

  const buildBrandingThemePayload = useCallback(() => {
    if (brandingUploadStatus.logoImage || brandingUploadStatus.loginBackgroundImage) {
      return { payload: null, reason: 'uploading' };
    }

    const resolvedLogoImage = brandingAssetPaths.logoImagePath
      ? getStoragePublicUrl(BRANDING_BUCKET, brandingAssetPaths.logoImagePath)
      : brandingAssets.logoImage;
    const resolvedLoginBackgroundImage = brandingAssetPaths.loginBackgroundImagePath
      ? getStoragePublicUrl(BRANDING_BUCKET, brandingAssetPaths.loginBackgroundImagePath)
      : brandingAssets.loginBackgroundImage;

    if (isBlobUrl(resolvedLogoImage) || isBlobUrl(resolvedLoginBackgroundImage)) {
      return { payload: null, reason: 'local-only-media' };
    }

    return {
      payload: {
        primaryColor: tempColors.primary,
        primaryColorDark: tempColors.primaryDark,
        primaryColorLight: tempColors.primaryLight,
        secondaryColor: tempColors.secondary,
        secondaryColorDark: tempColors.secondaryDark,
        secondaryColorLight: tempColors.secondaryLight,
        tertiaryColor: tempColors.tertiary,
        tertiaryColorDark: tempColors.tertiaryDark,
        tertiaryColorLight: tempColors.tertiaryLight,
        backgroundColor: tempColors.background,
        primaryTextColor: tempColors.fontPrimary,
        secondaryTextColor: tempColors.fontSecondary,
        tertiaryTextColor: tempColors.fontTertiary || tempColors.fontSecondary,
        fontFamily: brandingMeta.primaryFontFamily,
        selectedFont: brandingMeta.primaryFontFamily,
        secondaryFontFamily: brandingMeta.secondaryFontFamily || brandingMeta.primaryFontFamily,
        brandName: brandingMeta.brandName,
        brandTagline: brandingMeta.brandTagline,
        logoImage: resolvedLogoImage,
        logoImagePath: brandingAssetPaths.logoImagePath,
        loginBackgroundImage: resolvedLoginBackgroundImage,
        loginBackgroundImagePath: brandingAssetPaths.loginBackgroundImagePath,
      },
      reason: '',
    };
  }, [
    brandingUploadStatus,
    brandingAssetPaths,
    brandingAssets,
    tempColors,
    brandingMeta,
  ]);

  const saveBrandingGlobally = useCallback(async ({ successMessage = '', showError = true } = {}) => {
    const { payload, reason } = buildBrandingThemePayload();
    if (!payload) {
      if (showError && reason === 'uploading') {
        showToast('Please wait for branding uploads to finish before saving.');
      } else if (showError && reason === 'local-only-media') {
        showToast('Branding image is still local only. Re-upload it and wait for upload success before saving.');
      }
      return { saved: false, error: null, reason };
    }

    let actorUserId = userId || null;

    if (!actorUserId && isSupabaseConfigured && supabase && authUserId) {
      try {
        actorUserId = await ensureUserRow();
      } catch (actorError) {
        if (showError) {
          showToast(actorError?.message || 'Unable to resolve user identity for Updated_By.');
        }
        return { saved: false, error: actorError, reason: 'missing-updated-by' };
      }
    }

    const { error } = await saveThemeGlobally(payload, actorUserId);
    if (error) {
      if (showError) {
        showToast(error.message || 'Failed to save global branding settings.');
      }
      return { saved: false, error, reason: 'save-error' };
    }

    if (successMessage) {
      showToast(successMessage);
    }

    return { saved: true, error: null, reason: '' };
  }, [authUserId, buildBrandingThemePayload, ensureUserRow, saveThemeGlobally, showToast, userId]);

  const handleSave = async () => {
    if (activeTab === 'profile') {
      await handleSaveProfile();
      return;
    }

    if (activeTab === 'security') {
      if (!security.newPassword && !security.confirmPassword && !security.currentPassword) {
        showToast('Security changes are already up to date.');
        return;
      }

      await handleRequestPasswordOtp();
      return;
    }

    if (activeTab === 'branding') {
      await saveBrandingGlobally({ successMessage: 'Global branding updated for all users.', showError: true });
      return;
    }

    showToast('Changes saved.');
  };

  const handleDiscard = async () => {
    if (activeTab === 'profile' && authUserId) {
      try {
        await hydrateProfileFromDb(authUserId, authEmail);
      } catch {
        // ignore errors during discard refresh
      }
    }

    if (activeTab === 'security') {
      setSecurity((prev) => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
        passwordOtp: '',
      }));
      setIsOtpSent(false);
      setPasswordMfaRequired(false);
      setPasswordMfaCode('');
      setPasswordMfaFactorId('');
      setMfaSetup((prev) => ({ ...prev, enrolling: false, factorId: '', qrSvg: '', secret: '', code: '' }));
    }

    if (activeTab === 'branding') {
      setTempColors({
        primary: theme.primaryColor,
        primaryDark: theme.primaryColorDark,
        primaryLight: theme.primaryColorLight,
        secondary: theme.secondaryColor,
        secondaryDark: theme.secondaryColorDark,
        secondaryLight: theme.secondaryColorLight,
        tertiary: theme.tertiaryColor,
        tertiaryDark: theme.tertiaryColorDark,
        tertiaryLight: theme.tertiaryColorLight,
        background: theme.backgroundColor || '#f4f7fb',
        fontPrimary: theme.primaryTextColor || '#0f172a',
        fontSecondary: theme.secondaryTextColor || '#64748b',
        fontTertiary: theme.tertiaryTextColor || '#94a3b8',
      });
      const defaultPreset = themePresetCards.find((preset) => preset.isDefault);
      setSelectedThemeId(defaultPreset ? defaultPreset.id : 'custom');
      setBrandingMeta((prev) => ({
        ...prev,
        brandName: theme.brandName || 'Donivra',
        brandTagline: theme.brandTagline || 'Every Strand Counts',
        primaryFontFamily: theme.selectedFont || theme.fontFamily || prev.primaryFontFamily,
        secondaryFontFamily: theme.secondaryFontFamily || theme.selectedFont || theme.fontFamily || prev.secondaryFontFamily,
      }));
      setBrandingAssets({
        logoImage: theme.logoImage || '',
        loginBackgroundImage: theme.loginBackgroundImage || '',
      });
      setBrandingAssetPaths({
        logoImagePath: theme.logoImagePath || '',
        loginBackgroundImagePath: theme.loginBackgroundImagePath || '',
      });
    }

    showToast('Changes discarded.');
  };

  const applyPreset = (preset) => {
    if (!preset.colors) {
      return;
    }
    setTempColors((prev) => ({ ...prev, ...preset.colors }));
    setBrandingMeta((prev) => ({
      ...prev,
      primaryFontFamily: preset.fontFamily || prev.primaryFontFamily,
      secondaryFontFamily: preset.secondaryFontFamily || preset.fontFamily || prev.secondaryFontFamily,
    }));
    setSelectedThemeId(preset.id);
    setColorInputMode('hex');
    showToast(`${preset.name} theme loaded.`);
  };

  const handleSaveCustomPreset = async () => {
    const trimmedName = String(newPresetName || '').trim();
    if (!trimmedName) {
      showToast('Enter a preset name first.');
      return;
    }

    if (trimmedName.toLowerCase() === 'default') {
      showToast('The Default preset name is reserved.');
      return;
    }

    setIsSavingPreset(true);
    const { data, error } = await createThemePreset({
      presetName: trimmedName,
      colors: tempColors,
      fontFamily: brandingMeta.primaryFontFamily,
      secondaryFontFamily: brandingMeta.secondaryFontFamily,
    });
    setIsSavingPreset(false);

    if (error) {
      showToast(error.message || 'Failed to save custom preset.');
      return;
    }

    setNewPresetName('');
    setSelectedThemeId(String(data?.Preset_ID || 'custom'));
    showToast('Custom preset saved.');
  };

  const handleSoftDeletePreset = async (preset) => {
    if (!preset || preset.isDefault) {
      showToast('Default preset cannot be deleted.');
      return;
    }

    setIsDeletingPresetId(preset.rawPresetId);
    const { error } = await softDeleteThemePreset(preset.rawPresetId);
    setIsDeletingPresetId(null);

    if (error) {
      showToast(error.message || 'Failed to delete preset.');
      return;
    }

    const defaultPreset = themePresetCards.find((item) => item.isDefault);
    setSelectedThemeId(defaultPreset ? defaultPreset.id : 'custom');
    showToast('Preset removed from available themes.');
  };

  const handleResetBrandingToDefault = () => {
    const defaultPreset = themePresetCards.find((preset) => preset.isDefault);

    if (!defaultPreset) {
      showToast('Default preset is unavailable.');
      return;
    }

    setTempColors((prev) => ({ ...prev, ...defaultPreset.colors }));
    setBrandingMeta((prev) => ({
      ...prev,
      brandName: 'Donivra',
      brandTagline: 'Every Strand Counts',
      primaryFontFamily: defaultPreset.fontFamily || 'Poppins',
      secondaryFontFamily: defaultPreset.secondaryFontFamily || defaultPreset.fontFamily || 'Poppins',
    }));
    setSelectedThemeId(defaultPreset.id);
    setColorInputMode('hex');
    showToast('Reset to Default preset. Click Save Branding Now to apply globally.');
  };

  const activeTabStyle = (tabId) =>
    activeTab === tabId
      ? { color: theme.primaryColor, borderBottomColor: theme.primaryColor }
      : undefined;

  return (
    <div className="w-full">
      <div className="w-full">
        <div className="mb-5">
          <h1 className="role-page-title text-slate-900">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">Manage your profile and account security{canManageBranding ? ', or update the platform branding.' : '.'}</p>
        </div>

        <div className="mb-5 overflow-x-auto border-b border-slate-200 tab-strip-scroll">
          <nav className="flex gap-8 min-w-max pr-6">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className="pb-4 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-700 whitespace-nowrap"
                style={activeTabStyle(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {activeTab === 'profile' && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <aside className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-4 2xl:col-span-3">
              <div className="flex flex-col items-center text-center">
                <div className="relative">
                  <img
                    src={profile.avatar || (isProfileHydrated ? DEFAULT_AVATAR : 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')}
                    alt="Profile"
                    className="h-32 w-32 rounded-2xl border border-slate-200 object-cover shadow-sm"
                  />
                  <label
                    className="absolute -bottom-2 -right-2 flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border-4 border-white text-white shadow-lg"
                    style={{ backgroundColor: theme.primaryColor }}
                    title="Upload profile picture"
                  >
                    <Camera size={16} />
                    <input type="file" accept="image/*" className="hidden" onChange={handleProfileImage} />
                  </label>
                </div>
                <h2 className="mt-5 text-xl font-bold text-slate-900">
                  {[profile.firstName, profile.middleName, profile.lastName, profile.suffix].filter(Boolean).join(' ') || 'Your profile'}
                </h2>
                <p className="mt-1 text-sm font-semibold" style={{ color: theme.primaryColor }}>{formatRoleLabel(profile.role)}</p>
                <p className="mt-1 break-all text-sm text-slate-500">{profile.email || 'No email address'}</p>
              </div>
              <div className="mt-6 space-y-3 border-t border-slate-200 pt-5 text-sm">
                <div className="flex items-center gap-3 text-slate-600"><User size={16} /><span>{formatRoleLabel(profile.role)}</span></div>
                <div className="flex items-center gap-3 text-slate-600"><Mail size={16} /><span className="min-w-0 truncate">{profile.email || 'Not provided'}</span></div>
                <div className="flex items-center gap-3 text-slate-600"><Phone size={16} /><span>{profile.contactNumber || 'Not provided'}</span></div>
                <div className="flex items-start gap-3 text-slate-600"><MapPin size={16} className="mt-0.5 flex-none" /><span>{[profile.barangay, profile.city, profile.province].filter(Boolean).join(', ') || 'Address not provided'}</span></div>
              </div>
              <p className="mt-5 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">Your role and joined date are managed by the system and cannot be changed here.</p>
            </aside>

            <div className="space-y-5 xl:col-span-8 2xl:col-span-9">
              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <div className="mb-5"><h3 className="text-lg font-bold text-slate-900">Personal information</h3><p className="mt-1 text-sm text-slate-500">Keep your identity details accurate and complete.</p></div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <label className="text-sm font-semibold text-slate-700">First name *<input autoComplete="given-name" value={profile.firstName} onChange={(e) => setProfile({ ...profile, firstName: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Middle name<input autoComplete="additional-name" value={profile.middleName} onChange={(e) => setProfile({ ...profile, middleName: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Last name *<input autoComplete="family-name" value={profile.lastName} onChange={(e) => setProfile({ ...profile, lastName: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Suffix<select autoComplete="honorific-suffix" value={profile.suffix} onChange={(e) => setProfile({ ...profile, suffix: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900">{PERSON_SUFFIX_OPTIONS.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}</select></label>
                  <label className="text-sm font-semibold text-slate-700">Birthdate *<input type="date" autoComplete="bday" max={getAdultBirthdateMax()} value={profile.birthdate} onChange={(e) => setProfile({ ...profile, birthdate: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Gender *<select autoComplete="sex" value={profile.gender} onChange={(e) => setProfile({ ...profile, gender: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900"><option value="">Select gender</option><option value="male">Male</option><option value="female">Female</option></select></label>
                  <label className="text-sm font-semibold text-slate-700 md:col-span-2">Mobile number<input type="tel" inputMode="numeric" autoComplete="tel" maxLength={16} placeholder="+63 912 345 6789" value={profile.contactNumber} onChange={(e) => setProfile({ ...profile, contactNumber: formatPhilippineMobile(e.target.value) })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                </div>
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
                <div className="mb-5"><h3 className="text-lg font-bold text-slate-900">Account and address</h3><p className="mt-1 text-sm text-slate-500">Email changes may require confirmation from your inbox.</p></div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <label className="text-sm font-semibold text-slate-700 md:col-span-2">Email address *<input type="email" autoComplete="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Joined date<input type="date" value={profile.joinedDate} readOnly className="mt-1.5 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-2.5 font-normal text-slate-500" /></label>
                  <label className="text-sm font-semibold text-slate-700 xl:col-span-2">Street<input autoComplete="street-address" value={profile.street} onChange={(e) => setProfile({ ...profile, street: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Barangay<input value={profile.barangay} onChange={(e) => setProfile({ ...profile, barangay: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">City / municipality<input autoComplete="address-level2" value={profile.city} onChange={(e) => setProfile({ ...profile, city: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Province<input autoComplete="address-level1" value={profile.province} onChange={(e) => setProfile({ ...profile, province: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Region<input value={profile.region} onChange={(e) => setProfile({ ...profile, region: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                  <label className="text-sm font-semibold text-slate-700">Country<input autoComplete="country-name" value={profile.country} onChange={(e) => setProfile({ ...profile, country: e.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-normal text-slate-900" /></label>
                </div>
              </section>

              <div className="flex flex-wrap items-center justify-end gap-3">
                <button type="button" onClick={handleDiscard} className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Discard changes</button>
                <button type="button" onClick={handleSave} className="inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-bold text-white" style={{ backgroundColor: theme.primaryColor }}><Save size={15} />Save profile</button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="space-y-5">
            <section className="rounded-xl border border-slate-200 p-5">
              <h3 className="text-xl font-bold text-slate-900 mb-4">Update Password</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-bold tracking-wider uppercase text-slate-500 mb-1.5">Current Password</label>
                  <div className="relative">
                    <input
                      type={showCurrentPassword ? 'text' : 'password'}
                      value={security.currentPassword}
                      onChange={(e) => setSecurity({ ...security, currentPassword: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 pr-10 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                    >
                      {showCurrentPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Password Requirements</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                    {[
                      ['At least 8 characters', passwordRuleChecks.minLength],
                      ['One uppercase letter', passwordRuleChecks.uppercase],
                      ['One lowercase letter', passwordRuleChecks.lowercase],
                      ['One number', passwordRuleChecks.number],
                      ['One special character', passwordRuleChecks.special],
                    ].map(([label, passed]) => (
                      <div key={label} className="flex items-center gap-2 text-slate-600">
                        {passed ? <Check size={14} className="text-emerald-600" /> : <X size={14} className="text-red-500" />}
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] font-bold tracking-wider uppercase text-slate-500 mb-1.5">New Password</label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={security.newPassword}
                        onChange={(e) => setSecurity({ ...security, newPassword: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 pr-10 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold tracking-wider uppercase text-slate-500 mb-1.5">Confirm Password</label>
                    <div className="relative">
                      <input
                        type={showConfirmPassword ? 'text' : 'password'}
                        value={security.confirmPassword}
                        onChange={(e) => setSecurity({ ...security, confirmPassword: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 pr-10 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500"
                      >
                        {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                </div>

                {(security.newPassword || security.confirmPassword) && (
                  <div className="text-sm font-medium">
                    {security.newPassword === security.confirmPassword && security.confirmPassword ? (
                      <span className="text-emerald-600">Matched</span>
                    ) : (
                      <span className="text-red-500">Mismatched</span>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleRequestPasswordOtp}
                    disabled={isUpdatingPassword || isVerifyingPasswordOtp || isVerifyingPasswordMfa}
                    className="px-4 py-2 rounded-lg text-white text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ backgroundColor: theme.primaryColor }}
                  >
                    {isUpdatingPassword ? 'Updating...' : 'Change Password'}
                  </button>
                  {isOtpSent && <span className="text-xs text-slate-500">OTP sent to your email. Enter it below to finish.</span>}
                </div>

                {isOtpSent && (
                  <div>
                    <label className="block text-[11px] font-bold tracking-wider uppercase text-slate-500 mb-1.5">Email OTP (Auto verify on 6 digits)</label>
                    <input
                      value={security.passwordOtp}
                      onChange={(e) => setSecurity({ ...security, passwordOtp: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                      inputMode="numeric"
                      placeholder="Enter 6-digit OTP"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm tracking-[0.3em]"
                    />
                    {isVerifyingPasswordOtp && <p className="text-xs mt-2 text-slate-500">Verifying OTP...</p>}
                  </div>
                )}

                {passwordMfaRequired && (
                  <div>
                    <label className="block text-[11px] font-bold tracking-wider uppercase text-slate-500 mb-1.5">Authenticator Code (Auto verify on 6 digits)</label>
                    <input
                      value={passwordMfaCode}
                      onChange={(e) => setPasswordMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      inputMode="numeric"
                      placeholder="Enter 6-digit authenticator code"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm tracking-[0.3em]"
                    />
                    {isVerifyingPasswordMfa && <p className="text-xs mt-2 text-slate-500">Verifying authenticator code...</p>}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 rounded-lg bg-emerald-50 p-2 text-emerald-700">
                    <ShieldCheck size={18} />
                  </span>
                  <div>
                  <h4 className="font-bold text-slate-900">Two-Factor Authentication</h4>
                    <p className="text-sm text-slate-500">
                      Google Authenticator is required for every management account and cannot be disabled in Settings.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {isLoadingMfaStatus ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">Checking...</span>
                  ) : security.twoFactorEnabled ? (
                    <>
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">Required · Active</span>
                      <button
                        type="button"
                        onClick={handleStartMfaEnrollment}
                        disabled={mfaSetup.enrolling || isManagingMfa}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      >
                        Add backup authenticator
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleEnsureMfaEnabled}
                      className="rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                      style={{ backgroundColor: theme.primaryColor }}
                      disabled={mfaSetup.enrolling}
                    >
                      Set up now
                    </button>
                  )}
                </div>
              </div>

              {mfaStepUp.required && (
                <div className="mt-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <div>
                    <p className="text-sm font-semibold text-blue-950">Verify an existing authenticator</p>
                    <p className="mt-1 text-xs leading-5 text-blue-800">Supabase requires an AAL2 session before another authenticator can be enrolled.</p>
                  </div>
                  {mfaFactors.length > 1 && (
                    <select
                      value={mfaStepUp.factorId}
                      onChange={(event) => setMfaStepUp((prev) => ({ ...prev, factorId: event.target.value, code: '' }))}
                      className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2.5 text-sm text-slate-800"
                    >
                      {mfaFactors.map((factor, index) => (
                        <option key={factor.id} value={factor.id}>{factor.friendly_name || `Google Authenticator ${index + 1}`}</option>
                      ))}
                    </select>
                  )}
                  <input
                    value={mfaStepUp.code}
                    onChange={(event) => setMfaStepUp((prev) => ({ ...prev, code: event.target.value.replace(/\D/g, '').slice(0, 6) }))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="Enter current 6-digit code"
                    className="w-full rounded-lg border border-blue-200 bg-white px-3 py-2.5 text-sm tracking-[0.3em]"
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={() => setMfaStepUp({ required: false, factorId: '', code: '' })} disabled={isVerifyingMfaStepUp} className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60">Cancel</button>
                    <button type="button" onClick={() => setShowMfaRecoveryHelp(true)} disabled={isVerifyingMfaStepUp} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-60">I no longer have access</button>
                    <button type="button" onClick={verifyMfaStepUpAndEnroll} disabled={mfaStepUp.code.length !== 6 || isVerifyingMfaStepUp} className="rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-60" style={{ backgroundColor: theme.primaryColor }}>
                      {isVerifyingMfaStepUp ? 'Verifying...' : 'Verify and continue'}
                    </button>
                  </div>
                </div>
              )}

              {showMfaRecoveryHelp && (
                <div className="mt-4 rounded-lg border border-amber-300 bg-amber-100 p-4 text-amber-950">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-bold">The lost authenticator must be reset</p>
                      <p className="mt-1 text-xs leading-5">
                        Email recovery creates an AAL1 session, but Supabase does not allow that session to replace an existing MFA factor. Ask a different authorized administrator to verify your identity and remove the lost factor. If this is the only administrator account, the Supabase project owner must remove it from Auth administration. You will then sign in again and enroll a new authenticator.
                      </p>
                    </div>
                    <button type="button" onClick={() => setShowMfaRecoveryHelp(false)} className="shrink-0 rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-950">Close</button>
                  </div>
                </div>
              )}

              {mfaFactors.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Verified authenticators</p>
                  {mfaFactors.map((factor, index) => (
                    <div key={factor.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{factor.friendly_name || `Google Authenticator ${index + 1}`}</p>
                        <p className="text-xs text-slate-500">Verified and available during sign-in</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveMfaFactor(factor)}
                        disabled={mfaFactors.length <= 1 || isManagingMfa}
                        title={mfaFactors.length <= 1 ? 'Add a backup authenticator before removing this factor.' : 'Remove authenticator'}
                        className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {mfaSetup.enrolling && (
                <div className="mt-4 rounded-lg border border-slate-200 p-4 space-y-3">
                  <p className="text-sm font-semibold text-slate-700">Google Authenticator Setup</p>
                  {mfaSetup.qrSvg && (
                    <div className="bg-white inline-block p-2 rounded border border-slate-200" dangerouslySetInnerHTML={{ __html: mfaSetup.qrSvg }} />
                  )}
                  {mfaSetup.secret && (
                    <p className="text-xs text-slate-500">
                      Manual key: <span className="font-mono text-slate-700">{mfaSetup.secret}</span>
                    </p>
                  )}
                  <input
                    value={mfaSetup.code}
                    onChange={(e) =>
                      setMfaSetup((prev) => ({
                        ...prev,
                        code: e.target.value.replace(/\D/g, '').slice(0, 6),
                      }))
                    }
                    placeholder="Enter 6-digit code"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm tracking-[0.3em]"
                  />
                  {isVerifyingMfaCode && <p className="text-xs text-slate-500">Verifying authenticator code...</p>}
                  <div className="flex justify-end">
                    <button type="button" onClick={cancelMfaEnrollment} disabled={isVerifyingMfaCode} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60">
                      Cancel setup
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">If you lose access to Google Authenticator</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs leading-5">
                  <li>Use a verified backup authenticator during sign-in, if available.</li>
                  <li>If every authenticator is unavailable, choose <strong>Recovery Email</strong> on the login verification screen to regain limited account access.</li>
                  <li>Ask an authorized administrator to reset the lost MFA factor after verifying your identity, then enroll a new authenticator at your next sign-in.</li>
                </ol>
                <p className="mt-2 text-xs">Supabase does not provide recovery codes, so registering a backup authenticator in advance is recommended.</p>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 p-5">
              <h4 className="font-bold text-slate-900 mb-3">Active Sessions</h4>
              <div className="space-y-3">
                {security.activeSessions.length === 0 && (
                  <div className="rounded-lg border border-slate-200 p-3 text-sm text-slate-500">
                    No active sessions recorded yet.
                  </div>
                )}
                {security.activeSessions.map((session) => (
                  <div key={session.device + session.lastActive} className="rounded-lg border border-slate-200 p-3 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-slate-900">{session.device}</p>
                      <p className="text-xs text-slate-500">{session.location} • {session.lastActive}</p>
                    </div>
                    {session.current && (
                      <span className="px-2 py-1 rounded-full text-[10px] font-bold" style={{ backgroundColor: `${theme.primaryColor}22`, color: theme.primaryColor }}>
                        Current
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 p-5">
              <h4 className="font-bold text-slate-900 mb-3">Log Sessions</h4>
              <div className="overflow-x-auto max-h-56 overflow-y-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-2 pr-3">Time</th>
                      <th className="py-2 pr-3">Action</th>
                      <th className="py-2">IP Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {security.loginSessions.length === 0 && (
                      <tr className="border-t border-slate-200">
                        <td className="py-2 pr-3 text-slate-500" colSpan={3}>
                          No security activity logs yet.
                        </td>
                      </tr>
                    )}
                    {security.loginSessions.map((log) => (
                      <tr key={log.time + log.action} className="border-t border-slate-200">
                        <td className="py-2 pr-3 text-slate-700">{log.time}</td>
                        <td className="py-2 pr-3 text-slate-700">{log.action}</td>
                        <td className="py-2 text-slate-700">{log.ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

          </div>
        )}

        {activeTab === 'branding' && (
          <div className="w-full space-y-5 xl:flex xl:items-start xl:gap-6 xl:space-y-0">
            <div className="space-y-6 xl:w-7/12">
            <section className="rounded-xl border border-slate-200 bg-white p-5 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-2xl font-bold text-slate-900">Theme Presets</h3>
                  <p className="text-sm text-slate-500">Quickly apply pre-curated color directions.</p>
                </div>
                {selectedThemeId === 'custom' && (
                  <button
                    type="button"
                    onClick={handleSaveCustomPreset}
                    disabled={isSavingPreset}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-[11px] font-black uppercase tracking-wider text-slate-700 disabled:opacity-60"
                  >
                    <Plus size={14} />
                    {isSavingPreset ? 'Saving...' : 'Save As Preset'}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-7">
                {visiblePresetCards.map((preset) => {
                  const isActive = preset.id === selectedThemeId;
                  return (
                    <div
                      key={preset.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (preset.isCustom) {
                          setSelectedThemeId('custom');
                          return;
                        }
                        applyPreset(preset);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          if (preset.isCustom) {
                            setSelectedThemeId('custom');
                            return;
                          }
                          applyPreset(preset);
                        }
                      }}
                      aria-pressed={isActive}
                      className="relative rounded-lg border p-2.5 text-left transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-300"
                      style={
                        isActive
                          ? {
                              borderColor: presetHighlightColor,
                              boxShadow: `0 0 0 2px ${presetHighlightColor}33`,
                              backgroundColor: '#f8fafc',
                            }
                          : { borderColor: '#e2e8f0', backgroundColor: '#f8fafc' }
                      }
                    >
                      {!preset.isCustom ? (
                        <div className="space-y-2">
                          <div className="h-10 rounded border border-slate-200 bg-white p-1 flex gap-1.5">
                            <div className="h-full flex-1 rounded" style={{ backgroundColor: preset.colors.primary }} />
                            <div className="h-full flex-1 rounded" style={{ backgroundColor: preset.colors.secondary }} />
                            <div className="h-full flex-1 rounded" style={{ backgroundColor: preset.colors.tertiary }} />
                          </div>
                          <div className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">
                            {preset.name}
                          </div>
                        </div>
                      ) : (
                        <div className="h-16 rounded border border-dashed border-slate-300 bg-white flex items-center justify-center text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
                          Custom
                        </div>
                      )}

                      {isActive && (
                        <span className="absolute right-2 top-2 rounded bg-slate-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">
                          Active
                        </span>
                      )}

                      {!preset.isCustom && !preset.isDefault && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleSoftDeletePreset(preset);
                          }}
                          title="Delete preset"
                          aria-label="Delete preset"
                          className={`absolute bottom-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-red-200 bg-white text-red-600 ${isDeletingPresetId === preset.rawPresetId ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-red-50'}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {hasMorePresetRows && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowAllPresets((prev) => !prev)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-50"
                  >
                    {showAllPresets ? 'View Less' : 'View More'}
                  </button>
                </div>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-5 md:p-6 space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-1">
                  {BRANDING_EDITOR_TABS.map((tab) => {
                    const isActive = brandingEditorTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setBrandingEditorTab(tab.id)}
                        className={`rounded px-3 py-1.5 text-xs ${isActive ? 'bg-white font-bold text-slate-900 shadow-sm' : 'font-medium text-slate-500'}`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1">
                  <button
                    type="button"
                    onClick={() => setColorInputMode('hex')}
                    className={`rounded px-2 py-0.5 text-[10px] ${colorInputMode === 'hex' ? 'bg-slate-100 font-bold text-slate-900' : 'text-slate-500'}`}
                  >
                    HEX
                  </button>
                  <button
                    type="button"
                    onClick={() => setColorInputMode('rgb')}
                    className={`rounded px-2 py-0.5 text-[10px] ${colorInputMode === 'rgb' ? 'bg-slate-100 font-bold text-slate-900' : 'text-slate-500'}`}
                  >
                    RGB
                  </button>
                </div>
              </div>

              {brandingEditorTab === 'appearance' && (
                <div className="space-y-6">
                  <article className="space-y-3">
                    <div>
                      <h4 className="text-3xl font-bold text-slate-800">Atmosphere</h4>
                      <p className="text-sm text-slate-500">Define the foundational canvas of your environment.</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Background Layer</p>
                      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-3">
                          <div className="relative" data-color-dropdown-root="true">
                            <button
                              type="button"
                              onClick={() => openColorPicker('background')}
                              className="h-9 w-9 rounded-md border border-slate-300"
                              style={{ backgroundColor: tempColors.background }}
                              title="Choose background color"
                              aria-label="Choose background color"
                            />
                            {activeColorPickerKey === 'background' && (
                              <div className="absolute left-0 top-11 z-50">
                                <ColorPickerPanel
                                  color={pickerDraftColor}
                                  onColorChange={setPickerDraftColor}
                                  onEnter={() => applyPickerColor('background')}
                                />
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-700">Base Surface</p>
                            <p className="text-[11px] text-slate-500">Global page background</p>
                          </div>
                        </div>
                        <input
                          value={colorInputMode === 'rgb' ? colorValueToRgb(tempColors.background) : colorValueToHex(tempColors.background)}
                          onChange={(event) =>
                            setTempColors({
                              ...tempColors,
                              background: colorInputMode === 'rgb' ? colorValueToRgb(event.target.value) : colorValueToHex(event.target.value),
                            })
                          }
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 sm:max-w-xs"
                        />
                      </div>
                    </div>
                  </article>

                  <article className="space-y-3">
                    <div>
                      <h4 className="text-3xl font-bold text-slate-800">Brand Spectrum</h4>
                      <p className="text-sm text-slate-500">Synchronize your core identity across all components.</p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {[
                        { key: 'primary', label: 'Primary', hint: 'Primary actions and highlights' },
                        { key: 'secondary', label: 'Secondary', hint: 'Supporting panels and controls' },
                        { key: 'tertiary', label: 'Tertiary', hint: 'Accents and emphasis states' },
                      ].map((item) => (
                        <div key={item.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{item.label}</p>
                          <div className="relative my-2" data-color-dropdown-root="true">
                            <button
                              type="button"
                              onClick={() => openColorPicker(item.key)}
                              className="h-16 w-full rounded-md border border-slate-300"
                              style={{ backgroundColor: tempColors[item.key] }}
                              title={`Choose ${item.label.toLowerCase()} color`}
                              aria-label={`Choose ${item.label.toLowerCase()} color`}
                            />
                            {activeColorPickerKey === item.key && (
                              <div className="absolute left-0 top-[calc(100%+8px)] z-50">
                                <ColorPickerPanel
                                  color={pickerDraftColor}
                                  onColorChange={setPickerDraftColor}
                                  onEnter={() => applyPickerColor(item.key)}
                                />
                              </div>
                            )}
                          </div>
                          <input
                            value={colorInputMode === 'rgb' ? colorValueToRgb(tempColors[item.key]) : colorValueToHex(tempColors[item.key])}
                            onChange={(event) =>
                              setTempColors({
                                ...tempColors,
                                [item.key]: colorInputMode === 'rgb' ? colorValueToRgb(event.target.value) : colorValueToHex(event.target.value),
                              })
                            }
                            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                          />
                          <p className="mt-2 text-[11px] text-slate-500">{item.hint}</p>
                        </div>
                      ))}
                    </div>
                  </article>

                  <article className="space-y-3">
                    <div>
                      <h4 className="text-3xl font-bold text-slate-800">Typography Palette</h4>
                      <p className="text-sm text-slate-500">Editorial legibility and tonal hierarchy.</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 divide-y divide-slate-200">
                      {[
                        { key: 'fontPrimary', label: 'Heading Color', icon: 'T', hint: 'Used for page titles and section headers' },
                        { key: 'fontSecondary', label: 'Body Text', icon: 'F', hint: 'Used for primary paragraph content' },
                        { key: 'fontTertiary', label: 'Meta & Details', icon: 'D', hint: 'Used for helper text and metadata labels' },
                      ].map((item) => (
                        <div key={item.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-start gap-3">
                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-xs font-bold text-slate-600">
                              {item.icon}
                            </span>
                            <div>
                              <p className="text-sm font-semibold text-slate-700">{item.label}</p>
                              <p className="text-[11px] text-slate-500">{item.hint}</p>
                            </div>
                          </div>

                          <div className="flex w-full items-center gap-2 sm:max-w-sm">
                            <input
                              value={colorInputMode === 'rgb' ? colorValueToRgb(tempColors[item.key]) : colorValueToHex(tempColors[item.key])}
                              onChange={(event) =>
                                setTempColors({
                                  ...tempColors,
                                  [item.key]: colorInputMode === 'rgb' ? colorValueToRgb(event.target.value) : colorValueToHex(event.target.value),
                                })
                              }
                              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                            />
                            <div className="relative" data-color-dropdown-root="true">
                              <button
                                type="button"
                                onClick={() => openColorPicker(item.key)}
                                className="h-6 w-6 rounded-full border border-slate-300"
                                style={{ backgroundColor: tempColors[item.key] }}
                                title={`Choose ${item.label.toLowerCase()}`}
                                aria-label={`Choose ${item.label.toLowerCase()}`}
                              />
                              {activeColorPickerKey === item.key && (
                                <div className="absolute right-0 top-8 z-50">
                                  <ColorPickerPanel
                                    color={pickerDraftColor}
                                    onColorChange={setPickerDraftColor}
                                    onEnter={() => applyPickerColor(item.key)}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Primary Font Family</label>
                        <select
                          value={brandingMeta.primaryFontFamily}
                          onChange={(event) => setBrandingMeta({ ...brandingMeta, primaryFontFamily: event.target.value })}
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        >
                          {(googleFonts || []).map((fontName) => (
                            <option key={fontName} value={fontName}>{fontName}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Secondary Font Family</label>
                        <select
                          value={brandingMeta.secondaryFontFamily}
                          onChange={(event) => setBrandingMeta({ ...brandingMeta, secondaryFontFamily: event.target.value })}
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        >
                          {(googleFonts || []).map((fontName) => (
                            <option key={fontName} value={fontName}>{fontName}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </article>
                </div>
              )}

              {brandingEditorTab === 'branding' && (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Brand Name</label>
                    <input
                      value={brandingMeta.brandName}
                      onChange={(event) => setBrandingMeta({ ...brandingMeta, brandName: event.target.value })}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Brand Tagline</label>
                    <input
                      value={brandingMeta.brandTagline}
                      onChange={(event) => setBrandingMeta({ ...brandingMeta, brandTagline: event.target.value })}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="space-y-2 sm:col-span-2">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Upload Logo Image</label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => handleBrandingAssetFileChange('logoImage', event)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="space-y-2 sm:col-span-2">
                    <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Upload Login Background</label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => handleBrandingAssetFileChange('loginBackgroundImage', event)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:col-span-2 md:grid-cols-2">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Current Logo</p>
                      <img
                        src={brandingAssets.logoImage || theme.logoImage || DEFAULT_AVATAR}
                        alt="Logo preview"
                        className="h-24 w-24 rounded-lg border border-slate-200 object-cover"
                      />
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-500">Current Login Background</p>
                      <img
                        src={brandingAssets.loginBackgroundImage || theme.loginBackgroundImage || DEFAULT_AVATAR}
                        alt="Login background preview"
                        className="h-24 w-full rounded-lg border border-slate-200 object-cover"
                      />
                    </div>
                  </div>
                </div>
              )}

              {selectedThemeId === 'custom' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2">Custom Preset Name</label>
                  <input
                    value={newPresetName}
                    onChange={(event) => setNewPresetName(event.target.value)}
                    placeholder="Name this custom preset"
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </div>
              )}
            </section>

            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleResetBrandingToDefault}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-500"
              >
                Reset To Default
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider text-white"
                style={{ backgroundColor: theme.primaryColor }}
              >
                <Save size={14} />
                Save Branding Now
              </button>
            </div>
            </div>

            <div className="branding-preview-rail xl:w-5/12">
            <section className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h4 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                  <Eye size={16} />
                  Live Theme Preview
                </h4>
                <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPreviewView('login')}
                    className="px-3 py-1.5 text-[11px] font-bold"
                    style={previewView === 'login' ? { backgroundColor: `${presetHighlightColor}20`, color: presetHighlightColor } : { color: '#64748b' }}
                  >
                    Login
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewView('home')}
                    className="px-3 py-1.5 text-[11px] font-bold"
                    style={previewView === 'home' ? { backgroundColor: `${presetHighlightColor}20`, color: presetHighlightColor } : { color: '#64748b' }}
                  >
                    Home
                  </button>
                </div>
              </div>

              <div className="bg-slate-900 rounded-2xl p-1.5 shadow-xl overflow-hidden border-[10px] border-slate-800 w-full">
                {previewView === 'login' ? (
                  <div className="bg-white rounded-lg aspect-[4/3] overflow-hidden" style={previewStyle}>
                    <div className="h-full w-full grid grid-cols-12">
                      <div
                        className="col-span-5 hidden sm:flex items-center justify-center p-3"
                        style={{
                          background: `linear-gradient(135deg, ${tempColors.primaryLight}15 0%, ${tempColors.primary}10 50%, ${tempColors.primaryDark}15 100%)`,
                        }}
                      >
                        <div className="w-full max-w-[170px]">
                          <div className="rounded-xl overflow-hidden shadow-lg border border-slate-200 mb-3">
                            <img
                              src={brandingAssets.loginBackgroundImage || theme.loginBackgroundImage || DEFAULT_AVATAR}
                              alt="Login preview background"
                              className="w-full h-24 object-cover"
                            />
                          </div>
                          <h4 className="text-[10px] font-bold text-center" style={{ color: tempColors.primary }}>
                            {brandingMeta.brandTagline || theme.brandTagline || 'Every Strand Counts'}
                          </h4>
                        </div>
                      </div>

                      <div className="col-span-12 sm:col-span-7 p-3 bg-white">
                        <div className="flex items-center gap-2 mb-3">
                          <img
                            src={brandingAssets.logoImage || theme.logoImage || DEFAULT_AVATAR}
                            alt="Logo preview"
                            className="w-7 h-7 rounded object-cover border border-slate-200"
                          />
                          <span className="text-[11px] font-bold text-slate-900">
                            {brandingMeta.brandName || theme.brandName || 'Donivra'}
                          </span>
                        </div>

                        <div className="h-2 w-24 rounded mb-1" style={{ backgroundColor: tempColors.fontPrimary }} />
                        <div className="h-1.5 w-32 rounded mb-3" style={{ backgroundColor: tempColors.fontSecondary }} />

                        <div className="space-y-2">
                          <div className="h-6 rounded border border-slate-200 bg-slate-50" />
                          <div className="h-6 rounded border border-slate-200 bg-slate-50" />
                          <div className="h-6 rounded" style={{ backgroundColor: tempColors.primary }} />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-[#f4f7fb] rounded-lg aspect-[4/3] overflow-hidden border border-slate-200 flex text-[8px]">
                    <div className="w-[30%] bg-white border-r border-slate-200 flex flex-col">
                      <div className="h-8 px-2.5 flex items-center gap-2 border-b border-slate-100">
                        <div className="w-3.5 h-3.5 rounded" style={{ backgroundColor: tempColors.primary }} />
                        <div className="h-1.5 w-12 rounded" style={{ backgroundColor: tempColors.fontPrimary }} />
                      </div>
                      <div className="p-2.5 space-y-2">
                        <div className="h-3.5 rounded-md flex items-center px-1.5" style={{ backgroundColor: `${tempColors.primary}20` }}>
                          <div className="h-1.5 w-8 rounded" style={{ backgroundColor: tempColors.primary }} />
                        </div>
                        <div className="h-3.5 rounded-md bg-slate-100" />
                        <div className="h-3.5 rounded-md bg-slate-100" />
                      </div>
                    </div>

                    <div className="flex-1 p-3">
                      <div className="h-5 flex items-center justify-between mb-3">
                        <div>
                          <div className="h-2 w-16 rounded mb-1" style={{ backgroundColor: tempColors.fontPrimary }} />
                          <div className="h-1.5 w-20 rounded" style={{ backgroundColor: tempColors.fontSecondary }} />
                        </div>
                        <div className="h-3.5 w-12 rounded-md" style={{ backgroundColor: tempColors.primary }} />
                      </div>

                      <div className="grid grid-cols-3 gap-2 mb-3">
                        {[tempColors.primary, tempColors.secondary, '#f59e0b'].map((cardColor) => (
                          <div key={cardColor} className="bg-white border border-slate-200 rounded-lg p-2">
                            <div className="h-2 w-2 rounded mb-2" style={{ backgroundColor: `${cardColor}33` }} />
                            <div className="h-1.5 w-10 rounded mb-1" style={{ backgroundColor: tempColors.fontSecondary }} />
                            <div className="h-2.5 w-8 rounded" style={{ backgroundColor: cardColor }} />
                          </div>
                        ))}
                      </div>

                      <div className="bg-white border border-slate-200 rounded-lg p-2">
                        <div className="h-1.5 w-12 rounded mb-2" style={{ backgroundColor: tempColors.fontPrimary }} />
                        <div className="h-4 rounded bg-slate-100 mb-2" />
                        <div className="h-4 rounded bg-slate-100" />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Selected Fonts</p>
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-slate-600">
                    Heading: <span className="font-semibold text-slate-800">{brandingMeta.primaryFontFamily || theme.selectedFont || theme.fontFamily}</span>
                  </p>
                  <p className="text-xs text-slate-600">
                    Body: <span className="font-semibold text-slate-800">{brandingMeta.secondaryFontFamily || brandingMeta.primaryFontFamily || theme.secondaryFontFamily || theme.fontFamily}</span>
                  </p>
                </div>
                <div className="mt-3 space-y-1">
                  <p className="text-sm font-bold text-slate-800" style={{ fontFamily: brandingMeta.primaryFontFamily || theme.selectedFont || theme.fontFamily }}>
                    Heading sample preview
                  </p>
                  <p className="text-xs text-slate-600" style={{ fontFamily: brandingMeta.secondaryFontFamily || brandingMeta.primaryFontFamily || theme.secondaryFontFamily || theme.fontFamily }}>
                    Body sample preview text using your current font selection.
                  </p>
                </div>
              </div>
            </section>
            </div>
          </div>
        )}
      </div>

      {showPasswordSuccessModal && (
        <div className="fixed inset-0 bg-black/45 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 p-6">
            <h4 className="text-xl font-bold text-slate-900 mb-2">Password Updated</h4>
            <p className="text-sm text-slate-600 mb-5">
              Your password was changed successfully after OTP verification.
            </p>
            <button
              type="button"
              onClick={() => setShowPasswordSuccessModal(false)}
              className="w-full py-2.5 rounded-lg text-white font-semibold"
              style={{ backgroundColor: theme.primaryColor }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed right-6 bottom-6 z-50 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 px-4 py-2.5 text-sm font-semibold shadow-lg">
          {toast}
        </div>
      )}

      <style>{`
        .tab-strip-scroll {
          scrollbar-width: thin;
          scrollbar-color: #94a3b8 transparent;
        }

        @media (min-width: 1024px) {
          .branding-preview-rail {
            position: sticky;
            position: -webkit-sticky;
            top: 1.5rem;
            align-self: flex-start;
          }
        }

        .tab-strip-scroll::-webkit-scrollbar {
          height: 8px;
        }

        .tab-strip-scroll::-webkit-scrollbar-thumb {
          background: #94a3b8;
          border-radius: 999px;
        }
      `}</style>
    </div>
  );
}
