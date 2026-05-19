-- One-time charges via Toss Payments. v1 is buy-30-days-of-Starter-or-Pro;
-- recurring (정기결제) is intentionally out of scope. When tier_expires_at
-- passes, auth.ts/deserializeUser flips the user back to 'free'.
--
-- Payment lifecycle:
--   pending  → paid     (Toss confirm succeeded; tier flipped)
--   pending  → failed   (user cancelled / card declined)
--   paid     → refunded (manual via Toss dashboard; rare)
-- A single payment row maps 1:1 to one Toss orderId. orderId is the PK so
-- the same /api/billing/confirm call is idempotent.

alter table users
  add column if not exists tier_expires_at timestamptz;

create table if not exists payments (
  id                   text primary key,                -- = toss_order_id
  user_id              uuid not null references users(id) on delete cascade,
  tier                 text not null check (tier in ('starter', 'pro')),
  amount_krw           int  not null check (amount_krw > 0),
  status               text not null default 'pending'
                         check (status in ('pending', 'paid', 'failed', 'refunded')),
  toss_payment_key     text,
  receipt_business_no  text,
  receipt_email        text,
  created_at           timestamptz not null default now(),
  paid_at              timestamptz
);

create index if not exists payments_user_created_idx
  on payments (user_id, created_at desc);

-- For the expiry sweep / quota checks that filter by current tier window.
create index if not exists users_tier_expiry_idx
  on users (tier_expires_at)
  where tier <> 'free';
