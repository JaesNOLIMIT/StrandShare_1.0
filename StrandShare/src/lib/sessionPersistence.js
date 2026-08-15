const REMEMBER_UNTIL_STORAGE_KEY = 'Donivra_remember_session_until';
const ACTIVE_TAB_STORAGE_KEY = 'Donivra_active_tab_session';
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

export function configureLoginSessionPersistence(rememberForThirtyDays) {
  const local = safeLocalStorage();
  const session = safeSessionStorage();

  session?.setItem(ACTIVE_TAB_STORAGE_KEY, 'true');

  if (rememberForThirtyDays) {
    local?.setItem(REMEMBER_UNTIL_STORAGE_KEY, String(Date.now() + THIRTY_DAYS_MS));
  } else {
    local?.removeItem(REMEMBER_UNTIL_STORAGE_KEY);
  }
}

export function clearLoginSessionPersistence() {
  safeLocalStorage()?.removeItem(REMEMBER_UNTIL_STORAGE_KEY);
  safeSessionStorage()?.removeItem(ACTIVE_TAB_STORAGE_KEY);
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

  const isCurrentTabSession = session?.getItem(ACTIVE_TAB_STORAGE_KEY) === 'true';
  return { isValid: isCurrentTabSession, isRemembered: false, rememberUntil: null };
}

