// ACE-Step client. Speaks to the local Docker container via Gradio's HTTP API.
//
// The handler accepts a 50-element positional `data` array — most slots are
// constants we never tune, but a few vary per task. buildPayload centralises
// the shape so the route handlers don't each redeclare 50 items with three-
// element diffs.
import kroman from "kroman";
import type { GradioSource } from "./audio.js";

// Hangul codepoint range — fast detector. Skip romanization for fully-ASCII
// lyrics so English songs stay verbatim.
const HANGUL_REGEX = /[가-힯ᄀ-ᇿ㄰-㆏]/;

// Pre-process Korean lyrics into Revised Romanization. ACE-Step's vocal
// model produces unintelligible phonemes when fed hangul syllables directly
// — its tokenizer/phoneme path is built around Latin-letter spellings.
// Sending "saranghae" instead of "사랑해" turns the same audio model into a
// recognisable Korean singer. The DB still stores the user's original
// hangul; only the version going to the model is romanized.
//
// kroman returns hyphen-separated syllables ("sa-rang-hae"); we strip the
// hyphens since the model sings on whole-word phonemes, not syllable beats,
// and the hyphens were producing audible micro-pauses in PoC tests.
function romanizeHangul(text: string): string {
  return kroman.parse(text).replace(/-/g, "");
}

const ACE_STEP_URL = "http://localhost:7860/gradio_api/call/generation_wrapper";
// Pre-formatting endpoint — LM normalizes user-supplied lyrics into the
// section-tagged / syllable-aligned form ACE-Step's downstream vocal model
// was actually trained on. The Gradio UI calls this when the user clicks
// "Format Lyrics (LM)" before generate. For Korean (and other languages
// underrepresented in the vocal-model training set) this is the difference
// between mumbled phonemes and recognisable words.
const FORMAT_LYRICS_URL = "http://localhost:7860/gradio_api/call/lambda_11";
const BATCH_SIZE = 1;

// Submit is a cheap POST that should return within seconds. SSE poll covers
// the whole generation — Pro 3min songs need ~3min of GPU, so we allow 10min
// before declaring the container hung.
const SUBMIT_TIMEOUT_MS = 30_000;
const SSE_TIMEOUT_MS = 10 * 60_000;

// Vocal-language hint passed to ACE-Step's slot 5 ("Vocal Language"). ISO 639-1
// codes (verified via the upstream cli.py example: "Vocal language (e.g., 'en',
// 'zh', 'unknown')"). "unknown" tells the model to infer / not bias.
export type AceVocalLanguageCode = "ko" | "en" | "unknown";

export type AceStepRequest =
  | {
      task: "text2music";
      caption: string;
      durationSec: number;
      vocalLanguageCode: AceVocalLanguageCode;
      // Optional 고급-menu overrides. When omitted, defaults are slot 2 = 0
      // (auto), slot 3 = "" (auto), slot 1 = "" (no lyrics → instrumental);
      // ACE-Step's LM picks BPM/key then and sings improvised vowels.
      bpm?: number;
      key?: string;
      lyrics?: string;
    }
  | {
      task: "repaint";
      caption: string;
      durationSec: number;
      source: GradioSource;
      startSec: number;
      endSec: number;
      vocalLanguageCode: AceVocalLanguageCode;
    }
  | { task: "lego"; caption: string; durationSec: number; source: GradioSource; vocalLanguageCode: AceVocalLanguageCode };

// Empirically the handler needs 50 inputs, not the 45 the schema reports —
// positions 36 and 46-49 are hidden gr.State components, position 43 is a
// dropdown only used for lego/extract. Pass null for all hidden states.
function buildPayload(req: AceStepRequest): unknown[] {
  const source = req.task === "text2music" ? null : req.source;
  const repaintStart = req.task === "repaint" ? req.startSec : 0.0;
  const repaintEnd = req.task === "repaint" ? req.endSec : -1;
  const bpm = req.task === "text2music" ? (req.bpm ?? 0) : 0;
  const keyScale = req.task === "text2music" ? (req.key ?? "") : "";
  const lyrics = req.task === "text2music" ? (req.lyrics ?? "") : "";

  return [
    req.caption,            // 0  Music Caption
    lyrics,                 // 1  Lyrics ("" = instrumental, 고급 override otherwise)
    bpm,                    // 2  BPM (0 = auto, 고급 override otherwise)
    keyScale,               // 3  KeyScale ("" = auto, 고급 override otherwise)
    "",                     // 4  Time Signature
    req.vocalLanguageCode,  // 5  Vocal Language (ISO 639-1: "ko" | "en" | "unknown")
    50,                     // 6  DiT Inference Steps
    7.0,                    // 7  DiT Guidance Scale — matches ACE-Step's own
                            // UI default. Our prior 1.5 was way under and
                            // produced loose lyric adherence (Korean phonemes
                            // mumbled). Higher guidance pushes the DiT to
                            // honor caption + Lyrics + KeyScale more strictly.
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
    "flac",                 // 26 Audio Format — ACE-Step's only lossless
                            // option (the dropdown is 'mp3' | 'flac', no
                            // wav). Eliminates the first lossy pass so the
                            // chain (BR Separator → YingMusic) and the final
                            // libmp3lame encode don't compound on top of an
                            // already-lossy 128k mp3.
    0.5,                    // 27 LM Temperature — lowered from default 0.85.
                            // Lower temp = LM picks more predictable phoneme
                            // sequences for the lyrics, helps Korean syllables
                            // come out as the LM "thinks they should" rather
                            // than creative variations.
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

async function pollSseRaw(baseUrl: string, eventId: string): Promise<unknown[]> {
  const res = await fetch(`${baseUrl}/${eventId}`, {
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
  return JSON.parse(lastDataLine) as unknown[];
}

async function pollSse(eventId: string): Promise<string[]> {
  const payload = await pollSseRaw(ACE_STEP_URL, eventId);

  // The complete data payload is a large array. Index 8 is the list of
  // generated FileData objects (flac + json pairs).
  const fileList = payload[8] as Array<{ path: string; orig_name?: string; mime_type?: string | null }>;
  if (!Array.isArray(fileList)) throw new Error("Unexpected SSE result shape");

  const flacPaths = fileList
    .filter((f) => f.path && f.path.endsWith(".flac"))
    .map((f) => f.path);

  if (flacPaths.length === 0) throw new Error("No FLAC paths in ACE-Step result");
  return flacPaths;
}

// LM-side normalization of free-form lyrics into the section-tagged form
// ACE-Step's vocal model expects. The Gradio UI calls this when the user
// clicks "Format Lyrics (LM)". /lambda_11 returns 8 fields: [caption, lyrics,
// bpm, durationSec, keyScale, vocalLang, timeSig, status]. We only consume
// the lyrics field — caption/BPM/Key/VocalLang stay user-controlled.
async function formatLyrics(caption: string, lyrics: string, durationSec: number): Promise<string> {
  const payload = [
    caption,        // 0 Music Caption
    lyrics,         // 1 Lyrics
    null,           // 2 BPM (let LM decide internally; we don't consume it)
    durationSec,    // 3 Audio Duration
    "",             // 4 KeyScale
    "",             // 5 Time Signature
    0.5,            // 6 LM Temperature (matches generation_wrapper slot 27)
    0,              // 7 LM Top-K
    0.9,            // 8 LM Top-P
    false,          // 9 Constrained Decoding Debug
  ];
  const submitRes = await fetch(FORMAT_LYRICS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: payload }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!submitRes.ok) throw new Error(`ACE-Step format-lyrics submit error: ${submitRes.status}`);
  const { event_id } = (await submitRes.json()) as { event_id: string };
  const out = await pollSseRaw(FORMAT_LYRICS_URL, event_id);
  const formatted = out[1];
  if (typeof formatted !== "string" || formatted.trim() === "") {
    throw new Error("format-lyrics returned empty lyrics");
  }
  return formatted;
}

// Single public entry. Submits, waits for completion, returns the list of
// container-side flac paths produced. Callers then `processAudio` to copy
// + watermark them.
//
// For text2music requests with non-empty lyrics, we run a pre-format pass
// through /lambda_11 first — the vocal model produces noticeably more
// intelligible non-English phonemes when fed LM-normalized lyrics. Failure
// in the format pass degrades to the raw lyrics rather than failing the job.
export async function runAceStep(req: AceStepRequest): Promise<string[]> {
  let effectiveReq = req;
  // Lyrics preprocessing for text2music. Two passes in order:
  //   1. Hangul → romaja (always when Korean detected; the user's hangul
  //      survives only at the DB layer, not in the model input)
  //   2. /lambda_11 format-lyrics (opt-in via MOUSIKE_FORMAT_LYRICS=1 —
  //      default off because the 5Hz LM init mode in our container hits a
  //      CUDA/CPU device-mismatch and returns garbage. Re-enable once the
  //      container is re-initialized with `Offload to CPU=False`.)
  if (req.task === "text2music" && req.lyrics && req.lyrics.trim() !== "") {
    let lyrics = req.lyrics;
    if (HANGUL_REGEX.test(lyrics)) {
      const romanized = romanizeHangul(lyrics);
      console.log(`[acestep] hangul→romaja: ${lyrics.length}→${romanized.length}chars`);
      lyrics = romanized;
    }
    const formatLyricsEnabled = process.env.MOUSIKE_FORMAT_LYRICS === "1";
    if (formatLyricsEnabled) {
      try {
        const formatted = await formatLyrics(req.caption, lyrics, req.durationSec);
        console.log(`[acestep] format-lyrics: ${lyrics.length}→${formatted.length}chars`);
        lyrics = formatted;
      } catch (e) {
        console.warn(`[acestep] format-lyrics failed, using prior lyrics: ${e instanceof Error ? e.message : e}`);
      }
    }
    effectiveReq = { ...req, lyrics };
  }
  const submitRes = await fetch(ACE_STEP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: buildPayload(effectiveReq) }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!submitRes.ok) throw new Error(`ACE-Step submit error: ${submitRes.status}`);
  const { event_id } = (await submitRes.json()) as { event_id: string };
  return pollSse(event_id);
}
