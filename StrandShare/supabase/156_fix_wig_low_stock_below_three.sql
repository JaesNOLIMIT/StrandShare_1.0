begin;

-- Low stock is a catalog-wide rule: 1-2 units are low and 0 is out of stock.
update public."Wigs"
set "Low_Stock_Threshold" = 2
where "Low_Stock_Threshold" is distinct from 2;

alter table public."Wigs"
  alter column "Low_Stock_Threshold" set default 2;

alter table public."Wigs"
  drop constraint if exists wigs_low_stock_threshold_non_negative;

alter table public."Wigs"
  drop constraint if exists wigs_low_stock_threshold_fixed;

alter table public."Wigs"
  add constraint wigs_low_stock_threshold_fixed
  check ("Low_Stock_Threshold" = 2);

comment on column public."Wigs"."Low_Stock_Threshold"
  is 'Fixed catalog threshold. Stock below 3 is low; zero is out of stock.';

commit;
