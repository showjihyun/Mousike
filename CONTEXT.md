# Mousike

Korean-facing web app that turns a short text prompt into a short music clip, by orchestrating a local ACE-Step model behind a queued job worker.

## Language

**Prompt**:
The short Korean or English text the user types to describe the song they want — a *description* of style, mood, and instrumentation. Not lyrics.
_Avoid_: Caption (used internally for the post-translation, post-genre-tag string sent to ACE-Step — different layer)

**Caption**:
The fully-processed English string sent to ACE-Step as the "Music Caption" input. Derived from the user's Prompt by (optionally) translating, prepending a genre tag, and appending the quality suffix.
_Avoid_: Prompt (those are the user's raw words; Caption is what the model sees)

**Prompt language** (`lang: "KO" | "EN"`):
The language the user *typed their Prompt in*. Drives whether the BE translates the Prompt to English before building the Caption. Has no direct effect on what language the model sings in.
_Avoid_: Language, locale, vocalLanguage

**Vocal language** (`vocalLanguage: "auto" | "KO" | "EN"`, default `"auto"`):
The language the model is asked to *sing in*. Independent of Prompt language — a user can type an English prompt and still want Korean vocals, and vice versa. Maps to ACE-Step payload slot 5 ("Vocal Language"). Default `"auto"` resolves on the BE via the **vocal-language auto rule**.
_Avoid_: Lang, singLanguage, sing style

**Vocal-language auto rule**:
When `vocalLanguage = "auto"`, the BE resolves it to a concrete `KO | EN` value before building the ACE-Step payload:
1. If detected Genre ∈ {`kpop`, `trot`} → `KO`
2. Else if Prompt language is `KO` → `KO`
3. Else → `EN`

The resolved value is also returned to the FE on the job result, so the library card can show what the model actually sang in.

**Slot 5 mapping** (BE → ACE-Step payload index 5):
`vocalLanguage` resolved value → ISO 639-1 code:
- `"KO"` → `"ko"`
- `"EN"` → `"en"`
- `"auto"` (only if explicitly chosen by a user who wants no hint) → `"unknown"`

Confirmed via ACE-Step-1.5 `cli.py` which documents the parameter as `"Vocal language (e.g., 'en', 'zh', 'unknown')"`. Since we never populate Lyrics (slot 1), slot 5 is the only vocal-language signal we send.

**Job-kind scope**:
`vocalLanguage` is a `generate`-only input. `repaint` and `lego` **inherit** the resolved value from their parent Song (no separate UI control). Songs created before this feature exists have no recorded value; they inherit as `"unknown"` to preserve today's exact behavior.

**UI placement**:
The vocal-language control lives in `composer-meta` (below the input, inline with `Enter 생성`/length/character-count), rendered as a compact dropdown: `🎤 보컬: 자동 ▾`. Deliberately not adjacent to the existing prompt-language toggle (`🌐 KO`) in `composer-actions`, to avoid collapsing the two distinct "language" concepts in the user's mind.

**Persistence**:
Resolved `vocalLanguage` lives on a new nullable column `songs.vocal_language` (text). `NULL` is read as `"unknown"` — old songs predating this feature keep their original behavior with zero backfill. The user's *original* choice (including `"auto"`) is retained on `jobs.payload` (jsonb), giving a free audit trail for analytics.

**Auto resolution ownership**:
The BE owns the **vocal-language auto rule** because it depends on genre detection (a BE concept). The FE sends the user's literal choice on `POST /api/generate`; the BE resolves it inside `runJob()` and returns the concrete value (`"KO" | "EN" | "unknown"`) on the job result so the FE can display it.

**Tier gating**:
None. The vocal-language dropdown is available to all tiers (Free, Starter, Pro). The `(베타)` label on the Korean option is the only friction — paying does not unlock quality. If post-ship data shows free-tier churn correlates with picking Korean, revisit with a soft `Pro 추천` badge before any hard paywall.

**Library card display**:
Every Song card surfaces the resolved vocal language as a chip alongside style/BPM:
- `KO` → `🎤 한국어`
- `EN` → `🎤 영어`
- `unknown` (legacy songs) → chip hidden
The `(베타)` label appears only at the moment of choice (the dropdown), never on the card — the card states what was sung, past tense, without re-litigating expectations.

**Beta caveat**:
ACE-Step 1.5 does not natively tokenize Hangul — Korean vocals are approximated via the model's English-trained phoneme encoder (see [upstream issue #334](https://github.com/ace-step/ACE-Step/issues/334)). Quality is "Korean-ish" rather than native. The UI labels the Korean option `(베타)` to set expectations.

**Master canvas**:
The directed-graph view that is Master mode's primary surface. Nodes are Songs the user has generated; edges record derivations. Grows incrementally — each generation adds one node.
_Avoid_: workflow editor, node editor (those imply ComfyUI's declarative "pre-declare, run once" model, which Mousike does not adopt)

**Song node**:
A node on the Master canvas representing one Song. Playable in place. Same artifact as a Song card in Play mode — only the layout differs.
_Avoid_: operation node, op node

**Derivation**:
The act of producing a new Song from an existing parent Song via one of {`cover`, `repaint`, `lego`, `extract`, `complete`}. Distinct from `generate`, which has no parent.
_Avoid_: variant (overloaded — used informally in UI copy as "비슷한 분위기로 더"), child song

**Derivation edge**:
A directed edge on the Master canvas, parent Song → derived Song, labeled with the derivation kind and its salient parameters (e.g. "repaint 0:45–1:15", "lego +bass").
_Avoid_: link, connection

**Advanced settings**:
The four optional power-user overrides surfaced via the 고급 button in the topbar (genre, BPM, key, duration). Each defaults to `"auto"`, meaning the BE keeps its existing behavior (keyword-detected genre, ACE-Step-picked BPM/key, tier-default duration). Persisted to localStorage so power users don't re-enter them per generation. Sent on `POST /api/generate` only — `repaint` and `lego` don't accept them (they inherit the parent Song's character).
_Avoid_: pro mode, expert mode, custom mode

**Genre override**:
A user-chosen `GenreCategory` (one of the 9 categories in `server/genre.ts`) from the 고급 menu that bypasses keyword-based detection in `resolveGenre`. Maps directly to the canonical `GenreMatch` for that category. When `"auto"`, keyword detection runs as before.
_Avoid_: forced genre, manual genre

## Example dialogue

> **Dev:** A user typed their prompt in Korean and set vocalLanguage to EN. What does ACE-Step see?
>
> **Domain:** The Prompt is Korean, so we translate it to English to build the Caption. The Caption goes into slot 0 (Music Caption). vocalLanguage = EN goes into slot 5 (Vocal Language). The Lyrics slot stays empty — we're describing the song, not dictating words.
>
> **Dev:** And if vocalLanguage is KO?
>
> **Domain:** Same flow — Caption is still English (because that's what ACE-Step's caption encoder expects) — but slot 5 becomes `"ko"` (ISO 639-1), so the model improvises vocals that sound Korean.
