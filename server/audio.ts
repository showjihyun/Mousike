// Filesystem + Gradio interop for audio files. Two-directory layout:
//   audio-cache/  watermarked, served publicly via /audio
//   audio-secure/ clean source, served only via /api/download for paid users
//                  and read directly when feeding ACE-Step (so derivatives
//                  don't get a doubled watermark).
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync, promises as fsp } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { mixWatermark } from "./watermark.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export const AUDIO_CACHE_DIR = join(__dirname, "audio-cache");
export const AUDIO_SECURE_DIR = join(__dirname, "audio-secure");
mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
mkdirSync(AUDIO_SECURE_DIR, { recursive: true });

const GRADIO_UPLOAD_URL = "http://localhost:7860/gradio_api/upload";

// Audio filenames are server-minted from Date.now() + Math.random — the only
// legal shapes are `<stem>.mp3` and `<stem>-wm.mp3`. SAFE_FILENAME is the
// security-load-bearing regex: do NOT loosen it without also revisiting
// resolveAudioUrlToLocalPath, which uses path.join on the captured name.
const SAFE_FILENAME = /^[A-Za-z0-9._-]+\.mp3$/;

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// The ACE-Step source-audio param accepts a Gradio FileData with this shape.
export interface GradioSource {
  path: string;
  meta: { _type: "gradio.FileData" };
  orig_name: string;
  mime_type: "audio/mpeg";
}

// Copies the model output out of the ace-step container into audio-secure
// as the clean file, then writes a watermarked sibling into audio-cache.
// Returns the watermarked filename (X-wm.mp3) — that's what's stored on the
// audioUrl returned to the client. If any step fails for a batch entry, both
// the clean and (partial) watermarked file are removed so they don't orphan.
//
// ACE-Step now outputs lossless flac (acestep.ts param 26), so we stage to a
// transient .flac next to audio-secure and ffmpeg-encode that to the final
// .mp3 — `cp flac → x.mp3` would leave audio-secure serving FLAC bytes
// labelled audio/mpeg via /api/download.
export async function processAudio(containerPaths: string[]): Promise<string[]> {
  const watermarkedNames: string[] = [];
  for (const containerPath of containerPaths) {
    const stem = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stagingFlac = join(AUDIO_SECURE_DIR, `_staging-${stem}.flac`);
    const cleanPath = join(AUDIO_SECURE_DIR, `${stem}.mp3`);
    const watermarkedPath = join(AUDIO_CACHE_DIR, `${stem}-wm.mp3`);
    try {
      await execFileAsync("docker", ["cp", `ace-step:${containerPath}`, stagingFlac]);
      await execFileAsync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-i", stagingFlac,
        "-codec:a", "libmp3lame", "-q:a", "0",
        cleanPath,
      ]);
      await mixWatermark(cleanPath, watermarkedPath);
      watermarkedNames.push(`${stem}-wm.mp3`);
    } catch (err) {
      await fsp.unlink(cleanPath).catch(() => {});
      await fsp.unlink(watermarkedPath).catch(() => {});
      throw err;
    } finally {
      await fsp.unlink(stagingFlac).catch(() => {});
    }
  }
  return watermarkedNames;
}

// Same as processAudio but the source is already a host-side file (e.g. the
// RVC infer output already copied out of its container by rvc.ts, or the
// YingMusic chain output from yingmusic.ts). Skips the docker cp and reads
// the host file directly, then unlinks the temp source on success so we
// don't accumulate orphan files.
//
// The host source may be wav (YingMusic) or mp3 (legacy). We re-encode via
// ffmpeg into the .mp3-named clean file so the bytes match the extension —
// `cp wav → x.mp3` would leave audio-secure serving WAV bytes labelled
// audio/mpeg via /api/download. -q:a 2 is ~190 kbps VBR, transparent for
// the chain's BigVGAN output.
export async function processAudioFromHost(hostPaths: string[]): Promise<string[]> {
  const watermarkedNames: string[] = [];
  for (const hostPath of hostPaths) {
    const stem = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanPath = join(AUDIO_SECURE_DIR, `${stem}.mp3`);
    const watermarkedPath = join(AUDIO_CACHE_DIR, `${stem}-wm.mp3`);
    try {
      await execFileAsync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-i", hostPath,
        // -q:a 0 is libmp3lame's highest-quality VBR (~245 kbps avg, near
        // transparent vs the source wav). The audio-secure file is what
        // /api/download serves to paid users AND what mixWatermark reads as
        // input — so the watermarked /audio stream inherits this quality too.
        "-codec:a", "libmp3lame", "-q:a", "0",
        cleanPath,
      ]);
      await mixWatermark(cleanPath, watermarkedPath);
      await fsp.unlink(hostPath).catch(() => {});
      watermarkedNames.push(`${stem}-wm.mp3`);
    } catch (err) {
      await fsp.unlink(cleanPath).catch(() => {});
      await fsp.unlink(watermarkedPath).catch(() => {});
      throw err;
    }
  }
  return watermarkedNames;
}

// Mix Korean TTS audio over each ACE-Step instrumental output. Used by the
// KO generation path — ACE-Step can't reliably sing Korean phonemes, so we
// generate an instrumental from it and overlay edge-tts ko-KR speech.
//
// Polish recipe (empirically tuned, user-approved):
//   1. HPF + EQ on TTS to cut mud + boost presence
//   2. Light compressor for consistent vocal level
//   3. Two-tap aecho for spatial cohesion with the music
//   4. Side-chain ducking on the instrumental so the voice cuts through
//   5. Limiter to prevent clipping
//   6. -q:a 0 mp3 (audio-secure) → watermark
//
// 2-second `adelay` gives the song time to establish before the voice enters,
// matching the "spoken word over music" UX.
export async function processAudioWithTtsOverlay(
  containerPaths: string[],
  ttsHostPath: string,
): Promise<string[]> {
  const watermarkedNames: string[] = [];
  for (const containerPath of containerPaths) {
    const stem = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stagingInstr = join(AUDIO_SECURE_DIR, `_staging-${stem}.flac`);
    const cleanPath = join(AUDIO_SECURE_DIR, `${stem}.mp3`);
    const watermarkedPath = join(AUDIO_CACHE_DIR, `${stem}-wm.mp3`);
    try {
      await execFileAsync("docker", ["cp", `ace-step:${containerPath}`, stagingInstr]);
      await execFileAsync("ffmpeg", [
        "-y", "-loglevel", "error",
        "-i", stagingInstr,
        "-i", ttsHostPath,
        "-filter_complex",
          // TTS chain: clean low-end, lift presence, light compressor for
          // consistency, two-tap echo for spatial match with the music,
          // boost +3.2x, 2s delay (so the song establishes before voice
          // enters). Static ducking on the instrumental (0.45x) — the
          // earlier sidechaincompress recipe truncated the output to the
          // sidechain (TTS) length, which made every song end when the
          // voice ended. Static ducking sacrifices the breathing effect
          // for predictable full-length playback.
          "[1:a]highpass=f=120," +
          "equalizer=f=200:width_type=q:width=1:g=-3," +
          "equalizer=f=2800:width_type=q:width=1:g=4," +
          "acompressor=threshold=-18dB:ratio=3:attack=5:release=80," +
          "aecho=0.7:0.85:60|180:0.4|0.2," +
          "aecho=0.6:0.7:300|650:0.25|0.15," +
          "volume=3.2,adelay=2000|2000[vmix];" +
          "[0:a]volume=0.45[mducked];" +
          "[mducked][vmix]amix=inputs=2:duration=first:dropout_transition=0,volume=1.4,alimiter=limit=0.95",
        "-codec:a", "libmp3lame", "-q:a", "0",
        cleanPath,
      ]);
      await mixWatermark(cleanPath, watermarkedPath);
      watermarkedNames.push(`${stem}-wm.mp3`);
    } catch (err) {
      await fsp.unlink(cleanPath).catch(() => {});
      await fsp.unlink(watermarkedPath).catch(() => {});
      throw err;
    } finally {
      await fsp.unlink(stagingInstr).catch(() => {});
    }
  }
  return watermarkedNames;
}

// Repaint/lego accept an audioUrl that points at /audio/...-wm.mp3. We feed
// ACE-Step the matching clean file from audio-secure if it exists, otherwise
// fall back to audio-cache (pre-watermark legacy songs). Validates the
// filename component against SAFE_FILENAME — without this, a request body
// of "http://x/audio/../../etc/passwd" would resolve outside the audio dirs
// and get uploaded to Gradio (auth'd arbitrary local-file read).
async function resolveAudioUrlToLocalPath(audioUrl: string): Promise<string> {
  const filename = audioUrl.split("/audio/")[1];
  if (!filename || !SAFE_FILENAME.test(filename)) {
    throw new Error(`invalid audio url: ${audioUrl}`);
  }
  const cleanFilename = filename.replace(/-wm\.mp3$/, ".mp3");
  // cleanFilename derives from filename via a fixed-suffix replacement —
  // can't introduce traversal characters that weren't already there.
  const securePath = join(AUDIO_SECURE_DIR, cleanFilename);
  if (await fileExists(securePath)) return securePath;
  return join(AUDIO_CACHE_DIR, filename);
}

async function uploadFileToGradio(localPath: string): Promise<string> {
  const fileBytes = await fsp.readFile(localPath);
  const blob = new Blob([fileBytes], { type: "audio/mpeg" });
  const formData = new FormData();
  formData.append("files", blob, basename(localPath));
  const res = await fetch(GRADIO_UPLOAD_URL, { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Gradio upload error: ${res.status}`);
  const paths = (await res.json()) as string[];
  if (!paths[0]) throw new Error("Gradio upload returned no path");
  return paths[0];
}

// Combines the two steps callers always do back-to-back: resolve the local
// path for a stored audioUrl, then hand it to Gradio so ACE-Step can read it.
export async function prepareSourceForAceStep(audioUrl: string): Promise<GradioSource> {
  const localPath = await resolveAudioUrlToLocalPath(audioUrl);
  const gradioPath = await uploadFileToGradio(localPath);
  return {
    path: gradioPath,
    meta: { _type: "gradio.FileData" },
    orig_name: basename(localPath),
    mime_type: "audio/mpeg",
  };
}
