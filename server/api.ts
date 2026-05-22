// Per-user data endpoints. All require an authenticated session.
// Anonymous flows (generate, audio playback) are NOT routed through here.
import type { Express, Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { promises as fsp } from "fs";
import { join } from "path";
import multer from "multer";
import { getSupabase } from "./db.js";
import { requireAuth, type AuthUser } from "./auth.js";
import { readUsage, tierEpochsForTraining, tierVoiceCap } from "./quota.js";
import { renderCert } from "./cert.js";
import { AUDIO_CACHE_DIR, AUDIO_SECURE_DIR, fileExists } from "./audio.js";
import {
  ensureVoiceSampleDir,
  probeDurationSec,
  purgeVoiceSamples,
  voiceSampleRelative,
} from "./voice-storage.js";

interface SongPayload {
  id: string;
  title: string;
  style: string;
  bpm: number;
  key: string;
  vibe: string;
  durationSec: number;
  prompt: string;
  liked: boolean;
  waveform: number[];
  instruments: string[];
  palette: [string, string];
  audioUrl?: string;
  vocalLanguage?: "KO" | "EN" | "unknown";
  createdAt?: string;
}

interface GenerationPayload {
  id: string;
  prompt: string;
  parentGenId?: string | null;
  parentSongId?: string | null;
  variationType?: string | null;
  palette: [string, string];
  createdAt?: string;
  songs: SongPayload[];
}

function userId(req: Request): string {
  return (req.user as { id: string }).id;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Log the real error server-side, hand the client a generic message.
// Supabase + postgres errors otherwise leak schema and row details to anyone
// who can hit the endpoint.
function respondServerError(res: import("express").Response, label: string, err: unknown) {
  console.error(`[${label}] error:`, errorMessage(err));
  res.status(500).json({ error: `${label} failed` });
}

// Caller-supplied IDs are accepted (the schema is text-PK on purpose) but
// must look like the timestamp+random stems we mint client-side. Without
// this an attacker can plant rows under future-likely IDs to DoS another
// user's first generation of the day.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STR_MAX = 500;
const MAX_SONGS_PER_GEN = 8;
const MAX_WAVEFORM_BARS = 256;
const MAX_INSTRUMENTS = 16;
// Same shape /audio/<safe>.mp3 — must round-trip safely through
// audio.ts:resolveAudioUrlToLocalPath without picking up traversal chars.
const AUDIO_URL_PATTERN = /^https?:\/\/[^/]+\/audio\/[A-Za-z0-9._-]+\.mp3$/;

function isShortString(v: unknown): v is string {
  return typeof v === "string" && v.length <= STR_MAX;
}

function isPalette(v: unknown): v is [string, string] {
  return Array.isArray(v) && v.length === 2 && isShortString(v[0]) && isShortString(v[1]);
}

function validateGeneration(p: unknown): p is GenerationPayload {
  if (!p || typeof p !== "object") return false;
  const g = p as GenerationPayload;
  if (!ID_PATTERN.test(g.id ?? "")) return false;
  if (!isShortString(g.prompt)) return false;
  if (!isPalette(g.palette)) return false;
  if (g.parentGenId != null && !ID_PATTERN.test(g.parentGenId)) return false;
  if (g.parentSongId != null && !ID_PATTERN.test(g.parentSongId)) return false;
  if (!Array.isArray(g.songs) || g.songs.length === 0 || g.songs.length > MAX_SONGS_PER_GEN) {
    return false;
  }
  return g.songs.every(
    (s) =>
      s &&
      ID_PATTERN.test(s.id ?? "") &&
      isShortString(s.title) &&
      isShortString(s.style) &&
      isShortString(s.vibe) &&
      isShortString(s.key) &&
      isShortString(s.prompt) &&
      typeof s.bpm === "number" && Number.isFinite(s.bpm) &&
      typeof s.durationSec === "number" && Number.isFinite(s.durationSec) &&
      typeof s.liked === "boolean" &&
      Array.isArray(s.waveform) && s.waveform.length <= MAX_WAVEFORM_BARS
        && s.waveform.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      Array.isArray(s.instruments) && s.instruments.length <= MAX_INSTRUMENTS
        && s.instruments.every(isShortString) &&
      isPalette(s.palette) &&
      (s.audioUrl == null || (typeof s.audioUrl === "string" && AUDIO_URL_PATTERN.test(s.audioUrl))) &&
      (s.vocalLanguage == null || s.vocalLanguage === "KO" || s.vocalLanguage === "EN" || s.vocalLanguage === "unknown"),
  );
}

// snake_case row → camelCase client shape.
function toClientGeneration(row: Record<string, unknown>) {
  return {
    id: row.id,
    prompt: row.prompt,
    parentGenId: row.parent_gen_id,
    parentSongId: row.parent_song_id,
    variationType: row.variation_type,
    palette: row.palette,
    createdAt: row.created_at,
    songs: ((row.songs as Record<string, unknown>[]) ?? []).map(toClientSong),
  };
}

function toClientSong(row: Record<string, unknown>) {
  return {
    id: row.id,
    genId: row.gen_id,
    title: row.title,
    style: row.style,
    bpm: row.bpm,
    key: row.music_key,
    vibe: row.vibe,
    durationSec: row.duration_sec,
    prompt: row.prompt,
    liked: row.liked,
    waveform: row.waveform,
    instruments: row.instruments,
    palette: row.palette,
    audioUrl: row.audio_url ?? undefined,
    // NULL column → "unknown" (matches legacy-row contract from CONTEXT.md).
    vocalLanguage: row.vocal_language ?? "unknown",
    createdAt: row.created_at,
  };
}

export function mountApi(app: Express): void {
  // Force-resolve env config up-front so a missing-config server fails to mount,
  // matching mountAuth's behavior. Same try/catch in index.ts handles it.
  getSupabase();

  app.get("/api/generations", requireAuth, async (req, res) => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("generations")
        .select(
          "id, prompt, parent_gen_id, parent_song_id, variation_type, palette, created_at, " +
            "songs ( id, gen_id, title, style, bpm, music_key, vibe, duration_sec, prompt, " +
            "liked, waveform, instruments, palette, audio_url, vocal_language, created_at )",
        )
        .eq("user_id", userId(req))
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      res.json({ generations: rows.map(toClientGeneration) });
    } catch (err) {
      respondServerError(res, "GET /api/generations", err);
    }
  });

  app.post("/api/generations", requireAuth, async (req, res) => {
    if (!validateGeneration(req.body)) {
      res.status(400).json({ error: "invalid generation payload" });
      return;
    }
    const p = req.body;
    const uid = userId(req);
    const sb = getSupabase();

    try {
      const { error: genErr } = await sb.from("generations").insert({
        id: p.id,
        user_id: uid,
        prompt: p.prompt,
        parent_gen_id: p.parentGenId ?? null,
        parent_song_id: p.parentSongId ?? null,
        variation_type: p.variationType ?? null,
        palette: p.palette,
        ...(p.createdAt && { created_at: p.createdAt }),
      });
      if (genErr) throw genErr;

      const songRows = p.songs.map((s) => ({
        id: s.id,
        gen_id: p.id,
        user_id: uid,
        title: s.title,
        style: s.style,
        bpm: s.bpm,
        music_key: s.key,
        vibe: s.vibe,
        duration_sec: s.durationSec,
        prompt: s.prompt,
        liked: s.liked,
        waveform: s.waveform,
        instruments: s.instruments,
        palette: s.palette,
        audio_url: s.audioUrl ?? null,
        // "unknown" is stored as NULL — keeps the column meaning honest
        // ("we don't know") and matches read-side fallback in toClientSong.
        vocal_language: s.vocalLanguage && s.vocalLanguage !== "unknown" ? s.vocalLanguage : null,
        ...(s.createdAt && { created_at: s.createdAt }),
      }));
      const { error: songErr } = await sb.from("songs").insert(songRows);
      if (songErr) {
        // Best-effort cleanup of the orphaned generation row.
        await sb.from("generations").delete().eq("id", p.id);
        throw songErr;
      }

      res.status(201).json({ ok: true });
    } catch (err) {
      respondServerError(res, "POST /api/generations", err);
    }
  });

  app.delete("/api/generations/:id", requireAuth, async (req, res) => {
    try {
      const sb = getSupabase();
      const { error } = await sb
        .from("generations")
        .delete()
        .eq("id", req.params.id)
        .eq("user_id", userId(req));
      if (error) throw error;
      res.status(204).end();
    } catch (err) {
      respondServerError(res, "DELETE /api/generations", err);
    }
  });

  app.patch("/api/songs/:id", requireAuth, async (req, res) => {
    const { liked } = req.body as { liked?: unknown };
    if (typeof liked !== "boolean") {
      res.status(400).json({ error: "liked must be boolean" });
      return;
    }
    try {
      const sb = getSupabase();
      const { error } = await sb
        .from("songs")
        .update({ liked })
        .eq("id", req.params.id)
        .eq("user_id", userId(req));
      if (error) throw error;
      res.status(204).end();
    } catch (err) {
      respondServerError(res, "PATCH /api/songs", err);
    }
  });

  app.get("/api/usage", requireAuth, async (req, res) => {
    try {
      const u = req.user as AuthUser;
      const usage = await readUsage(u.id, u.tier);
      res.json(usage);
    } catch (err) {
      respondServerError(res, "GET /api/usage", err);
    }
  });

  // /api/credits removed — usage_log + readUsage is the source of truth.
  // The PATCH let any authenticated user set their own balance, which would
  // have been a footgun once anything actually depended on it.

  app.get("/api/cert/:songId", requireAuth, async (req, res) => {
    try {
      const user = req.user as AuthUser;
      const sb = getSupabase();
      const { data, error } = await sb
        .from("songs")
        .select("id, title, prompt, audio_url, created_at")
        .eq("id", String(req.params.songId ?? ""))
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: "song not found" });
        return;
      }
      const row = data as {
        id: string;
        title: string;
        prompt: string;
        audio_url: string | null;
        created_at: string;
      };
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="mousike-cert-${row.id}.pdf"`,
      );
      // Once we pipe, headers are committed and the response is in stream
      // mode — any pdfkit error here can't be turned into a 500. Kill the
      // socket so the client sees an aborted request instead of a silently
      // truncated "PDF".
      const stream = renderCert(user, {
        id: row.id,
        title: row.title,
        prompt: row.prompt,
        audioUrl: row.audio_url,
        createdAt: new Date(row.created_at),
      });
      stream.on("error", (err: unknown) => {
        console.error("[cert] stream error:", errorMessage(err));
        res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      console.error("[cert] error:", errorMessage(err));
      if (!res.headersSent) {
        res.status(500).json({ error: "certificate render failed" });
      }
    }
  });

  // Auth-gated mirror of /audio for downloads. Paid users get the un-
  // watermarked clean file from audio-secure; free users get the same
  // watermarked file they already hear from /audio. Free users can still
  // stream via the public /audio path; only this route sets Content-Disposition.
  app.get("/api/download/:filename", requireAuth, async (req, res) => {
    const filename = String(req.params.filename ?? "");
    if (!/^[A-Za-z0-9._-]+\.mp3$/.test(filename)) {
      res.status(400).json({ error: "invalid filename" });
      return;
    }
    const tier = (req.user as { tier?: string } | undefined)?.tier;
    const isPaid = tier === "starter" || tier === "pro";
    if (isPaid) {
      const cleanFilename = filename.replace(/-wm\.mp3$/, ".mp3");
      const cleanPath = join(AUDIO_SECURE_DIR, cleanFilename);
      if (await fileExists(cleanPath)) {
        res.download(cleanPath, cleanFilename);
        return;
      }
    }
    res.download(join(AUDIO_CACHE_DIR, filename), filename);
  });

  // --- Voice-clone endpoints (Phase 1 of the musicai-stack pivot) -----------
  // Upload writes raw samples to voice-samples/<uid>/<voiceId>/ on disk and
  // inserts a user_voices row in 'uploading' state. The train trigger
  // (POST /api/voices/:id/train) and the rvc_infer demo trigger live in
  // commit C — they need rvc.ts wired into the worker dispatch first.

  // 2-5 mp3/wav files, 30-180s total. Matches the musicai intake of "MR-less
  // pure vocal recordings, 2-3+ tracks" but extended for self-serve where
  // users might upload shorter individual takes.
  const VOICE_UPLOAD_MIN_FILES = 2;
  const VOICE_UPLOAD_MAX_FILES = 5;
  const VOICE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
  const VOICE_UPLOAD_MIN_SECONDS = 30;
  const VOICE_UPLOAD_MAX_SECONDS = 180;
  const VOICE_ALLOWED_EXTS = new Set([".mp3", ".wav"]);

  const voiceUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: VOICE_UPLOAD_MAX_FILES,
      fileSize: VOICE_UPLOAD_MAX_BYTES,
    },
  });

  // Multer errors arrive via next(err), not throw — wrap so they map to
  // 4xx instead of the default Express 500.
  function handleVoiceMulter(req: Request, res: Response, next: NextFunction): void {
    voiceUpload.array("files", VOICE_UPLOAD_MAX_FILES)(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") {
          res.status(413).json({
            error: `file too large (max ${VOICE_UPLOAD_MAX_BYTES / 1024 / 1024}MB per file)`,
          });
          return;
        }
        if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") {
          res.status(400).json({ error: `too many files (max ${VOICE_UPLOAD_MAX_FILES})` });
          return;
        }
        const msg = err instanceof Error ? err.message : "upload error";
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  }

  app.post("/api/voice-samples", requireAuth, handleVoiceMulter, async (req, res) => {
    const u = req.user as AuthUser;
    const displayName = String((req.body?.displayName as string | undefined) ?? "")
      .trim()
      .slice(0, 64);
    if (!displayName) {
      res.status(400).json({ error: "displayName required" });
      return;
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length < VOICE_UPLOAD_MIN_FILES) {
      res.status(400).json({ error: `at least ${VOICE_UPLOAD_MIN_FILES} files required` });
      return;
    }
    for (const f of files) {
      const ext = ("." + (f.originalname.split(".").pop() ?? "")).toLowerCase();
      if (!VOICE_ALLOWED_EXTS.has(ext)) {
        res.status(400).json({ error: `unsupported file type: ${ext}` });
        return;
      }
    }

    const cap = tierVoiceCap(u.tier);
    if (cap === 0) {
      res.status(402).json({ error: "voice cloning requires a paid tier" });
      return;
    }

    const voiceId = randomBytes(12).toString("hex");
    let writtenDir: string | null = null;

    try {
      const sb = getSupabase();
      // Tier cap — count rows that still "exist" from the user's POV.
      // 'failed' rows are ignored so a botched training doesn't permanently
      // consume a slot.
      const { count: existing, error: cntErr } = await sb
        .from("user_voices")
        .select("id", { count: "exact", head: true })
        .eq("user_id", u.id)
        .neq("status", "failed");
      if (cntErr) throw cntErr;
      if ((existing ?? 0) >= cap) {
        res.status(403).json({
          error: `voice cap reached (${cap}). delete an existing voice first.`,
        });
        return;
      }

      writtenDir = await ensureVoiceSampleDir(u.id, voiceId);
      const samplePaths: string[] = [];
      let totalSec = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const ext = ("." + (f.originalname.split(".").pop() ?? "")).toLowerCase();
        const filename = `sample-${i}${ext}`;
        const absPath = join(writtenDir, filename);
        await fsp.writeFile(absPath, f.buffer);
        totalSec += await probeDurationSec(absPath);
        samplePaths.push(voiceSampleRelative(u.id, voiceId, filename));
      }
      if (totalSec < VOICE_UPLOAD_MIN_SECONDS || totalSec > VOICE_UPLOAD_MAX_SECONDS) {
        await purgeVoiceSamples(u.id, voiceId);
        res.status(400).json({
          error: `total sample duration ${Math.round(totalSec)}s out of range ` +
            `${VOICE_UPLOAD_MIN_SECONDS}-${VOICE_UPLOAD_MAX_SECONDS}s`,
        });
        return;
      }

      const { error: insErr } = await sb.from("user_voices").insert({
        id: voiceId,
        user_id: u.id,
        display_name: displayName,
        sample_paths: samplePaths,
        sample_seconds: Math.round(totalSec),
        epochs: tierEpochsForTraining(u.tier),
        status: "uploading",
      });
      if (insErr) {
        await purgeVoiceSamples(u.id, voiceId);
        throw insErr;
      }
      res.status(201).json({
        voiceId,
        sampleSeconds: Math.round(totalSec),
        epochs: tierEpochsForTraining(u.tier),
        status: "uploading",
      });
    } catch (err) {
      if (writtenDir) await purgeVoiceSamples(u.id, voiceId);
      respondServerError(res, "POST /api/voice-samples", err);
    }
  });

  app.get("/api/voices", requireAuth, async (req, res) => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("user_voices")
        .select(
          "id, display_name, sample_seconds, epochs, status, error, created_at, trained_at",
        )
        .eq("user_id", userId(req))
        .order("created_at", { ascending: false });
      if (error) throw error;
      res.json({ voices: data ?? [] });
    } catch (err) {
      respondServerError(res, "GET /api/voices", err);
    }
  });

  app.get("/api/voices/:id", requireAuth, async (req, res) => {
    const vid = String(req.params.id ?? "");
    if (!/^[A-Za-z0-9]+$/.test(vid)) {
      res.status(400).json({ error: "invalid voice id" });
      return;
    }
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("user_voices")
        .select(
          "id, display_name, sample_seconds, epochs, status, error, created_at, trained_at",
        )
        .eq("id", vid)
        .eq("user_id", userId(req))
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: "voice not found" });
        return;
      }
      res.json(data);
    } catch (err) {
      respondServerError(res, "GET /api/voices/:id", err);
    }
  });
}
