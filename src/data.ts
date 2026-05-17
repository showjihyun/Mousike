// ============================================================
// Mousike — Sample data
// Curated examples that look believable for a Korean creator AI BGM tool.
// ============================================================
import type {
  Generation,
  Palette,
  PopularItem,
  Preset,
  Song,
  StyleDef,
  VariationOptions,
  VariationType,
} from "./types";

export const PRESETS: Preset[] = [
  { id: "cafe",    emoji: "☕", title: "차분한 카페",   prompt: "잔잔한 어쿠스틱 카페 음악, 부드러운 기타", color: "#fef0e6" },
  { id: "study",   emoji: "📚", title: "집중 공부",     prompt: "로파이 비트, 낮은 BPM, 잔잔한 피아노",     color: "#e8f4f8" },
  { id: "vlog",    emoji: "🎬", title: "영상 BGM",     prompt: "밝은 브이로그 인트로, 어쿠스틱 기타, 가벼운 드럼", color: "#fde9f1" },
  { id: "sleep",   emoji: "🌙", title: "잠들기 좋은", prompt: "잔잔한 앰비언트, 부드러운 신디사이저",       color: "#e8e6f5" },
  { id: "drive",   emoji: "🚗", title: "드라이브",     prompt: "신스웨이브, 시티팝, 80년대 분위기",          color: "#fff3d6" },
  { id: "workout", emoji: "💪", title: "운동",         prompt: "에너제틱 EDM, 강한 드럼, 빠른 BPM",         color: "#e8f5ea" },
];

export const POPULAR: PopularItem[] = [
  { id: "p1", title: "여름 카페 오후",  user: "@youngwoo",   color1: "#ffd6a5", color2: "#ff7c5c", plays: "1.2k" },
  { id: "p2", title: "새벽 코딩 BGM",   user: "@dev_minji",  color1: "#cbb1f5", color2: "#7a5cf0", plays: "892" },
  { id: "p3", title: "한강 드라이브",   user: "@seoulvibes", color1: "#ffb1d8", color2: "#ff5c92", plays: "640" },
  { id: "p4", title: "ASMR 빗소리",    user: "@quietroom",  color1: "#b5d8ff", color2: "#5c8eff", plays: "1.8k" },
];

const STYLE_BANK: StyleDef[] = [
  { style: "Acoustic",  bpm: 88,  key: "C Major",  vibe: "차분함",   icons: ["acoustic-guitar", "piano"] },
  { style: "Lo-fi",     bpm: 78,  key: "A Minor",  vibe: "노스탤직", icons: ["headphones", "drum"] },
  { style: "Synth",     bpm: 96,  key: "F Major",  vibe: "꿈같음",   icons: ["sliders", "waves"] },
  { style: "Cinematic", bpm: 104, key: "D Minor",  vibe: "웅장함",   icons: ["music-2", "drum"] },
  { style: "K-Pop",     bpm: 118, key: "E Minor",  vibe: "활기참",   icons: ["mic-2", "drum"] },
  { style: "Jazz",      bpm: 92,  key: "Bb Major", vibe: "부드러움", icons: ["music", "piano"] },
  { style: "Ambient",   bpm: 64,  key: "G Major",  vibe: "고요함",   icons: ["waves", "circle"] },
  { style: "City Pop",  bpm: 110, key: "A Major",  vibe: "도시적",   icons: ["building", "sun"] },
];

const TITLE_TEMPLATES: Array<(p: string) => string> = [
  (p) => `${p} #01 — 차분한 오프닝`,
  (p) => `${p} #02 — 활기찬 버전`,
  (p) => `${p} #03 — 잔잔한 어레인지`,
  (p) => `${p} #04 — 시네마틱 톤`,
];

const GRADIENT_PALETTES: Palette[] = [
  ["#ffd6a5", "#ff7c5c"],
  ["#cbb1f5", "#7a5cf0"],
  ["#ffb1d8", "#ff5c92"],
  ["#b5d8ff", "#5c8eff"],
  ["#c8efb5", "#3eaa78"],
  ["#ffdfa1", "#f5a04b"],
  ["#d6c4b5", "#a37b5e"],
  ["#e6c7ff", "#9d6dd3"],
];

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Deterministic waveform pattern — bell-curve envelope with layered sine detail.
function waveformFor(seed: number, length = 56): number[] {
  const arr: number[] = [];
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const env = 0.55 + 0.45 * Math.sin(t * Math.PI);
    const det = Math.sin(t * 18 + seed * 0.13) * 0.35;
    const det2 = Math.sin(t * 47 + seed * 0.05) * 0.25;
    const noise = ((Math.sin(seed + i * 9.7) + 1) / 2) * 0.15;
    const v = Math.max(0.12, Math.min(1, env + det + det2 + noise));
    arr.push(v);
  }
  return arr;
}

let _genCounter = 0;

interface GenerateResultsOptions {
  salt?: number;
  genId?: string;
}

export function generateResults(prompt: string, options: GenerateResultsOptions = {}): Song[] {
  const seed = hashSeed(prompt || "default") + (options.salt || 0);
  // Backend currently returns 1 song per request; placeholder count matches.
  const stylesPicked: StyleDef[] = [STYLE_BANK[seed % STYLE_BANK.length]];
  const promptShort = (prompt || "음악").slice(0, 14);
  const genId = options.genId || `gen-${++_genCounter}-${seed}`;
  const durations = [165, 180, 142, 198];
  return stylesPicked.map((s, i) => ({
    id: `${genId}-s${i}`,
    genId,
    title: TITLE_TEMPLATES[i](promptShort),
    style: s.style,
    bpm: s.bpm,
    key: s.key,
    vibe: s.vibe,
    durationSec: durations[i],
    prompt,
    liked: false,
    waveform: waveformFor(seed + i, 56),
    instruments: i % 2 === 0 ? ["어쿠스틱 기타", "가벼운 드럼"] : ["피아노", "신디사이저"],
    palette: GRADIENT_PALETTES[(seed + i) % GRADIENT_PALETTES.length],
    createdAt: new Date(),
  }));
}

interface MakeGenerationArgs extends VariationOptions {
  id?: string;
  prompt: string;
}

export function makeGeneration({
  id,
  prompt,
  parentGenId = null,
  parentSongId = null,
  variationType = null,
}: MakeGenerationArgs): Generation {
  const genId = id || `gen-${++_genCounter}-${hashSeed(prompt + Math.random())}`;
  const salt = variationType === "restyle" ? 7 : variationType === "similar" ? 3 : variationType === "repaint" ? 11 : variationType === "lego" ? 5 : 0;
  const songs = generateResults(prompt, { genId, salt });
  return {
    id: genId,
    prompt,
    parentGenId,
    parentSongId,
    variationType,
    songs,
    palette: songs[0].palette,
    createdAt: new Date(),
  };
}

// Seed several historical generations so library has a believable tree on first load
export const SEED_GENERATIONS: Generation[] = (() => {
  const out: Generation[] = [];

  const g1 = makeGeneration({ prompt: "잔잔한 카페 음악, 어쿠스틱 기타" });
  g1.daysAgo = 3;
  g1.songs[0].liked = true;
  out.push(g1);

  const g2 = makeGeneration({
    prompt: "잔잔한 카페 음악 (K-pop 스타일)",
    parentGenId: g1.id,
    parentSongId: g1.songs[0].id,
    variationType: "restyle",
  });
  g2.daysAgo = 2;
  g2.songs[0].liked = true;
  out.push(g2);

  const g3 = makeGeneration({ prompt: "신나는 유튜브 인트로 30초" });
  g3.daysAgo = 1;
  g3.songs[0].liked = true;
  out.push(g3);

  const g4 = makeGeneration({ prompt: "ASMR 빗소리 + 부드러운 피아노" });
  g4.daysAgo = 7;
  out.push(g4);

  return out;
})();

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function daysAgoLabel(d: number): string {
  if (d === 0) return "오늘";
  if (d === 1) return "어제";
  if (d < 7) return `${d}일 전`;
  return `${Math.floor(d / 7)}주 전`;
}

// Re-export the variation type label map so components don't duplicate it.
export const VARIATION_LABELS: Record<VariationType, string> = {
  similar: "비슷한 분위기",
  restyle: "다른 스타일",
  repaint: "부분 수정",
  lego: "악기 변경",
};
