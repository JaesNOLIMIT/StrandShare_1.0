const REMEMBER_UNTIL_STORAGE_KEY = 'Donivra_remember_session_until';
const ACTIVE_TAB_STORAGE_KEY = 'Donivra_active_tab_session';
const ACTIVE_BROWSER_SESSION_COOKIE = 'Donivra_active_browser_session';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function safeLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function hasActiveBrowserSessionCookie() {
  try {
    return document.cookie
      .split(';')
      .map((entry) => entry.trim())
      .some((entry) => entry === `${ACTIVE_BROWSER_SESSION_COOKIE}=true`);
  } catch {
    return false;
  }
}

function setActiveBrowserSessionCookie() {
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${ACTIVE_BROWSER_SESSION_COOKIE}=true; Path=/; SameSite=Lax${secure}`;
  } catch {
    // The Supabase session still remains available when cookies are disabled.
  }
}

function clearActiveBrowserSessionCookie() {
  try {
    document.cookie = `${ACTIVE_BROWSER_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    // Ignore cookie cleanup failures.
  }
}

export function configureLoginSessionPersistence(rememberForThirtyDays) {
  const local = safeLocalStorage();
  const session = safeSessionStorage();

  // Session cookies are shared by normal tabs but isolated from Incognito.
  // sessionStorage is tab-specific and previously caused every new tab to
  // interpret the shared Supabase session as invalid and sign the user out.
  session?.removeItem(ACTIVE_TAB_STORAGE_KEY);

  if (rememberForThirtyDays) {
    clearActiveBrowserSessionCookie();
    local?.setItem(REMEMBER_UNTIL_STORAGE_KEY, String(Date.now() + THIRTY_DAYS_MS));
  } else {
    local?.removeItem(REMEMBER_UNTIL_STORAGE_KEY);
    setActiveBrowserSessionCookie();
  }
}

export function clearLoginSessionPersistence() {
  safeLocalStorage()?.removeItem(REMEMBER_UNTIL_STORAGE_KEY);
  safeSessionStorage()?.removeItem(ACTIVE_TAB_STORAGE_KEY);
  clearActiveBrowserSessionCookie();
}

export function getLoginSessionPersistenceStatus(now = Date.now()) {
  const local = safeLocalStorage();
  const session = safeSessionStorage();
  const rawRememberUntil = local?.getItem(REMEMBER_UNTIL_STORAGE_KEY) || '';
  const rememberUntil = Number(rawRememberUntil);
  const hasRememberDeadline = Number.isFinite(rememberUntil) && rememberUntil > 0;

  if (hasRememberDeadline && rememberUntil > now) {
    return { isValid: true, isRemembered: true, rememberUntil };
  }

  if (hasRememberDeadline) {
    local?.removeItem(REMEMBER_UNTIL_STORAGE_KEY);
  }

  if (hasActiveBrowserSessionCookie()) {
    return { isValid: true, isRemembered: false, rememberUntil: null };
  }

  // Preserve sessions created by the previous release and migrate their
  // tab-only marker to the browser-wide session cookie on first load.
  if (session?.getItem(ACTIVE_TAB_STORAGE_KEY) === 'true') {
    session.removeItem(ACTIVE_TAB_STORAGE_KEY);
    setActiveBrowserSessionCookie();
    return { isValid: true, isRemembered: false, rememberUntil: null };
  }

  return { isValid: false, isRemembered: false, rememberUntil: null };
}
