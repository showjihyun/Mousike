-- Add tier to users so server-side handlers can pick song duration etc.
-- by user plan. Toss payments will flip this column later; for now it's set
-- manually via SQL.
alter table users
  add column if not exists tier text not null default 'free';

-- CHECK constraint lives separately so re-runs are idempotent without IF NOT
-- EXISTS support on constraint creation in older Postgres.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_tier_check'
  ) then
    alter table users
      add constraint users_tier_check check (tier in ('free', 'starter', 'pro'));
  end if;
end $$;
