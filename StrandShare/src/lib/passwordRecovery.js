export function getPasswordRecoveryParameters(location = window.location) {
  const queryParams = new URLSearchParams(location.search || '');
  const hash = String(location.hash || '');
  const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);

  return {
    code: queryParams.get('code') || '',
    accessToken: hashParams.get('access_token') || '',
    refreshToken: hashParams.get('refresh_token') || '',
    type: queryParams.get('type') || hashParams.get('type') || '',
    recoveryMarker: queryParams.get('recovery') || '',
    errorCode: queryParams.get('error_code') || hashParams.get('error_code') || '',
    errorDescription:
      queryParams.get('error_description') ||
      hashParams.get('error_description') ||
      queryParams.get('error') ||
      hashParams.get('error') ||
      '',
  };
}

export function hasPasswordRecoveryCallback(parameters) {
  return Boolean(
    parameters?.type === 'recovery' ||
    parameters?.code ||
    (parameters?.accessToken && parameters?.refreshToken),
  );
}

export function ensurePasswordRecoveryRoute(location = window.location, history = window.history) {
  const parameters = getPasswordRecoveryParameters(location);
  const normalizedError = `${parameters.errorCode} ${parameters.errorDescription}`.toLowerCase();
  const isExpiredRecoveryLink =
    normalizedError.includes('otp_expired') ||
    (normalizedError.includes('email link') && normalizedError.includes('expired'));
  const hasRecoveryIntent =
    parameters.type === 'recovery' ||
    (parameters.recoveryMarker === '1' && hasPasswordRecoveryCallback(parameters)) ||
    isExpiredRecoveryLink;

  if (!hasRecoveryIntent || location.pathname === '/reset-password') {
    return location.pathname;
  }

  const recoveryUrl = `/reset-password${location.search || ''}${location.hash || ''}`;
  history.replaceState({}, document.title, recoveryUrl);
  return '/reset-password';
}

export function getPasswordRecoveryRedirectUrl(origin = window.location.origin) {
  return `${String(origin).replace(/\/$/, '')}/reset-password?recovery=1`;
}

export async function establishPasswordRecoverySession(auth, parameters) {
  if (parameters.code) {
    const { data, error } = await auth.exchangeCodeForSession(parameters.code);
    if (error) {
      throw error;
    }
    return data?.session || null;
  }

  if (parameters.accessToken && parameters.refreshToken) {
    const { data, error } = await auth.setSession({
      access_token: parameters.accessToken,
      refresh_token: parameters.refreshToken,
    });
    if (error) {
      throw error;
    }
    return data?.session || null;
  }

  if (parameters.type === 'recovery') {
    const { data, error } = await auth.getSession();
    if (error) {
      throw error;
    }
    return data?.session || null;
  }

  return null;
}

export function getSessionSubject(session) {
  const token = String(session?.access_token || '');
  const payloadPart = token.split('.')[1];
  if (!payloadPart) {
    return '';
  }

  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(window.atob(padded));
    return typeof payload?.sub === 'string' ? payload.sub : '';
  } catch {
    return '';
  }
}

export function isUserRecoverySession(session) {
  const userId = String(session?.user?.id || '');
  return Boolean(userId && getSessionSubject(session) === userId);
}
