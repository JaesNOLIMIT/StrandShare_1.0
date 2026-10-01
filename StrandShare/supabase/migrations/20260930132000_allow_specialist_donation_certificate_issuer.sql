-- Allow the current Specialist role to issue certificates after hair approval.

begin;

create or replace function public.guard_donation_certificate_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_submission public."Hair_Submissions"%rowtype;
begin
  if new."Submission_ID" is null then
    if tg_op = 'INSERT' then
      raise exception 'A donation certificate requires an accepted Hair_Submissions record.';
    end if;
    return new;
  end if;

  select * into v_submission
  from public."Hair_Submissions" submission
  where submission."Submission_ID" = new."Submission_ID";

  if not found or v_submission."User_ID" is null then
    raise exception 'The certificate submission does not exist or has no donor.';
  end if;

  if not exists (
    select 1
    from public."Hair_Submission_Details" detail
    where detail."Submission_ID" = new."Submission_ID"
      and public.normalize_flow_key(coalesce(detail."Status", '')) = 'approved'
  ) then
    raise exception 'A donation certificate can only be issued after an authorized reviewer approves the donated hair.';
  end if;

  if new."Issued_By" is not null and not exists (
    select 1
    from public.users app_user
    where app_user.user_id = new."Issued_By"
      and public.normalize_app_role(app_user.role) in (
        'admin', 'staff', 'specialist', 'organization', 'superadmin'
      )
  ) then
    raise exception 'Issued_By must identify an authorized reviewer.';
  end if;

  new."User_ID" := v_submission."User_ID";
  new."Issued_At" := coalesce(
    new."Issued_At",
    timezone('Asia/Manila', now())
  );
  new."Certificate_Number" := coalesce(
    nullif(btrim(new."Certificate_Number"), ''),
    public.generate_donation_certificate_number(
      new."Submission_ID",
      new."Issued_At"
    )
  );
  new."Certificate_Type" := coalesce(
    nullif(btrim(new."Certificate_Type"), ''),
    'Hair Donation Certificate'
  );

  return new;
end;
$fn$;

-- This is an internal trigger function, not a client-callable RPC.
revoke all on function public.guard_donation_certificate_record()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
