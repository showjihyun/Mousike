import type { Generation } from "./types";

const BACKEND_URL = "http://localhost:8787";

export interface BackendSong {
  id: string;
  audioUrl: string;
  prompt: string;
  translatedCaption?: string;
}

export interface BackendResponse {
  songs: BackendSong[];
}

export type Lang = "KO" | "EN";

export async function generate(prompt: string, lang: Lang): Promise<BackendSong[]> {
  const res = await fetch(`${BACKEND_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ prompt, lang }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as BackendResponse;
  return data.songs;
}

export async function repaint(args: {
  sourceAudioUrl: string;
  startSec: number;
  endSec: number;
  caption?: string;
  parentSongId?: string;
}): Promise<BackendSong[]> {
  const res = await fetch(`${BACKEND_URL}/api/repaint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as BackendResponse;
  return data.songs;
}

interface RawGeneration extends Omit<Generation, "createdAt" | "songs"> {
  createdAt: string;
  songs: Array<Omit<Generation["songs"][number], "createdAt"> & { createdAt: string }>;
}

function reviveGeneration(raw: RawGeneration): Generation {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    songs: raw.songs.map((s) => ({ ...s, createdAt: new Date(s.createdAt) })),
  };
}

export async function fetchGenerations(): Promise<Generation[]> {
  const res = await fetch(`${BACKEND_URL}/api/generations`, { credentials: "include" });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  const data = (await res.json()) as { generations: RawGeneration[] };
  return data.generations.map(reviveGeneration);
}

export async function postGeneration(gen: Generation): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(gen),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
}

export interface Usage {
  used: number;
  limit: number | null;
  periodLabel: string;
  windowStart: string;
}

export async function fetchUsage(): Promise<Usage> {
  const res = await fetch(`${BACKEND_URL}/api/usage`, { credentials: "include" });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  return (await res.json()) as Usage;
}

export async function downloadCertBlob(songId: string): Promise<Blob> {
  const res = await fetch(`${BACKEND_URL}/api/cert/${songId}`, { credentials: "include" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  // Sanity check — if a proxy/captive portal hijacks the response with HTML,
  // we'd otherwise save the HTML as a .pdf and the user opens a broken file.
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("pdf")) {
    throw new Error("응답이 PDF가 아닙니다");
  }
  return res.blob();
}

export async function patchSongLiked(songId: string, liked: boolean): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/songs/${songId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ liked }),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
}

export async function lego(args: {
  sourceAudioUrl: string;
  instruments: string[];
  caption?: string;
  parentSongId?: string;
}): Promise<BackendSong[]> {
  const res = await fetch(`${BACKEND_URL}/api/lego`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as BackendResponse;
  return data.songs;
}
