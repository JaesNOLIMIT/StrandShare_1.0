-- 095_drop_side_profile_and_glb.sql
-- Reverts the side-profile experiment and removes the unused 3D-era column.
--   * Layer_Side_Profile_Path: the side-view cross-fade was dropped in favour
--     of the 2D shift+squash try-on, so this layer is no longer produced.
--   * Glb_Asset_Path: the pipeline has been 2D-layer only since the TripoSR
--     mesh approach was abandoned; this column is dead.

alter table public."Wig_AI_Filters"
  drop column if exists "Layer_Side_Profile_Path",
  drop column if exists "Glb_Asset_Path";
