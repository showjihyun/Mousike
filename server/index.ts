import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_CACHE_DIR = join(__dirname, "audio-cache");
mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

const OLLAMA_URL = "http://localhost:11434/api/generate";
const ACE_STEP_URL = "http://localhost:7860/gradio_api/call/generation_wrapper";
const PORT = 8787;
const BATCH_SIZE = 1;
// Sample length for free tier (seconds). Paid users will later be allowed 30s+.
const SAMPLE_DURATION_SEC = 30;

async function translateKoreanToEnglish(prompt: string): Promise<string> {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gemma2:2b",
      stream: false,
      system:
        "Translate Korean music descriptions to short English music captions, 5-10 words. Output ONLY the English translation. No quotes, no explanation, no extra words.",
      prompt,
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = (await res.json()) as { response: string };
  return data.response.trim();
}

async function generateMusic(caption: string): Promise<{ paths: string[] }> {
  // Empirically validated: the handler needs 50 inputs despite the API schema showing 45.
  // The 5 hidden gr.State components (at positions 36, 46-49) are not exposed in /gradio_api/info
  // but the handler requires them. Pass null for all hidden States.
  // Position 43 (Track Name) is a dropdown for lego/extract tasks — null for text2music.
  const data: unknown[] = [
    caption,                // 0  Music Caption
    "",                     // 1  Lyrics
    0,                      // 2  BPM (0 = auto)
    "",                     // 3  KeyScale
    "",                     // 4  Time Signature
    "unknown",              // 5  Vocal Language
    50,                     // 6  DiT Inference Steps (Base model — 50 for quality)
    7.0,                    // 7  DiT Guidance Scale
    true,                   // 8  Random Seed
    "-1",                   // 9  Seed
    null,                   // 10 Reference Audio
    SAMPLE_DURATION_SEC,    // 11 Audio Duration (free-tier sample length)
    BATCH_SIZE,             // 12 Batch Size
    null,                   // 13 Source Audio
    "",                     // 14 LM Codes Hints
    0.0,                    // 15 Repainting Start
    -1,                     // 16 Repainting End
    "Fill the audio semantic mask based on the given conditions:", // 17 Instruction
    1.0,                    // 18 LM Codes Strength
    "text2music",           // 19 Task Type
    false,                  // 20 Use ADG
    0.0,                    // 21 CFG Interval Start
    1.0,                    // 22 CFG Interval End
    3.0,                    // 23 Shift
    "ode",                  // 24 Inference Method
    "",                     // 25 Custom Timesteps
    "mp3",                  // 26 Audio Format
    0.85,                   // 27 LM Temperature
    true,                   // 28 Think
    2.0,                    // 29 LM CFG Scale
    0,                      // 30 LM Top-K
    0.9,                    // 31 LM Top-P
    "NO USER INPUT",        // 32 LM Negative Prompt
    true,                   // 33 CoT Metas
    true,                   // 34 CaptionRewrite
    true,                   // 35 CoT Language
    null,                   // 36 hidden gr.State (gap in API schema — not param_36)
    false,                  // 37 Constrained Decoding Debug
    true,                   // 38 ParallelThinking
    false,                  // 39 Auto Score
    false,                  // 40 Auto LRC
    0.5,                    // 41 Quality Score Sensitivity
    8,                      // 42 LM Batch Chunk Size
    null,                   // 43 Track Name (dropdown, only for lego/extract — null for text2music)
    [],                     // 44 Track Names
    false,                  // 45 AutoGen
    null,                   // 46 hidden gr.State
    null,                   // 47 hidden gr.State
    null,                   // 48 hidden gr.State
    null,                   // 49 hidden gr.State
  ];

  const submitRes = await fetch(ACE_STEP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!submitRes.ok) throw new Error(`ACE-Step submit error: ${submitRes.status}`);
  const { event_id } = (await submitRes.json()) as { event_id: string };

  const paths = await pollSse(event_id);
  return { paths };
}

async function pollSse(eventId: string): Promise<string[]> {
  const res = await fetch(`${ACE_STEP_URL}/${eventId}`);
  if (!res.ok) throw new Error(`ACE-Step poll error: ${res.status}`);
  if (!res.body) throw new Error("No SSE body");

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
          throw new Error(`ACE-Step generation error: ${lastDataLine}`);
        }
      }
    }

    if (lastEventType === "complete") break;
  }

  if (!lastDataLine) throw new Error("No data received from ACE-Step SSE");

  // The complete data payload is a large array.
  // Index 8 is the list of generated FileData objects (mp3 + json pairs).
  const payload = JSON.parse(lastDataLine) as unknown[];
  const fileList = payload[8] as Array<{ path: string; orig_name?: string; mime_type?: string | null }>;
  if (!Array.isArray(fileList)) throw new Error("Unexpected SSE result shape");

  const mp3Paths = fileList
    .filter((f) => f.path && f.path.endsWith(".mp3"))
    .map((f) => f.path);

  if (mp3Paths.length === 0) throw new Error("No MP3 paths in ACE-Step result");
  return mp3Paths;
}

async function copyAudioToCache(containerPaths: string[]): Promise<string[]> {
  const localPaths: string[] = [];
  for (const containerPath of containerPaths) {
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
    const localPath = join(AUDIO_CACHE_DIR, filename);
    await execFileAsync("docker", ["cp", `ace-step:${containerPath}`, localPath]);
    localPaths.push(filename);
  }
  return localPaths;
}

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());
app.use("/audio", express.static(AUDIO_CACHE_DIR));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/generate", async (req, res) => {
  const { prompt, lang } = req.body as { prompt?: unknown; lang?: unknown };

  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: "prompt must be a non-empty string" });
    return;
  }
  if (lang !== "KO" && lang !== "EN") {
    res.status(400).json({ error: "lang must be KO or EN" });
    return;
  }

  try {
    let caption = prompt.trim();
    let translatedCaption: string | undefined;

    if (lang === "KO") {
      translatedCaption = await translateKoreanToEnglish(caption);
      caption = translatedCaption;
    }

    console.log(`[generate] caption: "${caption}"`);

    const { paths } = await generateMusic(caption);
    const filenames = await copyAudioToCache(paths);

    const songs = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: `http://localhost:${PORT}/audio/${filename}`,
      prompt,
      ...(translatedCaption !== undefined && { translatedCaption }),
    }));

    res.json({ songs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate] error:", message);
    res.status(500).json({ error: message });
  }
});

const KO_TO_EN_INSTRUMENTS: Record<string, string> = {
  기타: "electric guitar",
  피아노: "piano",
  드럼: "drums",
  베이스: "bass",
  신디사이저: "synthesizer",
  보컬: "vocals",
};

async function uploadAudioToGradio(localPath: string): Promise<string> {
  const formData = new FormData();
  const fileBytes = await import("fs").then((fs) => fs.promises.readFile(localPath));
  const blob = new Blob([fileBytes], { type: "audio/mpeg" });
  formData.append("files", blob, basename(localPath));

  const res = await fetch("http://localhost:7860/gradio_api/upload", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw new Error(`Gradio upload error: ${res.status}`);
  const paths = (await res.json()) as string[];
  if (!paths[0]) throw new Error("Gradio upload returned no path");
  return paths[0];
}

function resolveAudioUrlToLocalPath(audioUrl: string): string {
  // e.g. http://localhost:8787/audio/1234-abcd.mp3 → AUDIO_CACHE_DIR/1234-abcd.mp3
  const filename = audioUrl.split("/audio/")[1];
  if (!filename) throw new Error(`Cannot resolve audio URL: ${audioUrl}`);
  return join(AUDIO_CACHE_DIR, filename);
}

app.post("/api/repaint", async (req, res) => {
  const { sourceAudioUrl, startSec, endSec, caption, parentSongId } = req.body as {
    sourceAudioUrl?: unknown;
    startSec?: unknown;
    endSec?: unknown;
    caption?: unknown;
    parentSongId?: unknown;
  };

  if (typeof sourceAudioUrl !== "string" || !sourceAudioUrl) {
    res.status(400).json({ error: "sourceAudioUrl must be a non-empty string" });
    return;
  }
  if (typeof startSec !== "number" || typeof endSec !== "number" || startSec >= endSec) {
    res.status(400).json({ error: "startSec and endSec must be numbers with startSec < endSec" });
    return;
  }

  try {
    const localPath = resolveAudioUrlToLocalPath(sourceAudioUrl);
    const gradioPath = await uploadAudioToGradio(localPath);
    const captionStr = typeof caption === "string" ? caption.trim() : "";

    console.log(`[repaint] ${startSec}s–${endSec}s caption="${captionStr}" src=${gradioPath}`);

    // Build base data array (same structure as generateMusic), then override for repaint
    const baseData: unknown[] = [
      captionStr,         // 0  Music Caption
      "",                 // 1  Lyrics
      0,                  // 2  BPM
      "",                 // 3  KeyScale
      "",                 // 4  Time Signature
      "unknown",          // 5  Vocal Language
      50,                 // 6  DiT Inference Steps
      7.0,                // 7  DiT Guidance Scale
      true,               // 8  Random Seed
      "-1",               // 9  Seed
      null,               // 10 Reference Audio
      SAMPLE_DURATION_SEC, // 11 Audio Duration (cap to free-tier sample length)
      BATCH_SIZE,         // 12 Batch Size
      { path: gradioPath, meta: { _type: "gradio.FileData" }, orig_name: basename(localPath), mime_type: "audio/mpeg" }, // 13 Source Audio
      "",                 // 14 LM Codes Hints
      startSec,           // 15 Repainting Start
      endSec,             // 16 Repainting End
      "Fill the audio semantic mask based on the given conditions:", // 17 Instruction
      1.0,                // 18 LM Codes Strength
      "repaint",          // 19 Task Type
      false,              // 20 Use ADG
      0.0,                // 21 CFG Interval Start
      1.0,                // 22 CFG Interval End
      3.0,                // 23 Shift
      "ode",              // 24 Inference Method
      "",                 // 25 Custom Timesteps
      "mp3",              // 26 Audio Format
      0.85,               // 27 LM Temperature
      true,               // 28 Think
      2.0,                // 29 LM CFG Scale
      0,                  // 30 LM Top-K
      0.9,                // 31 LM Top-P
      "NO USER INPUT",    // 32 LM Negative Prompt
      true,               // 33 CoT Metas
      true,               // 34 CaptionRewrite
      true,               // 35 CoT Language
      null,               // 36 hidden gr.State
      false,              // 37 Constrained Decoding Debug
      true,               // 38 ParallelThinking
      false,              // 39 Auto Score
      false,              // 40 Auto LRC
      0.5,                // 41 Quality Score Sensitivity
      8,                  // 42 LM Batch Chunk Size
      null,               // 43 Track Name
      [],                 // 44 Track Names
      false,              // 45 AutoGen
      null,               // 46 hidden gr.State
      null,               // 47 hidden gr.State
      null,               // 48 hidden gr.State
      null,               // 49 hidden gr.State
    ];

    const submitRes = await fetch(ACE_STEP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: baseData }),
    });
    if (!submitRes.ok) throw new Error(`ACE-Step submit error: ${submitRes.status}`);
    const { event_id } = (await submitRes.json()) as { event_id: string };

    const paths = await pollSse(event_id);
    const filenames = await copyAudioToCache(paths);

    const songs = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: `http://localhost:${PORT}/audio/${filename}`,
      prompt: captionStr || "부분 수정",
      ...(typeof parentSongId === "string" && { parentSongId }),
    }));

    res.json({ songs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[repaint] error:", message);
    res.status(500).json({ error: message });
  }
});

app.post("/api/lego", async (req, res) => {
  const { sourceAudioUrl, instruments, caption, parentSongId } = req.body as {
    sourceAudioUrl?: unknown;
    instruments?: unknown;
    caption?: unknown;
    parentSongId?: unknown;
  };

  if (typeof sourceAudioUrl !== "string" || !sourceAudioUrl) {
    res.status(400).json({ error: "sourceAudioUrl must be a non-empty string" });
    return;
  }
  if (!Array.isArray(instruments) || instruments.length === 0) {
    res.status(400).json({ error: "instruments must be a non-empty array" });
    return;
  }

  try {
    const localPath = resolveAudioUrlToLocalPath(sourceAudioUrl);
    const gradioPath = await uploadAudioToGradio(localPath);

    const englishInstruments = (instruments as string[]).map(
      (ko) => KO_TO_EN_INSTRUMENTS[ko] ?? ko,
    );
    const captionStr = typeof caption === "string" ? caption.trim() : "";
    const fullCaption = captionStr
      ? `add ${englishInstruments.join(", ")}, ${captionStr}`
      : `add ${englishInstruments.join(", ")}`;

    console.log(`[lego] caption="${fullCaption}" src=${gradioPath}`);

    const data: unknown[] = [
      fullCaption,        // 0  Music Caption
      "",                 // 1  Lyrics
      0,                  // 2  BPM
      "",                 // 3  KeyScale
      "",                 // 4  Time Signature
      "unknown",          // 5  Vocal Language
      50,                 // 6  DiT Inference Steps
      7.0,                // 7  DiT Guidance Scale
      true,               // 8  Random Seed
      "-1",               // 9  Seed
      null,               // 10 Reference Audio
      SAMPLE_DURATION_SEC, // 11 Audio Duration (cap to free-tier sample length)
      BATCH_SIZE,         // 12 Batch Size
      { path: gradioPath, meta: { _type: "gradio.FileData" }, orig_name: basename(localPath), mime_type: "audio/mpeg" }, // 13 Source Audio
      "",                 // 14 LM Codes Hints
      0.0,                // 15 Repainting Start (unused for lego)
      -1,                 // 16 Repainting End (unused for lego)
      "Fill the audio semantic mask based on the given conditions:", // 17 Instruction
      1.0,                // 18 LM Codes Strength
      "lego",             // 19 Task Type
      false,              // 20 Use ADG
      0.0,                // 21 CFG Interval Start
      1.0,                // 22 CFG Interval End
      3.0,                // 23 Shift
      "ode",              // 24 Inference Method
      "",                 // 25 Custom Timesteps
      "mp3",              // 26 Audio Format
      0.85,               // 27 LM Temperature
      true,               // 28 Think
      2.0,                // 29 LM CFG Scale
      0,                  // 30 LM Top-K
      0.9,                // 31 LM Top-P
      "NO USER INPUT",    // 32 LM Negative Prompt
      true,               // 33 CoT Metas
      true,               // 34 CaptionRewrite
      true,               // 35 CoT Language
      null,               // 36 hidden gr.State
      false,              // 37 Constrained Decoding Debug
      true,               // 38 ParallelThinking
      false,              // 39 Auto Score
      false,              // 40 Auto LRC
      0.5,                // 41 Quality Score Sensitivity
      8,                  // 42 LM Batch Chunk Size
      null,               // 43 Track Name
      [],                 // 44 Track Names
      false,              // 45 AutoGen
      null,               // 46 hidden gr.State
      null,               // 47 hidden gr.State
      null,               // 48 hidden gr.State
      null,               // 49 hidden gr.State
    ];

    const submitRes = await fetch(ACE_STEP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    if (!submitRes.ok) throw new Error(`ACE-Step submit error: ${submitRes.status}`);
    const { event_id } = (await submitRes.json()) as { event_id: string };

    const paths = await pollSse(event_id);
    const filenames = await copyAudioToCache(paths);

    const songs = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: `http://localhost:${PORT}/audio/${filename}`,
      prompt: fullCaption,
      ...(typeof parentSongId === "string" && { parentSongId }),
    }));

    res.json({ songs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[lego] error:", message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Mousike server on :${PORT}`);
});
