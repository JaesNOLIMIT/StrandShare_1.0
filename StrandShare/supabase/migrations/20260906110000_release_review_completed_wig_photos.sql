begin;

-- Release review displays the finished wig, not only the AI catalog source.
-- Some deployed databases skipped the older non-timestamped inventory script,
-- so ensure the completed-wig photo columns exist in the current migration chain.
alter table public."Wigs"
  add column if not exists "Wig_Front_Image_Path" character varying(500),
  add column if not exists "Wig_Side_Image_Path" character varying(500),
  add column if not exists "Wig_Top_Image_Path" character varying(500);

notify pgrst, 'reload schema';
commit;
