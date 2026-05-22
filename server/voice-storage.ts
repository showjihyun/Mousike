// Filesystem layout for voice-clone artifacts. Three directories under
// the server root, mirroring the audio-cache/audio-secure pattern from
// audio.ts:
//
//   voice-samples/<userId>/<voiceId>/sample-N.<ext>
//     Raw uploaded vocal samples. Lifecycle: created on POST /api/voice-samples,
//     deleted by purgeVoiceSamples() when training succeeds. Owner-gated.
//
//   voice-models/<userId>/<voiceId>/{weight.pth, model.index}
//     Trained RVC artifacts. Persistent — these *are* the voice. The
//     bind-mounted directory in docker-compose.yml gives the RVC container
//     write access here at /weights.
//
//   voice-demo-backing/default.mp3
//     The canned backing track used by Phase 1's "내 목소리 들어보기"
//     demo. Provisioned manually — see voice-demo-backing/README.md.
//     Read-only mount into the RVC container at /backing.
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, promises as fsp } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const VOICE_SAMPLES_DIR = join(__dirname, "voice-samples");
export const VOICE_MODELS_DIR = join(__dirname, "voice-models");
export const VOICE_DEMO_BACKING_DIR = join(__dirname, "voice-demo-backing");

mkdirSync(VOICE_SAMPLES_DIR, { recursive: true });
mkdirSync(VOICE_MODELS_DIR, { recursive: true });
mkdirSync(VOICE_DEMO_BACKING_DIR, { recursive: true });

// userId is a uuid (hyphens), voiceId is 24 hex from crypto.randomBytes,
// filenames are server-minted as `sample-N.mp3` — all match this regex.
// SAFE_NAME is the security-load-bearing check: do NOT loosen without
// auditing resolveVoiceSamplePath, which joins captured segments.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function safeSegment(s: string): string {
  if (!SAFE_NAME.test(s)) throw new Error(`invalid path segment: ${s}`);
  return s;
}

export function voiceSampleDir(userId: string, voiceId: string): string {
  return join(VOICE_SAMPLES_DIR, safeSegment(userId), safeSegment(voiceId));
}

export function voiceModelDir(userId: string, voiceId: string): string {
  return join(VOICE_MODELS_DIR, safeSegment(userId), safeSegment(voiceId));
}

export function voiceWeightPath(userId: string, voiceId: string): string {
  return join(voiceModelDir(userId, voiceId), "weight.pth");
}

export function voiceIndexPath(userId: string, voiceId: string): string {
  return join(voiceModelDir(userId, voiceId), "model.index");
}

export const DEMO_BACKING_FILE = join(VOICE_DEMO_BACKING_DIR, "default.mp3");

// Relative form is what gets stored in user_voices.sample_paths. Keeping
// the column portable means a server move doesn't break existing rows;
// only resolveVoiceSamplePath needs to know the absolute root.
export function voiceSampleRelative(userId: string, voiceId: string, filename: string): string {
  return [safeSegment(userId), safeSegment(voiceId), safeSegment(filename)].join("/");
}

export function resolveVoiceSamplePath(relativePath: string): string {
  const parts = relativePath.split("/");
  if (parts.length !== 3) throw new Error(`invalid sample path: ${relativePath}`);
  return join(VOICE_SAMPLES_DIR, safeSegment(parts[0]), safeSegment(parts[1]), safeSegment(parts[2]));
}

export async function ensureVoiceSampleDir(userId: string, voiceId: string): Promise<string> {
  const dir = voiceSampleDir(userId, voiceId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// Wipe a voice's raw samples once training succeeds. Errors are logged
// and swallowed — failing to delete samples is a disk-usage issue, not a
// correctness issue; the trained .pth + .index in voice-models/ are
// unaffected.
export async function purgeVoiceSamples(userId: string, voiceId: string): Promise<void> {
  try {
    await fsp.rm(voiceSampleDir(userId, voiceId), { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[voice-storage] purge ${userId}/${voiceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Duration probe via ffprobe. Used at upload time to enforce the total
// sample-seconds window (30-180s for RVC training to converge).
export async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const sec = parseFloat(stdout.trim());
  if (!Number.isFinite(sec)) throw new Error(`ffprobe returned invalid duration for ${path}`);
  return sec;
}
