-- 090_wig_ai_filter_layers.sql
-- Switches Wig AI Studio from a single GLB output to AI-generated 2D layered
-- PNGs that the editor and mobile app composite on top of the user's webcam.
--
-- Each layer is a PNG stored in the wig_ai_filters bucket. Glb_Asset_Path is
-- preserved (nullable) so any old 3D filters keep working for read; new runs
-- write the layer paths instead.
--
-- Layer semantics (must match LAYER_DEFS in WigAiStudioPage.jsx):
--   full_wig     -- the entire isolated wig with background removed
--   back_hair    -- back / nape portion (from back or side photo when given,
--                   else bottom portion of front)
--   front_bangs  -- top portion above the brow line
--   hair_mask    -- white-on-black silhouette of the hair area
--   face_mask    -- face oval used for occluding hair behind the face

alter table public."Wig_AI_Filters"
  add column if not exists "Layer_Full_Wig_Path"    text null,
  add column if not exists "Layer_Back_Hair_Path"   text null,
  add column if not exists "Layer_Front_Bangs_Path" text null,
  add column if not exists "Layer_Hair_Mask_Path"   text null,
  add column if not exists "Layer_Face_Mask_Path"   text null;

-- Glb_Asset_Path stays for backwards compatibility but is no longer required
-- (was already nullable in 088, so nothing to do).

comment on column public."Wig_AI_Filters"."Layer_Full_Wig_Path"    is 'PNG path in wig_ai_filters bucket: full wig with background removed.';
comment on column public."Wig_AI_Filters"."Layer_Back_Hair_Path"   is 'PNG path: back/nape hair layer.';
comment on column public."Wig_AI_Filters"."Layer_Front_Bangs_Path" is 'PNG path: front bangs above the brow line.';
comment on column public."Wig_AI_Filters"."Layer_Hair_Mask_Path"   is 'PNG path: white-on-black hair silhouette mask.';
comment on column public."Wig_AI_Filters"."Layer_Face_Mask_Path"   is 'PNG path: face oval used for occluding hair behind the face.';
