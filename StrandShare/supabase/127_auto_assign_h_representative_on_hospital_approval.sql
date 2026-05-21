-- 127_auto_assign_h_representative_on_hospital_approval.sql
-- Auto-link approved hospital applicants to Hospital_Representative and activate role scope.

begin;

create or replace function public.sync_hospital_representative_on_hospital_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status_key text;
  v_user_role_key text;
  v_now timestamp without time zone;
begin
  v_status_key := lower(replace(replace(replace(coalesce(new."Approval_Status", ''), '_', ''), ' ', ''), '-', ''));

  if new."Is_Approved" is true or v_status_key = 'approved' then
    if new."Created_By" is not null and new."Hospital_ID" is not null then
      v_now := timezone('Asia/Manila', now());

      insert into public."Hospital_Representative" ("Hospital_ID", "User_ID", "Assigned_Date")
      values (new."Hospital_ID", new."Created_By", v_now)
      on conflict ("User_ID")
      do update
        set "Hospital_ID" = excluded."Hospital_ID",
            "Assigned_Date" = excluded."Assigned_Date";

      select lower(replace(replace(replace(coalesce(u.role, ''), '_', ''), ' ', ''), '-', ''))
        into v_user_role_key
      from public.users u
      where u.user_id = new."Created_By";

      if v_user_role_key is null
         or v_user_role_key in ('user', 'partner', 'hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative') then
        update public.users
           set role = 'h_representative',
               is_active = true,
               updated_at = v_now
         where user_id = new."Created_By";
      else
        update public.users
           set is_active = true,
               updated_at = v_now
         where user_id = new."Created_By";
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_hospital_representative_on_hospital_approval on public."Hospitals";
create trigger trg_sync_hospital_representative_on_hospital_approval
after insert or update of "Approval_Status", "Is_Approved", "Created_By"
on public."Hospitals"
for each row
execute function public.sync_hospital_representative_on_hospital_approval();

-- Backfill existing approved rows.
insert into public."Hospital_Representative" ("Hospital_ID", "User_ID", "Assigned_Date")
select
  h."Hospital_ID",
  h."Created_By",
  timezone('Asia/Manila', now())
from public."Hospitals" h
where h."Created_By" is not null
  and (
    coalesce(h."Is_Approved", false) = true
    or lower(replace(replace(replace(coalesce(h."Approval_Status", ''), '_', ''), ' ', ''), '-', '')) = 'approved'
  )
on conflict ("User_ID")
do update
  set "Hospital_ID" = excluded."Hospital_ID",
      "Assigned_Date" = excluded."Assigned_Date";

update public.users u
set
  role = case
    when lower(replace(replace(replace(coalesce(u.role, ''), '_', ''), ' ', ''), '-', '')) in ('', 'user', 'partner', 'hospital', 'hstaff', 'hrepresentative', 'hospitalrepresentative')
      then 'h_representative'
    else u.role
  end,
  is_active = true,
  updated_at = timezone('Asia/Manila', now())
where exists (
  select 1
  from public."Hospitals" h
  where h."Created_By" = u.user_id
    and (
      coalesce(h."Is_Approved", false) = true
      or lower(replace(replace(replace(coalesce(h."Approval_Status", ''), '_', ''), ' ', ''), '-', '')) = 'approved'
    )
);

commit;
