-- Async job queue for ACE-Step generation. The Express server enqueues a row
-- per /api/generate|repaint|lego request and returns immediately; an in-process
-- worker loop with concurrency=1 (matches the single-GPU constraint) drains
-- queued rows. Polling via GET /api/jobs/:id.
--
-- Status transitions:
--   queued  → running    (worker claim)
--   running → done|failed (worker finishes)
-- On server restart, recoverStaleRunning() flips any leftover 'running' rows
-- to 'failed' so a crash mid-generation doesn't leave a permanently stuck job.
-- user_id is nullable so anonymous /api/generate (no login) still queues
-- through the same worker; the jobId returned to anon callers acts as the
-- ownership token (24 random hex chars from crypto.randomBytes).
create table if not exists jobs (
  id           text primary key,
  user_id      uuid references users(id) on delete cascade,
  kind         text not null check (kind in ('generate', 'repaint', 'lego')),
  status       text not null default 'queued'
                 check (status in ('queued', 'running', 'done', 'failed')),
  payload      jsonb not null,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- Partial index: worker loop scans only active rows, queue-position counts
-- only queued rows. Drops once a job finishes.
create index if not exists jobs_active_idx
  on jobs (created_at)
  where status in ('queued', 'running');

-- Per-user in-flight cap counts queued+running for one user.
create index if not exists jobs_user_active_idx
  on jobs (user_id)
  where status in ('queued', 'running');
