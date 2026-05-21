export type VariationType = "similar" | "restyle" | "repaint" | "lego";

export type Stage = "idle" | "loading" | "results";

export type Page = "home" | "library";

export type Palette = [string, string];

export interface Preset {
  id: string;
  emoji: string;
  title: string;
  prompt: string;
  color: string;
}

export interface PopularItem {
  id: string;
  title: string;
  user: string;
  color1: string;
  color2: string;
  plays: string;
}

export interface StyleDef {
  style: string;
  bpm: number;
  key: string;
  vibe: string;
  icons: string[];
}

// Resolved vocal language: what the song actually sang in. "unknown" covers
// legacy songs (predating this field) — the chip is hidden for those.
export type VocalLanguage = "KO" | "EN" | "unknown";

export interface Song {
  id: string;
  genId: string;
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
  palette: Palette;
  createdAt: Date;
  audioUrl?: string;
  vocalLanguage?: VocalLanguage;
}

export interface Generation {
  id: string;
  prompt: string;
  parentGenId: string | null;
  parentSongId: string | null;
  variationType: VariationType | null;
  songs: Song[];
  palette: Palette;
  createdAt: Date;
  daysAgo?: number;
}

export interface VariationOptions {
  parentGenId?: string | null;
  parentSongId?: string | null;
  variationType?: VariationType | null;
}
