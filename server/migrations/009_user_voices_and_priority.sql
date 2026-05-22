-- Phase 1 of the musicai-stack pivot (ADR 0004, 0005). Three changes:
--
--   1. user_voices: per-user RVC voice models. One row per voice the user
--      trains. Lifecycle FSM:
--        uploading (samples in flight) → training (rvc_train job claimed)
--          → trained (terminal) | failed (terminal, with .error)
--      The .pth weight + .index retrieval files live on local disk under
--      voice-models/<userId>/<voiceId>/{weight.pth, model.index}; this
--      table holds their paths. Sample mp3/wav files live under
--      voice-samples/<userId>/<voiceId>/ during 'uploading'+'training' and
--      are deleted on transition to 'trained' — the .pth is the persistent
--      artifact, not the raw audio (ADR 0005 §Consequences).
--
--   2. jobs.kind: extend CHECK to allow 'rvc_train' and 'rvc_infer' so the
--      single GPU queue handles voice work alongside ACE-Step generation.
--      Mirrors the pattern in 008_song_derivation.sql where derivation_kind's
--      CHECK starts narrow and is widened when new job kinds ship.
--
--   3. jobs.priority: tier-snapshot at enqueue. claimNextJob orders by
--      priority DESC then created_at ASC so Pro users jump the next-slot
--      queue without preempting a running job. Snapshot-at-enqueue is
--      intentional — a mid-queue tier upgrade does not retroactively
--      reorder a user's already-queued jobs.
--
--      tier → priority mapping (server/jobs.ts:tierToPriority):
--        anonymous   = 0
--        free        = 1
--        starter     = 2
--        pro         = 3

create table if not exists user_voices (
  id              text primary key,
  user_id         uuid not null references users(id) on delete cascade,
  display_name    text not null,
  sample_paths    jsonb not null default '[]'::jsonb,
  sample_seconds  int,
  epochs          int  not null,
  weight_path     text,
  index_path      text,
  status          text not null
                    check (status in ('uploading', 'training', 'trained', 'failed')),
  error           text,
  created_at      timestamptz not null default now(),
  trained_at      timestamptz
);

-- Dominant query: "my voices, newest first" — list page + admission cap check.
create index if not exists user_voices_user_idx
  on user_voices (user_id, created_at desc);

-- Trained voices must have both artifacts and a trained_at; non-trained
-- voices must have neither. Mirrors songs_derivation_paired from 008.
alter table user_voices
  add constraint user_voices_artifacts_paired
    check (
      (status = 'trained'
        and weight_path is not null
        and index_path is not null
        and trained_at is not null)
      or
      (status <> 'trained'
        and weight_path is null
        and index_path is null
        and trained_at is null)
    );

-- Per-user voice cap (Free 1 / Starter 1 / Pro 3) is dynamic by tier, so
-- it's enforced at the API layer rather than as a CHECK constraint.

-- Widen jobs.kind for RVC. The inline check from 004_jobs.sql has the
-- auto-generated name jobs_kind_check on standard Postgres; drop IF EXISTS
-- keeps this idempotent even if the auto-name happens to differ.
alter table jobs
  drop constraint if exists jobs_kind_check;

alter table jobs
  add constraint jobs_kind_check
    check (kind in ('generate', 'repaint', 'lego', 'rvc_train', 'rvc_infer'));

-- Priority snapshot. Default 0 covers anonymous + legacy rows; no backfill
-- since by the time this migration runs, legacy jobs are all terminal
-- (done/failed) and their priority is irrelevant.
alter table jobs
  add column if not exists priority int not null default 0;

-- claimNextJob's new ordering. Partial on status='queued' (the only rows
-- the worker scans for claim) keeps the index small. The existing
-- jobs_active_idx still serves the sweep + per-user in-flight counts.
create index if not exists jobs_claim_idx
  on jobs (priority desc, created_at asc)
  where status = 'queued';
