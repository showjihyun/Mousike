// Per-user data endpoints. All require an authenticated session.
// Anonymous flows (generate, audio playback) are NOT routed through here.
import type { Express, Request } from "express";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getSupabase } from "./db.js";
import { requireAuth } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_CACHE_DIR = join(__dirname, "audio-cache");
const AUDIO_SECURE_DIR = join(__dirname, "audio-secure");

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

function validateGeneration(p: unknown): p is GenerationPayload {
  if (!p || typeof p !== "object") return false;
  const g = p as GenerationPayload;
  return (
    typeof g.id === "string" &&
    typeof g.prompt === "string" &&
    Array.isArray(g.palette) &&
    g.palette.length === 2 &&
    Array.isArray(g.songs) &&
    g.songs.every(
      (s) =>
        typeof s?.id === "string" &&
        typeof s.title === "string" &&
        typeof s.bpm === "number" &&
        typeof s.durationSec === "number" &&
        Array.isArray(s.waveform) &&
        Array.isArray(s.instruments) &&
        Array.isArray(s.palette),
    )
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
      res.status(500).json({ error: errorMessage(err) });
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
      res.status(500).json({ error: errorMessage(err) });
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
      res.status(500).json({ error: errorMessage(err) });
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
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.get("/api/credits", requireAuth, async (req, res) => {
    try {
      const sb = getSupabase();
      const { data, error } = await sb
        .from("credits")
        .select("balance")
        .eq("user_id", userId(req))
        .maybeSingle();
      if (error) throw error;
      res.json({ balance: data?.balance ?? 0 });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.patch("/api/credits", requireAuth, async (req, res) => {
    const { balance } = req.body as { balance?: unknown };
    if (typeof balance !== "number" || !Number.isInteger(balance) || balance < 0) {
      res.status(400).json({ error: "balance must be a non-negative integer" });
      return;
    }
    try {
      const sb = getSupabase();
      const { error } = await sb.from("credits").upsert({
        user_id: userId(req),
        balance,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
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
