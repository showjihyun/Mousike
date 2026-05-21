// Keyword-based genre detection. Scans the user's prompt for KO/EN trigger
// words and returns an English style tag that biases AceStep toward the
// matched category. Rules are ordered specific-first so e.g. "K-pop" beats
// the generic "pop" rule.

export type GenreCategory =
  | "anime"
  | "pop"
  | "hiphop"
  | "rock"
  | "rnb"
  | "kpop"
  | "ballad"
  | "trot"
  | "electronic";

export interface GenreMatch {
  category: GenreCategory;
  label: string;
  tag: string;
}

interface GenreRule extends GenreMatch {
  keywords: string[];
}

// Tag order follows the ACE-Step convention: genre, instruments, mood, tempo.
// 5-6 tags per profile keeps the model anchored without contradictions.
// Mix/quality words live in QUALITY_SUFFIX, not here, so they apply uniformly.
const RULES: GenreRule[] = [
  {
    category: "kpop",
    label: "K-Pop",
    tag: "K-pop, layered vocals, synth bass, punchy drums, energetic, 110 BPM",
    keywords: ["k-pop", "kpop", "k팝", "k-팝", "케이팝", "아이돌", "idol", "걸그룹", "보이그룹"],
  },
  {
    category: "hiphop",
    label: "Hip-hop",
    tag: "hip-hop, 808 sub bass, crisp hi-hats, confident, 90 BPM",
    keywords: ["힙합", "hiphop", "hip-hop", "rap", "랩"],
  },
  {
    category: "rnb",
    label: "R&B/Soul",
    tag: "R&B, smooth vocals, electric piano, soft drums, sensual, 75 BPM",
    keywords: ["r&b", "rnb", "r and b", "알앤비", "소울", "soul"],
  },
  {
    category: "trot",
    label: "Trot",
    tag: "Korean trot, accordion, synth brass, vocal bends, nostalgic, 105 BPM",
    keywords: ["트로트", "trot", "뽕짝"],
  },
  {
    category: "ballad",
    label: "Ballad",
    tag: "ballad, emotional piano, strings, soft vocal, melancholic, 70 BPM",
    keywords: ["발라드", "ballad"],
  },
  {
    category: "anime",
    label: "Anime",
    tag: "anime opening, J-rock, distorted guitar, driving drums, uplifting, 150 BPM",
    keywords: ["애니메이션", "애니송", "anime", "j-pop", "jpop", "j팝", "otaku"],
  },
  {
    category: "rock",
    label: "Rock",
    tag: "rock, electric guitar, powerful drums, male vocal, energetic, 130 BPM",
    keywords: [
      "rock", "metal", "메탈", "punk", "펑크",
      "록음악", "락음악", "록 음악", "락 음악",
      "록밴드", "락밴드", "록 밴드", "락 밴드",
    ],
  },
  {
    category: "electronic",
    label: "Electronic",
    tag: "electronic, synth lead, four-on-the-floor kick, driving, 128 BPM",
    keywords: [
      "일렉트로닉", "일렉트로", "일렉",
      "electronic", "edm", "techno", "house",
      "테크노", "하우스", "synth", "신스",
    ],
  },
  {
    category: "pop",
    label: "Pop",
    tag: "pop, female vocal, catchy hook, synth, upbeat, 120 BPM",
    keywords: ["팝", "pop"],
  },
];

export function detectGenre(prompt: string): GenreMatch | null {
  if (!prompt) return null;
  const lower = prompt.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      const { category, label, tag } = rule;
      return { category, label, tag };
    }
  }
  return null;
}

// User-chosen override from the 고급 menu. Returns the canonical GenreMatch for
// the category, bypassing keyword detection. Unknown category → null (the
// caller treats this as "no genre" rather than erroring, matching detectGenre).
export function genreByCategory(category: GenreCategory): GenreMatch | null {
  const rule = RULES.find((r) => r.category === category);
  if (!rule) return null;
  const { category: c, label, tag } = rule;
  return { category: c, label, tag };
}

export const ALL_GENRE_CATEGORIES: ReadonlyArray<GenreCategory> = RULES.map((r) => r.category);

// detectGenre + adjust the BPM token if the user prompt hints at tempo.
// Explicit "120 BPM" wins; otherwise 느린/slow scales the default BPM by 0.85,
// 빠른/fast by 1.2. Genres without a "N BPM" token are unchanged.
export function resolveGenre(prompt: string): GenreMatch | null {
  const match = detectGenre(prompt);
  if (!match) return null;
  return { ...match, tag: overrideBpmInTag(match.tag, prompt) };
}

function overrideBpmInTag(tag: string, prompt: string): string {
  const explicit = prompt.match(/(\d{2,3})\s*(?:BPM|bpm)/);
  if (explicit) return tag.replace(/\d{2,3}\s*BPM/, `${explicit[1]} BPM`);
  if (/느린|slow/i.test(prompt)) return tag.replace(/(\d{2,3})\s*BPM/, (_, n) => `${Math.round(+n * 0.85)} BPM`);
  if (/빠른|fast/i.test(prompt)) return tag.replace(/(\d{2,3})\s*BPM/, (_, n) => `${Math.round(+n * 1.2)} BPM`);
  return tag;
}

// Global mix/quality tag appended to every ACE-Step caption. Set to "" to disable.
export const QUALITY_SUFFIX = "clean mix";

// Prepend the genre tag: ACE-Step weights the start of the prompt more heavily,
// so leading with style/instrument/tempo anchors the output better than appending.
// `excludeTerms` drops tag tokens whose text contains any of the given words
// (case-insensitive substring) — used by lego to avoid duplicating instruments
// the user is explicitly adding.
export function applyGenreTag(
  caption: string,
  match: GenreMatch | null,
  excludeTerms?: string[],
): string {
  if (!match) return caption;
  const tag = excludeTerms?.length ? filterTagTokens(match.tag, excludeTerms) : match.tag;
  if (!tag) return caption;
  if (!caption.trim()) return tag;
  return `${tag}, ${caption}`;
}

export function withQualitySuffix(caption: string): string {
  if (!QUALITY_SUFFIX) return caption;
  if (!caption.trim()) return QUALITY_SUFFIX;
  return `${caption}, ${QUALITY_SUFFIX}`;
}

function filterTagTokens(tag: string, excludeTerms: string[]): string {
  const terms = excludeTerms.map((t) => t.toLowerCase()).filter(Boolean);
  if (!terms.length) return tag;
  return tag
    .split(",")
    .map((s) => s.trim())
    .filter((token) => token && !terms.some((term) => token.toLowerCase().includes(term)))
    .join(", ");
}
