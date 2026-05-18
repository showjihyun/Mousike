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
