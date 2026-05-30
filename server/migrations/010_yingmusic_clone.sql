-- Phase 2 of the musicai-stack pivot (ADR 0006). YingMusic-SVC replaces
-- RVC as the default voice-cloning backend. YingMusic is zero-shot: the
-- user uploads a single reference clip and it is immediately usable —
-- no per-voice .pth/.index artifacts, no training step.
--
-- Changes in this migration:
--   1. Fail any in-flight RVC jobs (rvc_train / rvc_infer queued or
--      running). They reference voice rows about to be deleted; without
--      this the worker would crash trying to read them.
--   2. Wipe user_voices. RVC weights are not compatible with YingMusic,
--      so existing rows are dropped and users are prompted to re-upload
--      on next visit (see the UI work in commit 2/4 of this branch).
--   3. user_voices.epochs becomes nullable (YingMusic doesn't train).
--   4. status gains 'ready' — YingMusic terminal success state.
--        YingMusic lifecycle: uploading → ready (terminal) | failed
--        RVC lifecycle (legacy, fallback-only):
--                       uploading → training → trained (terminal) | failed
--   5. user_voices_artifacts_paired CHECK split: 'trained' (legacy RVC)
--      still requires weight_path + index_path + trained_at; 'ready'
--      (YingMusic) requires all three NULL — there is nothing to pair.
--   6. jobs.kind gains 'yingmusic_clone' — zero-shot inference of a
--      vocal stem onto the user's reference voice.
--
-- On-disk cleanup is NOT in this migration. After applying, sweep:
--     voice-models/  (legacy .pth/.index artifacts)
--     voice-samples/ (raw training clips)
-- The migration runner has no filesystem context and the on-disk roots
-- are env-configurable, so this stays a separate ops step.

update jobs
   set status = 'failed',
       error = 'YingMusic migration: legacy RVC voice wiped',
       finished_at = now()
 where status in ('queued', 'running')
   and kind in ('rvc_train', 'rvc_infer');

delete from user_voices;

alter table user_voices alter column epochs drop not null;

-- PG auto-names inline column CHECKs as <table>_<col>_check; the 009 inline
-- check from `status text not null check (status in (...))` lives under
-- that name. drop-if-exists keeps this idempotent in case the auto-name
-- ever differs on a particular install.
alter table user_voices drop constraint if exists user_voices_status_check;
alter table user_voices
  add constraint user_voices_status_check
    check (status in ('uploading', 'training', 'trained', 'ready', 'failed'));

alter table user_voices drop constraint user_voices_artifacts_paired;
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

alter table jobs drop constraint jobs_kind_check;
alter table jobs
  add constraint jobs_kind_check
    check (kind in ('generate', 'repaint', 'lego', 'rvc_train', 'rvc_infer', 'yingmusic_clone'));
