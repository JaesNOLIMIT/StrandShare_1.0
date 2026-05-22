import React, { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Lock, ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const DEFAULT_LOGIN_BG =
  'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=1080&q=80';
const EMAIL_OTP_COOLDOWN_SECONDS = 60;

export default function ResetPasswordPage() {
  const { theme } = useTheme();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaFactorId, setMfaFactorId] = useState('');
  const [isCheckingMfaCode, setIsCheckingMfaCode] = useState(false);
  const [isMfaCodeVerified, setIsMfaCodeVerified] = useState(false);
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  const [emailConfirmRequired, setEmailConfirmRequired] = useState(false);
  const [emailOtpCode, setEmailOtpCode] = useState('');
  const [isSendingEmailOtp, setIsSendingEmailOtp] = useState(false);
  const [emailOtpCooldown, setEmailOtpCooldown] = useState(0);
  const [isPasswordChangeComplete, setIsPasswordChangeComplete] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [isSendingRecoveryLink, setIsSendingRecoveryLink] = useState(false);

  useEffect(() => {
    if (emailOtpCooldown <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setEmailOtpCooldown((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [emailOtpCooldown]);

  const passwordRules = useMemo(() => {
    const value = newPassword || '';
    return {
      length: value.length >= 8,
      uppercase: /[A-Z]/.test(value),
      number: /\d/.test(value),
      special: /[^A-Za-z0-9]/.test(value),
    };
  }, [newPassword]);

  const isPasswordValid =
    passwordRules.length &&
    passwordRules.uppercase &&
    passwordRules.number &&
    passwordRules.special;

  const passwordsMatch = Boolean(confirmPassword) && newPassword === confirmPassword;
  const passwordsMismatch = Boolean(confirmPassword) && newPassword !== confirmPassword;

  const recoveryTokens = useMemo(() => {
    const hash = String(window.location.hash || '');
    const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    return {
      accessToken: hashParams.get('access_token') || '',
      refreshToken: hashParams.get('refresh_token') || '',
      type: hashParams.get('type') || '',
    };
  }, []);

  const hasRecoveryToken = useMemo(() => {
    return recoveryTokens.type === 'recovery' || Boolean(recoveryTokens.accessToken);
  }, [recoveryTokens]);

  const canRequestNewRecoveryLink = useMemo(() => {
    const text = String(errorMessage || '').toLowerCase();
    return text.includes('recovery session is missing or expired');
  }, [errorMessage]);

  const goToLogin = () => {
    window.location.assign('/');
  };

  const ensureRecoverySession = async () => {
    const { data: currentSessionData } = await supabase.auth.getSession();
    if (currentSessionData?.session) {
      return true;
    }

    const accessToken = recoveryTokens.accessToken;
    const refreshToken = recoveryTokens.refreshToken;

    if (!accessToken || !refreshToken) {
      return false;
    }

    const { data: restoredSessionData, error: restoreError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (restoreError) {
      return false;
    }

    return Boolean(restoredSessionData?.session);
  };

  const toFriendlyAuthMessage = (message, fallback) => {
    const text = String(message || '').toLowerCase();
    if (text.includes('auth session missing') || text.includes('session not found') || text.includes('invalid jwt')) {
      return 'Recovery session is missing or expired. Please request a new reset email.';
    }

    return message || fallback;
  };

  const resolveMfaFactorId = async () => {
    const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
    if (factorsError) {
      throw factorsError;
    }

    const verifiedTotpFactor = (factorsData?.totp || []).find((factor) => factor.status === 'verified');
    if (!verifiedTotpFactor?.id) {
      throw new Error('No verified authenticator factor found for this account.');
    }

    return verifiedTotpFactor.id;
  };

  const completePasswordUpdate = async (passwordValue, nonceValue = '') => {
    const payload = nonceValue
      ? { password: passwordValue, nonce: nonceValue }
      : { password: passwordValue };

    const { error } = await supabase.auth.updateUser(payload);
    if (error) {
      throw error;
    }
  };

  const startVerificationStep = async () => {
    const hasSession = await ensureRecoverySession();
    if (!hasSession) {
      throw new Error('Recovery session is missing or expired. Please request a new reset email.');
    }

    const factorId = await resolveMfaFactorId();
    setMfaFactorId(factorId);
    setMfaRequired(true);
    setEmailConfirmRequired(true);
    setEmailOtpCode('');
    setMfaCode('');
    setIsMfaCodeVerified(false);

    const { error } = await supabase.auth.reauthenticate();
    if (error) {
      throw error;
    }

    setEmailOtpCooldown(EMAIL_OTP_COOLDOWN_SECONDS);
    setSuccessMessage('Enter your authenticator code and email confirmation code to complete password reset.');
  };

  const requestEmailConfirmationCode = async () => {
    setErrorMessage('');

    const hasSession = await ensureRecoverySession();
    if (!hasSession) {
      setErrorMessage('Recovery session is missing or expired. Please request a new reset email.');
      return false;
    }

    if (emailOtpCooldown > 0) {
      setErrorMessage(`Please wait ${emailOtpCooldown}s before requesting a new code.`);
      return false;
    }

    setIsSendingEmailOtp(true);
    try {
      const { error } = await supabase.auth.reauthenticate();
      if (error) {
        throw error;
      }

      setEmailConfirmRequired(true);
      setEmailOtpCode('');
      setEmailOtpCooldown(EMAIL_OTP_COOLDOWN_SECONDS);
      setSuccessMessage('A new reauthentication code was sent to your email.');
      return true;
    } catch (error) {
      setErrorMessage(toFriendlyAuthMessage(error.message, 'Unable to send email confirmation code.'));
      return false;
    } finally {
      setIsSendingEmailOtp(false);
    }
  };

  const handleConfirmReset = async (event) => {
    event?.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    const hasSession = await ensureRecoverySession();
    if (!hasSession) {
      setErrorMessage('Recovery session is missing or expired. Please request a new reset email.');
      return;
    }

    if (!mfaCode || mfaCode.length < 6) {
      setErrorMessage('Enter the 6-digit authenticator code.');
      return;
    }

    if (!mfaFactorId) {
      setErrorMessage('MFA verification session is missing. Try submitting password again.');
      return;
    }

    if (!isMfaCodeVerified) {
      setErrorMessage('Please check and verify your authenticator code first.');
      return;
    }

    if (!emailOtpCode || emailOtpCode.length < 6) {
      setErrorMessage('Enter the 6-digit code sent to your email.');
      return;
    }

    setIsConfirmingReset(true);
    try {
      await completePasswordUpdate(newPassword, emailOtpCode.trim());
      setEmailConfirmRequired(false);
      setMfaRequired(false);
      setEmailOtpCode('');
      setMfaCode('');
      setMfaFactorId('');
      setIsMfaCodeVerified(false);
      setEmailOtpCooldown(0);
      setIsPasswordChangeComplete(true);
    } catch (error) {
      const message = String(error?.message || '');
      if (message.toLowerCase().includes('aal2 session is required')) {
        setErrorMessage('Authenticator verification is required. Verify your 6-digit app code and try again.');
      } else if (/different from the old password|same password|same as old|identical/i.test(message)) {
        setErrorMessage('Please use a new password that is different from your current password. Request a new reset password link if you still wish to change your password.');
      } else {
        setErrorMessage(toFriendlyAuthMessage(error.message, 'Verification failed. Please check both codes and try again.'));
      }
    } finally {
      setIsConfirmingReset(false);
    }
  };

  const handleCheckMfaCode = async () => {
    setErrorMessage('');

    if (!mfaCode || mfaCode.length < 6) {
      setErrorMessage('Enter the 6-digit authenticator code before checking.');
      return;
    }

    if (!mfaFactorId) {
      setErrorMessage('MFA verification session is missing. Try submitting password again.');
      return;
    }

    setIsCheckingMfaCode(true);

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

      setIsMfaCodeVerified(true);
      setSuccessMessage('MFA confirmed. Now enter your email OTP, then click Confirm and Update Password.');
    } catch (error) {
      setIsMfaCodeVerified(false);
      setErrorMessage(toFriendlyAuthMessage(error.message, 'MFA code is invalid or expired. Please use the latest code and try again.'));
    } finally {
      setIsCheckingMfaCode(false);
    }
  };

  const handleUpdatePassword = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    if (isPasswordChangeComplete) {
      return;
    }

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured.');
      return;
    }

    if (!hasRecoveryToken) {
      setErrorMessage('Recovery link is invalid or expired. Request a new reset email.');
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
      const hasSession = await ensureRecoverySession();
      if (!hasSession) {
        setErrorMessage('Recovery session is missing or expired. Please request a new reset email.');
        return;
      }

      // Proceed directly to verification. Supabase handles identical password checks natively.
      await startVerificationStep();
    } catch (error) {
      setErrorMessage(toFriendlyAuthMessage(error?.message, 'Verification could not be started.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequestNewRecoveryLink = async () => {
    setErrorMessage('');

    if (!recoveryEmail.trim()) {
      setErrorMessage('Enter your account email to receive a new reset link.');
      return;
    }

    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured.');
      return;
    }

    setIsSendingRecoveryLink(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(recoveryEmail.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });

      if (error) {
        throw error;
      }

      setSuccessMessage('A new password reset email has been sent. Please check your inbox.');
    } catch (error) {
      setErrorMessage(error?.message || 'Unable to send a new password reset email.');
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
                S
              </div>
            )}
            <span className="text-2xl font-bold text-gray-900">{theme.brandName}</span>
          </div>

          <h1 className="text-3xl font-bold text-gray-900 mb-2">Reset Password</h1>
          <p className="text-gray-600 mb-6 text-sm">
            Set a new password for your account.
          </p>

          {errorMessage && (
            <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMessage}
            </div>
          )}

          {successMessage && !isPasswordChangeComplete && (
            <div className="mb-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">
              {successMessage}
            </div>
          )}

          {canRequestNewRecoveryLink && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 space-y-3">
              <p className="text-sm text-amber-800">
                Your reset link expired. Request a new one below.
              </p>
              <input
                type="email"
                value={recoveryEmail}
                onChange={(event) => setRecoveryEmail(event.target.value)}
                placeholder="name@example.com"
                className="w-full p-2.5 border border-amber-300 rounded-lg bg-white text-gray-900"
              />
              <button
                type="button"
                onClick={handleRequestNewRecoveryLink}
                className="w-full py-2.5 rounded-lg text-white font-medium"
                style={{ backgroundColor: theme.primaryColor }}
                disabled={isSendingRecoveryLink}
              >
                {isSendingRecoveryLink ? 'Sending Reset Link...' : 'Request New Reset Email'}
              </button>
            </div>
          )}

          <form onSubmit={handleUpdatePassword} className="space-y-5">
            {!isPasswordChangeComplete && !mfaRequired && !emailConfirmRequired && (
              <>
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
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-3 top-3 text-gray-400"
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
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm((prev) => !prev)}
                      className="absolute right-3 top-3 text-gray-400"
                    >
                      {showConfirm ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                  {passwordsMatch && (
                    <p className="mt-2 text-xs font-medium text-emerald-600">Passwords matched.</p>
                  )}
                  {passwordsMismatch && (
                    <p className="mt-2 text-xs font-medium text-red-600">Passwords mismatched.</p>
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
                  className="w-full py-2.5 rounded-lg text-white font-medium flex items-center justify-center gap-2"
                  style={{ backgroundColor: theme.primaryColor }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Starting verification...' : 'Update Password'}
                  <ArrowRight size={18} />
                </button>
              </>
            )}

            {!isPasswordChangeComplete && mfaRequired && emailConfirmRequired && (
              <div className="rounded-lg border border-gray-200 p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} style={{ color: theme.primaryColor }} />
                  <p className="text-sm font-semibold text-gray-800">Confirm It Is Really You</p>
                </div>
                <p className="text-xs text-gray-500">
                  Enter your authenticator code and the reauthentication email code to finish changing your password.
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Authenticator Code</label>
                    <input
                      value={mfaCode}
                      onChange={(event) => {
                        setMfaCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                        if (isMfaCodeVerified) {
                          setIsMfaCodeVerified(false);
                        }
                      }}
                      placeholder="123456"
                      className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-gray-900 tracking-[0.25em]"
                      inputMode="numeric"
                      required
                    />
                    <p className="mt-1 text-[11px] text-gray-500">
                      Authenticator codes refresh quickly. Use the current code before the timer resets.
                    </p>

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCheckMfaCode}
                        className="px-3 py-1.5 rounded-md border border-gray-300 text-xs font-semibold text-gray-700"
                        disabled={isCheckingMfaCode || isConfirmingReset}
                      >
                        {isCheckingMfaCode ? 'Checking MFA...' : 'Check MFA Code'}
                      </button>

                      {isMfaCodeVerified && (
                        <span className="text-xs font-semibold text-emerald-600">MFA verified ✓</span>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Email OTP Code</label>
                    <input
                      value={emailOtpCode}
                      onChange={(event) => setEmailOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="123456"
                      className="w-full p-2.5 border border-gray-300 rounded-lg bg-white text-gray-900 tracking-[0.25em]"
                      inputMode="numeric"
                      required
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleConfirmReset}
                  className="w-full py-2.5 rounded-lg text-white font-medium"
                  style={{ backgroundColor: theme.primaryColor }}
                  disabled={isConfirmingReset}
                >
                  {isConfirmingReset ? 'Confirming...' : 'Confirm and Update Password'}
                </button>

                <button
                  type="button"
                  onClick={requestEmailConfirmationCode}
                  className="w-full py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium"
                  disabled={isSendingEmailOtp || isConfirmingReset || emailOtpCooldown > 0}
                >
                  {isSendingEmailOtp
                    ? 'Sending code...'
                    : emailOtpCooldown > 0
                      ? `Resend Email Code in ${emailOtpCooldown}s`
                      : 'Resend Email Code'}
                </button>

                {emailOtpCooldown > 0 && (
                  <p className="text-xs text-gray-500 text-center">
                    You can request another code in {emailOtpCooldown}s.
                  </p>
                )}
              </div>
            )}

            {isPasswordChangeComplete && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-semibold text-emerald-700">Password confirmation done.</p>
                <p className="mt-1 text-xs text-emerald-700/90">
                  Your password was updated successfully. Use the button below when you are ready to go back to login.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={goToLogin}
              className="w-full py-2.5 rounded-lg border border-gray-300 text-gray-700 font-medium"
            >
              Back to Login
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
