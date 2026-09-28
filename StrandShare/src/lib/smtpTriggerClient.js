const REQUEST_TIMEOUT_MS = 15000;

function resolveTriggerUrl() {
  const fromEnv = String(process.env.REACT_APP_SMTP_TRIGGER_URL || '').trim();
  if (fromEnv) return fromEnv;
  return '';
}

export async function triggerSmtpNow(reason = 'manual') {
  const endpoint = resolveTriggerUrl();
  if (!endpoint) {
    return {
      ok: true,
      queued: true,
      message: 'Email was queued for the independent local SMTP worker.',
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        payload,
        message: String(payload?.error || `SMTP trigger failed (${response.status}).`),
      };
    }

    return { ok: true, status: response.status, payload };
  } catch (error) {
    return {
      ok: false,
      message: String(error?.message || error || 'SMTP trigger request failed.'),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
