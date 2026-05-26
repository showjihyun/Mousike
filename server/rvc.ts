// RVC voice-clone client. Two transports, picked per workload:
//
//   • Training (trainVoice) → `docker exec … /runner/train.py`.
//     train1key fans out into long subprocesses (preprocess → f0 →
//     feature-extract → train → index) over ~15-25 min, and Gradio
//     3.34's queue drops the socket mid-run — observed repeatedly as
//     "Gradio WS closed unexpectedly (fn=15)". Driving the generator
//     inside a subprocess removes the socket as a failure point.
//
//   • Inference (inferOnBackingTrack) → Gradio v3 WebSocket queue.
//     RVC's infer fns are Python generators too, but each completes in
//     seconds, so the queue protocol (ws://host/queue/join) drives them
//     to completion reliably. The simpler /api/<fn> route can't: it
//     calls a generator's __next__() once then GCs it, so the rest of
//     the pipeline never runs.
//
// Fn indices below were captured via `curl /config | jq` (see git
// history for the probe). They're stable as long as RVC's infer-web.py
// UI block order doesn't change.
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { promises as fsp } from "fs";
import { basename, posix as pposix, relative as pathRelative, sep as pathSep } from "path";
import WebSocket from "ws";
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
const GRADIO_HOST = "localhost:7865";
const GRADIO_WS_URL = `ws://${GRADIO_HOST}/queue/join`;

// fn_index from RVC's /config. Update if the Gradio UI's component order changes.
const FN_INFER_LOAD = 5;      // infer_change_voice
const FN_INFER = 2;           // infer_convert

// Training runner inside the rvc container, mounted by docker-compose
// (./server/rvc-runner:/runner:ro). Drives train1key to completion.
const TRAIN_RUNNER = "/runner/train.py";

const MOUNT_INPUTS = "/app/dataset";
const MOUNT_WEIGHTS = "/app/assets/weights";
const MOUNT_BACKING = "/app/backing";

const TRAIN_TIMEOUT_MS = 60 * 60_000;
const INFER_TIMEOUT_MS = 5 * 60_000;
const INFER_LOAD_TIMEOUT_MS = 60_000;

const BACKING_CONTAINER_PATH = pposix.join(MOUNT_BACKING, basename(DEMO_BACKING_FILE));

interface GradioWsOptions {
  fnIndex: number;
  data: unknown[];
  timeoutMs: number;
  // Optional progress callback for generator functions. Called once per
  // process_generating message with the most recent yield's first element
  // stringified.
  onProgress?: (status: string) => void;
}

// Drives Gradio's queue protocol over a single WebSocket. Resolves with
// the array of values from the final process_completed message; rejects
// on transport errors, timeout, or success=false from the server.
//
// The Gradio 3.34 queue handshake:
//   1. server → {msg: "send_hash"}
//   2. client → {session_hash, fn_index}
//   3. server → {msg: "estimation", rank, queue_size, ...}     (1+ times)
//   4. server → {msg: "send_data"}
//   5. client → {session_hash, fn_index, data, event_data: null}
//   6. server → {msg: "process_starts"}
//   7. server → {msg: "process_generating", output: {data: [...]}}  (0+ times for generators)
//   8. server → {msg: "process_completed", success, output: {data, ...}}
function gradioWsCall(opts: GradioWsOptions): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const ws = new WebSocket(GRADIO_WS_URL);
    const sessionHash = randomBytes(8).toString("hex");
    let settled = false;
    // Track the latest process_generating output — Gradio 3.34's queue
    // often closes the WS (code 1000) instead of sending a final
    // process_completed message when a generator function returns. Use
    // the last yield as the "result" in that case.
    let lastGenerating: unknown[] | null = null;
    let sawCompletion = false;  // saw success=true completion (not error)

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Gradio WS timeout after ${Math.round(opts.timeoutMs / 60000)}min (fn=${opts.fnIndex})`)));
    }, opts.timeoutMs);

    ws.on("error", (err: Error) => {
      settle(() => reject(new Error(`Gradio WS transport: ${err.message}`)));
    });

    ws.on("close", (code: number) => {
      // Gradio 3.34 frequently closes with code 1000 after the generator
      // finishes (with or without a preceding process_completed). Accept
      // that as success; the caller verifies the actual artifact on disk.
      if (code === 1000) {
        settle(() => resolve(lastGenerating ?? []));
      } else {
        settle(() => reject(new Error(`Gradio WS closed code=${code} (fn=${opts.fnIndex})`)));
      }
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: { msg?: string; output?: { data?: unknown[]; error?: string }; success?: boolean };
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        settle(() => reject(new Error(`Gradio WS bad JSON: ${(err as Error).message}`)));
        return;
      }
      void sawCompletion;  // silence "set but not read" if all paths use close fallback

      switch (msg.msg) {
        case "send_hash":
          ws.send(JSON.stringify({ session_hash: sessionHash, fn_index: opts.fnIndex }));
          break;

        case "send_data":
          ws.send(JSON.stringify({
            session_hash: sessionHash,
            fn_index: opts.fnIndex,
            data: opts.data,
            event_data: null,
          }));
          break;

        case "process_generating":
          if (Array.isArray(msg.output?.data)) {
            lastGenerating = msg.output.data;
            if (opts.onProgress) {
              const first = msg.output.data[0];
              const text = typeof first === "string" ? first : JSON.stringify(first);
              const lastLine = text.split("\n").filter((l) => l.trim()).pop() ?? "";
              if (lastLine) opts.onProgress(lastLine);
            }
          }
          break;

        case "process_completed":
          // For some generators Gradio sends this; for others it just
          // closes the WS. Treat success=false as definitive failure,
          // otherwise resolve here (close handler is the fallback).
          if (msg.success === false) {
            const errStr = msg.output?.error ?? JSON.stringify(msg.output ?? {});
            settle(() => reject(new Error(`Gradio fn=${opts.fnIndex} failed: ${String(errStr).slice(0, 400)}`)));
          } else {
            sawCompletion = true;
            const data = (msg.output?.data ?? []) as unknown[];
            settle(() => resolve(data));
          }
          break;

        // estimation / process_starts / queue_full are informational; the
        // queue_full case is the one to optionally surface — Gradio will
        // close the socket itself if it can't accept us.
        case "queue_full":
          settle(() => reject(new Error("Gradio queue full")));
          break;

        default:
          // estimation, process_starts, etc. — drop silently.
          break;
      }
    });
  });
}

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
    "",                  // 11 pretrained G (default bundled)
    "",                  // 12 pretrained D (default bundled)
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

  // get_vc takes the .pth filename relative to /app/assets/weights —
  // RVC scans the weights dir recursively, so nested user/voice paths work.
  const weightRel = pathRelative(VOICE_MODELS_DIR, opts.weightPath).split(pathSep).join("/");
  const indexContainer = pposix.join(
    MOUNT_WEIGHTS,
    pathRelative(VOICE_MODELS_DIR, opts.indexPath).split(pathSep).join("/"),
  );

  // Step 1: load the trained voice into RVC's active slot.
  console.log(`[rvc] infer_change_voice load: ${weightRel}`);
  await gradioWsCall({
    fnIndex: FN_INFER_LOAD,
    data: [weightRel, 0.33, 0.33],
    timeoutMs: INFER_LOAD_TIMEOUT_MS,
  });

  // Step 2: run inference. 12 args matching the infer_convert signature
  // captured from /info — [5] is the explicit index path, [6] the
  // dropdown auto-detect (left blank since we pass [5] explicitly).
  const inferData = [
    0,                       // 0  speaker ID
    BACKING_CONTAINER_PATH,  // 1  input audio path (inside container)
    0,                       // 2  transpose (semitones)
    null,                    // 3  optional F0 curve file
    "rmvpe",                 // 4  pitch algorithm
    indexContainer,          // 5  feature index path
    "",                      // 6  dropdown auto-detect (unused)
    0.75,                    // 7  index rate
    3,                       // 8  filter radius
    0,                       // 9  resample SR
    0.25,                    // 10 RMS mix rate
    0.33,                    // 11 protect voiceless consonants
  ];
  console.log(`[rvc] infer_convert begin`);
  const result = await gradioWsCall({
    fnIndex: FN_INFER,
    data: inferData,
    timeoutMs: INFER_TIMEOUT_MS,
  });

  // infer_convert returns [status_string, audio_file]. Newer Gradio
  // wraps file outputs as {name, data, is_file: true, ...}; older
  // returns {path: "..."}. Handle both.
  const audioField = result[1] as { path?: string; name?: string } | string | null;
  let containerPath: string | null = null;
  if (typeof audioField === "string") containerPath = audioField;
  else if (audioField && typeof audioField === "object") {
    containerPath = audioField.path ?? audioField.name ?? null;
  }
  if (!containerPath) {
    throw new Error(`infer_convert returned unexpected shape — ${JSON.stringify(result).slice(0, 200)}`);
  }

  return copyOutOfContainer(containerPath);
}

async function copyOutOfContainer(containerPath: string): Promise<string> {
  const stem = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ext = containerPath.endsWith(".wav") ? ".wav" : ".mp3";
  const hostTmp = `${VOICE_MODELS_DIR}/_tmp-${stem}${ext}`;
  await execFileAsync("docker", ["cp", `${RVC_CONTAINER}:${containerPath}`, hostTmp]);
  return hostTmp;
}

export async function pingRvc(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{.State.Running}}", RVC_CONTAINER]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
