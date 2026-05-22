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

// Mirror of server/genre.ts GenreCategory. Kept in sync manually; the validator
// in server/index.ts is the source of truth.
export type GenreCategory =
  | "anime" | "pop" | "hiphop" | "rock" | "rnb"
  | "kpop" | "ballad" | "trot" | "electronic";

export const ALL_GENRES: ReadonlyArray<{ value: GenreCategory; label: string }> = [
  { value: "kpop", label: "K-Pop" },
  { value: "pop", label: "Pop" },
  { value: "ballad", label: "발라드" },
  { value: "rnb", label: "R&B" },
  { value: "hiphop", label: "Hip-hop" },
  { value: "rock", label: "Rock" },
  { value: "electronic", label: "Electronic" },
  { value: "trot", label: "트로트" },
  { value: "anime", label: "Anime/J-Pop" },
];

// Optional power-user overrides surfaced via the 고급 menu. Any field set to
// "auto" defers to the existing default behavior (keyword genre detection,
// auto BPM/key, tier-default duration). `lyrics` is `""` by default (empty =
// instrumental, today's behavior); non-empty populates ACE-Step slot 1.
export interface AdvancedSettings {
  genre: GenreCategory | "auto";
  bpm: number | "auto";       // 60-180 inclusive when set
  key: string | "auto";       // e.g. "C Major"; one of MUSICAL_KEYS when set
  durationSec: number | "auto"; // capped by tier on submit
  lyrics: string;             // empty = instrumental; supports [Verse]/[Chorus]/[Bridge] tags
}

export const LYRICS_MAX_LEN = 2000;

export const DEFAULT_ADVANCED: AdvancedSettings = {
  genre: "auto",
  bpm: "auto",
  key: "auto",
  durationSec: "auto",
  lyrics: "",
};

const KEY_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const MUSICAL_KEYS: readonly string[] = KEY_ROOTS.flatMap((r) => [`${r} Major`, `${r} Minor`]);

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
