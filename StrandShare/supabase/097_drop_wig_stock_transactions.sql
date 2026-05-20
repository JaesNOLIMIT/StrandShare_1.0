-- 097_drop_wig_stock_transactions.sql
-- Wig stock is now managed directly on Wigs.Stock_Count.
-- This removes the temporary stock transaction table and RPC helper.

drop function if exists public.add_wig_stock(integer, integer, text, integer);

drop table if exists public."Wig_Stock_Transactions";

