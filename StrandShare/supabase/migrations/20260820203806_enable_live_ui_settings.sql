-- Keep global branding and UI configuration synchronized across open clients.
-- Both tables already have RLS enabled; Realtime continues to authorize each
-- event against the subscriber's existing SELECT policies.

do $do$
declare
  live_table text;
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'The supabase_realtime publication does not exist.';
  end if;

  foreach live_table in array array['UI_Settings', 'Theme_Presets']
  loop
    if to_regclass(format('public.%I', live_table)) is not null
      and not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = live_table
      )
    then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        live_table
      );
    end if;
  end loop;
end;
$do$;
