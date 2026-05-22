# Store user-uploaded source audio on local disk (24h retention, owner-gated)

> **Recontextualized 2026-05-22 by [ADR 0004](0004-pivot-to-musicai-stack.md).** Original motivation (Suno mp3 → `repaint`/`lego`) is dropped with the wedge pivot. The storage + retention design below carries over to its new use: **cover-song instrumental uploads** (Tier 1). Voice-sample uploads (Phase 1, multi-file, different retention) are scoped separately in [ADR 0005](0005-voice-clone-rvc-self-hosted.md).

The wedge plan's Sprint 1 deliverable lets a user upload an mp3 (typically a Suno output) and run `repaint`/`lego` on it. The uploaded *source* needs a home. We store it on the server's local disk under a new `audio-uploads/` directory — same model the existing `audio-cache/` + `audio-secure/` pipeline already uses (`server/audio.ts`) — rather than introducing Supabase Storage. Retention is 24 hours from upload; access is auth-gated to the owner.

## Considered Options

- **(a) Local disk, new `audio-uploads/` directory (chosen).** Matches the codebase's existing pattern (server is single-machine, ACE-Step container runs locally on the same box, and `processAudio`/`prepareSourceForAceStep` already speak the local-disk dialect). Zero new dependency, zero new IAM, ~5GB peak at K1=100 users × 50MB cap is trivially absorbed by the dev box. The `SAFE_FILENAME` regex + server-minted stems generalize cleanly to uploads.
- **(b) Supabase Storage.** Free tier 1GB — exactly at the projected ceiling (100 users × 50MB cap with 24h retention sits at ~500MB-1GB nominal, but burst traffic could blow past). Adds a new auth model (Storage RLS vs the server's Express session) and a new monitoring surface. Real value would be CDN delivery, but external uploads are *private* — the user uploaded their own Suno track, no one else needs access — so CDN isn't a benefit. Rejected for the wedge phase; revisit if traffic patterns shift toward many-user-sharing.
- **(c) S3 / R2 / external object storage.** Same drawbacks as (b) without the Supabase auth integration. Rejected.

## Privacy + retention

- External uploads are **not served via `/audio/...`** (the existing public watermarked path). A new `GET /api/uploads/:filename` endpoint streams the bytes with session-owner verification — only the user who uploaded it can play it back in the FE preview.
- Each upload row in `songs` (with `source='external'`) is owned by `user_id`. The owner check is `songs.user_id = session.user.id`.
- **Retention: 24 hours from upload.** A cron sweep deletes files in `audio-uploads/` whose `mtime` is older than 24h. The corresponding `songs` row stays but has its `audio_url` cleared to NULL (UI shows "원본 만료됨" tooltip on the source node, but any derived/repaint output stays intact).
- Derived songs (repaint/lego output from an upload) go through the normal `processAudio` pipeline → watermarked, public at `/audio/...`. The watermark is applied to *our* derivative, not the user's original.

## Consequences

- New migration `009_song_source.sql`: `songs.source text check (source in ('internal','external'))` (NULL = internal, legacy rows untouched).
- **The `parent_song_id` FK on `songs` (from migration 008) is currently `ON DELETE CASCADE`** — that's wrong for the upload-expiry case, since clearing an expired source row would cascade-delete its repaint children. Migration `010_song_derivation_setnull.sql` drops the constraint and re-adds it as `ON DELETE SET NULL` so a child outlives its parent. Captured here so future readers don't "fix" the SET NULL back to CASCADE.
- New endpoint `POST /api/upload` (multipart/form-data, 50MB cap, mp3/wav only, length ≤4min via `ffprobe`, auth required). New endpoint `GET /api/uploads/:filename` (owner-gated stream). Both filenames pass through the same `SAFE_FILENAME` regex used elsewhere.
- New cron: a 24h sweep job. Implementation can piggyback on the existing job worker's tick loop (run hourly, no separate scheduler needed).
- ACE-Step input path is unchanged: `prepareSourceForAceStep(audioUrl)` already resolves `/audio/...` URLs against local disk. We extend `resolveAudioUrlToLocalPath` (or add a sibling) to also resolve `audio-uploads/` paths.
