begin;

-- These are application-level logical snapshots of every public base table.
-- They complement (but do not replace) Supabase project/PITR backups because
-- the snapshot is stored inside the same Supabase project.
create table if not exists public."System_Backups" (
  "Backup_ID" bigint generated always as identity primary key,
  "Backup_Code" text not null unique,
  "Status" text not null default 'Completed'
    check ("Status" in ('Completed', 'Verified', 'Failed')),
  "Format_Version" integer not null default 1,
  "Table_Count" integer not null default 0,
  "Row_Count" bigint not null default 0,
  "Size_Bytes" bigint not null default 0,
  "Checksum" text not null,
  "Snapshot" jsonb not null,
  "Created_At" timestamp with time zone not null default now(),
  "Created_By" integer references public.users(user_id) on delete set null,
  "Verified_At" timestamp with time zone,
  "Verified_By" integer references public.users(user_id) on delete set null,
  "Expires_At" timestamp with time zone not null default (now() + interval '30 days')
);

create index if not exists idx_system_backups_created_at
  on public."System_Backups" ("Created_At" desc);
create index if not exists idx_system_backups_expires_at
  on public."System_Backups" ("Expires_At");

alter table public."System_Backups" enable row level security;
revoke all on table public."System_Backups" from public, anon, authenticated;

create or replace function public.create_admin_application_backup()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_table record;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
  v_payload jsonb;
  v_table_rows bigint;
  v_total_rows bigint := 0;
  v_table_count integer := 0;
  v_size_bytes bigint;
  v_checksum text;
  v_code text;
  v_backup public."System_Backups"%rowtype;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('admin', 'superadmin')
  then
    raise exception 'Only active Admin or Super Admin accounts can create backups';
  end if;

  -- Enforce the stated retention policy whenever a new snapshot is created.
  delete from public."System_Backups"
  where "Expires_At" <= now();

  for v_table in
    select tables.table_name
    from information_schema.tables
    where tables.table_schema = 'public'
      and tables.table_type = 'BASE TABLE'
      and tables.table_name <> 'System_Backups'
    order by tables.table_name
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(source_row)), ''[]''::jsonb), count(*)::bigint from public.%I source_row',
      v_table.table_name
    ) into v_rows, v_table_rows;

    v_tables := v_tables || jsonb_build_object(
      v_table.table_name,
      jsonb_build_object('row_count', v_table_rows, 'rows', v_rows)
    );
    v_table_count := v_table_count + 1;
    v_total_rows := v_total_rows + v_table_rows;
  end loop;

  v_payload := jsonb_build_object(
    'format', 'strandshare-public-schema-backup',
    'format_version', 1,
    'created_at', now(),
    'schema', 'public',
    'table_count', v_table_count,
    'row_count', v_total_rows,
    'tables', v_tables
  );
  v_size_bytes := pg_column_size(v_payload)::bigint;
  v_checksum := md5(v_payload::text);
  v_code := 'BKP-' || to_char(timezone('Asia/Manila', clock_timestamp()), 'YYYYMMDD-HH24MISS-MS');

  insert into public."System_Backups" (
    "Backup_Code", "Status", "Format_Version", "Table_Count", "Row_Count",
    "Size_Bytes", "Checksum", "Snapshot", "Created_By", "Expires_At"
  ) values (
    v_code, 'Completed', 1, v_table_count, v_total_rows,
    v_size_bytes, v_checksum, v_payload, v_actor.user_id, now() + interval '30 days'
  ) returning * into v_backup;

  insert into public.audit_logs (
    user_id, action, description, user_email, resource, status, "time"
  ) values (
    v_actor.user_id,
    'backup.create',
    format(
      'Created application backup %s with %s tables, %s rows, and %s bytes.',
      v_backup."Backup_Code", v_backup."Table_Count", v_backup."Row_Count", v_backup."Size_Bytes"
    ),
    v_actor.email,
    'backup:' || v_backup."Backup_Code",
    'success',
    timezone('Asia/Manila', now())
  );

  return jsonb_build_object(
    'backup_id', v_backup."Backup_ID",
    'backup_code', v_backup."Backup_Code",
    'status', v_backup."Status",
    'table_count', v_backup."Table_Count",
    'row_count', v_backup."Row_Count",
    'size_bytes', v_backup."Size_Bytes",
    'checksum', v_backup."Checksum",
    'created_at', v_backup."Created_At",
    'expires_at', v_backup."Expires_At"
  );
end;
$fn$;

create or replace function public.list_admin_application_backups()
returns table (
  backup_id bigint,
  backup_code text,
  status text,
  table_count integer,
  row_count bigint,
  size_bytes bigint,
  checksum text,
  created_at timestamp with time zone,
  created_by integer,
  verified_at timestamp with time zone,
  verified_by integer,
  expires_at timestamp with time zone
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_actor public.users%rowtype;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('admin', 'superadmin')
  then
    raise exception 'Only active Admin or Super Admin accounts can view backups';
  end if;

  return query
  select
    backup."Backup_ID",
    backup."Backup_Code",
    case when backup."Expires_At" <= now() then 'Expired' else backup."Status" end,
    backup."Table_Count",
    backup."Row_Count",
    backup."Size_Bytes",
    backup."Checksum",
    backup."Created_At",
    backup."Created_By",
    backup."Verified_At",
    backup."Verified_By",
    backup."Expires_At"
  from public."System_Backups" backup
  order by backup."Created_At" desc
  limit 100;
end;
$fn$;

create or replace function public.verify_admin_application_backup(p_backup_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_backup public."System_Backups"%rowtype;
  v_actual_checksum text;
  v_valid boolean;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('admin', 'superadmin')
  then
    raise exception 'Only active Admin or Super Admin accounts can verify backups';
  end if;

  select * into v_backup
  from public."System_Backups" backup
  where backup."Backup_ID" = p_backup_id
  for update;

  if v_backup."Backup_ID" is null then
    raise exception 'Backup was not found';
  end if;

  v_actual_checksum := md5(v_backup."Snapshot"::text);
  v_valid := v_actual_checksum = v_backup."Checksum"
    and coalesce((v_backup."Snapshot" ->> 'format_version')::integer, 0) = v_backup."Format_Version";

  update public."System_Backups"
  set
    "Status" = case when v_valid then 'Verified' else 'Failed' end,
    "Verified_At" = now(),
    "Verified_By" = v_actor.user_id
  where "Backup_ID" = v_backup."Backup_ID"
  returning * into v_backup;

  insert into public.audit_logs (
    user_id, action, description, user_email, resource, status, "time"
  ) values (
    v_actor.user_id,
    'backup.verify',
    format('Verified application backup %s. Integrity result: %s.', v_backup."Backup_Code", case when v_valid then 'valid' else 'failed' end),
    v_actor.email,
    'backup:' || v_backup."Backup_Code",
    case when v_valid then 'success' else 'failed' end,
    timezone('Asia/Manila', now())
  );

  return jsonb_build_object(
    'backup_id', v_backup."Backup_ID",
    'backup_code', v_backup."Backup_Code",
    'valid', v_valid,
    'status', v_backup."Status",
    'verified_at', v_backup."Verified_At",
    'checksum', v_backup."Checksum"
  );
end;
$fn$;

create or replace function public.download_admin_application_backup(p_backup_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_backup public."System_Backups"%rowtype;
begin
  select * into v_actor
  from public.users account
  where account.auth_user_id = auth.uid()
    and account.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null
    or public.normalize_app_role(v_actor.role) not in ('admin', 'superadmin')
  then
    raise exception 'Only active Admin or Super Admin accounts can download backups';
  end if;

  select * into v_backup
  from public."System_Backups" backup
  where backup."Backup_ID" = p_backup_id;

  if v_backup."Backup_ID" is null then
    raise exception 'Backup was not found';
  end if;

  insert into public.audit_logs (
    user_id, action, description, user_email, resource, status, "time"
  ) values (
    v_actor.user_id,
    'backup.download',
    format('Downloaded application backup %s.', v_backup."Backup_Code"),
    v_actor.email,
    'backup:' || v_backup."Backup_Code",
    'success',
    timezone('Asia/Manila', now())
  );

  return jsonb_build_object(
    'backup_code', v_backup."Backup_Code",
    'checksum', v_backup."Checksum",
    'created_at', v_backup."Created_At",
    'expires_at', v_backup."Expires_At",
    'snapshot', v_backup."Snapshot"
  );
end;
$fn$;

revoke all on function public.create_admin_application_backup() from public, anon;
revoke all on function public.list_admin_application_backups() from public, anon;
revoke all on function public.verify_admin_application_backup(bigint) from public, anon;
revoke all on function public.download_admin_application_backup(bigint) from public, anon;
grant execute on function public.create_admin_application_backup() to authenticated;
grant execute on function public.list_admin_application_backups() to authenticated;
grant execute on function public.verify_admin_application_backup(bigint) to authenticated;
grant execute on function public.download_admin_application_backup(bigint) to authenticated;

comment on table public."System_Backups" is
  'Admin-created logical JSON snapshots of public application tables with a 30-day retention window.';
comment on function public.create_admin_application_backup() is
  'Creates a real logical snapshot of all public application tables except System_Backups.';

notify pgrst, 'reload schema';
commit;
