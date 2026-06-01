// Voice watermark applied to free-tier audio: a Korean "Mousike" clip mixed
// over the start and the last ~2s of the song. Paid users get the clean
// file (stored separately in audio-secure).
//
// The watermark clip itself was generated once with:
//   edge-tts --voice ko-KR-SunHiNeural --text "Mousike" --write-media server/assets/watermark.mp3
// Re-run it if you want to swap voices, then commit the new mp3.
import { execFile } from "child_process";
import { promisify } from "util";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const WATERMARK_PATH = join(__dirname, "assets", "watermark.mp3");
const WATERMARK_VOLUME = 0.6;
const END_LEAD_TIME_SEC = 2; // how close to the end the closing tag plays

// 60s is a generous ceiling — a 3min mp3 mixes in under a second on a
// modern laptop. The timeout protects against a wedged ffmpeg holding the
// HTTP request open indefinitely.
const CHILD_TIMEOUT_MS = 60_000;

async function probeDurationSec(path: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      path,
    ],
    { timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`bad ffprobe duration for ${path}: ${stdout}`);
  return d;
}

export async function mixWatermark(cleanPath: string, outPath: string): Promise<void> {
  const durationSec = await probeDurationSec(cleanPath);
  // adelay needs ms per channel. Stereo source → "ms|ms".
  const startDelayMs = 200;
  const endDelayMs = Math.max(0, Math.round((durationSec - END_LEAD_TIME_SEC) * 1000));

  // Two filtered copies of the watermark, mixed onto the source. duration=first
  // clips to the song length so the mix doesn't extend past the original.
  const filter =
    `[1:a]volume=${WATERMARK_VOLUME},adelay=${startDelayMs}|${startDelayMs}[wmStart];` +
    `[1:a]volume=${WATERMARK_VOLUME},adelay=${endDelayMs}|${endDelayMs}[wmEnd];` +
    `[0:a][wmStart][wmEnd]amix=inputs=3:duration=first:dropout_transition=0`;

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i", cleanPath,
      "-i", WATERMARK_PATH,
      "-filter_complex", filter,
      // 320k CBR is the libmp3lame ceiling — the watermark mix is the LAST
      // lossy pass before users hear the song, so leave as much headroom as
      // mp3 allows. File size grows ~67% vs 192k (still a few MB per 3min
      // song) and bandwidth is negligible at this scale.
      "-c:a", "libmp3lame",
      "-b:a", "320k",
      outPath,
    ],
    { timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
}
