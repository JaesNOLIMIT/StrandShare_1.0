-- Add immutable-looking business request code (WR + 6 alphanumeric) for Wig_Requests.
begin;

alter table public."Wig_Requests"
  add column if not exists "Request_Code" character varying(8);

create or replace function public.generate_wig_request_code_wr6()
returns character varying
language plpgsql
as $fn$
declare
  v_chars constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  v_candidate text;
  v_suffix text;
  v_i integer;
  v_try integer := 0;
begin
  loop
    v_try := v_try + 1;
    v_suffix := '';

    for v_i in 1..6 loop
      v_suffix := v_suffix || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
    end loop;

    if v_suffix ~ '[A-Z]' and v_suffix ~ '[0-9]' then
      v_candidate := 'WR' || v_suffix;
      if not exists (
        select 1
        from public."Wig_Requests" wr
        where wr."Request_Code" = v_candidate
      ) then
        return v_candidate;
      end if;
    end if;

    if v_try > 200 then
      raise exception 'Unable to generate unique Wig Request code after % attempts', v_try;
    end if;
  end loop;
end;
$fn$;

create or replace function public.set_wig_request_code_wr6()
returns trigger
language plpgsql
as $fn$
begin
  if coalesce(btrim(new."Request_Code"), '') = '' then
    new."Request_Code" := public.generate_wig_request_code_wr6();
  else
    new."Request_Code" := upper(regexp_replace(new."Request_Code", '[^A-Za-z0-9]+', '', 'g'));
    if new."Request_Code" !~ '^WR[A-Z0-9]{6}$' then
      raise exception 'Request_Code must match WR + 6 alphanumeric characters';
    end if;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_set_wig_request_code_wr6 on public."Wig_Requests";
create trigger trg_set_wig_request_code_wr6
before insert on public."Wig_Requests"
for each row
execute function public.set_wig_request_code_wr6();

update public."Wig_Requests" wr
set "Request_Code" = public.generate_wig_request_code_wr6()
where coalesce(btrim(wr."Request_Code"), '') = ''
   or upper(regexp_replace(wr."Request_Code", '[^A-Za-z0-9]+', '', 'g')) !~ '^WR[A-Z0-9]{6}$';

alter table public."Wig_Requests"
  alter column "Request_Code" set not null;

create unique index if not exists "idx_Wig_Requests_Request_Code_unique"
  on public."Wig_Requests" using btree ("Request_Code");

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wig_requests_request_code_format_check'
      and conrelid = 'public."Wig_Requests"'::regclass
  ) then
    alter table public."Wig_Requests"
      add constraint wig_requests_request_code_format_check
      check ("Request_Code" ~ '^WR[A-Z0-9]{6}$');
  end if;
end
$$;

commit;
