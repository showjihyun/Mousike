# Runbook

How to get the project running on a fresh machine, and how to do the
recurring operations (migrations, tier flips, watermark voice swap).

## 1. One-time setup

### 1.1 Local dependencies

- Node.js 22+ (the project tracks `@types/node ^22`)
- Docker Desktop (for the ACE-Step container)
- ffmpeg + ffprobe on PATH (Windows: `winget install Gyan.FFmpeg`)
- Python 3.10+ with `pip install edge-tts` if you want to regenerate
  the watermark voice clip

### 1.2 External services

- **Supabase project** (free tier is fine). From Settings → API copy:
  - `Project URL` → `SUPABASE_URL`
  - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (the secret one,
    NOT the publishable key)
  - From Settings → Database, the connection string → `DATABASE_URL`
- **Google Cloud OAuth 2.0 client** at
  console.cloud.google.com/apis/credentials → "Create Credentials" →
  OAuth 2.0 Client ID → Web application:
  - Authorized JavaScript origin: `http://localhost:5173`
  - Authorized redirect URI: `http://localhost:8787/auth/google/callback`
  - Copy Client ID + Client Secret

### 1.3 .env

```powershell
Copy-Item server/.env.example server/.env
```

Then fill `server/.env`:

```
GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
SESSION_SECRET=<generate locally: see below>
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>
DATABASE_URL=postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres
```

Generate a session secret:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

### 1.4 Install + migrate

```powershell
npm install
npm --prefix server install
npm --prefix server run migrate
```

The migration runner creates `_migrations` automatically and skips
already-applied files on re-runs.

### 1.5 ACE-Step + Ollama

These are out-of-process and out-of-scope for this repo, but the server
expects them at:

- `http://localhost:7860` — ACE-Step Gradio (Docker container named
  `ace-step` — `docker cp` is hard-coded in `server/index.ts`'s
  `processAudio`)
- `http://localhost:11434` — Ollama with `gemma2:2b` pulled

If either is offline, `/api/generate` will return 500 with the
upstream error in the body.

## 2. Day-to-day

### 2.1 Run dev

In two terminals (or one with a process manager you prefer):

```powershell
npm --prefix server start    # :8787
npm run dev                  # :5173 (Vite)
```

A clean boot logs `Mousike server on :8787` with **no**
`[auth] disabled` warning. The warning means `server/.env` is missing
or mis-filled and `/auth/*` will 404.

### 2.2 Type-check + build

```powershell
npx tsc -b                   # frontend project references
npm --prefix server exec tsc -- --noEmit
npm run build                # vite production build
```

### 2.3 Add a migration

1. Drop a file in `server/migrations/` using the next number:
   `004_<short_slug>.sql`.
2. Make it idempotent — `CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, etc. The ledger prevents re-runs in
   normal cases, but idempotent SQL is the seatbelt.
3. Run `npm --prefix server run migrate`.

## 3. Recurring operations

### 3.1 Flip a user's tier

Until Toss integration ships, this is the only way to upgrade a user.

```sql
update users set tier = 'pro' where email = 'someone@example.com';
```

The user must refresh their tab to pick up the new tier (the SPA
fetches `/auth/me` once on mount). No re-login required — the session
cookie is unchanged.

### 3.2 Inspect a user's usage

```sql
select action, count(*) as n
from usage_log
where user_id = (select id from users where email = '…')
  and created_at > now() - interval '24 hours'
group by action;
```

### 3.3 Regenerate the watermark voice

```powershell
edge-tts --voice ko-KR-SunHiNeural --text "Mousike" `
  --write-media server/assets/watermark.mp3
```

Re-commit the resulting mp3. New generations will use it immediately
(the file is read on every `mixWatermark` call); old `audio-cache/`
files keep the previous mix.

### 3.4 Reset a stuck local server

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

(Same pattern for 5173.)

## 4. Deploying (not done yet, plan)

The architecture targets these:
- Frontend: Vercel (static Vite build)
- Server: a node-friendly host with persistent disk for
  `audio-cache/` + `audio-secure/`. Fly.io, Render, Railway all fit.
- DB: Supabase (already hosted)

Before flipping `NODE_ENV=production`:
1. Replace the in-memory `express-session` store with something
   persistent (`connect-pg-simple` against the same Supabase DB).
2. Move `audio-cache/` and `audio-secure/` to object storage (R2/S3)
   if you ever scale beyond one server instance.
3. Set `CLIENT_ORIGIN` and `GOOGLE_CALLBACK_URL` env vars to the
   public URLs (already supported by `server/auth.ts`).

## 5. Things that will surprise you

- The first generate of the day pulls Ollama's model into memory and
  takes ~30s longer than later ones.
- `docker cp ace-step:<path> <host>` is the only point where the
  server touches Docker. If the container is named anything other
  than `ace-step`, edit `server/index.ts`'s `processAudio`.
- Tracks created before the watermark feature shipped don't have a
  matching file in `audio-secure/`. `resolveAudioUrlToLocalPath` falls
  back to `audio-cache/`, and `/api/download` does the same — but
  those tracks won't get a watermark removed because there's no clean
  source to swap to.
