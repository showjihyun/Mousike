# Async Job Queue

How concurrent generation requests are handled on a single-GPU box.
Landed 2026-05-20.

## 1. Why

ACE-Step runs at `BATCH_SIZE=1` on a 12GB GPU. Pre-change, every
`/api/generate|repaint|lego` held its TCP connection open for up to
10 minutes (`acestep.ts:SSE_TIMEOUT_MS`) while the GPU ran. Five
concurrent users were enough to block honest traffic on proxy
timeouts and exhaust the Node event loop's HTTP slots.

The new design returns 202 immediately with a `jobId` and processes
work in an in-process worker loop sized to the GPU (concurrency=1).
Clients poll `GET /api/jobs/:id` every 2s for status.

## 2. Components

```
POST /api/generate ──▶ admitJob() ──▶ enqueue() ──▶ 202 {jobId}
                                       │
                                       ▼ INSERT jobs (status='queued')
                                       │
                                  notifyWorker()
                                       │
              ┌────────────────────────┘
              ▼
   [worker loop, concurrency=1]
     claimNextJob()  ──▶ runJob()  ──▶ markDone()|markFailed()
                          │
                          └─▶ translate + genre-tag + ACE-Step + watermark

GET /api/jobs/:id ──▶ getJob() ──▶ {status, queuePosition?, result?, error?}
```

| File | Role |
|---|---|
| `server/migrations/004_jobs.sql` | `jobs` table (status, payload, result, timestamps) + partial indexes on active rows |
| `server/jobs.ts` | enqueue / getJob / queue position / admission helpers / worker loop / stale-running recovery / periodic sweep |
| `server/index.ts` | route handlers: validation → `admitJob` → `enqueue` → 202. `GET /api/jobs/:id` polling. Boot calls `recoverStaleRunning` + `startWorker` |
| `src/api.ts` | client-side `enqueueJob` + `pollJob` with `onProgress` callback |
| `src/App.tsx` | `generate()` surfaces queue position in `loadingMsg` |

## 3. Admission caps

Enforced in `server/index.ts:admitJob` (skipped entirely if
`MOUSIKE_DEV=1`):

| Cap | Value | Trigger |
|---|---|---|
| Global queue depth | `GLOBAL_QUEUE_CAP = 50` | 503 to caller |
| Per-user in-flight | `PER_USER_INFLIGHT_CAP = 2` (authed only) | 429 |
| Tier quota incl. in-flight | free 3/day, starter 30/30d, pro ∞ | 429 with `usage` body |
| Anon IP rate limit | 10/hour | 429 from `express-rate-limit` |
| Poll IP rate limit | 30/sec | 429 from `express-rate-limit` |

The quota gate uses `countUsedPlusInFlight` (successful + currently
queued/running) so a user can't pre-queue past their daily limit and
burn the GPU on generations they can't keep.

## 4. Failure & recovery

- **Mid-job server crash** → `recoverStaleRunning()` flips all
  `status='running'` rows to `'failed'` at next boot. Clients see a
  clean failure on next poll.
- **Abandoned queued / orphan running rows** →
  `jobs.ts` sweep ticks every 60s and fails rows older than
  `QUEUED_TTL_MS` (1h) / `RUNNING_TTL_MS` (15min). Stops the global
  cap getting blocked by ghosts.
- **ACE-Step or Ollama throws inside `runJob`** → worker catches and
  calls `markFailed(jobId, err.message)`. The user sees the error
  text in their toast.
- **Concurrent enqueue race** → single worker process + single async
  loop = no concurrent claim. `claimNextJob` is `SELECT … LIMIT 1`
  then `UPDATE`; the mutex is the loop body itself. (For multi-worker
  later, swap for a Postgres RPC using `FOR UPDATE SKIP LOCKED`.)

## 5. Anonymous flow

`jobs.user_id` is nullable so the existing anon `/api/generate` path
keeps working. The `jobId` is 24 random hex chars (96 bits via
`crypto.randomBytes`); it acts as the ownership token for anonymous
polling. `getJob` matches anon callers only to jobs with `user_id IS
NULL`, and authed callers only to their own.

## 6. Throughput, measured 2026-05-20

5 concurrent anonymous free-tier (30s) generations:

```
enqueue       5 in 188ms
running       always ≤ 1 (single-flight invariant held)
per-job       avg 8.5s on the dev GPU
total wall    52s for all 5 to finish
```

Extrapolation:
- Free 30s: ~250–300 jobs/hour sustained
- Starter 90s: ~80–100/hour
- Pro 180s: ~40–50/hour

Active-user math (one song per user per 5 minutes):
- 5–10 sustained active users keeps the queue empty
- Bursts up to 50 absorbed in the queue, p95 wait 5–10 min at peak

## 7. Operating

### 7.1 Migrate

```
cd server && npm run migrate
```

`004_jobs.sql` is idempotent. Drops nothing.

### 7.2 Dev mode

```
cd server && MOUSIKE_DEV=1 npm run dev
```

Skips rate limit, quota, global queue cap, per-user in-flight cap,
and the poll-endpoint limiter — useful for load tests and for
hammering the GPU during model debugging. Do **not** set in prod.

### 7.3 Load test

```
node scripts/load-test-concurrent.mjs 5
```

Sends N anonymous POSTs in parallel, polls every 2s, prints status
transitions + 3s snapshots until all done. Default N=5; pass N as
arg. Hits ACE-Step for real, so expect ~10s × N wall clock at the
30s free-tier duration.

### 7.4 Inspect the queue

In Supabase SQL editor:

```sql
select id, kind, status, error, created_at, started_at, finished_at
  from jobs
 where status in ('queued', 'running')
 order by created_at;
```

To unstick a wedged row by hand (worker crashed mid-write, sweep
hasn't kicked in yet):

```sql
update jobs set status='failed', error='manual abort'
 where id = '...' and status in ('queued','running');
```

## 8. What's not in v1

- **SSE/WebSocket progress** — polling at 2s is the v1 UX. The
  Gradio side already streams SSE (`acestep.ts:pollSse`), so a
  future proxy endpoint can forward percent progress when wanted.
- **Multi-worker** — single Node process today. The schema already
  supports multi-worker via timestamps; flip `claimNextJob` to an
  RPC with `FOR UPDATE SKIP LOCKED` when needed.
- **Priority lanes** — FIFO across all tiers. If Pro 3-min jobs
  starve free users (or vice versa) in real data, add a tier-aware
  ordering in `claimNextJob`.
- **Repaint/Lego modal queue display** — only the main generate
  flow surfaces queue position in `App.tsx`. Modal flows show a
  plain spinner. Cheap to thread a `loadingMsg` prop through
  `RepaintModal` / `LegoModal` when wanted.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN (PLAN) | 6 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**UNRESOLVED:** 0 (all 6 issues received explicit decisions)
**VERDICT:** ENG ISSUES OPEN — 5 P1/P2 fixes accepted (T1 polling ceiling, T2 env URLs, T3 claim-race guard, T4 doc rot, T5 test infrastructure) + 1 P3 TODO recorded. Implement, then re-run `/review` on the diff before `/ship`.

