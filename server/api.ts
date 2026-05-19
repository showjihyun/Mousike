// Per-user data endpoints. All require an authenticated session.
// Anonymous flows (generate, audio playback) are NOT routed through here.
import type { Express, Request } from "express";
import { existsSync } from "fs";
import { join } from "path";
import { getSupabase } from "./db.js";
import { requireAuth, type AuthUser } from "./auth.js";
import { readUsage } from "./quota.js";
import { renderCert } from "./cert.js";
import { AUDIO_CACHE_DIR, AUDIO_SECURE_DIR } from "./audio.js";

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
      (s.audioUrl == null || (typeof s.audioUrl === "string" && AUDIO_URL_PATTERN.test(s.audioUrl))),
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
            "liked, waveform, instruments, palette, audio_url, created_at )",
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
  app.get("/api/download/:filename", requireAuth, (req, res) => {
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
      if (existsSync(cleanPath)) {
        res.download(cleanPath, cleanFilename);
        return;
      }
    }
    res.download(join(AUDIO_CACHE_DIR, filename), filename);
  });
}
