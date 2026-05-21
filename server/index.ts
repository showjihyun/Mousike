import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { mountAuth, requireAuth } from "./auth.js";
import { mountApi } from "./api.js";
import { mountBilling } from "./billing.js";
import { readUsage } from "./quota.js";
import {
  enqueue,
  getJob,
  inFlightCountForUser,
  queuedDepth,
  countUsedPlusInFlight,
  recoverStaleRunning,
  startWorker,
  GLOBAL_QUEUE_CAP,
  PER_USER_INFLIGHT_CAP,
  type GeneratePayload,
  type RepaintPayload,
  type LegoPayload,
} from "./jobs.js";
import { AUDIO_CACHE_DIR } from "./audio.js";
import { ALL_GENRE_CATEGORIES, type GenreCategory } from "./genre.js";

const PORT = 8787;
const FREE_DURATION_SEC = 30;
const STARTER_DURATION_SEC = 90;
const PRO_DURATION_SEC = 180;

// Opt-in dev shortcut: skips quota + rate-limit + queue caps. Polarity is
// fail-safe — anyone deploying without setting MOUSIKE_DEV=1 gets the
// production behaviour (limits on). Don't switch this to a NODE_ENV
// negation; that would silently disable the limits on any deploy that
// forgets to set NODE_ENV.
const IS_DEV = process.env.MOUSIKE_DEV === "1";

// Caps caller-supplied text fields so a 10MB prompt can't be forwarded to
// Ollama → ACE-Step. express.json's 100KB default body limit also covers this,
// but the explicit cap fails fast with a useful message.
const MAX_PROMPT_CHARS = 500;
const MAX_LEGO_INSTRUMENTS = 16;

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

// Mirror quota.ts TIER_RULES. Duplicated by intent — quota.ts owns the
// "successful-only" usage view served via /api/usage; this is the
// enqueue-side gate that counts pending jobs too, so a user can't queue past
// their cap.
const TIER_WINDOW_MS: Record<string, number> = {
  free: 24 * 60 * 60 * 1000,
  starter: 30 * 24 * 60 * 60 * 1000,
  pro: 24 * 60 * 60 * 1000,
};
const TIER_LIMIT: Record<string, number | null> = {
  free: 3,
  starter: 30,
  pro: null,
};

function durationForUser(user: Express.User | undefined): number {
  if (!user) return FREE_DURATION_SEC;
  if (user.tier === "pro") return PRO_DURATION_SEC;
  if (user.tier === "starter") return STARTER_DURATION_SEC;
  return FREE_DURATION_SEC;
}

// Admission gate run before enqueue. Returns true if the request can be
// queued; writes the appropriate 4xx/5xx response and returns false otherwise.
// Anonymous traffic skips the per-user checks (their cap is the IP rate limit
// + client-side credits) but still respects the global queue cap.
async function admitJob(
  req: express.Request,
  res: express.Response,
): Promise<boolean> {
  if (IS_DEV) return true;
  const depth = await queuedDepth();
  if (depth >= GLOBAL_QUEUE_CAP) {
    res.status(503).json({ error: "지금 생성 요청이 너무 많아요. 잠시 후 다시 시도해주세요." });
    return false;
  }
  const user = req.user;
  if (!user) return true;
  const limit = TIER_LIMIT[user.tier];
  const windowMs = TIER_WINDOW_MS[user.tier] ?? TIER_WINDOW_MS.free;
  if (limit !== null) {
    const usedPlusInFlight = await countUsedPlusInFlight(user.id, windowMs);
    if (usedPlusInFlight >= limit) {
      const usage = await readUsage(user.id, user.tier);
      res.status(429).json({
        error: `${usage.periodLabel} 한도(${limit})를 모두 사용했어요.`,
        usage,
      });
      return false;
    }
  }
  const inFlight = await inFlightCountForUser(user.id);
  if (inFlight >= PER_USER_INFLIGHT_CAP) {
    res.status(429).json({
      error: `이미 ${PER_USER_INFLIGHT_CAP}개의 생성이 진행 중이에요. 완료된 후 다시 시도해주세요.`,
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
  skip: () => IS_DEV,
});

// Per-IP cap on the poll endpoint. Honest polling is once per 2s per job; this
// gives plenty of headroom for multiple concurrent polls while stopping a
// single client from running a tight CPU-burn loop against us.
const jobPollLimiter = rateLimit({
  windowMs: 1_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "요청이 너무 많아요. 잠시 후 다시 시도해주세요." },
  skip: () => IS_DEV,
});

const app = express();
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(express.json());
app.use("/audio", express.static(AUDIO_CACHE_DIR));

try {
  mountAuth(app);
  mountApi(app);
  mountBilling(app);
} catch (err) {
  // Missing env vars: keep the server running so the free-tier flow still works,
  // but /auth/* and /api/{generations,songs,credits,download,usage,cert} will
  // 404 until the operator sets GOOGLE_*, SESSION_SECRET, SUPABASE_*.
  console.warn("[auth] disabled —", err instanceof Error ? err.message : err);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 24 musical keys ACE-Step's KeyScale slot accepts. Mirrors src/types.ts MUSICAL_KEYS.
const VALID_KEYS = new Set<string>([
  "C Major","C Minor","C# Major","C# Minor","D Major","D Minor","D# Major","D# Minor",
  "E Major","E Minor","F Major","F Minor","F# Major","F# Minor","G Major","G Minor",
  "G# Major","G# Minor","A Major","A Minor","A# Major","A# Minor","B Major","B Minor",
]);

interface NormalizedAdvanced {
  genre: GenreCategory | "auto";
  bpm: number | "auto";
  key: string | "auto";
  durationSec: number | "auto";
}

// Validates the advanced settings blob from the FE. Returns an error string
// on first invalid field; returns the normalized settings otherwise. Missing
// blob → all-auto defaults so old FE clients still work.
function normalizeAdvanced(raw: unknown): NormalizedAdvanced | { error: string } {
  if (raw == null) return { genre: "auto", bpm: "auto", key: "auto", durationSec: "auto" };
  if (typeof raw !== "object") return { error: "advanced must be an object" };
  const r = raw as Record<string, unknown>;

  const genre = r.genre;
  if (genre !== undefined && genre !== "auto" && !ALL_GENRE_CATEGORIES.includes(genre as GenreCategory)) {
    return { error: `advanced.genre invalid` };
  }
  const bpm = r.bpm;
  if (bpm !== undefined && bpm !== "auto") {
    if (typeof bpm !== "number" || !Number.isFinite(bpm) || bpm < 60 || bpm > 180) {
      return { error: "advanced.bpm must be 60-180 or 'auto'" };
    }
  }
  const key = r.key;
  if (key !== undefined && key !== "auto") {
    if (typeof key !== "string" || !VALID_KEYS.has(key)) {
      return { error: "advanced.key invalid" };
    }
  }
  const durationSec = r.durationSec;
  if (durationSec !== undefined && durationSec !== "auto") {
    if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 15 || durationSec > 180) {
      return { error: "advanced.durationSec must be 15-180 or 'auto'" };
    }
  }
  return {
    genre: (genre as GenreCategory | "auto" | undefined) ?? "auto",
    bpm: (bpm as number | "auto" | undefined) ?? "auto",
    key: (key as string | "auto" | undefined) ?? "auto",
    durationSec: (durationSec as number | "auto" | undefined) ?? "auto",
  };
}

app.post("/api/generate", generateLimiter, async (req, res) => {
  const { prompt, lang, vocalLanguage, advanced } = req.body as {
    prompt?: unknown;
    lang?: unknown;
    vocalLanguage?: unknown;
    advanced?: unknown;
  };

  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: "prompt must be a non-empty string" });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `prompt must be ${MAX_PROMPT_CHARS} characters or fewer` });
    return;
  }
  if (lang !== "KO" && lang !== "EN") {
    res.status(400).json({ error: "lang must be KO or EN" });
    return;
  }
  // vocalLanguage is optional; default "auto" matches the FE control's default.
  const vl = vocalLanguage ?? "auto";
  if (vl !== "auto" && vl !== "KO" && vl !== "EN") {
    res.status(400).json({ error: "vocalLanguage must be auto, KO, or EN" });
    return;
  }
  const adv = normalizeAdvanced(advanced);
  if ("error" in adv) {
    res.status(400).json({ error: adv.error });
    return;
  }
  if (!(await admitJob(req, res))) return;

  // User-requested duration is capped at the tier's maximum so a free user
  // can't bypass the limit by sending durationSec=180 in the advanced blob.
  const tierMax = durationForUser(req.user);
  const resolvedDuration = adv.durationSec === "auto" ? tierMax : Math.min(adv.durationSec, tierMax);

  try {
    const payload: GeneratePayload = {
      prompt: prompt.trim(),
      lang,
      vocalLanguage: vl,
      durationSec: resolvedDuration,
      advancedGenre: adv.genre,
      advancedBpm: adv.bpm,
      advancedKey: adv.key,
    };
    const jobId = await enqueue(req.user?.id ?? null, "generate", payload);
    res.status(202).json({ jobId });
  } catch (err) {
    console.error("[generate] enqueue error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "enqueue failed" });
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
  if (typeof caption === "string" && caption.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `caption must be ${MAX_PROMPT_CHARS} characters or fewer` });
    return;
  }
  if (!(await admitJob(req, res))) return;

  try {
    const payload: RepaintPayload = {
      sourceAudioUrl,
      startSec,
      endSec,
      caption: typeof caption === "string" ? caption.trim() : "",
      ...(typeof parentSongId === "string" && { parentSongId }),
      durationSec: durationForUser(req.user),
    };
    const jobId = await enqueue(req.user?.id ?? null, "repaint", payload);
    res.status(202).json({ jobId });
  } catch (err) {
    console.error("[repaint] enqueue error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "enqueue failed" });
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
  if (instruments.length > MAX_LEGO_INSTRUMENTS || !instruments.every((it) => typeof it === "string")) {
    res.status(400).json({ error: "instruments must be 16 or fewer string entries" });
    return;
  }
  if (typeof caption === "string" && caption.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `caption must be ${MAX_PROMPT_CHARS} characters or fewer` });
    return;
  }
  if (!(await admitJob(req, res))) return;

  try {
    const englishInstruments = (instruments as string[]).map(
      (ko) => KO_TO_EN_INSTRUMENTS[ko] ?? ko,
    );
    const payload: LegoPayload = {
      sourceAudioUrl,
      instruments: englishInstruments,
      caption: typeof caption === "string" ? caption.trim() : "",
      ...(typeof parentSongId === "string" && { parentSongId }),
      durationSec: durationForUser(req.user),
    };
    const jobId = await enqueue(req.user?.id ?? null, "lego", payload);
    res.status(202).json({ jobId });
  } catch (err) {
    console.error("[lego] enqueue error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "enqueue failed" });
  }
});

// Polling endpoint. Anon callers pass no session and only match jobs they
// enqueued anonymously (jobId acts as the ownership token, 96 bits of entropy).
// Authed callers only match their own jobs.
app.get("/api/jobs/:id", jobPollLimiter, async (req, res) => {
  const jobId = String(req.params.id ?? "");
  // Tight regex matches the minter's exact output (24 hex chars from
  // crypto.randomBytes(12)). Looser patterns aren't exploitable thanks to
  // parameterized queries, but a precise check fails malformed requests
  // before they touch the DB.
  if (!/^[a-f0-9]{24}$/.test(jobId)) {
    res.status(400).json({ error: "invalid jobId" });
    return;
  }
  try {
    const view = await getJob(jobId, req.user?.id ?? null);
    if (!view) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    res.json(view);
  } catch (err) {
    console.error("[jobs] poll error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "job lookup failed" });
  }
});

// Boot-time recovery + worker start. Wrapped in try/catch so a missing
// Supabase config (auth-disabled mode) doesn't crash the server — the worker
// just stays offline until env is fixed.
void (async () => {
  try {
    const stale = await recoverStaleRunning();
    if (stale > 0) console.log(`[jobs] cleared ${stale} stale running job(s) from prior process`);
    startWorker();
  } catch (err) {
    console.warn("[jobs] worker disabled —", err instanceof Error ? err.message : err);
  }
})();

app.listen(PORT, () => {
  console.log(`Mousike server on :${PORT}`);
});
