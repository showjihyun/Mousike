// Korean TTS via Microsoft Edge's free neural voices (edge-tts CLI). Used
// by the KO generation path (jobs.ts) when ACE-Step's vocal model can't
// reliably sing Korean phonemes — we synthesize the lyrics as spoken Korean
// and overlay onto an ACE-Step instrumental.
//
// ko-KR-SunHiNeural is the same voice we use for the watermark clip (see
// watermark.ts), so the dependency is already known to work in this env.
// edge-tts is installed on the host (Python CLI); the BE shells out.
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fsp } from "fs";

const execFileAsync = promisify(execFile);

const KR_VOICE = "ko-KR-SunHiNeural";
// edge-tts is a single REST round-trip to Microsoft's free endpoint. 60s
// covers a long lyrics blob + transient network blips.
const TTS_TIMEOUT_MS = 60_000;

// Synthesize Korean text to an mp3 at `outputPath`. Throws if the CLI fails
// or produces an empty file (the latter happens silently when the endpoint
// rejects the input).
export async function synthesizeKoreanTts(text: string, outputPath: string): Promise<void> {
  await execFileAsync(
    "edge-tts",
    ["--voice", KR_VOICE, "--text", text, "--write-media", outputPath],
    { timeout: TTS_TIMEOUT_MS },
  );
  const st = await fsp.stat(outputPath);
  if (st.size === 0) throw new Error(`edge-tts produced empty file at ${outputPath}`);
}
