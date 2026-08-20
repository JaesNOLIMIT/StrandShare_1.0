import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import {
  establishPasswordRecoverySession,
  getPasswordRecoveryParameters,
  getPasswordRecoveryRedirectUrl,
  hasPasswordRecoveryCallback,
  isUserRecoverySession,
} from '../../../lib/passwordRecovery';

const DEFAULT_LOGIN_BG =
  'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1080&q=80';

function toRecoveryErrorMessage(error) {
  const message = String(error?.message || error || '').replace(/\+/g, ' ').trim();
  const normalized = message.toLowerCase();

  if (
    normalized.includes('expired') ||
    normalized.includes('invalid') ||
    normalized.includes('flow state') ||
    normalized.includes('code verifier') ||
    normalized.includes('auth session missing') ||
    normalized.includes('session not found')
  ) {
    return 'This password reset link is invalid, expired, or has already been used. Request a new link below.';
  }

  return message || 'The password reset link could not be verified. Request a new link below.';
}

function isRecoverySessionError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('expired') ||
    message.includes('invalid jwt') ||
    message.includes('flow state') ||
    message.includes('code verifier') ||
    message.includes('auth session missing') ||
    message.includes('session not found')
  );
}

export default function ResetPasswordPage() {
  const { theme } = useTheme();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingRecovery, setIsCheckingRecovery] = useState(true);
  const [isRecoveryReady, setIsRecoveryReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isPasswordChangeComplete, setIsPasswordChangeComplete] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [isSendingRecoveryLink, setIsSendingRecoveryLink] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [isVerifyingMfa, setIsVerifyingMfa] = useState(false);
  const [recoveryUserId, setRecoveryUserId] = useState('');

  useEffect(() => {
    let isMounted = true;

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured.');
      setIsCheckingRecovery(false);
      return undefined;
    }

    const parameters = getPasswordRecoveryParameters();

    const acceptRecoverySession = (nextSession) => {
      if (!isUserRecoverySession(nextSession)) {
        throw new Error('The password reset session is missing a valid user identity. Request a new link below.');
      }

      if (isMounted) {
        setRecoveryEmail(nextSession.user.email || '');
        setRecoveryUserId(nextSession.user.id);
        setIsRecoveryReady(true);
        setErrorMessage('');
        setIsCheckingRecovery(false);
      }
    };

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!isMounted || event !== 'PASSWORD_RECOVERY') {
        return;
      }

      if (nextSession) {
        try {
          acceptRecoverySession(nextSession);
        } catch (error) {
          setIsRecoveryReady(false);
          setErrorMessage(toRecoveryErrorMessage(error));
          setIsCheckingRecovery(false);
        }
      }
    });

    const initializeRecoverySession = async () => {
      if (parameters.errorDescription) {
        if (isMounted) {
          setErrorMessage(toRecoveryErrorMessage(parameters.errorDescription));
          setIsCheckingRecovery(false);
        }
        return;
      }

      if (!hasPasswordRecoveryCallback(parameters)) {
        if (isMounted) {
          setErrorMessage('Open the password reset link from your email, or request a new link below.');
          setIsCheckingRecovery(false);
        }
        return;
      }

      try {
        // Recovery credentials must take precedence over any account already signed in
        // on this browser. Otherwise the existing user's dashboard/session wins.
        const recoverySession = await establishPasswordRecoverySession(supabase.auth, parameters);

        if (!recoverySession) {
          throw new Error('Auth session missing');
        }

        const { data: userData, error: userError } = await supabase.auth.getUser(
          recoverySession.access_token,
        );
        if (userError || userData?.user?.id !== recoverySession.user?.id) {
          throw userError || new Error('The recovery user could not be verified.');
        }

        acceptRecoverySession(recoverySession);
      } catch (error) {
        if (isMounted) {
          setIsRecoveryReady(false);
          setErrorMessage(toRecoveryErrorMessage(error));
        }
      } finally {
        if (isMounted) {
          setIsCheckingRecovery(false);
        }
      }
    };

    void initializeRecoverySession();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const passwordRules = useMemo(() => {
    const value = newPassword || '';
    return {
      length: value.length >= 8,
      uppercase: /[A-Z]/.test(value),
      number: /\d/.test(value),
      special: /[^A-Za-z0-9]/.test(value),
    };
  }, [newPassword]);

  const isPasswordValid = Object.values(passwordRules).every(Boolean);
  const passwordsMatch = Boolean(confirmPassword) && newPassword === confirmPassword;
  const passwordsMismatch = Boolean(confirmPassword) && newPassword !== confirmPassword;

  const goToLogin = () => {
    window.location.assign('/login');
  };

  const finishPasswordUpdate = async ({ requiresAuthenticatorEnrollment = false } = {}) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      throw error;
    }

    await supabase.auth.signOut({ scope: 'local' });
    window.history.replaceState({}, document.title, window.location.pathname);
    setIsPasswordChangeComplete(true);
    setIsRecoveryReady(false);
    setMfaRequired(false);
    setMfaFactorId('');
    setMfaCode('');
    setRecoveryUserId('');
    setSuccessMessage(
      requiresAuthenticatorEnrollment
        ? 'Your password was updated successfully. Sign in with your new password to set up Google Authenticator.'
        : 'Your password was updated successfully. You can now sign in with your new password.',
    );
  };

  const requireCurrentRecoverySession = async () => {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const currentSession = sessionData?.session || null;
    if (
      sessionError ||
      !isUserRecoverySession(currentSession) ||
      !recoveryUserId ||
      currentSession.user.id !== recoveryUserId
    ) {
      throw sessionError || new Error('Auth session missing');
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(
      currentSession.access_token,
    );
    if (userError || userData?.user?.id !== recoveryUserId) {
      throw userError || new Error('The recovery user could not be verified.');
    }

    return currentSession;
  };

  const requireGoogleAuthenticator = async () => {
    await requireCurrentRecoverySession();
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) {
      throw factorsError;
    }

    const verifiedFactor = (factorsData?.totp || []).find((factor) => factor.status === 'verified');
    if (!verifiedFactor?.id) {
      return false;
    }

    setMfaFactorId(verifiedFactor.id);
    setMfaCode('');
    setMfaRequired(true);
    setSuccessMessage('Enter the current code from Google Authenticator to authorize this password change.');
    return true;
  };

  const handleVerifyMfaAndUpdate = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    if (!mfaFactorId || mfaCode.length !== 6) {
      setErrorMessage('Enter the current 6-digit code from Google Authenticator.');
      return;
    }

    setIsVerifyingMfa(true);
    try {
      await requireCurrentRecoverySession();
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId,
      });
      if (challengeError) {
        throw challengeError;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId,
        challengeId: challengeData.id,
        code: mfaCode,
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

      await finishPasswordUpdate();
    } catch (error) {
      const message = String(error?.message || '');
      if (/different from the old password|same password|same as old|identical/i.test(message)) {
        setErrorMessage('Choose a password that is different from your current password.');
      } else {
        setErrorMessage(message || 'Google Authenticator verification failed. Please use the current code and try again.');
      }
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const handleUpdatePassword = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    if (!isRecoveryReady) {
      setErrorMessage('Your recovery session is not ready. Request a new password reset link below.');
      return;
    }

    if (!newPassword || !confirmPassword) {
      setErrorMessage('Please fill in both password fields.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    if (!isPasswordValid) {
      setErrorMessage('Password does not meet the required rules.');
      return;
    }

    setIsSubmitting(true);

    try {
      await requireCurrentRecoverySession();

      const { data: assuranceData, error: assuranceError } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError) {
        throw assuranceError;
      }

      if (assuranceData?.currentLevel !== 'aal2') {
        const authenticatorIsEnrolled = await requireGoogleAuthenticator();
        if (authenticatorIsEnrolled) {
          return;
        }

        await finishPasswordUpdate({ requiresAuthenticatorEnrollment: true });
        return;
      }

      await finishPasswordUpdate();
    } catch (error) {
      const message = String(error?.message || '');
      if (/different from the old password|same password|same as old|identical/i.test(message)) {
        setErrorMessage('Choose a password that is different from your current password.');
      } else if (message.toLowerCase().includes('aal2 session is required')) {
        try {
          const authenticatorIsEnrolled = await requireGoogleAuthenticator();
          if (!authenticatorIsEnrolled) {
            setErrorMessage(
              'The password service requested Google Authenticator verification, but this account has no verified factor. Please request a new recovery link and try again.',
            );
          }
        } catch (mfaError) {
          setErrorMessage(mfaError?.message || 'Google Authenticator verification could not be started.');
        }
      } else {
        setErrorMessage(toRecoveryErrorMessage(error));
        if (isRecoverySessionError(error)) {
          setIsRecoveryReady(false);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequestNewRecoveryLink = async () => {
    setErrorMessage('');
    setSuccessMessage('');
    const normalizedEmail = recoveryEmail.trim().toLowerCase();

    if (!normalizedEmail) {
      setErrorMessage('Enter your account email to receive a new reset link.');
      return;
    }

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured.');
      return;
    }

    setIsSendingRecoveryLink(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
        redirectTo: getPasswordRecoveryRedirectUrl(),
      });

      if (error) {
        throw error;
      }

      setSuccessMessage('If an account exists for that email, a new password reset link has been sent.');
    } catch (error) {
      setErrorMessage(error?.message || 'Unable to send a new password reset email. Please try again.');
    } finally {
      setIsSendingRecoveryLink(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-white">
      <div
        className="hidden lg:flex w-1/2 items-center justify-center p-12"
        style={{
          background: `linear-gradient(135deg, ${theme.primaryColorLight}18 0%, ${theme.primaryColor}10 50%, ${theme.primaryColorDark}16 100%)`,
        }}
      >
        <div className="max-w-md">
          <div className="rounded-2xl shadow-2xl overflow-hidden mb-8">
            <img
              src={theme.loginBackgroundImage || DEFAULT_LOGIN_BG}
              alt="Reset password visual"
              className="w-full h-80 object-cover"
            />
          </div>
          <h2 className="text-4xl font-bold text-center mb-3" style={{ color: theme.primaryColor }}>
            Secure Your Account
          </h2>
          <p className="text-center text-gray-600 text-sm">
            Create a new password to regain secure access to your dashboard.
          </p>
        </div>
      </div>

      <div className="w-full lg:w-1/2 bg-white flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2 mb-10">
            {theme.logoImage ? (
              <img
                src={theme.logoImage}
                alt={`${theme.brandName || 'Donivra'} logo`}
                className="w-8 h-8 rounded-lg object-cover border border-gray-200"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: theme.primaryColor }}
              >
                D
              </div>
            )}
            <span className="text-2xl font-bold text-gray-900">{theme.brandName}</span>
          </div>

          <h1 className="text-3xl font-bold text-gray-900 mb-2">Reset Password</h1>
          <p className="text-gray-600 mb-6 text-sm">
            {isCheckingRecovery ? 'Verifying your password reset link...' : 'Set a new password for your account.'}
          </p>

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

          {!isCheckingRecovery && !isRecoveryReady && !isPasswordChangeComplete && (
            <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 space-y-3">
              <p className="text-sm text-amber-800">Request a fresh password reset link.</p>
              <input
                type="email"
                value={recoveryEmail}
                onChange={(event) => setRecoveryEmail(event.target.value)}
                placeholder="name@example.com"
                autoComplete="email"
                className="w-full p-2.5 border border-amber-300 rounded-lg bg-white text-gray-900"
              />
              <button
                type="button"
                onClick={handleRequestNewRecoveryLink}
                className="w-full py-2.5 rounded-lg text-white font-medium disabled:opacity-60"
                style={{ backgroundColor: theme.primaryColor }}
                disabled={isSendingRecoveryLink}
              >
                {isSendingRecoveryLink ? 'Sending Reset Link...' : 'Send New Reset Link'}
              </button>
            </div>
          )}

          {isCheckingRecovery && (
            <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-600">
              Verifying your recovery session...
            </div>
          )}

          {isRecoveryReady && !isPasswordChangeComplete && !mfaRequired && (
            <form onSubmit={handleUpdatePassword} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">New Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 text-gray-400" size={20} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg bg-white text-gray-900"
                    placeholder="Enter new password"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((previous) => !previous)}
                    className="absolute right-3 top-3 text-gray-400"
                    aria-label={showPassword ? 'Hide new password' : 'Show new password'}
                  >
                    {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Confirm Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 text-gray-400" size={20} />
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className="w-full pl-10 pr-10 py-2.5 border border-gray-300 rounded-lg bg-white text-gray-900"
                    placeholder="Confirm new password"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((previous) => !previous)}
                    className="absolute right-3 top-3 text-gray-400"
                    aria-label={showConfirm ? 'Hide confirmed password' : 'Show confirmed password'}
                  >
                    {showConfirm ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
                {passwordsMatch && (
                  <p className="mt-2 text-xs font-medium text-emerald-600">Passwords match.</p>
                )}
                {passwordsMismatch && (
                  <p className="mt-2 text-xs font-medium text-red-600">Passwords do not match.</p>
                )}
              </div>

              <div className="rounded-lg border border-gray-200 p-3 text-sm">
                {[
                  ['At least 8 characters', passwordRules.length],
                  ['At least one uppercase letter', passwordRules.uppercase],
                  ['At least one number', passwordRules.number],
                  ['At least one special character', passwordRules.special],
                ].map(([label, valid]) => (
                  <div key={label} className="flex items-center gap-2 py-0.5 text-gray-600">
                    <Check size={14} className={valid ? 'text-emerald-500' : 'text-gray-400'} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>

              <button
                type="submit"
                className="w-full py-2.5 rounded-lg text-white font-medium flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ backgroundColor: theme.primaryColor }}
                disabled={isSubmitting || !isPasswordValid || !passwordsMatch}
              >
                {isSubmitting ? 'Updating Password...' : 'Update Password'}
                <ArrowRight size={18} />
              </button>
            </form>
          )}

          {isRecoveryReady && !isPasswordChangeComplete && mfaRequired && (
            <form onSubmit={handleVerifyMfaAndUpdate} className="space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} style={{ color: theme.primaryColor }} />
                <h2 className="font-semibold text-gray-900">Google Authenticator Required</h2>
              </div>
              <p className="text-sm text-gray-600">
                MFA is enabled for this account. Enter the current code from Google Authenticator to continue.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Authenticator Code</label>
                <input
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
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
                disabled={isVerifyingMfa || mfaCode.length !== 6}
              >
                {isVerifyingMfa ? 'Verifying and Updating...' : 'Verify and Update Password'}
              </button>
            </form>
          )}

          <button
            type="button"
            onClick={goToLogin}
            className="mt-5 w-full py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium"
          >
            Back to Login
          </button>
        </div>
      </div>
    </div>
  );
}
