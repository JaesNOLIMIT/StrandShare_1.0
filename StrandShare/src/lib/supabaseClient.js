import { createClient } from '@supabase/supabase-js';
import { trackDataRequest } from './dataRequestTracker';

export const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
export const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;
const AUTH_FETCH_TIMEOUT_MS = 15000;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function isAuthRequest(input) {
  const requestUrl = typeof Request !== 'undefined' && input instanceof Request
    ? input.url
    : String(input || '');

  return Boolean(supabaseUrl && requestUrl.startsWith(`${supabaseUrl}/auth/v1/`));
}

function isDataRequest(input) {
  const requestUrl = typeof Request !== 'undefined' && input instanceof Request
    ? input.url
    : String(input || '');

  return Boolean(supabaseUrl && requestUrl.startsWith(`${supabaseUrl}/rest/v1/`));
}

function fetchWithAuthTimeout(input, init = {}) {
  if (!isAuthRequest(input)) {
    const request = fetch(input, init);
    return isDataRequest(input) ? trackDataRequest(request) : request;
  }

  const controller = new AbortController();
  const inputSignal = init.signal
    || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  const forwardAbort = () => controller.abort(inputSignal?.reason);

  if (inputSignal?.aborted) {
    forwardAbort();
  } else {
    inputSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutId = window.setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);

  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    window.clearTimeout(timeoutId);
    inputSignal?.removeEventListener('abort', forwardAbort);
  });
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        fetch: fetchWithAuthTimeout,
      },
    })
  : null;

export function clearLocalSupabaseSession() {
  if (typeof window === 'undefined') {
    return;
  }

  let storageKey = '';
  try {
    storageKey = String(supabase?.auth?.storageKey || '');
  } catch {
    // Fall back to the project-ref-based key below.
  }

  if (!storageKey && supabaseUrl) {
    try {
      const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
      storageKey = projectRef ? `sb-${projectRef}-auth-token` : '';
    } catch {
      storageKey = '';
    }
  }

  if (!storageKey) {
    return;
  }

  [window.localStorage, window.sessionStorage].forEach((storage) => {
    try {
      const matchingKeys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === storageKey || key?.startsWith(`${storageKey}-`)) {
          matchingKeys.push(key);
        }
      }
      matchingKeys.forEach((key) => storage.removeItem(key));
    } catch {
      // Storage may be unavailable under strict browser privacy settings.
    }
  });
}
