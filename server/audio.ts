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
export async function processAudio(containerPaths: string[]): Promise<string[]> {
  const watermarkedNames: string[] = [];
  for (const containerPath of containerPaths) {
    const stem = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanPath = join(AUDIO_SECURE_DIR, `${stem}.mp3`);
    const watermarkedPath = join(AUDIO_CACHE_DIR, `${stem}-wm.mp3`);
    try {
      await execFileAsync("docker", ["cp", `ace-step:${containerPath}`, cleanPath]);
      await mixWatermark(cleanPath, watermarkedPath);
      watermarkedNames.push(`${stem}-wm.mp3`);
    } catch (err) {
      await fsp.unlink(cleanPath).catch(() => {});
      await fsp.unlink(watermarkedPath).catch(() => {});
      throw err;
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
