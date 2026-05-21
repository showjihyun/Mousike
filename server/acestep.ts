// ACE-Step client. Speaks to the local Docker container via Gradio's HTTP API.
//
// The handler accepts a 50-element positional `data` array — most slots are
// constants we never tune, but a few vary per task. buildPayload centralises
// the shape so the route handlers don't each redeclare 50 items with three-
// element diffs.
import type { GradioSource } from "./audio.js";

const ACE_STEP_URL = "http://localhost:7860/gradio_api/call/generation_wrapper";
const BATCH_SIZE = 1;

// Submit is a cheap POST that should return within seconds. SSE poll covers
// the whole generation — Pro 3min songs need ~3min of GPU, so we allow 10min
// before declaring the container hung.
const SUBMIT_TIMEOUT_MS = 30_000;
const SSE_TIMEOUT_MS = 10 * 60_000;

export type AceStepRequest =
  | { task: "text2music"; caption: string; durationSec: number }
  | {
      task: "repaint";
      caption: string;
      durationSec: number;
      source: GradioSource;
      startSec: number;
      endSec: number;
    }
  | { task: "lego"; caption: string; durationSec: number; source: GradioSource };

// Empirically the handler needs 50 inputs, not the 45 the schema reports —
// positions 36 and 46-49 are hidden gr.State components, position 43 is a
// dropdown only used for lego/extract. Pass null for all hidden states.
function buildPayload(req: AceStepRequest): unknown[] {
  const source = req.task === "text2music" ? null : req.source;
  const repaintStart = req.task === "repaint" ? req.startSec : 0.0;
  const repaintEnd = req.task === "repaint" ? req.endSec : -1;

  return [
    req.caption,            // 0  Music Caption
    "",                     // 1  Lyrics
    0,                      // 2  BPM (0 = auto)
    "",                     // 3  KeyScale
    "",                     // 4  Time Signature
    "unknown",              // 5  Vocal Language
    50,                     // 6  DiT Inference Steps
    1.5,                    // 7  DiT Guidance Scale
    true,                   // 8  Random Seed
    "-1",                   // 9  Seed
    null,                   // 10 Reference Audio
    req.durationSec,        // 11 Audio Duration
    BATCH_SIZE,             // 12 Batch Size
    source,                 // 13 Source Audio
    "",                     // 14 LM Codes Hints
    repaintStart,           // 15 Repainting Start
    repaintEnd,             // 16 Repainting End
    "Fill the audio semantic mask based on the given conditions:", // 17 Instruction
    1.0,                    // 18 LM Codes Strength
    req.task,               // 19 Task Type
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
    null,                   // 36 hidden gr.State
    false,                  // 37 Constrained Decoding Debug
    true,                   // 38 ParallelThinking
    false,                  // 39 Auto Score
    false,                  // 40 Auto LRC
    0.5,                    // 41 Quality Score Sensitivity
    8,                      // 42 LM Batch Chunk Size
    null,                   // 43 Track Name (dropdown, lego/extract only)
    [],                     // 44 Track Names
    false,                  // 45 AutoGen
    null,                   // 46 hidden gr.State
    null,                   // 47 hidden gr.State
    null,                   // 48 hidden gr.State
    null,                   // 49 hidden gr.State
  ];
}

async function pollSse(eventId: string): Promise<string[]> {
  const res = await fetch(`${ACE_STEP_URL}/${eventId}`, {
    signal: AbortSignal.timeout(SSE_TIMEOUT_MS),
  });
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

  // The complete data payload is a large array. Index 8 is the list of
  // generated FileData objects (mp3 + json pairs).
  const payload = JSON.parse(lastDataLine) as unknown[];
  const fileList = payload[8] as Array<{ path: string; orig_name?: string; mime_type?: string | null }>;
  if (!Array.isArray(fileList)) throw new Error("Unexpected SSE result shape");

  const mp3Paths = fileList
    .filter((f) => f.path && f.path.endsWith(".mp3"))
    .map((f) => f.path);

  if (mp3Paths.length === 0) throw new Error("No MP3 paths in ACE-Step result");
  return mp3Paths;
}

// Single public entry. Submits, waits for completion, returns the list of
// container-side mp3 paths produced. Callers then `processAudio` to copy
// + watermark them.
export async function runAceStep(req: AceStepRequest): Promise<string[]> {
  const submitRes = await fetch(ACE_STEP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: buildPayload(req) }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!submitRes.ok) throw new Error(`ACE-Step submit error: ${submitRes.status}`);
  const { event_id } = (await submitRes.json()) as { event_id: string };
  return pollSse(event_id);
}
