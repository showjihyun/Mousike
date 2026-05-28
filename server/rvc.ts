// RVC voice-clone client. Every RVC operation runs as a Python script
// inside the rvc container via `docker exec … /runner/<script>`:
//
//   • Training  (trainVoice)          → /runner/train.py    (train1key)
//   • Inference (inferOnBackingTrack) → /runner/vc_infer.py (VC.vc_single)
//
// We deliberately do NOT use RVC's Gradio queue/WebSocket. Training's
// generator drops the socket mid-run over ~15-25 min; inference's
// infer_convert returns an empty success=false over the queue even though
// the conversion itself succeeds in seconds (the failure is in Gradio's
// Audio-output postprocessing, not the model). Driving the Python
// directly removes Gradio as a failure point and surfaces real
// tracebacks. The scripts write artifacts to bind-mounted dirs, so the
// host reads them with no docker cp.
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { promises as fsp } from "fs";
import { basename, posix as pposix, relative as pathRelative, sep as pathSep } from "path";
import {
  DEMO_BACKING_FILE,
  VOICE_MODELS_DIR,
  VOICE_TRAIN_LOGS_DIR,
  voiceIndexPath,
  voiceModelDir,
  voiceWeightPath,
} from "./voice-storage.js";

const execFileAsync = promisify(execFile);

const RVC_CONTAINER = "rvc";

// Python runners inside the rvc container, mounted by docker-compose
// (./server/rvc-runner:/runner:ro).
const TRAIN_RUNNER = "/runner/train.py";
const INFER_RUNNER = "/runner/vc_infer.py";

// Container-side bind-mount roots (see docker-compose.yml).
const MOUNT_INPUTS = "/app/dataset";          // ← voice-samples/
const MOUNT_WEIGHTS = "/app/assets/weights";  // ← voice-models/
const MOUNT_BACKING = "/app/backing";         // ← voice-demo-backing/ (ro)
const MOUNT_LOGS = "/app/logs";               // ← voice-train-logs/

const TRAIN_TIMEOUT_MS = 60 * 60_000;
const INFER_TIMEOUT_MS = 5 * 60_000;

const BACKING_CONTAINER_PATH = pposix.join(MOUNT_BACKING, basename(DEMO_BACKING_FILE));

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export interface TrainOptions {
  userId: string;
  voiceId: string;
  sampleHostPaths: string[];
  epochs: number;
}

export interface TrainResult {
  weightPath: string;
  indexPath: string;
}

export async function trainVoice(opts: TrainOptions): Promise<TrainResult> {
  if (opts.sampleHostPaths.length === 0) {
    throw new Error("no samples provided for training");
  }
  const sampleDirContainer = pposix.join(MOUNT_INPUTS, opts.userId, opts.voiceId);

  // train1key signature (18 args), passed straight through to
  // train1key(*args) by /runner/train.py. Verified via Gradio /info
  // introspection — Radio fields that look boolean ([10],[14],[15]) take
  // "Yes"/"No" strings; [2] pitch-guidance does take a Python bool.
  const data = [
    opts.voiceId,        // 0  experiment name → .pth stem
    "40k",               // 1  sample rate
    true,                // 2  pitch guidance (Radio: True/False bool)
    sampleDirContainer,  // 3  training folder
    0,                   // 4  speaker ID
    1,                   // 5  CPU processes
    "rmvpe",             // 6  pitch algorithm
    5,                   // 7  save_every_epoch (1-50)
    opts.epochs,         // 8  total_epoch
    7,                   // 9  batch size per GPU (fits 12GB VRAM)
    "Yes",               // 10 save only latest .ckpt
    // [11],[12]: KLM (Korean Language Model) pretrained — RVC v2 40k base
    // finetuned on Korean voice actors + vocalists. The bundled English /
    // Chinese-trained assets/pretrained_v2/f0G40k.pth produces robotic output
    // when fine-tuned for Korean (model has to learn KR phonemes from
    // scratch). KLM43_X3 is the most recent 40k pair from
    // SeoulStreamingStation via Politrees/RVC_resources, mounted by
    // docker-compose at /app/assets/pretrained_klm. NB train1key does NOT
    // fall back to bundled weights on empty string — it just logs "No
    // pretrained" and trains from random init.
    "assets/pretrained_klm/G_KLM43_X3_40k.pth",  // 11 pretrained G
    "assets/pretrained_klm/D_KLM43_X3_40k.pth",  // 12 pretrained D
    "0",                 // 13 GPU index
    "No",                // 14 cache training set to GPU memory
    "Yes",               // 15 save small final model to weights/
    "v2",                // 16 RVC version
    "0-0",               // 17 RMVPE GPU index
  ];

  console.log(`[rvc] train begin (voice=${opts.voiceId}, epochs=${opts.epochs})`);
  await runTrainer(data);

  return resolveTrainedArtifacts(opts.userId, opts.voiceId);
}

// Drives train1key to completion in the rvc container via
// `docker exec … /runner/train.py '<json-18-args>'`. The runner prints
// one line per generator yield and a __TRAIN_DONE__ sentinel at the end;
// we stream those to the log. Exit code is the gate, but
// resolveTrainedArtifacts() is the real success check — it verifies the
// .pth/.index actually landed on disk.
function runTrainer(args: unknown[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["exec", RVC_CONTAINER, "python", TRAIN_RUNNER, JSON.stringify(args)],
      { windowsHide: true },
    );

    let stdoutBuf = "";
    let stderrTail = "";
    let sawDone = false;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`train.py timed out after ${Math.round(TRAIN_TIMEOUT_MS / 60000)}min`)));
    }, TRAIN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trimEnd();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        if (line.includes("__TRAIN_DONE__")) { sawDone = true; continue; }
        console.log(`[rvc/train] ${line}`);
      }
    });

    // RVC logs progress bars + warnings to stderr; keep only the tail for
    // failure diagnostics rather than treating any stderr as fatal.
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) => {
      settle(() => reject(new Error(`docker exec spawn failed: ${err.message}`)));
    });

    child.on("close", (code) => {
      if (code === 0) {
        if (!sawDone) console.warn("[rvc/train] exited 0 without __TRAIN_DONE__ — verifying artifacts anyway");
        settle(() => resolve());
      } else {
        settle(() => reject(new Error(`train.py exited code=${code}: ${stderrTail.slice(-400)}`)));
      }
    });
  });
}

async function resolveTrainedArtifacts(userId: string, voiceId: string): Promise<TrainResult> {
  const wantWeight = voiceWeightPath(userId, voiceId);
  const wantIndex = voiceIndexPath(userId, voiceId);
  await fsp.mkdir(voiceModelDir(userId, voiceId), { recursive: true });

  // runTrainer resolves only after train.py exits, by which point RVC has
  // written the final small model to weights/ (→ voice-models/ root). Poll
  // rather than stat-once as a safety net for fs-flush latency and the
  // "exited 0 without __TRAIN_DONE__" edge; normally hits on the first try.
  const weightSrc = `${VOICE_MODELS_DIR}/${voiceId}.pth`;
  const POLL_MS = 10_000;
  const deadline = Date.now() + TRAIN_TIMEOUT_MS - 30_000;
  let weightFound = false;
  while (Date.now() < deadline) {
    try { await fsp.access(weightSrc); weightFound = true; break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!weightFound) {
    throw new Error(`training timed out — ${voiceId}.pth never appeared after ${Math.round(TRAIN_TIMEOUT_MS / 60000)}min`);
  }
  await fsp.rename(weightSrc, wantWeight);

  // if_save_every_weights="Yes" (train arg [15]) drops a small model to
  // weights/ every save_every_epoch as <voiceId>_e{N}_s{S}.pth. Only the
  // final model (renamed above) is the voice — sweep the periodic ones so
  // each run doesn't leak ~55MB × (epochs/5) into voice-models/.
  const stray = (await fsp.readdir(VOICE_MODELS_DIR)).filter(
    (f) => f.startsWith(`${voiceId}_e`) && f.endsWith(".pth"),
  );
  await Promise.all(stray.map((f) => fsp.rm(`${VOICE_MODELS_DIR}/${f}`, { force: true })));
  if (stray.length) console.log(`[rvc] swept ${stray.length} periodic checkpoint(s) for ${voiceId}`);

  // The index file may land slightly after the .pth (separate train_index
  // step). Poll for up to 2 minutes after the .pth appears.
  const logsDir = `${VOICE_TRAIN_LOGS_DIR}/${voiceId}`;
  const idxDeadline = Date.now() + 120_000;
  let indexSrc: string | null = null;
  while (Date.now() < idxDeadline) {
    try {
      const entries = await fsp.readdir(logsDir);
      indexSrc = entries.find((f) => f.endsWith(".index") && f.startsWith("added_")) ?? null;
      if (indexSrc) break;
    } catch { /* logsDir not present yet */ }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!indexSrc) {
    throw new Error(`.pth created but no added_*.index in logs/${voiceId}/ after 2min`);
  }
  await fsp.rename(`${logsDir}/${indexSrc}`, wantIndex);

  await fsp.rm(logsDir, { recursive: true, force: true }).catch((err) => {
    console.error(`[rvc] failed to clean logs/${voiceId}:`, err instanceof Error ? err.message : err);
  });

  return { weightPath: wantWeight, indexPath: wantIndex };
}

// ---------------------------------------------------------------------------
// Inference (demo)
// ---------------------------------------------------------------------------

export interface InferOptions {
  weightPath: string;
  indexPath: string;
}

export async function inferOnBackingTrack(opts: InferOptions): Promise<string> {
  try {
    await fsp.access(DEMO_BACKING_FILE);
  } catch {
    throw new Error(
      `backing track missing at ${DEMO_BACKING_FILE} — see voice-demo-backing/README.md`,
    );
  }

  // get_vc resolves weight_rel under weight_root (= /app/assets/weights,
  // the voice-models/ mount); the index goes in as an absolute in-container
  // path. Both forms verified against vc_infer.py's get_vc + vc_single.
  const weightRel = pathRelative(VOICE_MODELS_DIR, opts.weightPath).split(pathSep).join("/");
  const indexContainer = pposix.join(
    MOUNT_WEIGHTS,
    pathRelative(VOICE_MODELS_DIR, opts.indexPath).split(pathSep).join("/"),
  );

  // vc_infer.py writes the converted wav here. /app/logs is bind-mounted to
  // VOICE_TRAIN_LOGS_DIR, so it appears on the host with no docker cp.
  const outName = `_demo-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
  const outContainer = pposix.join(MOUNT_LOGS, outName);
  const outHost = `${VOICE_TRAIN_LOGS_DIR}/${outName}`;

  console.log(`[rvc] infer begin: ${weightRel}`);
  await runInfer({
    weight_rel: weightRel,
    index_path: indexContainer,
    input_path: BACKING_CONTAINER_PATH,
    output_path: outContainer,
    transpose: 0,
    f0_method: "rmvpe",
    index_rate: 0.75,
    filter_radius: 3,
    resample_sr: 0,
    rms_mix_rate: 0.25,
    protect: 0.33,
  });

  // runInfer exits 0 only after vc_infer.py wrote the wav; verify it landed.
  try {
    await fsp.access(outHost);
  } catch {
    throw new Error(`vc_infer.py reported done but ${outHost} is missing`);
  }
  return outHost;
}

// Runs vc_infer.py (VC.get_vc + VC.vc_single) in the rvc container. Same
// rationale as runTrainer: the Gradio queue swallows infer_convert's real
// error into an empty WS failure, while the direct call succeeds in
// seconds. vc_single's "Success./Time:" line goes to stdout; tracebacks +
// RVC INFO logs go to stderr (kept as a tail for failure messages).
function runInfer(args: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["exec", RVC_CONTAINER, "python", INFER_RUNNER, JSON.stringify(args)],
      { windowsHide: true },
    );

    let stderrTail = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`vc_infer.py timed out after ${Math.round(INFER_TIMEOUT_MS / 60000)}min`)));
    }, INFER_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const line = chunk.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (line) console.log(`[rvc/infer] ${line}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) => {
      settle(() => reject(new Error(`docker exec spawn failed: ${err.message}`)));
    });

    child.on("close", (code) => {
      if (code === 0) settle(() => resolve());
      else settle(() => reject(new Error(`vc_infer.py exited code=${code}: ${stderrTail.slice(-400)}`)));
    });
  });
}

export async function pingRvc(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", RVC_CONTAINER]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
