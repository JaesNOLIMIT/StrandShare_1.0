-- Backfill legacy hospital rows so Is_Approved aligns with Approval_Status.
-- This keeps landing metrics (approved hospitals) accurate when counting Is_Approved = true.

update public."Hospitals"
set "Is_Approved" = (
  lower(coalesce("Approval_Status", 'pending'::character varying)) = 'approved'
)
where coalesce("Is_Approved", false) is distinct from (
  lower(coalesce("Approval_Status", 'pending'::character varying)) = 'approved'
);

