import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_CACHE_DIR = join(__dirname, "audio-cache");
mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

const OLLAMA_URL = "http://localhost:11434/api/generate";
const ACE_STEP_URL = "http://localhost:7860/gradio_api/call/generation_wrapper";
const PORT = 8787;
const BATCH_SIZE = 4;

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
    8,                      // 6  DiT Inference Steps
    7.0,                    // 7  DiT Guidance Scale
    true,                   // 8  Random Seed
    "-1",                   // 9  Seed
    null,                   // 10 Reference Audio
    -1,                     // 11 Audio Duration (-1 = auto)
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

app.listen(PORT, () => {
  console.log(`Mousike server on :${PORT}`);
});
