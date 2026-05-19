import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { mountAuth, requireAuth } from "./auth.js";
import { mountApi } from "./api.js";
import { logUsage, readUsage } from "./quota.js";
import { translateKoreanToEnglish } from "./ollama.js";
import { runAceStep } from "./acestep.js";
import { AUDIO_CACHE_DIR, prepareSourceForAceStep, processAudio } from "./audio.js";

const PORT = 8787;
const FREE_DURATION_SEC = 30;
const PAID_DURATION_SEC = 90;

const KO_TO_EN_INSTRUMENTS: Record<string, string> = {
  // 기본
  기타: "electric guitar",
  피아노: "piano",
  드럼: "drums",
  베이스: "bass",
  신디사이저: "synthesizer",
  보컬: "vocals",
  // 오케스트라
  바이올린: "violin",
  첼로: "cello",
  플루트: "flute",
  클라리넷: "clarinet",
  트럼펫: "trumpet",
  호른: "french horn",
  하프: "harp",
  팀파니: "timpani",
};

function durationForUser(user: Express.User | undefined): number {
  if (!user) return FREE_DURATION_SEC;
  return user.tier === "starter" || user.tier === "pro"
    ? PAID_DURATION_SEC
    : FREE_DURATION_SEC;
}

// Returns true if the user is under quota (or anonymous — anonymous traffic is
// gated by the IP rate limiter, not this function). On 'over quota', writes a
// 429 response itself so callers can simply `return` without further action.
async function requireQuota(req: express.Request, res: express.Response): Promise<boolean> {
  const user = req.user;
  if (!user) return true;
  const usage = await readUsage(user.id, user.tier);
  if (usage.limit !== null && usage.used >= usage.limit) {
    res.status(429).json({
      error: `${usage.periodLabel} 한도(${usage.limit})를 모두 사용했어요.`,
      usage,
    });
    return false;
  }
  return true;
}

// Anonymous spam guard. Authenticated callers also pass through, but the
// per-user quota check is the load-bearing one for them.
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "요청이 너무 많아요. 잠시 후 다시 시도해주세요." },
});

function audioUrl(filename: string): string {
  return `http://localhost:${PORT}/audio/${filename}`;
}

const app = express();
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(express.json());
app.use("/audio", express.static(AUDIO_CACHE_DIR));

try {
  mountAuth(app);
  mountApi(app);
} catch (err) {
  // Missing env vars: keep the server running so the free-tier flow still works,
  // but /auth/* and /api/{generations,songs,credits,download,usage,cert} will
  // 404 until the operator sets GOOGLE_*, SESSION_SECRET, SUPABASE_*.
  console.warn("[auth] disabled —", err instanceof Error ? err.message : err);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/generate", generateLimiter, async (req, res) => {
  const { prompt, lang } = req.body as { prompt?: unknown; lang?: unknown };

  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: "prompt must be a non-empty string" });
    return;
  }
  if (lang !== "KO" && lang !== "EN") {
    res.status(400).json({ error: "lang must be KO or EN" });
    return;
  }
  if (!(await requireQuota(req, res))) return;

  try {
    let caption = prompt.trim();
    let translatedCaption: string | undefined;
    if (lang === "KO") {
      translatedCaption = await translateKoreanToEnglish(caption);
      caption = translatedCaption;
    }
    console.log(`[generate] caption: "${caption}"`);

    const paths = await runAceStep({
      task: "text2music",
      caption,
      durationSec: durationForUser(req.user),
    });
    const filenames = await processAudio(paths);

    const songs = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt,
      ...(translatedCaption !== undefined && { translatedCaption }),
    }));

    if (req.user) await logUsage(req.user.id, "generate");
    res.json({ songs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate] error:", message);
    res.status(500).json({ error: message });
  }
});

app.post("/api/repaint", requireAuth, async (req, res) => {
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
  if (!(await requireQuota(req, res))) return;

  try {
    const source = await prepareSourceForAceStep(sourceAudioUrl);
    const captionStr = typeof caption === "string" ? caption.trim() : "";
    console.log(`[repaint] ${startSec}s–${endSec}s caption="${captionStr}" src=${source.path}`);

    const paths = await runAceStep({
      task: "repaint",
      caption: captionStr,
      durationSec: durationForUser(req.user),
      source,
      startSec,
      endSec,
    });
    const filenames = await processAudio(paths);

    const songs = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: captionStr || "부분 수정",
      ...(typeof parentSongId === "string" && { parentSongId }),
    }));

    if (req.user) await logUsage(req.user.id, "repaint");
    res.json({ songs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[repaint] error:", message);
    res.status(500).json({ error: message });
  }
});

app.post("/api/lego", requireAuth, async (req, res) => {
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
  if (!(await requireQuota(req, res))) return;

  try {
    const source = await prepareSourceForAceStep(sourceAudioUrl);
    const englishInstruments = (instruments as string[]).map(
      (ko) => KO_TO_EN_INSTRUMENTS[ko] ?? ko,
    );
    const captionStr = typeof caption === "string" ? caption.trim() : "";
    const fullCaption = captionStr
      ? `add ${englishInstruments.join(", ")}, ${captionStr}`
      : `add ${englishInstruments.join(", ")}`;
    console.log(`[lego] caption="${fullCaption}" src=${source.path}`);

    const paths = await runAceStep({
      task: "lego",
      caption: fullCaption,
      durationSec: durationForUser(req.user),
      source,
    });
    const filenames = await processAudio(paths);

    const songs = filenames.map((filename, i) => ({
      id: `${Date.now()}-${i}`,
      audioUrl: audioUrl(filename),
      prompt: fullCaption,
      ...(typeof parentSongId === "string" && { parentSongId }),
    }));

    if (req.user) await logUsage(req.user.id, "lego");
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
