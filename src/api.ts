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

export async function fetchCredits(): Promise<number> {
  const res = await fetch(`${BACKEND_URL}/api/credits`, { credentials: "include" });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  const data = (await res.json()) as { balance: number };
  return data.balance;
}

export async function patchCredits(balance: number): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/credits`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ balance }),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
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
