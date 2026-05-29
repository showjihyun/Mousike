// YingMusic-SVC client (ADR 0006, Phase 2). Zero-shot SVC: no per-voice
// training counterpart — every call passes a fresh target reference, and the
// model conditions on it at inference. Replaces server/rvc.ts's
// trainVoice + inferOnBackingTrack pair with a single cloneOnto().
//
// Transport mirrors rvc.ts: spawn `docker exec yingmusic …` with env vars,
// stream stdout, verify the produced wav on disk. The container is the
// long-running service from docker-compose; the baked /usr/local/bin/
// yingmusic-infer wrapper is what we exec.
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { promises as fsp } from "fs";
import { dirname, join, posix as pposix, resolve, sep as pathSep } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONTAINER = "yingmusic";
const RUNNER = "yingmusic-infer";

// Mousike voice/ dir is bind-mounted into the container at /data (see
// docker-compose.yml). Anything we pass as source/target must live under it.
const VOICE_HOST_ROOT = resolve(__dirname, "..", "voice");
const VOICE_CONTAINER_MOUNT = "/data";

// YingMusic-SVC source dir on host (mounted at /app in container). The
// inference script writes to <src>/outputs/<expname>/, which we read back.
const YINGMUSIC_SRC = process.env.YINGMUSIC_SRC ?? resolve(__dirname, "..", "..", "YingMusic-SVC");
const OUTPUTS_HOST_ROOT = join(YINGMUSIC_SRC, "outputs");

// 100 diffusion steps + setup ≈ 15s wall on a 4070 SUPER for a 1min source.
// 10min cap leaves room for batch / very long inputs without obscuring a
// runaway hang.
const INFER_TIMEOUT_MS = 10 * 60_000;

export interface CloneOptions {
  // Path to the vocal we want to convert (e.g. an ACE-Step output stem).
  // Must live under server/../voice/.
  sourceHostPath: string;
  // Path to a 10-60s reference recording in the target speaker's voice.
  // Must live under server/../voice/.
  targetHostPath: string;
  // Unique tag — becomes the outputs/<expname>/ dir holding the produced wav.
  // Caller is responsible for uniqueness (e.g. job id).
  expname: string;
  // Diffusion denoising steps. Default 100 matches the upstream PoC; lower
  // trades quality for latency.
  steps?: number;
}

// Translate a /…/Mousike/voice/x/y.wav host path to /data/x/y.wav container
// path. Posix paths only on the container side, even on Windows hosts.
function toContainerPath(hostPath: string): string {
  const abs = resolve(hostPath);
  const prefix = VOICE_HOST_ROOT + pathSep;
  if (!abs.startsWith(prefix)) {
    throw new Error(`yingmusic: path must be under ${VOICE_HOST_ROOT}, got ${abs}`);
  }
  const rel = abs.slice(prefix.length).split(pathSep).join("/");
  return pposix.join(VOICE_CONTAINER_MOUNT, rel);
}

// Run inference and return the host path of the produced wav.
export async function cloneOnto(opts: CloneOptions): Promise<string> {
  // Up-front validation — both files must exist on disk so we fail before
  // burning a 15s GPU run.
  await fsp.access(opts.sourceHostPath);
  await fsp.access(opts.targetHostPath);

  const source = toContainerPath(opts.sourceHostPath);
  const target = toContainerPath(opts.targetHostPath);
  const steps = String(opts.steps ?? 100);

  console.log(`[yingmusic] cloneOnto ${opts.expname}: ${source} → target ${target}`);
  await runYingMusic(source, target, opts.expname, steps);

  // my_inference.py writes <target_stem>_<source_stem>_<auto_pitch>.wav. We
  // don't know the auto pitch up front, so glob the dir and take the .wav.
  const outDir = join(OUTPUTS_HOST_ROOT, opts.expname);
  const entries = await fsp.readdir(outDir).catch(() => [] as string[]);
  const wav = entries.find((f) => f.toLowerCase().endsWith(".wav"));
  if (!wav) {
    throw new Error(`yingmusic: inference reported done but no .wav in ${outDir}`);
  }
  return join(outDir, wav);
}

// docker exec with env vars (rather than CLI args) so the bash wrapper stays
// idiomatic. SOURCE/TARGET/EXPNAME/STEPS map 1:1 onto infer.sh.
function runYingMusic(source: string, target: string, expname: string, steps: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-e", `SOURCE=${source}`,
        "-e", `TARGET=${target}`,
        "-e", `EXPNAME=${expname}`,
        "-e", `STEPS=${steps}`,
        CONTAINER,
        RUNNER,
      ],
      { windowsHide: true },
    );

    let stdoutBuf = "";
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
      settle(() => reject(new Error(`yingmusic timed out after ${Math.round(INFER_TIMEOUT_MS / 60000)}min`)));
    }, INFER_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trimEnd();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        // tqdm-style \r-overwritten progress lines are noisy; only log
        // milestone strings the wrapper emits.
        if (line.startsWith("===") || line.startsWith("RTF")) console.log(`[yingmusic] ${line}`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.on("error", (err) => {
      settle(() => reject(new Error(`docker exec spawn failed: ${err.message}`)));
    });

    child.on("close", (code) => {
      if (code === 0) settle(() => resolve());
      else settle(() => reject(new Error(`yingmusic exited code=${code}: ${stderrTail.slice(-400)}`)));
    });
  });
}

// Health check — for boot-time readiness + Phase-2 jobs.ts gating.
export async function pingYingMusic(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.on("close", () => resolve(stdout.trim() === "true"));
    child.on("error", () => resolve(false));
  });
}
