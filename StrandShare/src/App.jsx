import React, { useEffect, useState } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import LandingPage from './pages/public/LandingPage';
import LoginPage from './pages/shared/auth/LoginPage';
import CompleteAccountPage from './pages/shared/auth/CompleteAccountPage';
import ResetPasswordPage from './pages/shared/auth/ResetPasswordPage';
import ConfirmationCompletePage from './pages/shared/auth/ConfirmationCompletePage';
import AdminRole from './pages/roles/admin/AdminRole';
import HRepresentativeRole from './pages/roles/h-representative/HRepresentativeRole';
import EventApplicationPage from './pages/public/EventApplicationPage';
import EventApplicationSuccessPage from './pages/public/EventApplicationSuccessPage';
import PartnershipApplicationPage from './pages/public/PartnershipApplicationPage';
import StaffRole from './pages/roles/staff/StaffRole';
import SpecialistRole from './pages/roles/specialist/SpecialistRole';
import { isSupabaseConfigured, supabase } from './lib/supabaseClient';
import { logAuditAction } from './lib/auditLogger';
import { toCanonicalRole } from './lib/roleUtils';

const USER_PROFILE_STORAGE_KEY = 'Donivra_user_profile';
const USER_PROFILE_READY_EVENT = 'Donivra-profile-ready';

function resolveDashboardByRole(roleValue) {
  const normalizedRole = toCanonicalRole(roleValue);

  if (normalizedRole === 'admin') {
    return AdminRole;
  }

  if (normalizedRole === 'h_representative') {
    return HRepresentativeRole;
  }

  if (normalizedRole === 'staff') {
    return StaffRole;
  }

  if (normalizedRole === 'specialist') {
    return SpecialistRole;
  }

  return null;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isHydratingProfile, setIsHydratingProfile] = useState(false);
  const [authNotice, setAuthNotice] = useState('');

  const getStoredProfileForUser = (authUserId) => {
    try {
      const raw = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.auth_user_id === authUserId ? parsed : null;
    } catch {
      return null;
    }
  };

  const hydrateProfileDetails = async (authUserId, baseProfile = null) => {
    if (!isSupabaseConfigured || !supabase || !authUserId) {
      return baseProfile;
    }

    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('user_id, auth_user_id, role, email')
      .eq('auth_user_id', authUserId)
      .maybeSingle();

    if (userError || !userRow?.user_id) {
      return baseProfile;
    }

    const { data: detailsRow, error: detailsError } = await supabase
      .from('user_details')
      .select('first_name, middle_name, last_name, suffix, gender, photo_path')
      .eq('user_id', userRow.user_id)
      .maybeSingle();

    if (detailsError) {
      return {
        ...(baseProfile || {}),
        user_id: userRow.user_id,
        auth_user_id: userRow.auth_user_id,
        role: userRow.role,
        email: userRow.email,
      };
    }

    return {
      ...(baseProfile || {}),
      user_id: userRow.user_id,
      auth_user_id: userRow.auth_user_id,
      role: userRow.role,
      email: userRow.email,
      first_name: detailsRow?.first_name || '',
      middle_name: detailsRow?.middle_name || '',
      last_name: detailsRow?.last_name || '',
      suffix: detailsRow?.suffix || '',
      gender: detailsRow?.gender || '',
      photo_path: detailsRow?.photo_path || '',
    };
  };

  useEffect(() => {
    let isMounted = true;

    const handleProfileReady = (event) => {
      const payload = event?.detail;
      const authUserId = payload?.authUserId;
      const profile = payload?.profile;

      if (!authUserId || !profile) {
        return;
      }

      if (isSupabaseConfigured && supabase) {
        supabase.auth.getSession().then(({ data }) => {
          const nextSession = data?.session ?? null;
          if (nextSession?.user?.id === authUserId) {
            setSession(nextSession);
          }
        });
      }

      setUserProfile(profile);
      setIsHydratingProfile(false);
    };

    const handleProfileStorageSync = (event) => {
      if (event.key !== USER_PROFILE_STORAGE_KEY || !event.newValue) {
        return;
      }

      try {
        const parsed = JSON.parse(event.newValue);
        if (!parsed?.auth_user_id) {
          return;
        }

        setUserProfile(parsed);
      } catch {
        // ignore invalid storage payload
      }
    };

    window.addEventListener(USER_PROFILE_READY_EVENT, handleProfileReady);
    window.addEventListener('storage', handleProfileStorageSync);

    const bootstrapSession = async () => {
      if (!isSupabaseConfigured) {
        setIsLoadingAuth(false);
        return;
      }

      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) {
        return;
      }

      if (error) {
        setAuthNotice('Could not load your current session. Please log in again.');
      }

      const existingSession = data?.session ?? null;

      if (existingSession?.user?.id) {
        const storedProfile = getStoredProfileForUser(existingSession.user.id);
        if (storedProfile) {
          setSession(existingSession);
          setUserProfile(storedProfile);

          const hydratedProfile = await hydrateProfileDetails(existingSession.user.id, storedProfile);
          if (hydratedProfile) {
            setUserProfile(hydratedProfile);
            try {
              localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(hydratedProfile));
            } catch {
              // ignore storage write errors
            }
          }
          setIsHydratingProfile(false);
        } else {
          // Keep the user on LoginPage so MFA/profile sync can complete there.
          setSession(null);
          setUserProfile(null);
          setIsHydratingProfile(false);
        }
      } else {
        setUserProfile(null);
        setIsHydratingProfile(false);
      }

      setIsLoadingAuth(false);
    };

    bootstrapSession();

    if (!isSupabaseConfigured) {
      return () => {
        isMounted = false;
      };
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
        setSession(null);
        setUserProfile(null);
        setIsHydratingProfile(false);
        return;
      }

      if (!nextSession?.user?.id) {
        return;
      }

      const storedProfile = getStoredProfileForUser(nextSession.user.id);
      if (storedProfile) {
        setSession(nextSession);
        setUserProfile(storedProfile);

        hydrateProfileDetails(nextSession.user.id, storedProfile).then((hydratedProfile) => {
          if (!hydratedProfile) {
            return;
          }

          setUserProfile(hydratedProfile);
          try {
            localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(hydratedProfile));
          } catch {
            // ignore storage write errors
          }
        });
        setIsHydratingProfile(false);
      } else {
        // During login we wait for LoginPage MFA to publish USER_PROFILE_READY_EVENT.
        setSession(null);
        setUserProfile(null);
        setIsHydratingProfile(false);
      }
    });

    return () => {
      isMounted = false;
      window.removeEventListener(USER_PROFILE_READY_EVENT, handleProfileReady);
      window.removeEventListener('storage', handleProfileStorageSync);
      subscription.unsubscribe();
    };
  }, []);

  const handleSignOut = async () => {
    const platform = navigator.platform || 'Unknown platform';

    await logAuditAction({
      action: 'auth.sign_out',
      description: 'User signed out.',
      resource: `auth/session:${platform}`,
      status: 'success',
      userProfile,
    });

    if (isSupabaseConfigured) {
      await supabase.auth.signOut();
    }
    localStorage.removeItem(USER_PROFILE_STORAGE_KEY);
    setSession(null);
    setUserProfile(null);
    setIsHydratingProfile(false);
  };

  const activeRole = userProfile?.role || null;
  const canonicalActiveRole = toCanonicalRole(activeRole);
  const ActiveDashboard = resolveDashboardByRole(activeRole);
  const currentPath = window.location.pathname;
  const isLandingRoute = currentPath === '/';
  const isWigAiStudioRoute = currentPath === '/wig-ai-studio';
  const isPartnershipApplicationRoute = currentPath === '/apply-partnership';
  const isEventApplicationRoute = currentPath === '/apply-event';
  const isEventApplicationSuccessRoute = currentPath === '/apply-event/success';
  const isCompleteAccountRoute = currentPath === '/complete-account';
  const isResetPasswordRoute = currentPath === '/reset-password';
  const isConfirmationCompleteRoute = currentPath === '/confirmation-complete';
  const showLandingPage = !isLoadingAuth && !session && isLandingRoute;
  const showPartnershipApplicationPage = !isLoadingAuth && !session && isPartnershipApplicationRoute;
  const showEventApplicationPage = !isLoadingAuth && !session && isEventApplicationRoute;
  const showEventApplicationSuccessPage = !isLoadingAuth && !session && isEventApplicationSuccessRoute;
  const showLoginPage = !isLoadingAuth && !session && !isLandingRoute && !isPartnershipApplicationRoute && !isEventApplicationRoute && !isEventApplicationSuccessRoute;
  const showDashboard =
    !isLoadingAuth &&
    Boolean(session) &&
    Boolean(activeRole) &&
    Boolean(ActiveDashboard);
  const showHydratingScreen =
    !isLoadingAuth && Boolean(session) && !showDashboard && isHydratingProfile;
  const showUnsupportedRole =
    !isLoadingAuth &&
    Boolean(session) &&
    Boolean(activeRole) &&
    !ActiveDashboard &&
    !isHydratingProfile;

  return (
    <ThemeProvider>
      <div className="min-h-screen">
        {isCompleteAccountRoute && <CompleteAccountPage />}
        {isResetPasswordRoute && <ResetPasswordPage />}
        {isConfirmationCompleteRoute && <ConfirmationCompletePage />}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showLandingPage && (
          <LandingPage />
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showPartnershipApplicationPage && (
          <PartnershipApplicationPage />
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showEventApplicationPage && (
          <EventApplicationPage />
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showEventApplicationSuccessPage && (
          <EventApplicationSuccessPage />
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showLoginPage && (
          <LoginPage
            authNotice={
              authNotice ||
              (!isSupabaseConfigured
                ? 'Supabase is not configured yet. Add REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.'
                : '')
            }
            onClearNotice={() => setAuthNotice('')}
          />
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showDashboard && (
          <ActiveDashboard
            onSignOut={handleSignOut}
            userProfile={
              userProfile || {
                email: session.user.email,
                role: activeRole || 'staff',
              }
            }
            initialPage={canonicalActiveRole === 'specialist' && isWigAiStudioRoute ? 'wig-ai-studio' : undefined}
          />
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showHydratingScreen && (
          <div className="min-h-screen flex items-center justify-center">
            Finalizing your account access...
          </div>
        )}

        {!isCompleteAccountRoute && !isResetPasswordRoute && !isConfirmationCompleteRoute && showUnsupportedRole && (
          <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
            <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
              <h1 className="text-xl font-semibold text-slate-900">Management access only</h1>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                This account is not assigned to an authorized management role.
              </p>
              <button type="button" onClick={handleSignOut} className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </ThemeProvider>
  );
}

