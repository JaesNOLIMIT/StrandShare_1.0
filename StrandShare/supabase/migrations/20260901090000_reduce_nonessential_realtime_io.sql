-- Keep Realtime focused on screens where immediate workflow updates matter.
-- Dashboard, report, audit, theme, and configuration pages now use cached data
-- plus their existing explicit refresh/load paths, so publishing these tables
-- only adds WAL decoding and subscriber authorization work.

begin;

do $do$
declare
  v_table_name text;
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    return;
  end if;

  foreach v_table_name in array array[
    'audit_logs',
    'Hair_AI_Review_Comparisons',
    'wig_requirements',
    'Logistics_Settings',
    'legal_documents',
    'UI_Settings',
    'Theme_Presets'
  ]
  loop
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table_name
    ) then
      execute format(
        'alter publication supabase_realtime drop table public.%I',
        v_table_name
      );
    end if;
  end loop;
end;
$do$;

commit;
