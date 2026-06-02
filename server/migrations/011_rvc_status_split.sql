-- Phase D Y-2 (ADR 0007 follow-up). YingMusic-SVC and RVC+KLM now coexist
-- per row: YingMusic readiness lives on `status` (terminal value 'ready');
-- RVC training lifecycle lives on a new `rvc_status` column with its own
-- enum + paired-artifacts invariant. Voice upload triggers background
-- rvc_train in addition to the immediate YingMusic-ready insert, so KO
-- songs (which route through TTS rather than ACE-Step's vocal model — see
-- ADR 0007) can apply the user's voice timbre via RVC once training
-- completes.
--
-- Changes:
--   1. Add rvc_status enum: idle (default, fresh upload) → training
--      (worker claimed rvc_train) → trained (terminal success) | failed
--      (terminal, with .error). The previous Phase 2 lifecycle on `status`
--      (uploading/training/trained/ready/failed) is no longer used for
--      RVC — `status` is now exclusively the YingMusic readiness flag.
--   2. Re-anchor user_voices_artifacts_paired: weight_path + index_path +
--      trained_at must all be set together IFF rvc_status='trained'. The
--      previous CHECK keyed on status='trained' would have rejected
--      'ready'+'trained' rows.

alter table user_voices
  add column if not exists rvc_status text
    check (rvc_status in ('idle', 'training', 'trained', 'failed'))
    default 'idle';

-- The check expression is "is null" not "= null", which is the only form
-- Postgres treats as a real comparison. The old CHECK had the same form,
-- so re-creating it under the new key column is mechanical.
alter table user_voices drop constraint user_voices_artifacts_paired;
alter table user_voices
  add constraint user_voices_artifacts_paired
    check (
      (rvc_status = 'trained'
        and weight_path is not null
        and index_path is not null
        and trained_at is not null)
      or
      (rvc_status <> 'trained'
        and weight_path is null
        and index_path is null
        and trained_at is null)
    );

-- Index supports the "do I have a trained RVC voice for this user?" lookup
-- that the KO TTS path runs once per generate call.
create index if not exists user_voices_rvc_trained_idx
  on user_voices (user_id, created_at desc)
  where rvc_status = 'trained';
