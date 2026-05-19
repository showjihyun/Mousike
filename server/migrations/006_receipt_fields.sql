-- Receipts (현금영수증) at checkout. Toss accepts these on the confirm call,
-- so we store the user's choice on the pending payment row and forward it
-- when /api/billing/confirm POSTs to Toss.
--
-- receipt_business_no was named for the 사업자 path, but the same column
-- also stores 휴대폰번호 for 소득공제. Rename to make that honest.

alter table payments
  rename column receipt_business_no to receipt_registration_no;

alter table payments
  add column if not exists receipt_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payments_receipt_type_check'
  ) then
    alter table payments
      add constraint payments_receipt_type_check
        check (receipt_type is null or receipt_type in ('소득공제', '지출증빙'));
  end if;
end $$;
