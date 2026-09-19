begin;

alter table public."Wig_Requests"
  add column if not exists "Is_Urgent" boolean not null default false,
  add column if not exists "Urgent_Set_At" timestamp without time zone,
  add column if not exists "Urgent_Set_By" integer references public.users(user_id) on delete set null;

create index if not exists idx_wig_requests_urgent_queue
  on public."Wig_Requests" ("Is_Urgent" desc, "Request_Date" asc)
  where "Is_Urgent" is true;

create or replace function public.guard_wig_request_urgency_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_role_key text;
  v_urgency_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    v_urgency_changed := coalesce(new."Is_Urgent", false);
  elsif tg_op = 'UPDATE' then
    v_urgency_changed := (
      new."Is_Urgent" is distinct from old."Is_Urgent"
      or new."Urgent_Set_At" is distinct from old."Urgent_Set_At"
      or new."Urgent_Set_By" is distinct from old."Urgent_Set_By"
    );
  end if;

  if not v_urgency_changed or auth.uid() is null then
    return new;
  end if;

  select public.normalize_app_role(actor.role)
  into v_role_key
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if coalesce(v_role_key, '') <> 'staff' then
    raise exception 'Only Staff can change wig request urgency';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_guard_wig_request_urgency_insert on public."Wig_Requests";
create trigger trg_guard_wig_request_urgency_insert
before insert on public."Wig_Requests"
for each row execute function public.guard_wig_request_urgency_write();

drop trigger if exists trg_guard_wig_request_urgency_update on public."Wig_Requests";
create trigger trg_guard_wig_request_urgency_update
before update of "Is_Urgent", "Urgent_Set_At", "Urgent_Set_By" on public."Wig_Requests"
for each row execute function public.guard_wig_request_urgency_write();

create or replace function public.clear_terminal_wig_request_urgency()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_status_key text := lower(replace(replace(replace(coalesce(new."Status", ''), '_', ''), ' ', ''), '-', ''));
begin
  if v_status_key in (
    'released', 'completed', 'complete', 'releasecompleted', 'done',
    'returnedcompleted', 'returnedclosed', 'rejected', 'declined', 'denied',
    'cancelled', 'canceled', 'cancel'
  ) then
    new."Is_Urgent" := false;
    new."Urgent_Set_At" := null;
    new."Urgent_Set_By" := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_clear_terminal_wig_request_urgency on public."Wig_Requests";
create trigger trg_clear_terminal_wig_request_urgency
before insert or update of "Status" on public."Wig_Requests"
for each row execute function public.clear_terminal_wig_request_urgency();

create or replace function public.set_wig_request_urgent(
  p_req_id integer,
  p_is_urgent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor public.users%rowtype;
  v_request public."Wig_Requests"%rowtype;
  v_status_key text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_actor
  from public.users actor
  where actor.auth_user_id = auth.uid()
    and actor.is_active is distinct from false
  limit 1;

  if v_actor.user_id is null or public.normalize_app_role(v_actor.role) <> 'staff' then
    raise exception 'Only Staff can change wig request urgency';
  end if;

  select * into v_request
  from public."Wig_Requests"
  where "Req_ID" = p_req_id
  for update;

  if v_request."Req_ID" is null then
    raise exception 'Wig request was not found';
  end if;

  v_status_key := lower(replace(replace(replace(coalesce(v_request."Status", ''), '_', ''), ' ', ''), '-', ''));
  if coalesce(p_is_urgent, false) and v_status_key in (
    'released', 'completed', 'complete', 'releasecompleted', 'done',
    'returnedcompleted', 'returnedclosed', 'rejected', 'declined', 'denied',
    'cancelled', 'canceled', 'cancel'
  ) then
    raise exception 'Completed, released, rejected, or cancelled requests cannot be marked urgent';
  end if;

  update public."Wig_Requests"
  set "Is_Urgent" = coalesce(p_is_urgent, false),
      "Urgent_Set_At" = case when coalesce(p_is_urgent, false) then timezone('Asia/Manila', now()) else null end,
      "Urgent_Set_By" = case when coalesce(p_is_urgent, false) then v_actor.user_id else null end
  where "Req_ID" = p_req_id
  returning * into v_request;

  return jsonb_build_object(
    'req_id', v_request."Req_ID",
    'is_urgent', v_request."Is_Urgent",
    'urgent_set_at', v_request."Urgent_Set_At",
    'urgent_set_by', v_request."Urgent_Set_By"
  );
end;
$fn$;

revoke all on function public.set_wig_request_urgent(integer, boolean) from public, anon;
grant execute on function public.set_wig_request_urgent(integer, boolean) to authenticated;

comment on column public."Wig_Requests"."Is_Urgent" is
  'Staff-controlled display priority override. It does not change approval or allocation rules.';

notify pgrst, 'reload schema';
commit;
