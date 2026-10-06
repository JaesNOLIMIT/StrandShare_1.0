import { createClient } from 'npm:@supabase/supabase-js@2';

const PRIVATE_ID_BUCKET = 'event_application_private_ids';
const EVENT_ASSET_BUCKET = 'event_application_assets';
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://donivra.vercel.app',
]);

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
  const configured = String(
    Deno.env.get('PROGRAM_MAINTENANCE_ALLOWED_ORIGINS')
      || Deno.env.get('ADMIN_ACCOUNT_ALLOWED_ORIGINS')
      || '',
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (DEFAULT_ALLOWED_ORIGINS.has(origin) || configured.includes(origin)) return origin;
  return '';
}

function normalizeRole(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function uniquePaths(values: unknown[]) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
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
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: 'Program applicant maintenance is not configured.' }, 503, allowedOrigin || null);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const payload = await request.json().catch(() => ({}));
    const action = String(payload?.action || 'preview').trim().toLowerCase();
    const requestedMode = String(payload?.mode || 'manual').trim().toLowerCase();
    const jwt = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    // Cron/pg_net has no browser Origin header and must still pass the Edge
    // gateway with the project's public key. Cleanup eligibility is enforced
    // again in the service-role-only database functions.
    const isScheduledRequest = !request.headers.get('Origin')
      && request.headers.get('apikey') === anonKey
      && action === 'cleanup'
      && requestedMode === 'automatic';
    let actorUserId: number | null = null;

    if (!isScheduledRequest) {
      if (!jwt) return jsonResponse({ error: 'Authentication required.' }, 401, allowedOrigin || null);
      const { data: authData, error: authError } = await admin.auth.getUser(jwt);
      if (authError || !authData.user) {
        return jsonResponse({ error: 'Your Admin session expired. Sign in again and retry.' }, 401, allowedOrigin || null);
      }

      const { data: actor, error: actorError } = await admin
        .from('users')
        .select('user_id, role, is_active')
        .eq('auth_user_id', authData.user.id)
        .maybeSingle();
      if (actorError) throw actorError;
      if (!actor || actor.is_active === false || !['admin', 'superadmin'].includes(normalizeRole(actor.role))) {
        return jsonResponse({ error: 'Only an active Admin can manage applicant-data retention.' }, 403, allowedOrigin || null);
      }
      actorUserId = Number(actor.user_id);
    }

    let summaryResult = await admin.rpc('get_program_applicant_maintenance_summary');
    if (summaryResult.error) throw summaryResult.error;

    // Configure once when absent. Normal page refreshes and nightly runs must
    // not repeatedly replace the same Cron job or rewrite Vault secrets.
    if (!summaryResult.data?.automatic_schedule_active) {
      const scheduleResult = await admin.rpc('configure_program_applicant_maintenance_schedule', {
        p_project_url: supabaseUrl,
        p_anon_key: anonKey,
      });
      if (scheduleResult.error) throw scheduleResult.error;
      summaryResult = await admin.rpc('get_program_applicant_maintenance_summary');
      if (summaryResult.error) throw summaryResult.error;
    }

    if (action === 'preview') {
      return jsonResponse({ ok: true, summary: summaryResult.data }, 200, allowedOrigin || null);
    }
    if (action !== 'cleanup') {
      return jsonResponse({ error: 'Unsupported maintenance action.' }, 400, allowedOrigin || null);
    }

    const mode = isScheduledRequest ? 'automatic' : 'manual';
    const { data: candidates, error: candidateError } = await admin.rpc(
      'get_program_applicant_cleanup_candidates',
      { p_limit: 100 },
    );
    if (candidateError) throw candidateError;

    let completed = 0;
    let failed = 0;
    const errors: Array<{ applicationId: number; message: string }> = [];

    for (const candidate of candidates || []) {
      const applicationId = Number(candidate.event_application_id);
      const idPaths = uniquePaths([
        candidate.applicant_valid_id_path,
        candidate.didit_id_front_image_path,
      ]);
      const attendeePaths = uniquePaths([candidate.attendee_list_path]);
      const deletedPaths: Array<{ bucket: string; path: string }> = [];

      try {
        if (idPaths.length > 0) {
          const removal = await admin.storage.from(PRIVATE_ID_BUCKET).remove(idPaths);
          if (removal.error) throw removal.error;
          idPaths.forEach((path) => deletedPaths.push({ bucket: PRIVATE_ID_BUCKET, path }));
        }
        if (attendeePaths.length > 0) {
          const removal = await admin.storage.from(EVENT_ASSET_BUCKET).remove(attendeePaths);
          if (removal.error) throw removal.error;
          attendeePaths.forEach((path) => deletedPaths.push({ bucket: EVENT_ASSET_BUCKET, path }));
        }

        const finalize = await admin.rpc('finalize_program_applicant_data_deletion', {
          p_event_application_id: applicationId,
          p_deletion_mode: mode,
          p_deleted_storage_buckets: [...new Set(deletedPaths.map((item) => item.bucket))],
          p_deleted_file_count: deletedPaths.length,
          p_triggered_by_user_id: actorUserId,
          p_error_message: null,
        });
        if (finalize.error) throw finalize.error;
        if (finalize.data) completed += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Unknown cleanup error.';
        errors.push({ applicationId, message });
        try {
          await admin.rpc('finalize_program_applicant_data_deletion', {
            p_event_application_id: applicationId,
            p_deletion_mode: mode,
            p_deleted_storage_buckets: [...new Set(deletedPaths.map((item) => item.bucket))],
            p_deleted_file_count: deletedPaths.length,
            p_triggered_by_user_id: actorUserId,
            p_error_message: message,
          });
        } catch {
          // Preserve the original failure in the response if audit logging also fails.
        }
      }
    }

    return jsonResponse({
      ok: failed === 0,
      mode,
      eligible: (candidates || []).length,
      completed,
      failed,
      errors,
    }, failed === 0 ? 200 : 207, allowedOrigin || null);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String((error as { message?: unknown })?.message || 'Applicant-data maintenance failed.');
    return jsonResponse({ error: message }, 400, allowedOrigin || null);
  }
});
