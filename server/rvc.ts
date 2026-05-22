// RVC voice-clone client. Talks to the local Docker container via Gradio
// HTTP (same pattern as acestep.ts) at port 7865, with bind-mounted
// voice-samples/ and voice-models/ directories for input/output exchange.
//
// === BEFORE THIS WORKS END-TO-END (verify your RVC version) ===
//
// 1. The container must expose Gradio at localhost:7865 with these
//    function names registered:
//       train1key   — one-click training pipeline
//       vc_single   — single-file voice conversion (inference)
//    Verify via:
//       curl -s http://localhost:7865/info | jq '.named_endpoints | keys'
//    If your fork uses different names (some forks rename to
//    `train_one_click`, `infer_one`, etc.), update FN_TRAIN / FN_INFER
//    below and the parameter lists.
//
// 2. Bind mounts in docker-compose.yml must match:
//       ./server/voice-samples       →  /inputs
//       ./server/voice-models        →  /weights
//       ./server/voice-demo-backing  →  /backing  (read-only)
//    If you ran the container with `docker run` and no mounts, switch
//    `useBindMounts` to false and we'll fall back to docker cp shuttling
//    (slower but works on any container).
//
// 3. Training writes to /weights/<voiceId>.pth and an index file at
//    /weights/added_IVF*<voiceId>*.index — RVC's index naming is
//    unfortunate. resolveTrainedArtifacts handles the discovery.
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fsp } from "fs";
import { basename, posix as pposix, relative as pathRelative, sep as pathSep } from "path";
import {
  DEMO_BACKING_FILE,
  VOICE_MODELS_DIR,
  voiceIndexPath,
  voiceModelDir,
  voiceWeightPath,
} from "./voice-storage.js";

const execFileAsync = promisify(execFile);

const RVC_URL = "http://localhost:7865";

// Gradio fn names — adjust here if your RVC version differs (see header).
const FN_TRAIN = "train1key";
const FN_INFER = "vc_single";

// Container-side mount points. Match docker-compose.yml.
const MOUNT_INPUTS = "/inputs";
const MOUNT_WEIGHTS = "/weights";
const MOUNT_BACKING = "/backing";

// Submit handshake is fast; training/inference is the long pole.
const SUBMIT_TIMEOUT_MS = 30_000;
const TRAIN_TIMEOUT_MS = 45 * 60_000;  // Pro 250ep at ~10s/epoch + pipeline overhead
const INFER_TIMEOUT_MS = 5 * 60_000;   // ~1-2min for a 30-60s backing track

// Mirror for the demo backing track (single fixed file inside /backing).
const BACKING_CONTAINER_PATH = pposix.join(MOUNT_BACKING, basename(DEMO_BACKING_FILE));

interface GradioSubmitResponse {
  event_id: string;
}

// Generic Gradio fn invoker. Mirrors acestep.ts's submit + SSE-poll loop
// but parameterized for any fn name.
async function callGradio(fnName: string, data: unknown[], pollTimeoutMs: number): Promise<unknown> {
  const submitRes = await fetch(`${RVC_URL}/gradio_api/call/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!submitRes.ok) {
    throw new Error(`RVC submit ${fnName}: HTTP ${submitRes.status}`);
  }
  const { event_id } = (await submitRes.json()) as GradioSubmitResponse;
  return pollSse(`${RVC_URL}/gradio_api/call/${fnName}/${event_id}`, pollTimeoutMs);
}

async function pollSse(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`RVC poll: HTTP ${res.status}`);
  if (!res.body) throw new Error("RVC poll: no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastDataLine = "";
  let lastEventType = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        lastEventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        lastDataLine = line.slice(6).trim();
        if (lastEventType === "error") {
          throw new Error(`RVC generation error: ${lastDataLine}`);
        }
      }
    }
    if (lastEventType === "complete") break;
  }
  if (!lastDataLine) throw new Error("RVC: no data received from SSE");
  return JSON.parse(lastDataLine);
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export interface TrainOptions {
  userId: string;
  voiceId: string;
  sampleHostPaths: string[];  // absolute host paths under voice-samples/
  epochs: number;
}

export interface TrainResult {
  weightPath: string;  // absolute host path under voice-models/
  indexPath: string;
}

export async function trainVoice(opts: TrainOptions): Promise<TrainResult> {
  if (opts.sampleHostPaths.length === 0) {
    throw new Error("no samples provided for training");
  }
  // RVC's train1key takes a *directory* of samples, not individual files —
  // its preprocess step walks the dir. All samples for one voice already
  // live under the same dir per voice-storage.ts's layout.
  const sampleDirContainer = pposix.join(
    MOUNT_INPUTS,
    opts.userId,
    opts.voiceId,
  );

  // === ASSUMPTION: train1key parameter list (RVC-Project main ~2024) ===
  // If your fork has a different signature, this is the list to adjust.
  // The internal Python signature lives in infer-web.py near `train1key =`.
  const trainArgs = [
    opts.voiceId,        // 0  exp_dir1 — model name, also the output stem under /weights
    "40k",               // 1  sr2 — sample rate
    true,                // 2  if_f0_3 — use pitch (singing needs this)
    sampleDirContainer,  // 3  trainset_dir4 — input directory inside container
    0,                   // 4  spk_id5 — single speaker
    1,                   // 5  np7 — num parallel preprocess workers
    "rmvpe",             // 6  f0method8 — pitch extraction method (good default)
    opts.epochs,         // 7  save_epoch10 — save every N epochs
    opts.epochs,         // 8  total_epoch11 — total epochs (Free 100 / Starter 200 / Pro 250)
    7,                   // 9  batch_size12 — 7 fits ~8GB VRAM headroom
    true,                // 10 if_save_latest13 — keep only the final .pth
    "",                  // 11 pretrained_G14 — empty = use default
    "",                  // 12 pretrained_D15 — empty = use default
    "0",                 // 13 gpus16 — GPU index
    false,               // 14 if_cache_gpu17 — cache off (samples small)
    false,               // 15 if_save_every_weights18 — only need final
    "v2",                // 16 version19 — RVC v2
    "0",                 // 17 gpus_rmvpe21 — RMVPE pitch GPU index
  ];

  await callGradio(FN_TRAIN, trainArgs, TRAIN_TIMEOUT_MS);

  // RVC writes weight + index files into /weights/. The exact filenames
  // depend on version; resolve them by globbing the host-side mount.
  return resolveTrainedArtifacts(opts.userId, opts.voiceId);
}

// Discover the .pth weight + .index file that train1key wrote. RVC's index
// naming includes the version + speaker count (e.g.
// "added_IVF256_Flat_nprobe_1_<voiceId>_v2.index"), so we glob rather than
// pin a literal name. The weight is named directly after `exp_dir1`.
async function resolveTrainedArtifacts(userId: string, voiceId: string): Promise<TrainResult> {
  // Canonical destination paths we want the artifacts at.
  const wantWeight = voiceWeightPath(userId, voiceId);
  const wantIndex = voiceIndexPath(userId, voiceId);
  await fsp.mkdir(voiceModelDir(userId, voiceId), { recursive: true });

  // RVC writes to the root of /weights/ (mapped to VOICE_MODELS_DIR on host).
  const entries = await fsp.readdir(VOICE_MODELS_DIR);
  const weightSrc = entries.find((f) => f === `${voiceId}.pth`);
  const indexSrc = entries.find((f) => f.includes(voiceId) && f.endsWith(".index"));
  if (!weightSrc) throw new Error(`RVC training finished but no weight file found for ${voiceId}`);
  if (!indexSrc) throw new Error(`RVC training finished but no index file found for ${voiceId}`);

  // Move (rename) the loose artifacts into the per-voice subdir so we don't
  // accumulate root-level files as more voices train.
  await fsp.rename(`${VOICE_MODELS_DIR}/${weightSrc}`, wantWeight);
  await fsp.rename(`${VOICE_MODELS_DIR}/${indexSrc}`, wantIndex);
  return { weightPath: wantWeight, indexPath: wantIndex };
}

// ---------------------------------------------------------------------------
// Inference (demo)
// ---------------------------------------------------------------------------

export interface InferOptions {
  weightPath: string;  // host path
  indexPath: string;   // host path
}

// Runs the trained voice over the canned backing track and returns the
// output as a host-side path. Caller hands it to processAudio for the
// public watermarked URL.
export async function inferOnBackingTrack(opts: InferOptions): Promise<string> {
  // Ensure the backing track exists — without this, Gradio returns a
  // confusing "file not found" deep in the RVC pipeline.
  try {
    await fsp.access(DEMO_BACKING_FILE);
  } catch {
    throw new Error(
      `backing track missing at ${DEMO_BACKING_FILE} — see voice-demo-backing/README.md`,
    );
  }

  // get_vc takes just the weight filename (it resolves under /weights);
  // vc_single takes the full container path for the FAISS index. Both
  // because voice-models/ is bind-mounted to /weights.
  const indexContainer = hostIndexToContainer(opts.indexPath);

  // === ASSUMPTION: vc_single parameter list (RVC-Project main ~2024) ===
  // Some versions split file_index/file_index2 differently; this list
  // matches the most common modern signature.
  const inferArgs = [
    0,                          // 0  sid (speaker id)
    BACKING_CONTAINER_PATH,     // 1  input_audio_path
    0,                          // 2  f0_up_key (semitone shift, 0 = no shift)
    "",                         // 3  f0_file (optional pitch curve override)
    "rmvpe",                    // 4  f0_method
    indexContainer,             // 5  file_index (FAISS index path)
    "",                         // 6  file_index2 (legacy slot, leave blank)
    0.75,                       // 7  index_rate (how much to use the index — higher = closer to training voice)
    3,                          // 8  filter_radius
    0,                          // 9  resample_sr (0 = no resample)
    0.25,                       // 10 rms_mix_rate (mix in original loudness contour)
    0.33,                       // 11 protect (preserve unvoiced consonants — lower = more)
  ];

  // RVC's vc_single requires the model to be loaded first. The Gradio UI
  // does this via a separate get_vc(weight_file) call. Mirror that.
  await callGradio("get_vc", [basename(opts.weightPath), 0, 0], SUBMIT_TIMEOUT_MS * 2);

  const result = await callGradio(FN_INFER, inferArgs, INFER_TIMEOUT_MS);

  // vc_single returns a tuple — the audio output is typically at index 1
  // as a Gradio FileData { path: "..." }. Adjust if your version shapes
  // the response differently.
  const arr = result as unknown[];
  const audioField = arr[1] as { path?: string; name?: string } | string | null;
  let containerOutputPath: string | null = null;
  if (typeof audioField === "string") containerOutputPath = audioField;
  else if (audioField && typeof audioField === "object" && audioField.path) containerOutputPath = audioField.path;
  if (!containerOutputPath) {
    throw new Error(`vc_single returned unexpected shape — got ${JSON.stringify(result).slice(0, 200)}`);
  }

  // Pull the file off the container into our host-side temp area. We
  // re-use the audio-cache directory pipeline via processAudio in the
  // caller; here we just copy out and return the path.
  return copyOutOfContainer(containerOutputPath);
}

function hostWeightToContainer(hostPath: string): string {
  const rel = pathRelative(VOICE_MODELS_DIR, hostPath);
  if (rel.startsWith("..")) throw new Error(`weight path not under models dir: ${hostPath}`);
  return pposix.join(MOUNT_WEIGHTS, rel.split(pathSep).join("/"));
}

function hostIndexToContainer(hostPath: string): string {
  return hostWeightToContainer(hostPath);  // same root mount
}

async function copyOutOfContainer(containerPath: string): Promise<string> {
  const stem = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ext = containerPath.endsWith(".wav") ? ".wav" : ".mp3";
  const hostTmp = `${VOICE_MODELS_DIR}/_tmp-${stem}${ext}`;
  // The container name `rvc` matches docker-compose.yml. If you ran the
  // container with a different --name, change here.
  await execFileAsync("docker", ["cp", `rvc:${containerPath}`, hostTmp]);
  return hostTmp;
}

// Used by callers to surface a cleaner failure when the user hasn't
// brought up the RVC container.
export async function pingRvc(): Promise<boolean> {
  try {
    const res = await fetch(`${RVC_URL}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok || res.status === 404; // 404 = up but no root route; still alive
  } catch {
    return false;
  }
}
