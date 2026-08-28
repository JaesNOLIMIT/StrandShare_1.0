import React, { useEffect, useMemo, useState } from 'react';
import { motion, useAnimation } from 'framer-motion';
import { useTheme } from '../../../context/ThemeContext';
import { ArrowLeft, ArrowRight, Coins, Eye, EyeOff, Heart, Lock, Mail, QrCode, ShieldCheck } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { getPasswordRecoveryRedirectUrl } from '../../../lib/passwordRecovery';
import { logAuditAction } from '../../../lib/auditLogger';
import { toCanonicalRole } from '../../../lib/roleUtils';
import {
  clearLoginSessionPersistence,
  configureLoginSessionPersistence,
} from '../../../lib/sessionPersistence';

const USER_PROFILE_STORAGE_KEY = 'Donivra_user_profile';
const USER_PROFILE_READY_EVENT = 'Donivra-profile-ready';
const EMAIL_OTP_COOLDOWN_SECONDS = 60;
const DEFAULT_LOGIN_BG = 'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1080&q=80';

function getPasswordResetErrorMessage(error) {
  const code = String(error?.code || '').trim().toLowerCase();
  const rawMessage = [error?.message, error?.error_description, error?.error]
    .find((value) => typeof value === 'string' && value.trim());
  const message = String(rawMessage || '').trim();
  const normalized = message.toLowerCase();

  if (code === 'over_email_send_rate_limit' || normalized.includes('rate limit')) {
    return 'Too many reset emails were requested. Please wait a few minutes, then try again.';
  }

  if (code === 'email_address_not_authorized' || normalized.includes('email address not authorized')) {
    return 'Password reset email delivery is not enabled for this address. Please contact an administrator.';
  }

  // auth-js can serialize a browser network/CORS exception as the unhelpful string "{}".
  if (
    !message ||
    message === '{}' ||
    message === '[object Object]' ||
    normalized.includes('failed to fetch') ||
    normalized.includes('network request failed')
  ) {
    return 'Unable to contact the password service. Check your internet connection and try again.';
  }

  return message;
}

function withAlpha(colorValue, alpha) {
  const input = String(colorValue || '').trim();
  if (!input) {
    return `rgba(2, 117, 216, ${alpha})`;
  }

  const clampedAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  const normalizedAlpha = Number(clampedAlpha.toFixed(3));

  const hex6 = input.match(/^#([0-9a-f]{6})$/i);
  if (hex6) {
    const hex = hex6[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  const hex3 = input.match(/^#([0-9a-f]{3})$/i);
  if (hex3) {
    const hex = hex3[1];
    const r = parseInt(`${hex[0]}${hex[0]}`, 16);
    const g = parseInt(`${hex[1]}${hex[1]}`, 16);
    const b = parseInt(`${hex[2]}${hex[2]}`, 16);
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  const rgb = input.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map((part) => {
      const n = Number(part);
      return Math.max(0, Math.min(255, Number.isFinite(n) ? n : 0));
    });
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  return input;
}

export default function LoginPage({ authNotice, onClearNotice }) {
  const { theme, isThemeReady } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [mfaMode, setMfaMode] = useState(null);
  const [mfaMethod, setMfaMethod] = useState('authenticator');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaFactorId, setMfaFactorId] = useState(null);
  const [mfaQrSvg, setMfaQrSvg] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaPendingProfile, setMfaPendingProfile] = useState(null);
  const [mfaPendingAuthUserId, setMfaPendingAuthUserId] = useState(null);
  const [emailOtpCode, setEmailOtpCode] = useState('');
  const [emailOtpTarget, setEmailOtpTarget] = useState('');
  const [emailOtpRequested, setEmailOtpRequested] = useState(false);
  const [emailOtpCooldown, setEmailOtpCooldown] = useState(0);
  const [isSendingEmailOtp, setIsSendingEmailOtp] = useState(false);

  useEffect(() => {
    if (emailOtpCooldown <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setEmailOtpCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [emailOtpCooldown]);

  const clearMessages = () => {
    if (errorMessage) {
      setErrorMessage('');
    }
    if (successMessage) {
      setSuccessMessage('');
    }
    if (authNotice && onClearNotice) {
      onClearNotice();
    }
  };

  const clearMfaState = () => {
    setMfaMode(null);
    setMfaMethod('authenticator');
    setMfaCode('');
    setMfaFactorId(null);
    setMfaQrSvg('');
    setMfaSecret('');
    setMfaPendingProfile(null);
    setMfaPendingAuthUserId(null);
    setEmailOtpCode('');
    setEmailOtpTarget('');
    setEmailOtpRequested(false);
    setEmailOtpCooldown(0);
  };

  const recoverProfileByEmail = async (authUserId) => {
    const { data: authData, error: authError } = await supabase.auth.getUser();

    if (authError) {
      return null;
    }

    const normalizedEmail = String(authData?.user?.email || '').trim().toLowerCase();

    if (!normalizedEmail) {
      return null;
    }

    const { data: emailProfiles, error: emailProfilesError } = await supabase
      .from('users')
      .select('user_id, auth_user_id, email, role, is_active, access_start, access_end')
      .ilike('email', normalizedEmail);

    if (emailProfilesError) {
      throw new Error(emailProfilesError.message);
    }

    if (!Array.isArray(emailProfiles) || emailProfiles.length === 0) {
      return null;
    }

    if (emailProfiles.length > 1) {
      throw new Error('Multiple account profiles use this email. Please contact an administrator.');
    }

    const matchedProfile = emailProfiles[0];

    if (!matchedProfile?.user_id) {
      return null;
    }

    if (String(matchedProfile.auth_user_id || '') !== String(authUserId || '')) {
      const { error: relinkError } = await supabase
        .from('users')
        .update({
          auth_user_id: authUserId,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', matchedProfile.user_id);

      if (relinkError) {
        throw new Error(relinkError.message);
      }
    }

    return {
      ...matchedProfile,
      auth_user_id: authUserId,
    };
  };

  const getValidatedProfileByAuthUserId = async (authUserId) => {
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('user_id, auth_user_id, email, role, is_active, access_start, access_end')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (profileError) {
      throw new Error('Your account profile could not be found. Please contact an administrator.');
    }

    let resolvedProfile = profile;

    if (!resolvedProfile?.user_id) {
      resolvedProfile = await recoverProfileByEmail(authUserId);
    }

    if (!resolvedProfile?.user_id) {
      throw new Error('Your account profile could not be found. Please contact an administrator.');
    }

    if (!resolvedProfile?.role) {
      throw new Error('Your account does not have a role yet. Please contact an administrator.');
    }

    const managementRole = toCanonicalRole(resolvedProfile.role);
    if (!['admin', 'staff', 'specialist', 'h_representative'].includes(managementRole)) {
      throw new Error('This portal is restricted to authorized management accounts.');
    }

    const now = new Date();
    const withinStart = !resolvedProfile.access_start || new Date(resolvedProfile.access_start) <= now;
    const withinEnd = !resolvedProfile.access_end || new Date(resolvedProfile.access_end) >= now;

    if (resolvedProfile.is_active === false) {
      throw new Error('Your account is currently inactive. Please contact an administrator.');
    }

    if (!withinStart || !withinEnd) {
      throw new Error('Your account is outside the allowed access schedule. Please contact an administrator.');
    }

    return enrichProfileWithDetails(resolvedProfile);
  };

  const finalizeLoginProfile = (profile, authUserId, fallbackEmail) => {
    const userAgent = navigator.userAgent || 'Unknown browser';
    const platform = navigator.platform || 'Unknown platform';
    const deviceSource = `${userAgent} on ${platform}`;

    const validatedProfile = {
      ...profile,
      auth_user_id: authUserId,
      email: profile?.email || fallbackEmail,
    };

    localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(validatedProfile));

    window.dispatchEvent(
      new CustomEvent(USER_PROFILE_READY_EVENT, {
        detail: {
          authUserId,
          profile: validatedProfile,
        },
      }),
    );

    void logAuditAction({
      action: 'auth.sign_in',
      description: `User completed login flow from ${deviceSource}.`,
      resource: `auth/session:${platform}`,
      status: 'success',
      userProfile: validatedProfile,
    });
  };

  const enrichProfileWithDetails = async (baseProfile) => {
    if (!baseProfile?.user_id) {
      return baseProfile;
    }

    const { data: detailsRow, error: detailsError } = await supabase
      .from('user_details')
      .select('first_name, middle_name, last_name, suffix, gender, photo_path')
      .eq('user_id', baseProfile.user_id)
      .maybeSingle();

    if (detailsError) {
      return baseProfile;
    }

    if (!detailsRow) {
      return baseProfile;
    }

    return {
      ...baseProfile,
      first_name: detailsRow.first_name || '',
      middle_name: detailsRow.middle_name || '',
      last_name: detailsRow.last_name || '',
      suffix: detailsRow.suffix || '',
      gender: detailsRow.gender || '',
      photo_path: detailsRow.photo_path || '',
    };
  };

  const beginMfaStep = async (profile, authUserId, fallbackEmail) => {
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();

    if (factorsError) {
      throw factorsError;
    }

    const verifiedTotpFactor = (factorsData?.totp || []).find((factor) => factor.status === 'verified');

    if (verifiedTotpFactor) {
      setMfaPendingProfile(profile);
      setMfaPendingAuthUserId(authUserId);
      setMfaFactorId(verifiedTotpFactor.id);
      setMfaMode('verify');
      setMfaMethod('authenticator');
      setSuccessMessage('Enter your Google Authenticator code to continue.');
      return;
    }

    // Remove stale unverified factors from interrupted enroll attempts.
    const unverifiedTotpFactors = (factorsData?.totp || []).filter((factor) => factor.status !== 'verified');
    for (const factor of unverifiedTotpFactors) {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }

    let enrollData = null;
    let enrollError = null;

    const firstEnroll = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Google Authenticator',
      issuer: 'Donivra',
    });

    enrollData = firstEnroll.data;
    enrollError = firstEnroll.error;

    // If provider still reports duplicate friendly name, retry with a unique display name.
    if (enrollError?.message?.includes('friendly name')) {
      const secondEnroll = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Google Authenticator ${new Date().toISOString().slice(0, 10)}`,
        issuer: 'Donivra',
      });
      enrollData = secondEnroll.data;
      enrollError = secondEnroll.error;
    }

    if (enrollError || !enrollData?.id) {
      throw enrollError || new Error('Unable to create MFA factor. Please try again.');
    }

    setMfaPendingProfile(profile);
    setMfaPendingAuthUserId(authUserId);
    setMfaFactorId(enrollData.id);
    setMfaQrSvg(enrollData?.totp?.qr_code || '');
    setMfaSecret(enrollData?.totp?.secret || '');
    setMfaMode('enroll');
    setMfaMethod('authenticator');
    setSuccessMessage('Scan the QR code with Google Authenticator, then enter the 6-digit code.');
  };

  const handleMfaVerify = async (e) => {
    e.preventDefault();
    clearMessages();

    if (!mfaFactorId || !mfaPendingAuthUserId || !mfaPendingProfile) {
      setErrorMessage('MFA session expired. Please log in again.');
      clearMfaState();
      return;
    }

    if (!mfaCode.trim()) {
      setErrorMessage('Enter the 6-digit code from Google Authenticator.');
      return;
    }

    setIsSubmitting(true);

    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId,
      });

      if (challengeError) {
        throw challengeError;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: challengeData.id,
        code: mfaCode.trim(),
      });

      if (verifyError) {
        throw verifyError;
      }

      const { data: assuranceData, error: assuranceError } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) {
        throw assuranceError;
      }
      if (assuranceData?.currentLevel !== 'aal2') {
        throw new Error('Google Authenticator verification did not create an AAL2 session. Please try again.');
      }

      finalizeLoginProfile(
        mfaPendingProfile,
        mfaPendingAuthUserId,
        mfaPendingProfile.email || email,
      );

      clearMfaState();
      setSuccessMessage('MFA verified. Redirecting to your dashboard...');
    } catch (error) {
      setErrorMessage(error.message || 'MFA verification failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    clearMessages();

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured yet. Add REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    setIsSubmitting(true);
    configureLoginSessionPersistence(rememberMe);

    const { data: loginData, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      clearLoginSessionPersistence();
      localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
      setErrorMessage(error.message);
    } else {
      const authUserId = loginData?.user?.id || loginData?.session?.user?.id;

      if (!authUserId) {
        await supabase.auth.signOut();
        clearLoginSessionPersistence();
        setErrorMessage('Could not verify your account profile. Please contact an administrator.');
        setIsSubmitting(false);
        return;
      }

      let enrichedProfile;

      try {
        enrichedProfile = await getValidatedProfileByAuthUserId(authUserId);
      } catch (profileValidationError) {
        await supabase.auth.signOut();
        clearLoginSessionPersistence();
        localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
        setErrorMessage(profileValidationError.message || 'Unable to validate account profile.');
        setIsSubmitting(false);
        return;
      }

      try {
        await beginMfaStep(enrichedProfile, authUserId, loginData?.user?.email || email);
      } catch (mfaError) {
        await supabase.auth.signOut();
        clearLoginSessionPersistence();
        localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
        setErrorMessage(mfaError.message || 'Unable to start MFA verification.');
        setIsSubmitting(false);
        return;
      }
    }

    setIsSubmitting(false);
  };

  const handleForgotPassword = async () => {
    clearMessages();

    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      setErrorMessage('Enter your email first, then click Forgot password.');
      return;
    }

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured yet. Add REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      return;
    }

    setIsSubmitting(true);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: getPasswordRecoveryRedirectUrl(),
      });

      if (error) {
        throw error;
      }

      setSuccessMessage('If an account exists for that email, a password reset link has been sent.');
    } catch (error) {
      setErrorMessage(getPasswordResetErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequestEmailOtp = async () => {
    clearMessages();

    if (!mfaPendingAuthUserId || !mfaMode) {
      setErrorMessage('Log in with your email and password before requesting an email code.');
      return;
    }

    if (emailOtpCooldown > 0) {
      setErrorMessage(`Please wait ${emailOtpCooldown}s before requesting a new code.`);
      return;
    }

    setIsSendingEmailOtp(true);

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData?.user?.id || userData.user.id !== mfaPendingAuthUserId) {
        throw userError || new Error('The current login session could not be verified.');
      }

      const targetEmail = String(userData.user.email || '').trim().toLowerCase();
      if (!targetEmail) {
        throw new Error('No registered email address is available for this account.');
      }

      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: targetEmail,
        options: {
          shouldCreateUser: false,
        },
      });

      if (otpError) {
        throw otpError;
      }

      setEmailOtpTarget(targetEmail);
      setEmailOtpRequested(true);
      setEmailOtpCode('');
      setEmailOtpCooldown(EMAIL_OTP_COOLDOWN_SECONDS);
      setMfaMethod('email-otp');
      setSuccessMessage(`A 6-digit sign-in code was sent to ${targetEmail}.`);
    } catch (otpError) {
      setErrorMessage(getPasswordResetErrorMessage(otpError));
    } finally {
      setIsSendingEmailOtp(false);
    }
  };

  const handleVerifyEmailOtp = async (event) => {
    event.preventDefault();
    clearMessages();

    if (!emailOtpRequested || !emailOtpTarget) {
      setErrorMessage('Send an email OTP code first.');
      return;
    }

    if (emailOtpCode.length !== 6) {
      setErrorMessage('Enter the complete 6-digit code from your email.');
      return;
    }

    setIsSubmitting(true);

    try {
      const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
        email: emailOtpTarget,
        token: emailOtpCode,
        type: 'email',
      });

      if (otpError) {
        throw otpError;
      }

      const verifiedAuthUserId = otpData?.user?.id || otpData?.session?.user?.id;
      const verifiedEmail = String(otpData?.user?.email || otpData?.session?.user?.email || '')
        .trim()
        .toLowerCase();

      if (
        !verifiedAuthUserId
        || verifiedAuthUserId !== mfaPendingAuthUserId
        || verifiedEmail !== emailOtpTarget
      ) {
        throw new Error('The email OTP does not match the management account currently signing in.');
      }

      const verifiedProfile = await getValidatedProfileByAuthUserId(verifiedAuthUserId);
      finalizeLoginProfile(verifiedProfile, verifiedAuthUserId, verifiedEmail);

      void logAuditAction({
        action: 'auth.email_otp_fallback_sign_in',
        description: 'User completed authenticator fallback using a verified email OTP.',
        resource: 'auth/email-otp-fallback',
        status: 'success',
        userProfile: verifiedProfile,
      });

      clearMfaState();
      setSuccessMessage('Email code verified. Redirecting to your dashboard...');
    } catch (otpError) {
      setErrorMessage(otpError?.message || 'Email OTP verification failed. Request a new code and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const incomingTransition = useMemo(() => {
    try {
      return typeof window !== 'undefined' ? sessionStorage.getItem('Donivra:incoming-transition') || '' : '';
    } catch {
      return '';
    }
  }, []);

  const fadeControls = useAnimation();
  const [isReturningToLanding, setIsReturningToLanding] = useState(false);

  useEffect(() => {
    if (incomingTransition === 'login') {
      try { sessionStorage.removeItem('Donivra:incoming-transition'); } catch { /* ignore */ }
      fadeControls.start({
        opacity: 1,
        transition: { duration: 0.5, ease: [0.22, 0.61, 0.36, 1] },
      });
    }
  }, [incomingTransition, fadeControls]);

  const handleBackToLanding = () => {
    if (isReturningToLanding) return;
    setIsReturningToLanding(true);
    fadeControls.start({
      opacity: 0,
      transition: { duration: 0.45, ease: [0.22, 0.61, 0.36, 1] },
    }).then(() => {
      try { sessionStorage.setItem('Donivra:incoming-transition', 'back-from-login'); } catch { /* ignore */ }
      window.location.assign('/');
    });
  };

  return (
    <motion.div
      initial={incomingTransition === 'login' ? { opacity: 0 } : { opacity: 1 }}
      animate={fadeControls}
      style={{ minHeight: '100vh', width: '100%', overflowX: 'hidden', backgroundColor: '#ffffff' }}
    >
    <div className="flex min-h-screen bg-white">
      {/* Left Pane - Branding */}
      <div
        className="hidden lg:flex w-1/2 items-center justify-center p-12"
        style={{
          background: `linear-gradient(135deg, ${withAlpha(theme.primaryColorLight || theme.primaryColor, 0.15)} 0%, ${withAlpha(theme.primaryColor, 0.1)} 50%, ${withAlpha(theme.primaryColorDark || theme.primaryColor, 0.15)} 100%)`,
          backdropFilter: 'blur(10px)',
        }}
      >
        <div className="max-w-md">
          {/* Main Image Card */}
          <div className="rounded-2xl shadow-2xl overflow-hidden mb-8 hover:shadow-3xl transition-shadow">
            {isThemeReady ? (
              <img
                src={theme.loginBackgroundImage || DEFAULT_LOGIN_BG}
                alt="Professional hairstylist at work"
                className="w-full h-80 object-cover"
              />
            ) : (
              <div className="w-full h-80 bg-gray-200 animate-pulse" />
            )}
          </div>

          {/* Headline */}
          <h2 className="text-4xl font-bold text-center mb-4" style={{ color: theme.primaryColor }}>
            {theme.brandTagline || 'Every Strand Counts'}
          </h2>

          {/* Subtext */}
          <p className="text-center text-gray-600 mb-8 text-sm leading-relaxed">
            Join our community of donors and recipients. Your contribution brings confidence and joy to those battling hair loss.
          </p>

          {/* Badges */}
          <div className="flex gap-4 justify-center">
            <div className="bg-white rounded-full px-6 py-3 shadow-md flex items-center gap-2 whitespace-nowrap">
              <Coins size={18} style={{ color: theme.primaryColor }} />
              <span className="text-sm font-medium text-gray-800">1K Donors</span>
            </div>
            <div className="bg-white rounded-full px-6 py-3 shadow-md flex items-center gap-2 whitespace-nowrap">
              <Heart size={18} style={{ color: theme.primaryColor }} />
              <span className="text-sm font-medium text-gray-800">Empathetic Care</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right Pane - Login Form */}
      <div className="w-full lg:w-1/2 bg-white flex flex-col items-center justify-center px-6 py-12 lg:py-0 relative">
        <button
          type="button"
          onClick={handleBackToLanding}
          disabled={isReturningToLanding}
          className="absolute top-6 left-6 inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white/80 backdrop-blur px-3 py-1.5 text-xs font-medium text-gray-600 shadow-sm transition hover:border-gray-300 hover:text-gray-900 disabled:opacity-60"
          aria-label="Back to landing page"
        >
          <ArrowLeft size={14} />
          Back to landing
        </button>
        <div className="w-full max-w-sm">
          {/* Logo */}
          <div className="flex items-center gap-2 mb-12">
            {theme.logoImage ? (
              <img
                src={theme.logoImage}
                alt={`${theme.brandName || 'Donivra'} logo`}
                className="w-8 h-8 rounded-lg object-cover border border-gray-200"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-lg"
                style={{ backgroundColor: theme.primaryColor }}
              >
                A
              </div>
            )}
            <span className="text-2xl font-bold text-gray-900">{theme.brandName}</span>
          </div>

          {/* Header */}
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Management Portal
          </h1>
          <p className="text-gray-600 mb-8 text-sm">
            Sign in with your authorized organization account.
          </p>

          {authNotice && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {authNotice}
            </div>
          )}

          {errorMessage && (
            <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          )}

          {successMessage && (
            <div className="mb-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">
              {successMessage}
            </div>
          )}

          {/* Form */}
          {!mfaMode && (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Email Field */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 text-gray-400" size={20} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full pl-10 pr-4 py-2.5 border border-gray-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-offset-2"
                  style={{ '--tw-ring-color': theme.primaryColor }}
                  required
                />
              </div>
            </div>

            {/* Password Field */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Password
                </label>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className="text-sm font-medium transition-opacity hover:opacity-80"
                  style={{ color: theme.primaryColor }}
                  disabled={isSubmitting}
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-3 text-gray-400" size={20} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="........"
                  className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg bg-white text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-offset-2"
                  style={{ '--tw-ring-color': theme.primaryColor }}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
                    disabled={isSubmitting}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>

            {/* Remember Me */}
            <div className="flex items-center">
              <input
                type="checkbox"
                id="remember"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                style={{
                  accentColor: theme.primaryColor,
                }}
              />
              <label htmlFor="remember" className="ml-2 text-sm text-gray-600 cursor-pointer">
                Remember me for 30 days
              </label>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              className="w-full py-2.5 rounded-lg text-white font-medium flex items-center justify-center gap-2 group hover:opacity-90 transition-all"
              style={{ backgroundColor: theme.primaryColor }}
              disabled={isSubmitting}
            >
              {isSubmitting
                ? 'Please wait...'
                : 'Login to Account'}
              <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
            </button>
          </form>
          )}

          {mfaMode && (
            <div className="space-y-5 rounded-xl border border-gray-200 p-5 bg-gray-50">
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} style={{ color: theme.primaryColor }} />
                <h3 className="font-semibold text-gray-900">Two-Factor Authentication</h3>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-white p-2">
                <button
                  type="button"
                  onClick={() => setMfaMethod('authenticator')}
                  className="rounded-md border px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    borderColor: mfaMethod === 'authenticator' ? theme.primaryColor : '#e5e7eb',
                    backgroundColor: mfaMethod === 'authenticator' ? `${theme.primaryColor}12` : '#ffffff',
                    color: mfaMethod === 'authenticator' ? theme.primaryColor : '#4b5563',
                  }}
                  disabled={isSubmitting || isSendingEmailOtp}
                >
                  Google Authenticator
                </button>
                <button
                  type="button"
                  onClick={() => setMfaMethod('email-otp')}
                  className="rounded-md border px-3 py-2 text-sm font-medium transition-colors"
                  style={{
                    borderColor: mfaMethod === 'email-otp' ? theme.primaryColor : '#e5e7eb',
                    backgroundColor: mfaMethod === 'email-otp' ? `${theme.primaryColor}12` : '#ffffff',
                    color: mfaMethod === 'email-otp' ? theme.primaryColor : '#4b5563',
                  }}
                  disabled={isSubmitting || isSendingEmailOtp}
                >
                  Email OTP
                </button>
              </div>

              {mfaMethod === 'authenticator' && mfaMode === 'enroll' && (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600">
                    Scan this QR code in Google Authenticator, then enter the generated 6-digit code.
                  </p>

                  {mfaQrSvg ? (
                    <div
                      className="bg-white w-fit p-3 rounded-lg border border-gray-200"
                      dangerouslySetInnerHTML={{ __html: mfaQrSvg }}
                    />
                  ) : (
                    <div className="text-sm text-gray-500 flex items-center gap-2">
                      <QrCode size={16} /> QR code unavailable. Use the secret below.
                    </div>
                  )}

                  {mfaSecret && (
                    <div className="rounded-lg bg-white border border-gray-200 p-3">
                      <p className="text-xs text-gray-500 mb-1">Manual setup secret</p>
                      <p className="font-mono text-sm text-gray-800 break-all">{mfaSecret}</p>
                    </div>
                  )}
                </div>
              )}

              {mfaMethod === 'authenticator' && mfaMode === 'verify' && (
                <p className="text-sm text-gray-600">
                  Enter the 6-digit code from your Google Authenticator app.
                </p>
              )}

              {mfaMethod === 'authenticator' && (
                <form onSubmit={handleMfaVerify} className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Authenticator Code
                    </label>
                    <input
                      value={mfaCode}
                      onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-gray-900"
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-lg text-white font-medium"
                    style={{ backgroundColor: theme.primaryColor }}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? 'Verifying...' : 'Verify And Continue'}
                  </button>
                </form>
              )}

              {mfaMethod === 'email-otp' && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-gray-200 bg-white p-3">
                    <p className="text-sm font-medium text-gray-800">Verify your registered email</p>
                    <p className="mt-1 text-xs text-gray-500">
                      Request the 6-digit OTP from your email, then enter it below.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleRequestEmailOtp}
                    className="w-full py-2.5 rounded-lg border border-gray-300 bg-white text-gray-700 font-medium disabled:opacity-60"
                    disabled={isSubmitting || isSendingEmailOtp || emailOtpCooldown > 0}
                  >
                    {isSendingEmailOtp
                      ? 'Sending Code...'
                      : emailOtpCooldown > 0
                        ? `Resend Code in ${emailOtpCooldown}s`
                        : emailOtpRequested
                          ? 'Resend Email OTP'
                          : 'Send Email OTP'}
                  </button>

                  {emailOtpRequested && (
                    <form onSubmit={handleVerifyEmailOtp} className="space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Email OTP Code
                        </label>
                        <input
                          value={emailOtpCode}
                          onChange={(event) => setEmailOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="123456"
                          className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-gray-900 tracking-[0.3em]"
                          required
                        />
                      </div>
                      <button
                        type="submit"
                        className="w-full py-2.5 rounded-lg text-white font-medium disabled:opacity-60"
                        style={{ backgroundColor: theme.primaryColor }}
                        disabled={isSubmitting || emailOtpCode.length !== 6}
                      >
                        {isSubmitting ? 'Verifying Email Code...' : 'Verify Email And Continue'}
                      </button>
                    </form>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={async () => {
                  clearMfaState();
                  await supabase.auth.signOut();
                  clearLoginSessionPersistence();
                }}
                className="w-full py-2.5 rounded-lg border border-gray-300 text-gray-700"
                disabled={isSubmitting || isSendingEmailOtp}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Disclaimer */}
          <p className="text-center text-gray-400 mt-8 text-xs">
            © 2026 {theme.brandName}. Built with love for the hair donation community.
          </p>
        </div>
      </div>
    </div>
    </motion.div>
  );
}

