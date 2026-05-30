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
import { execFile } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { promises as fsp } from "fs";
import { join } from "path";
import { getSupabase } from "./db.js";
import { translateKoreanToEnglish } from "./ollama.js";
import { runAceStep } from "./acestep.js";
import { AUDIO_SECURE_DIR, prepareSourceForAceStep, processAudio, processAudioFromHost } from "./audio.js";
import { applyGenreTag, genreByCategory, resolveGenre, withQualitySuffix, type GenreCategory } from "./genre.js";
import { logUsage, type UsageAction } from "./quota.js";
import { inferOnBackingTrack, trainVoice } from "./rvc.js";
import { cleanupChainOutputs, cloneAndRemix, cloneOnto, pingYingMusic } from "./yingmusic.js";
import { purgeVoiceSamples, resolveVoiceSamplePath } from "./voice-storage.js";

const execFileAsync = promisify(execFile);

const PORT = 8787;

// rvc_train / rvc_infer are FALLBACK-ONLY in Phase 2 (ADR 0006) — no
// user-facing route enqueues them. They remain in the union so the
// worker can still claim and process any rows an operator inserts
// directly for emergency fallback or A/B comparison.
export type JobKind = "generate" | "repaint" | "lego" | "rvc_train" | "rvc_infer" | "yingmusic_clone";
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

// RVC voice-clone job kinds. Both reference a user_voices row by id;
// the worker reads sample paths / weight paths from that row rather than
// embedding them in the payload, so a single training-completion
// transaction (status → 'trained', weight_path set) atomically promotes
// every queued infer to succeed.
export interface RvcTrainPayload {
  voiceId: string;
  epochs: number;
}

export interface RvcInferPayload {
  voiceId: string;
}

// Phase 2 zero-shot SVC (ADR 0006). Worker reads sample_paths[0] off
// user_voices for the target reference; sourceHostPath is the vocal stem
// to convert (produced by the ACE-Step + BR-separator chain). Both paths
// must live under directories bind-mounted into the yingmusic container —
// see yingmusic.ts:toContainerPath for the allowed roots.
export interface YingmusicClonePayload {
  voiceId: string;
  sourceHostPath: string;
}

export type JobPayload =
  | GeneratePayload
  | RepaintPayload
  | LegoPayload
  | RvcTrainPayload
  | RvcInferPayload
  | YingmusicClonePayload;

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
const RUNNING_TTL_MS = 15 * 60_000;    // 15min — ACE-Step gen/repaint/lego + rvc_infer (Pro 3min + watermark + slack)
// rvc_train runs ~15-25min (ADR 0005); rvc.ts caps the docker-exec runner
// at 60min, so the sweep is a backstop just past that — NOT the 15min above,
// which would false-fail every legitimate training job.
const RVC_TRAIN_RUNNING_TTL_MS = 65 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;      // run once per minute

function audioUrl(filename: string): string {
  return `http://localhost:${PORT}/audio/${filename}`;
}

// 24 hex chars (96 bits) — anonymous callers use the jobId as ownership
// token, so it must be unguessable.
function mintJobId(): string {
  return randomBytes(12).toString("hex");
}

// Tier → priority snapshot for the queue. See migration 009 header for why
// this is a snapshot taken at enqueue time rather than re-read at claim.
function tierToPriority(tier: string | null): number {
  if (tier === "pro") return 3;
  if (tier === "starter") return 2;
  if (tier === "free") return 1;
  return 0;
}

// Read the user's current tier. Returns null on any failure so we degrade
// to priority 0 (back of queue) rather than 500ing on enqueue — a missing
// tier read is recoverable; a refused enqueue is not.
async function lookupUserTier(userId: string | null): Promise<string | null> {
  if (userId === null) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("users")
    .select("tier")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error(`[jobs] lookupUserTier(${userId}):`, error.message);
    return null;
  }
  return (data as { tier?: string } | null)?.tier ?? null;
}

export async function enqueue(
  userId: string | null,
  kind: JobKind,
  payload: JobPayload,
): Promise<string> {
  // Fail-fast for yingmusic_clone: if the worker container is down, refuse
  // the enqueue rather than letting the row sit until the sweep TTL fires.
  // Route handlers should pre-check pingYingMusic() to 503 cleanly; this is
  // the backstop for any other caller.
  if (kind === "yingmusic_clone" && !(await pingYingMusic())) {
    throw new Error("yingmusic worker unavailable");
  }
  const id = mintJobId();
  const priority = tierToPriority(await lookupUserTier(userId));
  const sb = getSupabase();
  const { error } = await sb.from("jobs").insert({
    id,
    user_id: userId,
    kind,
    status: "queued",
    payload,
    priority,
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

// Boot-time sweep of orphaned chain-staging files. chainAceOutputs writes
// each ACE-Step output as audio-secure/_pending-<jobId>-<i>.mp3 and unlinks
// it in a finally block; a worker SIGKILL between the docker cp and the
// finally leaks the transient indefinitely (AUDIO_SECURE_DIR has no other
// janitor). One pass at boot keeps the dir from accreting them. Errors are
// logged and swallowed — disk-usage, not correctness.
export async function sweepPendingTransients(): Promise<number> {
  try {
    const entries = await fsp.readdir(AUDIO_SECURE_DIR);
    const pending = entries.filter((f) => f.startsWith("_pending-"));
    await Promise.all(
      pending.map((f) => fsp.unlink(join(AUDIO_SECURE_DIR, f)).catch(() => {})),
    );
    return pending.length;
  } catch (err) {
    console.error("[jobs] sweepPendingTransients:", err instanceof Error ? err.message : err);
    return 0;
  }
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
//   - running rows older than their kind's TTL (worker hung past the
//     workload's own timeout; safety net behind the per-job AbortSignal /
//     docker-exec runner timeout)
// All get flipped to 'failed' so the global queue cap doesn't silently
// fill up with dead rows. rvc_train uses a much longer TTL because a real
// training run is ~15-25min — the 15min default would false-fail it.
async function sweepStaleJobs(): Promise<number> {
  const sb = getSupabase();
  const now = Date.now();
  const queuedCutoff = new Date(now - QUEUED_TTL_MS).toISOString();
  const runningCutoff = new Date(now - RUNNING_TTL_MS).toISOString();
  const trainCutoff = new Date(now - RVC_TRAIN_RUNNING_TTL_MS).toISOString();
  const finishedAt = new Date(now).toISOString();
  const [queuedRes, runningRes, trainRes] = await Promise.all([
    sb.from("jobs")
      .update({ status: "failed", error: "timed out while queued", finished_at: finishedAt })
      .eq("status", "queued")
      .lt("created_at", queuedCutoff)
      .select("id"),
    // Short-running kinds: everything except rvc_train.
    sb.from("jobs")
      .update({ status: "failed", error: "timed out while running", finished_at: finishedAt })
      .eq("status", "running")
      .neq("kind", "rvc_train")
      .lt("started_at", runningCutoff)
      .select("id"),
    // rvc_train: long backstop just past rvc.ts's 60min runner cap.
    sb.from("jobs")
      .update({ status: "failed", error: "timed out while running", finished_at: finishedAt })
      .eq("status", "running")
      .eq("kind", "rvc_train")
      .lt("started_at", trainCutoff)
      .select("id"),
  ]);
  if (queuedRes.error) throw queuedRes.error;
  if (runningRes.error) throw runningRes.error;
  if (trainRes.error) throw trainRes.error;
  return (queuedRes.data?.length ?? 0) + (runningRes.data?.length ?? 0) + (trainRes.data?.length ?? 0);
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
  // Order: priority DESC (Pro=3 → Starter=2 → Free=1 → anon=0), then
  // created_at ASC for FIFO within a priority level. Backed by
  // jobs_claim_idx (migration 009).
  const { data, error } = await sb
    .from("jobs")
    .select("id, user_id, kind, payload")
    .eq("status", "queued")
    .order("priority", { ascending: false })
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

// Look up the user's 'ready' YingMusic voice for the auto-chain step in
// generate. Returns the first ready row (newest first via the index) or
// null when there's nothing to apply. Errors degrade to null — the chain
// is an enhancement, not a correctness requirement, and falling back to
// plain ACE-Step output is the right failure mode.
interface ReadyVoice {
  id: string;
  sample_paths: string[];
}
async function lookupReadyVoice(userId: string): Promise<ReadyVoice | null> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("user_voices")
      .select("id, sample_paths")
      .eq("user_id", userId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error(`[jobs] lookupReadyVoice(${userId}):`, error.message);
      return null;
    }
    if (!data) return null;
    const row = data as ReadyVoice;
    if (!row.sample_paths || row.sample_paths.length === 0) return null;
    return row;
  } catch (e) {
    console.error(`[jobs] lookupReadyVoice(${userId}):`, e instanceof Error ? e.message : e);
    return null;
  }
}

// Auto-chain: ACE-Step output → BR-separate → clone vocals onto user's
// ready voice → echo+reverb remix with the instrumental. Replaces
// processAudio's docker-cp + watermark path when the user has a ready
// voice. Returns the same shape (watermarked filenames in audio-cache).
//
// Transient flow per ACE-Step output:
//   1. docker cp ace-step:<containerPath> → audio-secure/_pending-<id>.mp3
//      (audio-secure is bind-mounted into the yingmusic container as
//       /data/_aceout, so the chain runner reads it via that root)
//   2. cloneAndRemix → final wav in <YINGMUSIC_SRC>/outputs/<expname>/accompany/
//   3. processAudioFromHost on the chain wav: copy to audio-secure/<stem>.mp3,
//      watermark to audio-cache/<stem>-wm.mp3, unlink the chain wav
//   4. unlink the _pending-*.mp3 transient
async function chainAceOutputs(
  containerPaths: string[],
  voice: ReadyVoice,
  jobId: string,
): Promise<string[]> {
  const targetHostPath = resolveVoiceSamplePath(voice.sample_paths[0]);
  const filenames: string[] = [];
  for (let i = 0; i < containerPaths.length; i++) {
    const containerPath = containerPaths[i];
    const expname = `${jobId}-${i}`;
    const transient = join(AUDIO_SECURE_DIR, `_pending-${jobId}-${i}.mp3`);
    try {
      await execFileAsync("docker", ["cp", `ace-step:${containerPath}`, transient]);
      const chainOut = await cloneAndRemix({
        sourceHostPath: transient,
        targetHostPath,
        expname,
      });
      const [filename] = await processAudioFromHost([chainOut]);
      filenames.push(filename);
    } finally {
      await fsp.unlink(transient).catch(() => {});
      // GC YingMusic intermediates whether the chain succeeded or threw;
      // a failed run still leaves the BR-separator stems on disk and
      // there's no other janitor.
      await cleanupChainOutputs(expname);
    }
  }
  return filenames;
}

// Pre-flight gate for ACE-Step branches (generate / repaint / lego): if the
// user has a 'ready' voice, the post-ACE-Step chain WILL try to docker-exec
// yingmusic. Probing the container BEFORE we burn ACE-Step time means a
// stopped/unhealthy yingmusic fails the job in ~50ms instead of after a
// 3-min ACE-Step run that gets discarded. Returns the voice to chain onto,
// or null when the user has no voice (plain ACE-Step path).
async function preflightVoiceChain(userId: string | null, jobId: string): Promise<ReadyVoice | null> {
  if (!userId) return null;
  const voice = await lookupReadyVoice(userId);
  if (!voice) return null;
  if (!(await pingYingMusic())) {
    throw new Error("yingmusic worker unavailable — cannot apply user voice");
  }
  console.log(`[job ${jobId}] chain via voice=${voice.id}`);
  return voice;
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
    // Pre-flight: if user has a 'ready' voice but yingmusic is down, fail now
    // instead of burning ACE-Step time and discarding the result. Failure
    // propagates as a job failure — silent fallback to default vocal would
    // surprise a user who explicitly asked for their voice.
    const readyVoice = await preflightVoiceChain(job.user_id, job.id);
    const paths = await runAceStep({
      task: "text2music",
      caption,
      durationSec: p.durationSec,
      vocalLanguageCode: toAceCode(vocalLanguage),
      ...(bpmOverride !== undefined && { bpm: bpmOverride }),
      ...(keyOverride !== undefined && { key: keyOverride }),
      ...(lyricsOverride !== undefined && { lyrics: lyricsOverride }),
    });
    const filenames = readyVoice
      ? await chainAceOutputs(paths, readyVoice, job.id)
      : await processAudio(paths);
    const songs: JobSong[] = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: p.prompt,
      vocalLanguage,
      ...(translatedCaption !== undefined && { translatedCaption }),
    }));
    return { songs };
  }

  if (job.kind === "rvc_train") {
    const p = job.payload as RvcTrainPayload;
    if (!job.user_id) throw new Error("rvc_train requires an authenticated user");
    const sb = getSupabase();
    // Load the voice row + its sample paths. We snapshot only what we need
    // for the training call; the row gets a full update on completion.
    const { data: voiceRow, error: vErr } = await sb
      .from("user_voices")
      .select("id, user_id, sample_paths, display_name")
      .eq("id", p.voiceId)
      .eq("user_id", job.user_id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!voiceRow) throw new Error(`voice ${p.voiceId} not found`);
    const row = voiceRow as {
      id: string;
      user_id: string;
      sample_paths: string[];
      display_name: string;
    };
    const hostPaths = row.sample_paths.map(resolveVoiceSamplePath);

    // Flip to 'training' so the FE poll surfaces the transition. The row
    // is left with weight/index NULL — the paired-artifact CHECK
    // (user_voices_artifacts_paired) tolerates this because status != 'trained'.
    await sb
      .from("user_voices")
      .update({ status: "training" })
      .eq("id", row.id);

    console.log(`[job ${job.id}] rvc_train ${row.id} (${row.display_name}) ${p.epochs}ep`);
    try {
      const { weightPath, indexPath } = await trainVoice({
        userId: row.user_id,
        voiceId: row.id,
        sampleHostPaths: hostPaths,
        epochs: p.epochs,
      });

      // Atomically flip to 'trained' with both artifacts set. The CHECK
      // requires all three (weight_path, index_path, trained_at) together.
      await sb
        .from("user_voices")
        .update({
          status: "trained",
          weight_path: weightPath,
          index_path: indexPath,
          trained_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      // Raw samples are no longer needed — the .pth + .index are the voice.
      // Failure here is logged + swallowed by voice-storage.
      await purgeVoiceSamples(row.user_id, row.id);

      return { songs: [] };
    } catch (e) {
      // Mirror the job failure onto the voice row so the FE doesn't show
      // a perpetually-spinning "학습 중" badge for a job that died. The
      // jobs table gets its own failed flip via workerTick's catch.
      const errMsg = e instanceof Error ? e.message : String(e);
      await sb
        .from("user_voices")
        .update({ status: "failed", error: errMsg.slice(0, 500) })
        .eq("id", row.id);
      throw e;
    }
  }

  if (job.kind === "rvc_infer") {
    const p = job.payload as RvcInferPayload;
    if (!job.user_id) throw new Error("rvc_infer requires an authenticated user");
    const sb = getSupabase();
    const { data: voiceRow, error: vErr } = await sb
      .from("user_voices")
      .select("id, display_name, status, weight_path, index_path")
      .eq("id", p.voiceId)
      .eq("user_id", job.user_id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!voiceRow) throw new Error(`voice ${p.voiceId} not found`);
    const row = voiceRow as {
      id: string;
      display_name: string;
      status: string;
      weight_path: string | null;
      index_path: string | null;
    };
    if (row.status !== "trained" || !row.weight_path || !row.index_path) {
      throw new Error(`voice ${row.id} is not trained (status=${row.status})`);
    }

    console.log(`[job ${job.id}] rvc_infer ${row.id} (${row.display_name})`);
    const containerOutputHostPath = await inferOnBackingTrack({
      weightPath: row.weight_path,
      indexPath: row.index_path,
    });

    // The rvc.ts helper already copied the output off the container, so
    // feed the host path directly to the from-host pipeline (skips the
    // docker cp leg that processAudio normally does for ACE-Step).
    const filenames = await processAudioFromHost([containerOutputHostPath]);

    const songs: JobSong[] = filenames.map((filename, i) => ({
      id: `voice-demo-${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: `${row.display_name} 들어보기`,
      vocalLanguage: "unknown",
    }));
    return { songs };
  }

  if (job.kind === "yingmusic_clone") {
    const p = job.payload as YingmusicClonePayload;
    if (!job.user_id) throw new Error("yingmusic_clone requires an authenticated user");
    const sb = getSupabase();
    const { data: voiceRow, error: vErr } = await sb
      .from("user_voices")
      .select("id, display_name, status, sample_paths")
      .eq("id", p.voiceId)
      .eq("user_id", job.user_id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!voiceRow) throw new Error(`voice ${p.voiceId} not found`);
    const row = voiceRow as {
      id: string;
      display_name: string;
      status: string;
      sample_paths: string[];
    };
    if (row.status !== "ready") {
      throw new Error(`voice ${row.id} is not ready (status=${row.status})`);
    }
    if (row.sample_paths.length === 0) {
      throw new Error(`voice ${row.id} has no reference sample`);
    }
    // YingMusic is zero-shot: the first uploaded clip is the reference.
    // Phase-2 upload UI uploads exactly one clip per voice (commit 2/4).
    const targetHostPath = resolveVoiceSamplePath(row.sample_paths[0]);

    console.log(`[job ${job.id}] yingmusic_clone ${row.id} (${row.display_name})`);
    const outputHostPath = await cloneOnto({
      sourceHostPath: p.sourceHostPath,
      targetHostPath,
      expname: job.id,
    });

    const filenames = await processAudioFromHost([outputHostPath]);
    const songs: JobSong[] = filenames.map((filename, i) => ({
      id: `voice-clone-${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: `${row.display_name} 보컬`,
      vocalLanguage: "unknown",
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
    // Same chain semantics as generate — repainting a slice of a voice-cloned
    // song without the chain would leave an audible seam where the default
    // vocal returns mid-track.
    const readyVoice = await preflightVoiceChain(job.user_id, job.id);
    const paths = await runAceStep({
      task: "repaint",
      caption: aceCaption,
      durationSec: p.durationSec,
      source,
      startSec: p.startSec,
      endSec: p.endSec,
      vocalLanguageCode: toAceCode(vocalLanguage),
    });
    const filenames = readyVoice
      ? await chainAceOutputs(paths, readyVoice, job.id)
      : await processAudio(paths);
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
  const readyVoice = await preflightVoiceChain(job.user_id, job.id);
  const paths = await runAceStep({
    task: "lego",
    caption: fullCaption,
    durationSec: p.durationSec,
    source,
    vocalLanguageCode: toAceCode(vocalLanguage),
  });
  const filenames = readyVoice
    ? await chainAceOutputs(paths, readyVoice, job.id)
    : await processAudio(paths);
  const songs: JobSong[] = filenames.map((filename, i) => ({
    id: `${Date.now()}-${i}`,
    audioUrl: audioUrl(filename),
    prompt: fullCaption,
    vocalLanguage,
    ...(p.parentSongId && { parentSongId: p.parentSongId }),
  }));
  return { songs };
}

function isUsageActionKind(kind: JobKind): kind is UsageAction {
  return kind === "generate" || kind === "repaint" || kind === "lego";
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
    // RVC kinds (rvc_train / rvc_infer) are out of scope for usage_log in
    // Phase 1's commit A — they'll get their own quota wiring with the
    // API endpoints in commit B/C. ACE-Step kinds keep the existing
    // per-tier rolling-window counter.
    if (claimed.user_id && isUsageActionKind(claimed.kind)) {
      await logUsage(claimed.user_id, claimed.kind);
    }
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
