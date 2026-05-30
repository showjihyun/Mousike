# Voice demo backing track

Phase 1 of the musicai-stack pivot (ADR 0004, 0005). The "내 목소리
들어보기" demo on the voice-clone page plays back a single canned backing
track at:

    server/voice-demo-backing/default.mp3

When a user clicks **들어보기** on a trained voice, the worker enqueues an
`rvc_infer` job with this file as the source vocal track and the user's
trained voice as the conversion target. The output is the same backing
track re-sung in the user's voice.

## Why one fixed track

ADR 0005 §Considered Options chose this as the Phase 1 demo UX because it
keeps stem separation (Demucs) out of scope until Phase 2. The backing
track already has a clean vocal — RVC converts that vocal to the user's
voice in one shot, no separation needed.

## Provisioning

This file is **not committed to the repo** (binary, large, and the
specific choice is a content decision rather than a code one). Drop one
in before shipping Phase 1.

### Option A — Generate via Mousike itself (recommended)

Run a `generate` job and save the output here:

- Prompt: `K-pop ballad, female vocal, mid-tempo, short verse + chorus`
- Duration: 30s
- Vocal language: KO
- Lyrics (advanced):
  ```
  [Verse]
  오늘 밤 별이 빛나
  [Chorus]
  너와 함께라면
  ```

Copy the resulting `server/audio-secure/*.mp3` to
`server/voice-demo-backing/default.mp3`.

### Option B — Use a royalty-free Korean karaoke clip

Pick a ≤45s clip with a clear vocal track. Save as `default.mp3` here.

## Constraints on default.mp3

| Field | Value |
|---|---|
| Format | mp3 |
| Duration | ≤60s (keeps demo turnaround under ~1 minute) |
| Vocal track | Required — RVC converts the *vocal*, not the instrumental |
| Sample rate | 44.1 kHz preferred |

If the file is missing, the `rvc_infer` job (Commit C) will fail with
`backing track not found` and surface that to the user.
