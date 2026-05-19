# Architecture

A snapshot of how Mousike works as of 2026-05-19. Treat this as the
"map for new contributors" — point at code paths, not commit history.

## 1. Overview

Mousike is a Korean-language AI music generator. A user types a one-line
prompt; the server feeds it through Ollama (Korean → English caption)
and ACE-Step (caption → audio), then returns a sample. Free users get
a 30s watermarked clip; paid users get 90s, clean, and a per-track
license PDF.

The product splits into two long-lived processes (Vite SPA, Express
server) plus three local dependencies (ACE-Step in Docker, Ollama,
Supabase Postgres).

## 2. Process / component map

```
                                ┌──────────────────────────────┐
                                │  Browser  (Vite at :5173)    │
                                │  React + localStorage         │
                                └──────────────┬───────────────┘
                                               │ /api/*, /audio/*
                                               ▼
┌─────────────┐    Korean         ┌──────────────────────────────┐
│  Ollama     │◀──prompts/caption─│  Express server (:8787)      │
│  :11434     │   gemma2:2b       │  - Passport + Google OAuth   │
└─────────────┘                   │  - Supabase admin client     │
                                  │  - ACE-Step orchestration    │
┌─────────────┐  /gradio_api/…    │  - Quota + watermark + cert  │
│ ACE-Step    │◀──────────────────┤                              │
│ Docker:7860 │   docker cp …mp3  │                              │
└─────────────┘                   └──────────────┬───────────────┘
                                                 │ supabase-js (service_role)
                                                 ▼
                                  ┌──────────────────────────────┐
                                  │  Supabase Postgres            │
                                  │  users, generations, songs,   │
                                  │  usage_log, _migrations       │
                                  └──────────────────────────────┘
```

Static assets the server depends on:

- `server/assets/watermark.mp3` — Korean voice clip generated once via
  `edge-tts --voice ko-KR-SunHiNeural --text "Mousike"`.
- `server/assets/NotoSansKR-Regular.otf` — used by pdfkit so the cert
  PDF can draw Hangul.

## 3. Code layout

```
src/                            React SPA (Vite)
├── App.tsx                     Top-level state: auth, library, usage,
│                               modals, write-through to server
├── auth.ts                     /auth/me + login redirect + logout
├── api.ts                      Typed fetch wrappers, credentials: include
├── storage.ts                  localStorage persistence (anonymous path)
├── data.ts                     Seed library + makeGeneration factory
├── types.ts                    Shared SPA types
├── pages/{Home,Library}Page.tsx
├── components/{Topbar, MiniPlayer, RepaintModal, LegoModal,
│              LoginModal, SongCard, ...}.tsx

server/                         Express + tsx
├── index.ts                    Bootstraps express; defines /api/generate,
│                               /api/repaint, /api/lego; route-level
│                               quota + rate-limit logic
├── acestep.ts                  Single runAceStep(req) entry — payload
│                               builder, submit, SSE poll
├── audio.ts                    audio-cache/audio-secure dirs,
│                               processAudio (docker cp + watermark),
│                               prepareSourceForAceStep (resolve + upload)
├── ollama.ts                   translateKoreanToEnglish
├── watermark.ts                ffmpeg overlay (voice tag at start + end)
├── auth.ts                     Passport-Google strategy + session +
│                               /auth/google, /auth/google/callback,
│                               /auth/me, /auth/logout
├── api.ts                      Auth-gated REST: /api/generations,
│                               /api/songs/:id, /api/credits (legacy),
│                               /api/usage, /api/download, /api/cert
├── quota.ts                    Per-tier usage windows + readUsage + logUsage
├── cert.ts                     pdfkit-based license PDF renderer
├── db.ts                       getSupabase() singleton
├── migrations/
│   ├── run.ts                  `npm run migrate`; uses _migrations ledger
│   ├── 001_initial.sql         users, credits, generations, songs
│   ├── 002_user_tier.sql       users.tier (free/starter/pro)
│   └── 003_usage_log.sql       usage_log table
├── assets/                     watermark.mp3, NotoSansKR-Regular.otf
├── audio-cache/                Watermarked mp3s, served at /audio (public)
└── audio-secure/               Clean mp3s; reached via /api/download
                                for paid users, used as repaint/lego source
```

## 4. Data flow

### 4.1 Generate (the hot path)

```
SPA          Server                       Ollama       ACE-Step (Docker)
 │            │                            │            │
 │POST /api/generate {prompt, lang}        │            │
 ├───────────▶│                            │            │
 │            │ rate-limit (10/h per IP)   │            │
 │            │ requireQuota (logged-in)   │            │
 │            │ if KO → translate          │            │
 │            ├───────────────────────────▶│            │
 │            │◀───────────── caption ─────┤            │
 │            │ ACE-Step submit + SSE poll              │
 │            ├────────────────────────────────────────▶│
 │            │◀────────────── container mp3 paths ────┤
 │            │ docker cp → audio-secure/X.mp3 (clean)  │
 │            │ ffmpeg overlay → audio-cache/X-wm.mp3   │
 │            │ logUsage(user, "generate")              │
 │◀ {songs:[{audioUrl}]}                                │
 │            │                                          │
 │ optimistic state update + withRetry(postGeneration)   │
```

`/api/repaint` and `/api/lego` mirror this, with extra ACE-Step inputs
and `requireAuth` on the endpoint. Both also use `audio-secure` as the
source file (never the watermarked one) so derivatives don't get a
double watermark baked in.

### 4.2 Login

`/auth/google` → Google → `/auth/google/callback` → `upsertUserFromGoogle`
in `server/auth.ts` (upsert by `google_id`, returns tier) → session cookie
set → redirect to `CLIENT_ORIGIN`. Subsequent SPA loads call `/auth/me`,
which uses `deserializeUser` to refetch the user row (so tier changes are
picked up without re-logging-in).

### 4.3 Library / quota

```
SPA boot
  └─ fetch /auth/me
       ├─ 401   → keep localStorage library, synthesize "오늘 N/3" Usage
       └─ user  → fetch /api/generations + /api/usage in parallel
                  └─ if server library is empty and localStorage has
                     data → POST each Generation, then show toast
                  └─ setServerUsage drives Topbar chip
```

`consumeOneUse()` is the single seam that advances either `serverUsage`
(optimistic +1 used) or `credits` (anonymous, decrement). Each successful
generate/repaint/lego from a logged-in user POSTs the new Generation
back to server via `withRetry`. A final failure shows a toast naming the
track so the user knows what's at risk.

### 4.4 Certificate

`SongCard certificate action → downloadCertBlob(songId) → GET /api/cert/:songId`
(server looks up the song scoped to the requesting user → 404 if not theirs)
`→ pdfkit pipe → blob → anchor.click()`. The cert reads the song's
`audio_url` to detect a `-wm.mp3` suffix and adds a watermark notice when
the track is free-tier.

## 5. Database schema

All tables live in `public`. The server uses the `service_role` key so it
bypasses RLS; no RLS policies are defined.

```
users
  id            uuid PK  default gen_random_uuid()
  google_id     text  unique
  email         text
  name          text?
  picture       text?
  tier          text  default 'free'   check in ('free','starter','pro')
  created_at    timestamptz

generations
  id            text PK          -- client-generated string, e.g. '1779…-abc'
  user_id       uuid → users.id  on delete cascade
  prompt        text
  parent_gen_id text → generations.id  on delete set null
  parent_song_id text?
  variation_type text?           -- 'similar' | 'restyle' | 'repaint' | 'lego' | null
  palette       jsonb            -- [string, string]
  created_at    timestamptz

songs
  id            text PK
  gen_id        text → generations.id  on delete cascade
  user_id       uuid → users.id        on delete cascade
  title, style, vibe, prompt   text
  bpm, duration_sec            int
  music_key                    text
  liked                        boolean
  waveform, instruments, palette  jsonb
  audio_url                    text?
  created_at                   timestamptz

usage_log
  id            bigserial PK
  user_id       uuid → users.id  on delete cascade
  action        text             -- 'generate' | 'repaint' | 'lego'
  created_at    timestamptz

credits        -- LEGACY, no longer written or read
  user_id       uuid PK → users.id
  balance       int
  updated_at    timestamptz

_migrations
  filename      text PK
  applied_at    timestamptz
```

Indexes (the ones that earn their keep): `generations(user_id, created_at desc)`,
`songs(gen_id)`, `songs(user_id, liked)`, `usage_log(user_id, created_at desc)`.

## 6. Storage layout

```
server/
├── assets/                       committed (~5MB)
│   ├── watermark.mp3             voice tag, 1.8s
│   └── NotoSansKR-Regular.otf    Hangul font for pdfkit
├── audio-cache/                  gitignored
│   └── <stem>-wm.mp3             watermarked, served via /audio
└── audio-secure/                 gitignored
    └── <stem>.mp3                clean, served via /api/download (paid)
                                  also used as repaint/lego source for ALL tiers
```

`stem = Date.now() + Math.random()` — collision-free filenames, no DB FK
to the file (DB just holds the audio_url string).

## 7. Auth model

- Passport `passport-google-oauth20`. Not Supabase Auth; we just use
  Supabase as a Postgres + storage host.
- `express-session` with the memory store. Fine for dev; production
  needs a real store (Redis, pg).
- Cookie config: `httpOnly: true`, `sameSite: 'lax'`,
  `secure: NODE_ENV === 'production'`. `trust proxy` flipped on in prod
  for TLS-terminating load balancers.
- `requireAuth` middleware in `server/auth.ts` is the only gate
  recognized by the codebase. Tier checks happen inside handlers via
  `quota.readUsage`.
- The Supabase **service_role** key lives in `server/.env` and **never**
  reaches the browser. The SPA talks to Express; Express talks to
  Supabase. There's no client-side Supabase SDK.

## 8. Tier policy

| Tier     | Track length | Watermark | Quota (rolling)  | Cert PDF | Notes               |
|----------|--------------|-----------|------------------|----------|---------------------|
| anonymous| 30s          | yes       | 10 req/h per IP  | no       | client-only counter |
| free     | 30s          | yes       | 3 / 24h          | yes      | server-enforced     |
| starter  | 90s          | no        | 30 / 30d         | yes      |                     |
| pro      | 3min         | no        | unlimited        | yes      | full track          |

Tier is set by `update users set tier = 'starter'` for now — no Toss
integration yet. Tier widths and durations are defined in code, not DB
config:
- `FREE_DURATION_SEC` / `STARTER_DURATION_SEC` / `PRO_DURATION_SEC`
  in `server/index.ts`
- `TIER_RULES` in `server/quota.ts`

## 9. Known issues / future improvements

**Open items, ordered by how much rope they're giving us:**

1. **No Toss integration** — paid tier upgrades are manual SQL. The
   moment we acquire a real first user, this hurts.
2. **`credits` table is legacy** (replaced by `usage_log`). A
   `004_drop_credits.sql` migration is overdue.
3. **Memory session store** logs a warning at boot in production-like
   environments. Swap to `connect-pg-simple` against the existing
   Supabase database before deploying.
4. **No automated tests.** Manual playwright smoke tests cover the
   golden paths but the cert + watermark mix paths have only been
   eyeballed.
5. **`validateGeneration` has no array-size bounds** — a logged-in user
   could POST an enormous generation. Low risk (only their own row),
   worth a per-field cap when convenient.
6. **PDF cert text avoids "fi" pairs** because Noto Sans KR's GSUB
   ligature glyph extracts as a single character through pdfkit.
   Revisit if we ever change fonts.
7. **Anonymous quota** is a per-IP rate limit only; no per-user-day cap
   exists for them. If we ever want a strict "3/day" for non-logged-in
   users, we'd need IP-based usage_log or require login for free.

## 10. Glossary

- **Generation** — a single prompt → audio invocation. Has one or more
  songs (currently always one).
- **Variation** — a Generation whose `parent_gen_id` is set. Subtypes:
  `similar`, `restyle`, `repaint` (region edit), `lego` (instrument
  swap).
- **Watermark** — the voice tag at the start and end of free-tier audio.
- **Cert** — the per-track license PDF.
- **Tier** — `users.tier`, drives song length, watermark, and quota.
