// Single-GPU job queue. The Express handlers in index.ts call `enqueue` and
// return 202 with the job id; this module's worker loop holds a mutex that
// guarantees concurrency=1 (matches the BATCH_SIZE=1 ACE-Step config) and
// drains queued rows one at a time.
//
// Admission control lives in helpers exported alongside enqueue so the route
// handlers can reject early with a meaningful 4xx / 5xx:
//   - inFlightCountForUser:  per-user cap (queued + running)
//   - queuedDepth:           global queue depth (back-pressure / 503)
//   - countUsedPlusInFlight: quota check that includes pending jobs so a user
//                            can't pre-queue past their daily/monthly limit.
import { randomBytes } from "crypto";
import { getSupabase } from "./db.js";
import { translateKoreanToEnglish } from "./ollama.js";
import { runAceStep } from "./acestep.js";
import { prepareSourceForAceStep, processAudio } from "./audio.js";
import { applyGenreTag, genreByCategory, resolveGenre, withQualitySuffix, type GenreCategory } from "./genre.js";
import { logUsage } from "./quota.js";

const PORT = 8787;

export type JobKind = "generate" | "repaint" | "lego";
export type JobStatus = "queued" | "running" | "done" | "failed";

// User's literal choice on /api/generate. "auto" is resolved server-side via
// the vocal-language auto rule. See CONTEXT.md "Vocal language".
export type VocalLanguageChoice = "auto" | "KO" | "EN";
// Concrete value persisted on songs.vocal_language and returned to the FE.
// "unknown" covers legacy songs (NULL column) and repaint/lego whose parent
// song predates this feature.
export type VocalLanguageResolved = "KO" | "EN" | "unknown";

export interface GeneratePayload {
  prompt: string;
  lang: "KO" | "EN";
  vocalLanguage: VocalLanguageChoice;
  durationSec: number;
  // Advanced overrides from the 고급 menu. Each defaults to "auto"; the BE
  // resolves them in runJob. durationSec above is already tier-capped by the
  // route handler, so it's not duplicated here.
  advancedGenre?: GenreCategory | "auto";
  advancedBpm?: number | "auto";
  advancedKey?: string | "auto";
  // User-supplied lyrics. Empty string = today's instrumental behavior (ACE-Step
  // slot 1 stays empty). Non-empty populates slot 1; the model then sings the
  // provided words (regardless of slot 5 vocal-language hint, which becomes
  // weaker once explicit lyrics are present).
  advancedLyrics?: string;
}

export interface RepaintPayload {
  sourceAudioUrl: string;
  startSec: number;
  endSec: number;
  caption: string;
  parentSongId?: string;
  durationSec: number;
}

export interface LegoPayload {
  sourceAudioUrl: string;
  instruments: string[];
  caption: string;
  parentSongId?: string;
  durationSec: number;
}

export type JobPayload = GeneratePayload | RepaintPayload | LegoPayload;

export interface JobSong {
  id: string;
  audioUrl: string;
  prompt: string;
  translatedCaption?: string;
  parentSongId?: string;
  vocalLanguage: VocalLanguageResolved;
}

export interface JobResult {
  songs: JobSong[];
}

export interface JobView {
  id: string;
  status: JobStatus;
  kind: JobKind;
  queuePosition?: number;
  result?: JobResult;
  error?: string;
  createdAt: string;
}

// Single-instance global queue cap. Sustained throughput on one 12GB GPU is
// ~40-60 jobs/hour, so 50 queued ≈ ~1h p95 wait — past that we 503 to keep
// the latency story honest.
export const GLOBAL_QUEUE_CAP = 50;
// Per-user queued+running cap. 2 lets a user line up their next song while
// the current one runs; higher than that mostly creates impatient queues.
export const PER_USER_INFLIGHT_CAP = 2;

// Stale-job sweep thresholds. Abandoned queued rows (user closed tab before
// the worker reached them) and crashed running rows (worker died holding the
// row, post-boot recovery missed it) both eventually fill the global cap and
// 503 honest traffic. Sweep flips them to failed.
const QUEUED_TTL_MS = 60 * 60_000;     // 1h — generous for a popular slot
const RUNNING_TTL_MS = 15 * 60_000;    // 15min — Pro 3min + watermark + slack
const SWEEP_INTERVAL_MS = 60_000;      // run once per minute

function audioUrl(filename: string): string {
  return `http://localhost:${PORT}/audio/${filename}`;
}

// 24 hex chars (96 bits) — anonymous callers use the jobId as ownership
// token, so it must be unguessable.
function mintJobId(): string {
  return randomBytes(12).toString("hex");
}

export async function enqueue(
  userId: string | null,
  kind: JobKind,
  payload: JobPayload,
): Promise<string> {
  const id = mintJobId();
  const sb = getSupabase();
  const { error } = await sb.from("jobs").insert({
    id,
    user_id: userId,
    kind,
    status: "queued",
    payload,
  });
  if (error) throw error;
  notifyWorker();
  return id;
}

// userId === null = anonymous poll (only matches jobs enqueued with null
// user_id). Authed poll only matches the caller's own jobs. Cross-bucket
// reads return null.
export async function getJob(jobId: string, userId: string | null): Promise<JobView | null> {
  const sb = getSupabase();
  let query = sb
    .from("jobs")
    .select("id, kind, status, result, error, created_at")
    .eq("id", jobId);
  query = userId === null ? query.is("user_id", null) : query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    id: string;
    kind: JobKind;
    status: JobStatus;
    result: JobResult | null;
    error: string | null;
    created_at: string;
  };
  const view: JobView = {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.status === "queued") {
    view.queuePosition = await queuePositionFor(row.created_at);
  }
  if (row.status === "done" && row.result) view.result = row.result;
  if (row.status === "failed" && row.error) view.error = row.error;
  return view;
}

// 1-based index in the queue. Counts rows still queued whose created_at <= ours.
async function queuePositionFor(createdAt: string): Promise<number> {
  const sb = getSupabase();
  const { count, error } = await sb
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued")
    .lte("created_at", createdAt);
  if (error) throw error;
  return Math.max(1, count ?? 1);
}

export async function inFlightCountForUser(userId: string): Promise<number> {
  const sb = getSupabase();
  const { count, error } = await sb
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["queued", "running"]);
  if (error) throw error;
  return count ?? 0;
}

export async function queuedDepth(): Promise<number> {
  const sb = getSupabase();
  const { count, error } = await sb
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");
  if (error) throw error;
  return count ?? 0;
}

// `used` against quota = succeeded (usage_log) + currently-pending jobs. This
// stops a user from queuing 5 jobs against a 3/day cap and burning the GPU on
// generations they can't keep. Counts queued+running of any kind, since each
// will logUsage on success.
export async function countUsedPlusInFlight(
  userId: string,
  windowMs: number,
): Promise<number> {
  const sb = getSupabase();
  const since = new Date(Date.now() - windowMs).toISOString();
  const [logRes, jobRes] = await Promise.all([
    sb.from("usage_log").select("id", { count: "exact", head: true })
      .eq("user_id", userId).gte("created_at", since),
    sb.from("jobs").select("id", { count: "exact", head: true })
      .eq("user_id", userId).in("status", ["queued", "running"]),
  ]);
  if (logRes.error) throw logRes.error;
  if (jobRes.error) throw jobRes.error;
  return (logRes.count ?? 0) + (jobRes.count ?? 0);
}

// Boot-time recovery: any 'running' row at startup belonged to the previous
// process, which is now gone. Mark them failed so the polling client sees
// a clear failure instead of waiting forever.
export async function recoverStaleRunning(): Promise<number> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("jobs")
    .update({
      status: "failed",
      error: "server restarted mid-generation",
      finished_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

// Periodic sweep that complements recoverStaleRunning. Catches:
//   - queued rows older than QUEUED_TTL_MS (client abandoned the poll)
//   - running rows older than RUNNING_TTL_MS (worker hung past the ACE-Step
//     timeout; safety net behind acestep.ts's per-fetch AbortSignal)
// Both classes get flipped to 'failed' so the global queue cap doesn't
// silently fill up with dead rows.
async function sweepStaleJobs(): Promise<number> {
  const sb = getSupabase();
  const now = Date.now();
  const queuedCutoff = new Date(now - QUEUED_TTL_MS).toISOString();
  const runningCutoff = new Date(now - RUNNING_TTL_MS).toISOString();
  const finishedAt = new Date(now).toISOString();
  const [queuedRes, runningRes] = await Promise.all([
    sb.from("jobs")
      .update({ status: "failed", error: "timed out while queued", finished_at: finishedAt })
      .eq("status", "queued")
      .lt("created_at", queuedCutoff)
      .select("id"),
    sb.from("jobs")
      .update({ status: "failed", error: "timed out while running", finished_at: finishedAt })
      .eq("status", "running")
      .lt("started_at", runningCutoff)
      .select("id"),
  ]);
  if (queuedRes.error) throw queuedRes.error;
  if (runningRes.error) throw runningRes.error;
  return (queuedRes.data?.length ?? 0) + (runningRes.data?.length ?? 0);
}

// Worker loop internals. Single-instance, single-loop — no JS-level mutex
// needed since the loop body is a sequential await chain. `notifyWorker`
// resolves the idle sleep so newly-enqueued jobs are picked up immediately.
// SIGTERM mid-job is fine: recoverStaleRunning() picks up the orphan on next
// boot.
let wakeResolver: (() => void) | null = null;
const IDLE_POLL_MS = 5_000;

function notifyWorker(): void {
  if (wakeResolver) {
    wakeResolver();
    wakeResolver = null;
  }
}

function sleepUntilWake(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeResolver = null;
      resolve();
    }, IDLE_POLL_MS);
    wakeResolver = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

interface ClaimedJob {
  id: string;
  user_id: string | null;
  kind: JobKind;
  payload: JobPayload;
}

async function claimNextJob(): Promise<ClaimedJob | null> {
  const sb = getSupabase();
  // Single worker process + workerBusy mutex means no concurrent claims, so
  // SELECT-then-UPDATE is race-free without explicit row locks. If we ever
  // run multiple workers, swap this for a `claim_next_job()` RPC that uses
  // `for update skip locked`.
  const { data, error } = await sb
    .from("jobs")
    .select("id, user_id, kind, payload")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const claim = data as ClaimedJob;
  const { error: upErr } = await sb
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", claim.id)
    .eq("status", "queued");
  if (upErr) throw upErr;
  return claim;
}

async function markDone(jobId: string, result: JobResult): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("jobs")
    .update({ status: "done", result, finished_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw error;
}

async function markFailed(jobId: string, message: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("jobs")
    .update({
      status: "failed",
      error: message.slice(0, 500),
      finished_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) console.error("[jobs] markFailed:", error.message);
}

// Vocal-language auto rule (see CONTEXT.md). Pure: caller supplies the inputs.
// Note: returns "KO"|"EN" only — never "unknown". Use "unknown" only when
// inheriting from a legacy parent song that predates this feature.
function resolveVocalLanguage(
  choice: VocalLanguageChoice,
  genreCategory: string | null,
  promptLang: "KO" | "EN",
): "KO" | "EN" {
  if (choice !== "auto") return choice;
  if (genreCategory === "kpop" || genreCategory === "trot") return "KO";
  if (promptLang === "KO") return "KO";
  return "EN";
}

function toAceCode(v: VocalLanguageResolved): "ko" | "en" | "unknown" {
  return v === "KO" ? "ko" : v === "EN" ? "en" : "unknown";
}

// Repaint/lego inherit vocalLanguage from their parent song. NULL column
// (legacy) and missing-parent both fall through to "unknown".
async function lookupParentVocalLanguage(
  parentSongId: string | undefined,
): Promise<VocalLanguageResolved> {
  if (!parentSongId) return "unknown";
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("songs")
      .select("vocal_language")
      .eq("id", parentSongId)
      .maybeSingle();
    if (error) {
      console.error(`[jobs] lookupParentVocalLanguage(${parentSongId}):`, error.message);
      return "unknown";
    }
    if (!data) return "unknown";
    const v = (data as { vocal_language?: string | null }).vocal_language;
    if (v === "KO" || v === "EN") return v;
    return "unknown";
  } catch (e) {
    console.error(`[jobs] lookupParentVocalLanguage(${parentSongId}):`, e instanceof Error ? e.message : e);
    return "unknown";
  }
}

// Resolve translations / source uploads + call ACE-Step + watermark, returning
// the same song shape the client used to get synchronously. Throws on any
// step failure; caller (workerTick) marks the job failed. Genre detection
// runs on the *original* user prompt (Korean keywords list), then the tag is
// prepended to the translated caption and a global quality suffix appended.
async function runJob(job: ClaimedJob): Promise<JobResult> {
  if (job.kind === "generate") {
    const p = job.payload as GeneratePayload;
    let caption = p.prompt.trim();
    let translatedCaption: string | undefined;
    if (p.lang === "KO") {
      translatedCaption = await translateKoreanToEnglish(caption);
      caption = translatedCaption;
    }
    // Advanced override: explicit genre choice from the 고급 menu bypasses
    // keyword detection. When unset (or "auto"), fall back to resolveGenre.
    const genre = p.advancedGenre && p.advancedGenre !== "auto"
      ? genreByCategory(p.advancedGenre)
      : resolveGenre(p.prompt);
    caption = withQualitySuffix(applyGenreTag(caption, genre));
    const vocalLanguage: VocalLanguageResolved = resolveVocalLanguage(
      p.vocalLanguage,
      genre?.category ?? null,
      p.lang,
    );
    const bpmOverride = typeof p.advancedBpm === "number" ? p.advancedBpm : undefined;
    const keyOverride = typeof p.advancedKey === "string" && p.advancedKey !== "auto" ? p.advancedKey : undefined;
    const lyricsOverride = typeof p.advancedLyrics === "string" && p.advancedLyrics.trim() !== "" ? p.advancedLyrics : undefined;
    console.log(
      `[job ${job.id}] generate genre=${genre?.category ?? "none"}(${p.advancedGenre ?? "auto"}) ` +
      `bpm=${bpmOverride ?? "auto"} key=${keyOverride ?? "auto"} ` +
      `lyrics=${lyricsOverride ? `${lyricsOverride.length}chars` : "none"} ` +
      `vocal=${vocalLanguage}(${p.vocalLanguage}) caption="${caption}"`,
    );
    const paths = await runAceStep({
      task: "text2music",
      caption,
      durationSec: p.durationSec,
      vocalLanguageCode: toAceCode(vocalLanguage),
      ...(bpmOverride !== undefined && { bpm: bpmOverride }),
      ...(keyOverride !== undefined && { key: keyOverride }),
      ...(lyricsOverride !== undefined && { lyrics: lyricsOverride }),
    });
    const filenames = await processAudio(paths);
    const songs: JobSong[] = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: p.prompt,
      vocalLanguage,
      ...(translatedCaption !== undefined && { translatedCaption }),
    }));
    return { songs };
  }

  if (job.kind === "repaint") {
    const p = job.payload as RepaintPayload;
    const source = await prepareSourceForAceStep(p.sourceAudioUrl);
    const genre = resolveGenre(p.caption);
    const aceCaption = withQualitySuffix(applyGenreTag(p.caption, genre));
    const vocalLanguage = await lookupParentVocalLanguage(p.parentSongId);
    console.log(
      `[job ${job.id}] repaint ${p.startSec}s–${p.endSec}s ` +
      `genre=${genre?.category ?? "none"} vocal=${vocalLanguage} caption="${aceCaption}"`,
    );
    const paths = await runAceStep({
      task: "repaint",
      caption: aceCaption,
      durationSec: p.durationSec,
      source,
      startSec: p.startSec,
      endSec: p.endSec,
      vocalLanguageCode: toAceCode(vocalLanguage),
    });
    const filenames = await processAudio(paths);
    const songs: JobSong[] = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: p.caption || "부분 수정",
      vocalLanguage,
      ...(p.parentSongId && { parentSongId: p.parentSongId }),
    }));
    return { songs };
  }

  // lego
  const p = job.payload as LegoPayload;
  const source = await prepareSourceForAceStep(p.sourceAudioUrl);
  const baseCaption = p.caption
    ? `add ${p.instruments.join(", ")}, ${p.caption}`
    : `add ${p.instruments.join(", ")}`;
  const genre = resolveGenre(p.caption);
  const fullCaption = withQualitySuffix(applyGenreTag(baseCaption, genre, p.instruments));
  const vocalLanguage = await lookupParentVocalLanguage(p.parentSongId);
  console.log(
    `[job ${job.id}] lego genre=${genre?.category ?? "none"} ` +
    `vocal=${vocalLanguage} caption="${fullCaption}"`,
  );
  const paths = await runAceStep({
    task: "lego",
    caption: fullCaption,
    durationSec: p.durationSec,
    source,
    vocalLanguageCode: toAceCode(vocalLanguage),
  });
  const filenames = await processAudio(paths);
  const songs: JobSong[] = filenames.map((filename, i) => ({
    id: `${Date.now()}-${i}`,
    audioUrl: audioUrl(filename),
    prompt: fullCaption,
    vocalLanguage,
    ...(p.parentSongId && { parentSongId: p.parentSongId }),
  }));
  return { songs };
}

async function workerTick(): Promise<boolean> {
  let claimed: ClaimedJob | null;
  try {
    claimed = await claimNextJob();
  } catch (err) {
    console.error("[jobs] claim error:", err instanceof Error ? err.message : err);
    return false;
  }
  if (!claimed) return false;
  try {
    const result = await runJob(claimed);
    await markDone(claimed.id, result);
    if (claimed.user_id) await logUsage(claimed.user_id, claimed.kind);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job ${claimed.id}] failed:`, message);
    await markFailed(claimed.id, message);
  }
  return true;
}

export function startWorker(): void {
  // Independent interval so the sweep keeps running even if the worker loop
  // itself wedges. Errors are logged and swallowed.
  setInterval(() => {
    sweepStaleJobs()
      .then((n) => { if (n > 0) console.log(`[jobs] swept ${n} stale row(s)`); })
      .catch((err) => console.error("[jobs] sweep error:", err instanceof Error ? err.message : err));
  }, SWEEP_INTERVAL_MS);

  void (async () => {
    console.log("[jobs] worker started");
    while (true) {
      const didWork = await workerTick();
      if (!didWork) await sleepUntilWake();
    }
  })();
}
