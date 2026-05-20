-- 088_wig_ai_filters.sql
-- Wig AI Studio: stores AI-generated 3D try-on filters (.glb) per wig.
--
-- Workflow: Specialist uploads reference photos (front/side, optional top/back)
-- to the wig_ai_sources bucket. A local Python AI server (TripoSR / InstantMesh)
-- converts them to a .glb mesh and uploads it to wig_ai_filters bucket.
-- Specialist previews + tunes fit settings, then approves. Only ONE row per Wig
-- can have Is_Active = true at any time -- that row is what the mobile RN app
-- fetches to virtually try on the wig.

-- ---------------------------------------------------------------------------
-- 1. Enum for filter lifecycle status
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'wig_ai_filter_status') then
    create type public.wig_ai_filter_status as enum (
      'processing',      -- AI server is generating the asset
      'pending_review',  -- AI finished, awaiting specialist approval
      'approved',        -- specialist approved, eligible to be marked active
      'rejected',        -- specialist rejected; will be regenerated
      'failed',          -- AI pipeline errored out
      'superseded'       -- replaced by a newer approved version
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Wig_AI_Filters table
-- ---------------------------------------------------------------------------
create table if not exists public."Wig_AI_Filters" (
  "Filter_ID"               serial      not null,
  "Wig_ID"                  integer     not null,
  "Version"                 integer     not null default 1,
  "Status"                  public.wig_ai_filter_status not null default 'processing',
  "Is_Active"               boolean     not null default false,

  -- Source reference images (paths inside wig_ai_sources bucket)
  "Source_Front_Path"       text        not null,
  "Source_Side_Path"        text        not null,
  "Source_Top_Path"         text        null,
  "Source_Back_Path"        text        null,

  -- Generated artifacts (paths inside wig_ai_filters bucket)
  "Glb_Asset_Path"          text        null,   -- final 3D mesh .glb
  "Thumbnail_Path"          text        null,   -- preview PNG of the filter

  -- Fit calibration the specialist tunes in the editor
  -- Expected shape:
  --   { offsetX:number, offsetY:number, offsetZ:number,
  --     scale:number, rotationX:number, rotationY:number, rotationZ:number,
  --     opacity:number }
  "Fit_Settings"            jsonb       not null default '{}'::jsonb,

  -- AI pipeline metadata
  "AI_Model_Version"        varchar(80) null,   -- e.g. 'triposr-1.0'
  "Processing_Started_At"   timestamp without time zone null,
  "Processing_Completed_At" timestamp without time zone null,
  "Error_Message"           text        null,

  -- Audit
  "Created_By_User_ID"      integer     null,
  "Approved_By_User_ID"     integer     null,
  "Approved_At"             timestamp without time zone null,
  "Created_At"              timestamp without time zone not null default now(),
  "Updated_At"              timestamp without time zone not null default now(),

  constraint Wig_AI_Filters_pkey primary key ("Filter_ID"),
  constraint Wig_AI_Filters_Wig_ID_fkey
    foreign key ("Wig_ID") references public."Wigs" ("Wig_ID") on delete cascade,
  constraint Wig_AI_Filters_Created_By_fkey
    foreign key ("Created_By_User_ID") references public.users (user_id) on delete set null,
  constraint Wig_AI_Filters_Approved_By_fkey
    foreign key ("Approved_By_User_ID") references public.users (user_id) on delete set null,
  constraint Wig_AI_Filters_Wig_Version_unique unique ("Wig_ID", "Version")
) tablespace pg_default;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
create index if not exists "idx_Wig_AI_Filters_Wig_ID"
  on public."Wig_AI_Filters" using btree ("Wig_ID");

create index if not exists "idx_Wig_AI_Filters_Status"
  on public."Wig_AI_Filters" using btree ("Status");

-- Only one active filter per wig. The partial unique index makes the database
-- enforce this rather than relying on application-level coordination.
create unique index if not exists "Wig_AI_Filters_one_active_per_wig"
  on public."Wig_AI_Filters" ("Wig_ID")
  where "Is_Active" = true;

-- ---------------------------------------------------------------------------
-- 4. Updated_At trigger (matches set_wig_specifications_updated_at pattern)
-- ---------------------------------------------------------------------------
create or replace function public.set_wig_ai_filters_updated_at()
returns trigger
language plpgsql
as $$
begin
  new."Updated_At" := now();
  return new;
end;
$$;

drop trigger if exists trg_set_wig_ai_filters_updated_at on public."Wig_AI_Filters";
create trigger trg_set_wig_ai_filters_updated_at
  before update on public."Wig_AI_Filters"
  for each row
  execute function public.set_wig_ai_filters_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Auto-supersede prior active row when a new one is flipped active
--    Prevents the partial unique index from blocking a legitimate handoff.
-- ---------------------------------------------------------------------------
create or replace function public.wig_ai_filters_supersede_previous_active()
returns trigger
language plpgsql
as $$
begin
  if new."Is_Active" = true and (tg_op = 'INSERT' or old."Is_Active" is distinct from true) then
    update public."Wig_AI_Filters"
    set "Is_Active" = false,
        "Status"    = 'superseded'
    where "Wig_ID" = new."Wig_ID"
      and "Filter_ID" <> new."Filter_ID"
      and "Is_Active" = true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wig_ai_filters_supersede_prev on public."Wig_AI_Filters";
create trigger trg_wig_ai_filters_supersede_prev
  before insert or update of "Is_Active" on public."Wig_AI_Filters"
  for each row
  execute function public.wig_ai_filters_supersede_previous_active();

-- ---------------------------------------------------------------------------
-- 6. Row-Level Security
--    - Specialists / Admins: full read & write (uses normalize_app_role helper
--      from 064_replace_organization_and_donation_drive_with_event_applications).
--    - Any authenticated user (mobile app): can SELECT only rows that are
--      currently active (Is_Active = true). This is what the RN app fetches.
-- ---------------------------------------------------------------------------
alter table public."Wig_AI_Filters" enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'Wig_AI_Filters'
      and policyname = 'wig_ai_filters_select_active_authenticated'
  ) then
    create policy wig_ai_filters_select_active_authenticated
      on public."Wig_AI_Filters"
      for select
      to authenticated
      using ("Is_Active" = true);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'Wig_AI_Filters'
      and policyname = 'wig_ai_filters_select_specialist_admin'
  ) then
    create policy wig_ai_filters_select_specialist_admin
      on public."Wig_AI_Filters"
      for select
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'Wig_AI_Filters'
      and policyname = 'wig_ai_filters_insert_specialist_admin'
  ) then
    create policy wig_ai_filters_insert_specialist_admin
      on public."Wig_AI_Filters"
      for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'Wig_AI_Filters'
      and policyname = 'wig_ai_filters_update_specialist_admin'
  ) then
    create policy wig_ai_filters_update_specialist_admin
      on public."Wig_AI_Filters"
      for update
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      )
      with check (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'Wig_AI_Filters'
      and policyname = 'wig_ai_filters_delete_specialist_admin'
  ) then
    create policy wig_ai_filters_delete_specialist_admin
      on public."Wig_AI_Filters"
      for delete
      to authenticated
      using (
        exists (
          select 1
          from public.users u
          where u.auth_user_id = auth.uid()
            and public.normalize_app_role(u.role) in ('specialist', 'admin')
        )
      );
  end if;
end
$$;
