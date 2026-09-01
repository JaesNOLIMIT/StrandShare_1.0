import { createClient } from 'npm:@supabase/supabase-js@2';

const LOCAL_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      Vary: 'Origin',
    },
  });
}

function getAllowedOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const configured = String(Deno.env.get('ADMIN_ACCOUNT_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (LOCAL_ORIGINS.has(origin) || configured.includes(origin)) return origin;
  return '';
}

function normalizeRole(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const randomBytes = new Uint8Array(14);
  crypto.getRandomValues(randomBytes);
  const randomPart = Array.from(randomBytes, (value) => alphabet[value % alphabet.length]).join('');
  return `Dnv-${randomPart}!7a`;
}

Deno.serve(async (request) => {
  const allowedOrigin = getAllowedOrigin(request);
  if (request.method === 'OPTIONS') {
    return allowedOrigin === ''
      ? jsonResponse({ error: 'Origin is not allowed.' }, 403, null)
      : jsonResponse({}, 200, allowedOrigin);
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, allowedOrigin || null);
  if (allowedOrigin === '') return jsonResponse({ error: 'Origin is not allowed.' }, 403, null);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'The secure account management service is not configured.' }, 503, allowedOrigin || null);
  }

  try {
    const jwt = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return jsonResponse({ error: 'Authentication required.' }, 401, allowedOrigin || null);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !authData.user) {
      return jsonResponse({ error: 'Your admin session expired. Sign in again and retry.' }, 401, allowedOrigin || null);
    }

    const { data: actor, error: actorError } = await admin
      .from('users')
      .select('user_id, role, is_active')
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();
    if (actorError) throw actorError;
    if (!actor || actor.is_active === false || !['admin', 'superadmin'].includes(normalizeRole(actor.role))) {
      return jsonResponse({ error: 'Only an active Admin can manage account credentials.' }, 403, allowedOrigin || null);
    }

    const payload = await request.json();
    const action = String(payload?.action || '').trim().toLowerCase();

    if (action === 'invite-internal') {
      const email = String(payload?.email || '').trim().toLowerCase();
      const temporaryPassword = buildTemporaryPassword();
      const role = normalizeRole(payload?.role);
      const publicUserId = Number(payload?.publicUserId || 0);
      const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: 'A valid email address is required.' }, 400, allowedOrigin || null);
      }
      if (!['staff', 'specialist'].includes(role)) {
        return jsonResponse({ error: 'Only Staff and Specialist accounts can be invited here.' }, 400, allowedOrigin || null);
      }
      if (!publicUserId) {
        return jsonResponse({ error: 'The pending public account record is invalid.' }, 400, allowedOrigin || null);
      }

      const { data: publicUser, error: publicUserError } = await admin
        .from('users')
        .select('user_id, email, role, auth_user_id')
        .eq('user_id', publicUserId)
        .maybeSingle();
      if (publicUserError) throw publicUserError;
      if (!publicUser || String(publicUser.email || '').toLowerCase() !== email || normalizeRole(publicUser.role) !== role) {
        return jsonResponse({ error: 'The pending public account does not match this invitation.' }, 409, allowedOrigin || null);
      }
      if (publicUser.auth_user_id) {
        return jsonResponse({ error: 'This account is already linked to an Auth user.' }, 409, allowedOrigin || null);
      }

      const inviteResult = await admin.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${String(payload?.redirectTo || '').replace(/\/$/, '')}/login`,
        data: { ...metadata, temporary_password: temporaryPassword },
      });
      if (inviteResult.error) throw inviteResult.error;
      const authUserId = String(inviteResult.data.user?.id || '').trim();
      if (!authUserId) throw new Error('Invitation succeeded without returning an Auth user id.');

      const updateResult = await admin.auth.admin.updateUserById(authUserId, {
        email_confirm: true,
        password: temporaryPassword,
        user_metadata: {
          ...metadata,
          temporary_password: null,
          account_type: 'internal_web_user',
          role,
        },
      });
      if (updateResult.error) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
        throw updateResult.error;
      }

      const { data: linkedUser, error: linkError } = await admin
        .from('users')
        .update({ auth_user_id: authUserId, role, is_active: true, updated_at: new Date().toISOString() })
        .eq('user_id', publicUserId)
        .is('auth_user_id', null)
        .select('user_id')
        .maybeSingle();
      if (linkError || !linkedUser) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
        throw linkError || new Error('The pending public account could not be linked safely.');
      }

      return jsonResponse({ ok: true, authUserId }, 200, allowedOrigin || null);
    }

    if (action === 'set-hospital-manager-credentials') {
      const authUserId = String(payload?.authUserId || '').trim();
      const temporaryPassword = String(payload?.temporaryPassword || '');
      const hospitalId = Number(payload?.hospitalId || 0);
      if (!authUserId || !hospitalId || temporaryPassword.length < 8) {
        return jsonResponse({ error: 'Hospital manager credentials are incomplete.' }, 400, allowedOrigin || null);
      }

      const { data: hospital, error: hospitalError } = await admin
        .from('Hospitals')
        .select('Hospital_ID, Created_By')
        .eq('Hospital_ID', hospitalId)
        .maybeSingle();
      if (hospitalError) throw hospitalError;
      if (!hospital?.Created_By) return jsonResponse({ error: 'Hospital applicant was not found.' }, 404, allowedOrigin || null);

      const { data: manager, error: managerError } = await admin
        .from('users')
        .select('auth_user_id')
        .eq('user_id', hospital.Created_By)
        .maybeSingle();
      if (managerError) throw managerError;
      if (String(manager?.auth_user_id || '') !== authUserId) {
        return jsonResponse({ error: 'The selected Auth account does not belong to this hospital applicant.' }, 409, allowedOrigin || null);
      }

      const updateResult = await admin.auth.admin.updateUserById(authUserId, {
        email_confirm: true,
        password: temporaryPassword,
        user_metadata: {
          account_type: 'partner_hospital',
          role: 'h_representative',
          hospital_id: hospitalId,
          updated_at: new Date().toISOString(),
        },
      });
      if (updateResult.error) throw updateResult.error;
      return jsonResponse({ ok: true, authUserId }, 200, allowedOrigin || null);
    }

    if (action === 'delete-auth-user') {
      const authUserId = String(payload?.authUserId || '').trim();
      if (!authUserId) return jsonResponse({ error: 'Auth user id is required.' }, 400, allowedOrigin || null);

      const authTargetResult = await admin.auth.admin.getUserById(authUserId);
      const authTarget = authTargetResult.data?.user;
      if (authTargetResult.error || !authTarget) {
        return jsonResponse({ error: 'Auth account was not found.' }, 404, allowedOrigin || null);
      }
      const { data: publicTarget, error: publicTargetError } = await admin
        .from('users')
        .select('user_id, role')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
      if (publicTargetError) throw publicTargetError;
      if (
        String(authTarget.user_metadata?.account_type || '') !== 'internal_web_user'
        || !publicTarget
        || !['staff', 'specialist'].includes(normalizeRole(publicTarget.role))
      ) {
        return jsonResponse({ error: 'Only a newly created Staff or Specialist account can be rolled back here.' }, 403, allowedOrigin || null);
      }

      const deleteResult = await admin.auth.admin.deleteUser(authUserId);
      if (deleteResult.error) throw deleteResult.error;
      return jsonResponse({ ok: true, deleted: true }, 200, allowedOrigin || null);
    }

    return jsonResponse({ error: 'Unsupported account management action.' }, 400, allowedOrigin || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to manage the account.';
    return jsonResponse({ error: message }, 400, allowedOrigin || null);
  }
});
