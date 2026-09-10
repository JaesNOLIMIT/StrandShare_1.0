import { supabase } from './supabaseClient';

async function readFunctionError(error, data) {
  if (data?.error) return String(data.error);

  try {
    const response = error?.context;
    if (response && typeof response.clone === 'function') {
      const payload = await response.clone().json();
      if (payload?.error) return String(payload.error);
    }
  } catch {
    // Fall back to the SDK error message below.
  }

  const message = String(error?.message || 'The account management service did not respond.');
  const normalized = message.toLowerCase();
  if (
    normalized.includes('failed to send a request')
    || normalized.includes('function not found')
    || normalized.includes('non-2xx status')
  ) {
    return 'The secure account management service is unavailable. Deploy the admin-account-management Edge Function, then try again.';
  }
  return message;
}

export async function invokeAdminAccountManagement(payload) {
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase.functions.invoke('admin-account-management', {
    body: payload,
  });

  if (error || data?.error || data?.ok === false) {
    throw new Error(await readFunctionError(error, data));
  }

  return data;
}
