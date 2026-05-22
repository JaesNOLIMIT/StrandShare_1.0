import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Save } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';

const USER_PROFILE_STORAGE_KEY = 'Donivra_user_profile';
const USER_PROFILE_READY_EVENT = 'Donivra-profile-ready';

const EMPTY_FORM = {
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
};

export default function CompleteAccountPage() {
  const { theme } = useTheme();
  const passwordPattern = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

  const [session, setSession] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const completionHint = useMemo(() => {
    return session?.user?.email
      ? `Complete your profile for ${session.user.email}`
      : 'Complete your account profile';
  }, [session]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setErrorMessage('Supabase is not configured. Please set REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY.');
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    const bootstrap = async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!isMounted) return;

      if (error) {
        setErrorMessage(error.message || 'Unable to load your session. Open the confirmation link again.');
        setIsLoading(false);
        return;
      }

      const currentSession = data?.session || null;
      setSession(currentSession);

      if (!currentSession?.user?.id) {
        setErrorMessage('No active session from email link. Please open the invite email again.');
        setIsLoading(false);
        return;
      }

      const authUserId = currentSession.user.id;
      const metadata = currentSession.user.user_metadata || {};

      setForm((prev) => ({
        ...prev,
        firstName: metadata.firstName || metadata.first_name || '',
        lastName: metadata.lastName || metadata.last_name || '',
      }));

      const { data: userRow } = await supabase
        .from('users')
        .select('user_id')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      if (userRow?.user_id) {
        const { data: detailsRow } = await supabase
          .from('user_details')
          .select('first_name, middle_name, last_name, suffix, birthdate, gender, contact_number, street, region, barangay, city, province, country')
          .eq('user_id', userRow.user_id)
          .maybeSingle();

        if (detailsRow) {
          setForm({
            firstName: detailsRow.first_name || '',
            middleName: detailsRow.middle_name || '',
            lastName: detailsRow.last_name || '',
            suffix: detailsRow.suffix || '',
            birthdate: detailsRow.birthdate || '',
            gender: detailsRow.gender || '',
            contactNumber: detailsRow.contact_number || '',
            street: detailsRow.street || '',
            region: detailsRow.region || '',
            barangay: detailsRow.barangay || '',
            city: detailsRow.city || '',
            province: detailsRow.province || '',
            country: detailsRow.country || 'Philippines',
          });
        }
      }

      setIsLoading(false);
    };

    bootstrap();

    return () => {
      isMounted = false;
    };
  }, []);

  const updateField = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    if (!session?.user?.id) {
      setErrorMessage('No active session. Please open the invite email link again.');
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage('Password and password confirmation do not match.');
      return;
    }

    if (!passwordPattern.test(password)) {
      setErrorMessage('Password must be at least 8 characters and include an uppercase letter, a number, and a special character.');
      return;
    }

    setIsSaving(true);

    try {
      const authUserId = session.user.id;
      const metadata = session.user.user_metadata || {};

      const normalizedRole = metadata.role || 'Staff';
      const accessStart = metadata.accessStart || null;
      const accessEnd = metadata.accessEnd || null;

      const { error: passwordUpdateError } = await supabase.auth.updateUser({
        password,
      });

      if (passwordUpdateError) {
        throw passwordUpdateError;
      }

      const { data: upsertedUser, error: upsertUserError } = await supabase
        .from('users')
        .upsert(
          {
            auth_user_id: authUserId,
            email: session.user.email,
            role: normalizedRole,
            access_start: accessStart,
            access_end: accessEnd,
            is_active: true,
          },
          { onConflict: 'auth_user_id' },
        )
        .select('user_id, auth_user_id, email, role, is_active, access_start, access_end')
        .single();

      if (upsertUserError || !upsertedUser?.user_id) {
        throw upsertUserError || new Error('Unable to create or load user profile row.');
      }

      const userId = upsertedUser.user_id;

      const { data: existingDetails, error: detailsLookupError } = await supabase
        .from('user_details')
        .select('user_details_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (detailsLookupError) {
        throw detailsLookupError;
      }

      const detailsPayload = {
        user_id: userId,
        first_name: form.firstName,
        middle_name: form.middleName || null,
        last_name: form.lastName,
        suffix: form.suffix || null,
        birthdate: form.birthdate || null,
        gender: form.gender || null,
        contact_number: form.contactNumber || null,
        street: form.street || null,
        region: form.region || null,
        barangay: form.barangay || null,
        city: form.city || null,
        province: form.province || null,
        country: form.country || null,
        joined_date: new Date().toISOString().slice(0, 10),
      };

      if (existingDetails?.user_details_id) {
        const { error: detailsUpdateError } = await supabase
          .from('user_details')
          .update(detailsPayload)
          .eq('user_details_id', existingDetails.user_details_id);

        if (detailsUpdateError) {
          throw detailsUpdateError;
        }
      } else {
        const { error: detailsInsertError } = await supabase
          .from('user_details')
          .insert(detailsPayload);

        if (detailsInsertError) {
          throw detailsInsertError;
        }
      }

      localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(upsertedUser));
      window.dispatchEvent(
        new CustomEvent(USER_PROFILE_READY_EVENT, {
          detail: {
            authUserId,
            profile: upsertedUser,
          },
        }),
      );

      await supabase.auth.signOut();
      setIsCompleted(true);
      setStatusMessage('Your account is now available for use.');
    } catch (error) {
      setErrorMessage(error?.message || 'Unable to complete account. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isCompleted) {
    return (
      <div className="min-h-screen bg-white py-10 px-6">
        <div className="max-w-xl mx-auto">
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center space-y-4">
            <div className="inline-flex items-center justify-center rounded-full bg-green-100 text-green-700 p-3">
              <CheckCircle2 size={24} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Account Completed</h1>
            <p className="text-sm text-gray-600">Your account is now available for use.</p>
            <button
              type="button"
              onClick={() => window.location.replace('/')}
              className="w-full py-2.5 rounded-lg text-white font-semibold"
              style={{ backgroundColor: theme.primaryColor }}
            >
              Go To Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-700">
        <Loader2 className="animate-spin mr-2" size={18} /> Preparing your account...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white py-10 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Complete Account</h1>
          <p className="text-sm text-gray-600 mt-2">{completionHint}</p>
        </div>

        {errorMessage && (
          <div className="mb-5 rounded-lg border border-red-300 bg-red-50 text-red-700 px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} />
              <span>{errorMessage}</span>
            </div>
          </div>
        )}

        {statusMessage && (
          <div className="mb-5 rounded-lg border border-green-300 bg-green-50 text-green-700 px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} />
              <span>{statusMessage}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-xl p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
              <input name="firstName" value={form.firstName} onChange={updateField} required className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Middle Name</label>
              <input name="middleName" value={form.middleName} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
              <input name="lastName" value={form.lastName} onChange={updateField} required className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                className="w-full p-2 border border-gray-300 rounded-lg bg-white"
              />
              <p className="text-xs text-gray-500 mt-1">
                Must be at least 8 characters with an uppercase letter, a number, and a special character.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
              <input
                type="password"
                name="confirmPassword"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                className="w-full p-2 border border-gray-300 rounded-lg bg-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Suffix</label>
              <input name="suffix" value={form.suffix} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Birthdate</label>
              <input type="date" name="birthdate" value={form.birthdate} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
              <select name="gender" value={form.gender} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white">
                <option value="">Select</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Prefer not to say">Prefer not to say</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact Number</label>
              <input name="contactNumber" value={form.contactNumber} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Street</label>
              <input name="street" value={form.street} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
              <input name="region" value={form.region} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Barangay</label>
              <input name="barangay" value={form.barangay} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <input name="city" value={form.city} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Province</label>
              <input name="province" value={form.province} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <input name="country" value={form.country} onChange={updateField} className="w-full p-2 border border-gray-300 rounded-lg bg-white" />
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isSaving}
              className="w-full py-2.5 rounded-lg text-white font-semibold flex items-center justify-center gap-2"
              style={{ backgroundColor: theme.primaryColor }}
            >
              {isSaving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
              {isSaving ? 'Saving...' : 'Save And Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

