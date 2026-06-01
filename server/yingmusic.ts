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
const CHAIN_RUNNER = "yingmusic-chain";

// Three host roots are bind-mounted into the yingmusic container — anything
// we pass as source/target must live under one of them. Container paths are
// top-level (not nested under /data) because Docker can't mkdir a subdir
// mount target inside the read-only /data parent. Sorted longest-host-first
// at module init for prefix-match determinism. Mirrors docker-compose.yml
// `yingmusic.volumes`.
const VOICE_MOUNTS: Array<{ host: string; container: string }> = [
  { host: resolve(__dirname, "voice-samples"), container: "/uploads" },
  { host: resolve(__dirname, "audio-secure"),  container: "/aceout" },
  { host: resolve(__dirname, "..", "voice"),   container: "/data" },
].sort((a, b) => b.host.length - a.host.length);

// YingMusic-SVC source dir on host (mounted at /app in container). The
// inference script writes to <src>/outputs/<expname>/, which we read back.
const YINGMUSIC_SRC = process.env.YINGMUSIC_SRC ?? resolve(__dirname, "..", "..", "YingMusic-SVC");
const OUTPUTS_HOST_ROOT = join(YINGMUSIC_SRC, "outputs");

// 100 diffusion steps + setup ≈ 15s wall on a 4070 SUPER for a 1min source.
// 10min cap leaves room for batch / very long inputs without obscuring a
// runaway hang.
const INFER_TIMEOUT_MS = 10 * 60_000;
// chain.sh adds a BR Separator pass (30-90s) before YingMusic. With audit
// fix C raising default diffusion steps from 100 → 200, RTF roughly
// doubles: for a Pro 3min song the chain is now ~10-15min wall. The chain
// runs AFTER ACE-Step inside the same runJob, so the shared budget with
// ACE-Step (~4-6min on a 4070 SUPER for Pro 3min songs) has to stay under
// jobs.ts:RUNNING_TTL_MS (bumped to 26min). 18min here leaves a small
// cushion over ACE-Step's worst case before the sweep can race.
const CHAIN_TIMEOUT_MS = 18 * 60_000;

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

// Translate a host path to its container-side equivalent under one of the
// bind-mounted roots in VOICE_MOUNTS. Posix paths only on the container
// side, even on Windows hosts.
function toContainerPath(hostPath: string): string {
  const abs = resolve(hostPath);
  for (const mount of VOICE_MOUNTS) {
    const prefix = mount.host + pathSep;
    if (abs.startsWith(prefix)) {
      const rel = abs.slice(prefix.length).split(pathSep).join("/");
      return pposix.join(mount.container, rel);
    }
  }
  const roots = VOICE_MOUNTS.map((m) => m.host).join(" or ");
  throw new Error(`yingmusic: path must be under ${roots}, got ${abs}`);
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
  await runRunner(RUNNER, INFER_TIMEOUT_MS, { SOURCE: source, TARGET: target, EXPNAME: opts.expname, STEPS: steps });

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

// Chain inference: full-mix source → BR-separate → clone vocals onto target →
// echo+reverb mix back with the instrumental. Returns the host path of the
// final remixed wav. Used by the generate pipeline when the user has a
// 'ready' user_voices row (auto-apply, no explicit opt-in).
//
// Timing on a 4070 SUPER for a 3-min Pro song is ~5-7 min wall (BR ~30-90s,
// YingMusic RTF ~1.46) — fits inside the worker's RUNNING_TTL_MS.
export async function cloneAndRemix(opts: CloneOptions): Promise<string> {
  await fsp.access(opts.sourceHostPath);
  await fsp.access(opts.targetHostPath);

  const source = toContainerPath(opts.sourceHostPath);
  const target = toContainerPath(opts.targetHostPath);
  // Mousike audit fix C: 200 diffusion steps for the chain path (vs 100 for
  // the single-clone path) — sharper formants help phoneme intelligibility
  // for non-English source vocals at the cost of ~2x wall time per chain
  // step. CHAIN_TIMEOUT_MS + RUNNING_TTL_MS bumped to absorb the new budget.
  const steps = String(opts.steps ?? 200);

  console.log(`[yingmusic] cloneAndRemix ${opts.expname}: ${source} → target ${target}, steps=${steps}`);
  await runRunner(CHAIN_RUNNER, CHAIN_TIMEOUT_MS, { SOURCE: source, TARGET: target, EXPNAME: opts.expname, STEPS: steps });

  // chain.sh writes the final remix to /app/outputs/<expname>/accompany/<x>.wav.
  // The vc filename is auto-derived inside my_inference.py from source/target
  // stems + pitch shift, so glob the accompany/ dir.
  const accDir = join(OUTPUTS_HOST_ROOT, opts.expname, "accompany");
  const entries = await fsp.readdir(accDir).catch(() => [] as string[]);
  const wav = entries.find((f) => f.toLowerCase().endsWith(".wav"));
  if (!wav) {
    throw new Error(`yingmusic: chain reported done but no .wav in ${accDir}`);
  }
  return join(accDir, wav);
}

// docker exec with env vars (rather than CLI args) so the bash wrappers
// (infer.sh, chain.sh) stay idiomatic. env keys map 1:1 onto the wrapper's
// "${SOURCE:?required}" guards.
function runRunner(runner: string, timeoutMs: number, env: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args: string[] = ["exec"];
    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }
    args.push(CONTAINER, runner);
    const child = spawn("docker", args, { windowsHide: true });

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
      settle(() => reject(new Error(`yingmusic ${runner} timed out after ${Math.round(timeoutMs / 60000)}min`)));
    }, timeoutMs);

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
      else settle(() => reject(new Error(`yingmusic ${runner} exited code=${code}: ${stderrTail.slice(-400)}`)));
    });
  });
}

// Best-effort cleanup of the per-job intermediates left behind by chain.sh
// and my_inference.py:
//   <OUTPUTS_HOST_ROOT>/<expname>/        — YingMusic vc wav + accompany/<x>.wav
//   <OUTPUTS_HOST_ROOT>/<expname>_sep/    — BR Separator input + output stems
// Without this every voice-chained generate leaves ~60-120MB of wav on disk
// forever. Errors are logged + swallowed — a stuck dir is a disk-usage issue,
// not a correctness one, and we don't want to fail-the-job over GC.
export async function cleanupChainOutputs(expname: string): Promise<void> {
  for (const dir of [join(OUTPUTS_HOST_ROOT, expname), join(OUTPUTS_HOST_ROOT, `${expname}_sep`)]) {
    await fsp.rm(dir, { recursive: true, force: true }).catch((e) => {
      console.error(`[yingmusic] cleanup ${dir}:`, e instanceof Error ? e.message : e);
    });
  }
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
