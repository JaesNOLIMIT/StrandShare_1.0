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
  const configured = String(Deno.env.get('PATIENT_INVITE_ALLOWED_ORIGINS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (LOCAL_ORIGINS.has(origin) || configured.includes(origin)) return origin;
  return '';
}

function normalizeRole(value: unknown) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['admin', 'superadmin'].includes(key)) return 'admin';
  if (['hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative'].includes(key)) return 'h_representative';
  return key;
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
    return jsonResponse({ error: 'Patient invite service is not configured.' }, 503, allowedOrigin || null);
  }

  try {
    const authorization = request.headers.get('Authorization') || '';
    const jwt = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return jsonResponse({ error: 'Authentication required.' }, 401, allowedOrigin || null);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !authData.user) return jsonResponse({ error: 'Invalid or expired session.' }, 401, allowedOrigin || null);

    const payload = await request.json();
    const action = String(payload?.action || 'invite').trim().toLowerCase();
    const hospitalId = Number(payload?.hospitalId || 0);
    if (!hospitalId) return jsonResponse({ error: 'Hospital assignment is required.' }, 400, allowedOrigin || null);

    const { data: actor, error: actorError } = await admin
      .from('users')
      .select('user_id, role, is_active')
      .eq('auth_user_id', authData.user.id)
      .maybeSingle();
    if (actorError || !actor || actor.is_active === false) {
      return jsonResponse({ error: 'Active staff account was not found.' }, 403, allowedOrigin || null);
    }

    const actorRole = normalizeRole(actor.role);
    if (!['admin', 'h_representative'].includes(actorRole)) {
      return jsonResponse({ error: 'Only an H-Representative or Admin can manage patient invites.' }, 403, allowedOrigin || null);
    }
    if (actorRole === 'h_representative') {
      const { data: assignment } = await admin
        .from('Hospital_Representative')
        .select('Link_ID')
        .eq('User_ID', actor.user_id)
        .eq('Hospital_ID', hospitalId)
        .maybeSingle();
      if (!assignment) return jsonResponse({ error: 'You are not assigned to this hospital.' }, 403, allowedOrigin || null);
    }

    if (action === 'authorize') {
      return jsonResponse({ authorized: true, hospitalId }, 200, allowedOrigin || null);
    }

    if (action === 'delete') {
      const authUserId = String(payload?.authUserId || '').trim();
      if (!authUserId) return jsonResponse({ error: 'Auth user id is required.' }, 400, allowedOrigin || null);
      const targetResult = await admin.auth.admin.getUserById(authUserId);
      const target = targetResult.data?.user;
      if (targetResult.error || !target) return jsonResponse({ error: 'Patient auth account was not found.' }, 404, allowedOrigin || null);
      if (String(target.user_metadata?.account_type || '').toLowerCase() !== 'patient') {
        return jsonResponse({ error: 'Only patient invite accounts can be removed by this function.' }, 403, allowedOrigin || null);
      }
      const deleteResult = await admin.auth.admin.deleteUser(authUserId);
      if (deleteResult.error) throw deleteResult.error;
      return jsonResponse({ deleted: true }, 200, allowedOrigin || null);
    }

    if (action !== 'invite') return jsonResponse({ error: 'Unsupported action.' }, 400, allowedOrigin || null);

    const email = String(payload?.email || '').trim().toLowerCase();
    const temporaryPassword = String(payload?.temporaryPassword || '');
    const metadata = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: 'A valid patient email is required.' }, 400, allowedOrigin || null);
    }
    if (temporaryPassword.length < 8) {
      return jsonResponse({ error: 'Temporary password did not meet the minimum length.' }, 400, allowedOrigin || null);
    }

    const inviteResult = await admin.auth.admin.inviteUserByEmail(email, {
      data: { ...metadata, account_type: 'patient', hospital_id: hospitalId },
    });
    if (inviteResult.error) throw inviteResult.error;
    const authUserId = inviteResult.data.user?.id;
    if (!authUserId) throw new Error('Invite succeeded without returning an auth user id.');

    const updateResult = await admin.auth.admin.updateUserById(authUserId, {
      email_confirm: true,
      password: temporaryPassword,
    });
    if (updateResult.error) {
      await admin.auth.admin.deleteUser(authUserId).catch(() => undefined);
      throw updateResult.error;
    }

    return jsonResponse({ authUserId }, 200, allowedOrigin || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to manage the patient invite.';
    return jsonResponse({ error: message }, 400, allowedOrigin || null);
  }
});
