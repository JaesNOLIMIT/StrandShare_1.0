import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
export const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;
const inFlightDataReads = new Map();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function isDataRequest(input) {
  const requestUrl = typeof Request !== 'undefined' && input instanceof Request
    ? input.url
    : String(input || '');

  return Boolean(supabaseUrl && requestUrl.startsWith(`${supabaseUrl}/rest/v1/`));
}

function requestMethod(input, init = {}) {
  return String(
    init.method
      || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      || 'GET',
  ).toUpperCase();
}

function requestHeader(input, init, name) {
  const initHeaders = new Headers(init?.headers || undefined);
  const initValue = initHeaders.get(name);
  if (initValue !== null) return initValue;
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.headers.get(name) || '';
  }
  return '';
}

function dataReadKey(input, init = {}) {
  const requestUrl = typeof Request !== 'undefined' && input instanceof Request
    ? input.url
    : String(input || '');
  const varyingHeaders = [
    'accept',
    'accept-profile',
    'authorization',
    'content-profile',
    'range',
    'range-unit',
    'prefer',
  ].map((name) => `${name}:${requestHeader(input, init, name)}`).join('|');
  return `${requestMethod(input, init)}|${requestUrl}|${varyingHeaders}`;
}

function fetchDataRequest(input, init = {}) {
  const method = requestMethod(input, init);
  if (method !== 'GET' && method !== 'HEAD') {
    return fetch(input, init);
  }

  const key = dataReadKey(input, init);
  let pending = inFlightDataReads.get(key);
  if (!pending) {
    pending = fetch(input, init).finally(() => {
      inFlightDataReads.delete(key);
    });
    inFlightDataReads.set(key, pending);
  }

  // A Response body can only be consumed once. Each Supabase caller receives
  // an independent clone while the database executes the identical read once.
  return pending.then((response) => response.clone());
}

function fetchWithRequestControls(input, init = {}) {
  // Supabase Auth already owns its retry and cancellation lifecycle. Aborting
  // those requests here turns a temporarily slow refresh into an
  // AuthRetryableFetchError and can leave client initialization waiting on a
  // retry. Only coalesce identical REST reads; pass auth and all other traffic
  // through unchanged.
  return isDataRequest(input) ? fetchDataRequest(input, init) : fetch(input, init);
}

function createSupabaseClient() {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      fetch: fetchWithRequestControls,
    },
  });
}

function getBrowserSupabaseSingleton() {
  if (typeof window === 'undefined') {
    return createSupabaseClient();
  }

  const existing = window.__donivraSupabaseClient;
  if (existing?.url === supabaseUrl && existing?.anonKey === supabaseAnonKey && existing?.client) {
    return existing.client;
  }

  const client = createSupabaseClient();
  window.__donivraSupabaseClient = {
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
    client,
  };
  return client;
}

// React Fast Refresh re-evaluates modules during development. Keeping the
// client on window prevents multiple GoTrueClient instances from competing
// for the same Supabase auth storage key after a hot update.
export const supabase = isSupabaseConfigured ? getBrowserSupabaseSingleton() : null;

// React cleanup does not run when Chrome freezes a document in the
// back-forward cache. Close Realtime before that freeze so the browser does
// not abort the socket and report a misleading WebSocket console error. The
// existing channels reconnect when the cached page is restored.
if (typeof window !== 'undefined' && supabase && !window.__donivraRealtimePageLifecycle) {
  window.__donivraRealtimePageLifecycle = true;
  let reconnectAfterRestore = false;

  window.addEventListener('pagehide', () => {
    reconnectAfterRestore = supabase.realtime.getChannels().length > 0;
    void supabase.realtime.disconnect(1000, 'page hidden');
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !reconnectAfterRestore) return;
    window.setTimeout(() => {
      if (supabase.realtime.getChannels().length > 0) {
        supabase.realtime.connect();
      }
    }, 0);
  });
}

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
