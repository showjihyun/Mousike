-- Append-only log of each successful generate / repaint / lego per user.
-- Quota checks COUNT entries in a sliding window per tier.
-- The older `credits` table is left in place but no longer used.
create table if not exists usage_log (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  action      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists usage_log_user_recent_idx
  on usage_log (user_id, created_at desc);
