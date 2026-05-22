-- 004_global_theme_settings.sql
-- Global UI settings and theme preset storage.

drop table if exists public.app_theme_settings cascade;

create table if not exists public."UI_Settings" (
  "Primary_Color" varchar(20),
  "Secondary_Color" varchar(20),
  "Tertiary_Color" varchar(20),
  "Background_Color" varchar(20),
  "Primary_Text_Color" varchar(20),
  "Secondary_Text_Color" varchar(20),
  "Tertiary_Text_Color" varchar(20),
  "Font_Family" varchar(100),
  "Secondary_Font_Family" varchar(100),
  "Brand_Name" varchar(120),
  "Brand_Tagline" varchar(255),
  "Logo_Icon" varchar(255),
  "Login_Background_Photo" varchar(255),
  "Updated_By" int references public.users(user_id),
  "Updated_At" timestamp without time zone default now()
);

alter table if exists public."UI_Settings"
  add column if not exists "Secondary_Font_Family" varchar(100);

alter table if exists public."UI_Settings"
  add column if not exists "Background_Color" varchar(20);

alter table if exists public."UI_Settings"
  add column if not exists "Brand_Name" varchar(120);

alter table if exists public."UI_Settings"
  add column if not exists "Brand_Tagline" varchar(255);

create unique index if not exists "UI_Settings_single_row_idx"
  on public."UI_Settings" ((true));

create table if not exists public."Theme_Presets" (
  "Preset_ID" serial primary key,
  "Preset_Name" varchar(100),
  "Primary_Color" varchar(20),
  "Secondary_Color" varchar(20),
  "Tertiary_Color" varchar(20),
  "Background_Color" varchar(20),
  "Primary_Text_Color" varchar(20),
  "Secondary_Text_Color" varchar(20),
  "Tertiary_Text_Color" varchar(20),
  "Font_Family" varchar(100),
  "Secondary_Font_Family" varchar(100),
  "Created_At" timestamp without time zone default now(),
  "Is_Default" boolean not null default false,
  "Is_Deleted" boolean not null default false
);

alter table if exists public."Theme_Presets"
  add column if not exists "Secondary_Font_Family" varchar(100);

alter table if exists public."Theme_Presets"
  add column if not exists "Background_Color" varchar(20);

create unique index if not exists "Theme_Presets_default_unique_idx"
  on public."Theme_Presets" ("Is_Default")
  where "Is_Default" = true;

alter table public."UI_Settings" enable row level security;
alter table public."Theme_Presets" enable row level security;

drop policy if exists "ui_settings_select_public" on public."UI_Settings";
create policy "ui_settings_select_public"
  on public."UI_Settings"
  for select
  to public
  using (true);

drop policy if exists "theme_presets_select_public" on public."Theme_Presets";
create policy "theme_presets_select_public"
  on public."Theme_Presets"
  for select
  to public
  using ("Is_Deleted" = false);

drop policy if exists "ui_settings_write_super_admin" on public."UI_Settings";
create policy "ui_settings_write_super_admin"
  on public."UI_Settings"
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and lower(replace(replace(u.role, '_', ''), ' ', '')) = 'superadmin'
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and lower(replace(replace(u.role, '_', ''), ' ', '')) = 'superadmin'
    )
  );

drop policy if exists "theme_presets_write_super_admin" on public."Theme_Presets";
create policy "theme_presets_write_super_admin"
  on public."Theme_Presets"
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and lower(replace(replace(u.role, '_', ''), ' ', '')) = 'superadmin'
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.auth_user_id = auth.uid()
        and lower(replace(replace(u.role, '_', ''), ' ', '')) = 'superadmin'
    )
  );

create or replace function public.prevent_default_theme_preset_changes()
returns trigger
language plpgsql
as $$
begin
  if old."Is_Default" = true then
    raise exception 'Default preset is non-editable and non-deletable.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_prevent_default_theme_preset_changes on public."Theme_Presets";
create trigger trg_prevent_default_theme_preset_changes
  before update or delete on public."Theme_Presets"
  for each row
  execute function public.prevent_default_theme_preset_changes();

insert into public."Theme_Presets" (
  "Preset_Name",
  "Primary_Color",
  "Secondary_Color",
  "Tertiary_Color",
  "Background_Color",
  "Primary_Text_Color",
  "Secondary_Text_Color",
  "Tertiary_Text_Color",
  "Font_Family",
  "Secondary_Font_Family",
  "Created_At",
  "Is_Default",
  "Is_Deleted"
)
values (
  'Default',
  '#0275d8',
  '#6B7280',
  '#10b981',
  '#f4f7fb',
  '#0f172a',
  '#64748b',
  '#94a3b8',
  'Poppins',
  'Poppins',
  now(),
  true,
  false
)
on conflict ("Is_Default") where "Is_Default" = true do nothing;

insert into public."Theme_Presets" (
  "Preset_Name",
  "Primary_Color",
  "Secondary_Color",
  "Tertiary_Color",
  "Background_Color",
  "Primary_Text_Color",
  "Secondary_Text_Color",
  "Tertiary_Text_Color",
  "Font_Family",
  "Secondary_Font_Family",
  "Created_At",
  "Is_Default",
  "Is_Deleted"
)
select
  'Ocean Breeze',
  '#0f4c81',
  '#1d7874',
  '#7ed6df',
  '#f2f7fb',
  '#0b132b',
  '#1c2541',
  '#3a506b',
  'Poppins',
  'Inter',
  now(),
  false,
  false
where not exists (
  select 1 from public."Theme_Presets" where "Preset_Name" = 'Ocean Breeze'
);

insert into public."Theme_Presets" (
  "Preset_Name",
  "Primary_Color",
  "Secondary_Color",
  "Tertiary_Color",
  "Background_Color",
  "Primary_Text_Color",
  "Secondary_Text_Color",
  "Tertiary_Text_Color",
  "Font_Family",
  "Secondary_Font_Family",
  "Created_At",
  "Is_Default",
  "Is_Deleted"
)
select
  'Sunset Coral',
  '#c44536',
  '#e58e26',
  '#f8c291',
  '#fdf4ee',
  '#2f1b12',
  '#5d4037',
  '#8d6e63',
  'Lato',
  'Open Sans',
  now(),
  false,
  false
where not exists (
  select 1 from public."Theme_Presets" where "Preset_Name" = 'Sunset Coral'
);

insert into public."Theme_Presets" (
  "Preset_Name",
  "Primary_Color",
  "Secondary_Color",
  "Tertiary_Color",
  "Background_Color",
  "Primary_Text_Color",
  "Secondary_Text_Color",
  "Tertiary_Text_Color",
  "Font_Family",
  "Secondary_Font_Family",
  "Created_At",
  "Is_Default",
  "Is_Deleted"
)
select
  'Forest Mint',
  '#2d6a4f',
  '#40916c',
  '#95d5b2',
  '#eef8f2',
  '#081c15',
  '#1b4332',
  '#2d6a4f',
  'Nunito',
  'Source Sans 3',
  now(),
  false,
  false
where not exists (
  select 1 from public."Theme_Presets" where "Preset_Name" = 'Forest Mint'
);

insert into public."Theme_Presets" (
  "Preset_Name",
  "Primary_Color",
  "Secondary_Color",
  "Tertiary_Color",
  "Background_Color",
  "Primary_Text_Color",
  "Secondary_Text_Color",
  "Tertiary_Text_Color",
  "Font_Family",
  "Secondary_Font_Family",
  "Created_At",
  "Is_Default",
  "Is_Deleted"
)
select
  'Slate Gold',
  '#334155',
  '#475569',
  '#f59e0b',
  '#f2f5f8',
  '#0f172a',
  '#334155',
  '#64748b',
  'Merriweather',
  'Work Sans',
  now(),
  false,
  false
where not exists (
  select 1 from public."Theme_Presets" where "Preset_Name" = 'Slate Gold'
);

insert into public."UI_Settings" (
  "Primary_Color",
  "Secondary_Color",
  "Tertiary_Color",
  "Background_Color",
  "Primary_Text_Color",
  "Secondary_Text_Color",
  "Tertiary_Text_Color",
  "Font_Family",
  "Secondary_Font_Family",
  "Brand_Name",
  "Brand_Tagline",
  "Logo_Icon",
  "Login_Background_Photo",
  "Updated_By",
  "Updated_At"
)
values (
  '#0275d8',
  '#6B7280',
  '#10b981',
  '#f4f7fb',
  '#0f172a',
  '#64748b',
  '#94a3b8',
  'Poppins',
  'Poppins',
  'Donivra',
  'Every Strand Counts',
  '',
  '',
  null,
  now()
)
on conflict ((true)) do nothing;

