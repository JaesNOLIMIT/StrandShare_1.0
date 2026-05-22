-- 008_add_brand_name_tagline_to_ui_settings.sql
-- Adds brand identity fields so Brand Name and Tagline are globally persisted.

alter table if exists public."UI_Settings"
  add column if not exists "Brand_Name" varchar(120);

alter table if exists public."UI_Settings"
  add column if not exists "Brand_Tagline" varchar(255);

update public."UI_Settings"
set "Brand_Name" = 'Donivra'
where coalesce("Brand_Name", '') = '';

update public."UI_Settings"
set "Brand_Tagline" = 'Every Strand Counts'
where coalesce("Brand_Tagline", '') = '';

