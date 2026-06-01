# 0007. Korean songs use TTS spoken-word over instrumental; OSS singing options exhausted

## Status

Accepted (2026-06-01). Replaces no prior decision; documents an empirical dead end.

## Context

Phase 2 (ADR 0006) adopted YingMusic-SVC for zero-shot voice cloning on top of
ACE-Step's lyrics→song output. The architecture worked end-to-end for English
and Chinese, but Korean output was consistently unintelligible. A multi-day
investigation in 2026-05/06 evaluated every open-source path that could
plausibly fix Korean phoneme accuracy + voice cloning + music integration
WITHOUT a paid Suno API dependency. **All open-source paths failed.** This ADR
records what was tried, what specifically failed, and how each failure-mode
manifests, so future contributors don't re-walk the same trail.

## What was tried, in order, and why each failed

### 1. ACE-Step internal tuning (Phase A)

Tuned every Gradio slot reachable from `server/acestep.ts`:

| Lever | Change | Outcome |
|---|---|---|
| DiT Guidance Scale | 1.5 → 7.0 (match gradio default) | Clarity improved; Korean still mumbled |
| LM Temperature | 0.85 → 0.5 | Marginal — phonemes still wrong |
| Audio Format | mp3 → flac (eliminate first lossy pass) | Quality up; Korean problem orthogonal |
| `/lambda_11` Format-Lyrics pre-call | Required 5Hz LM init (`/lambda_1`) | LM init succeeds but `/lambda_11` returns CUDA/CPU device-mismatch error when LM is offloaded to CPU (12GB GPU mode). Gated behind `MOUSIKE_FORMAT_LYRICS=1` env, default OFF. |
| Hangul → romaja preprocessing | Added via `kroman` npm package, auto-converts at `runAceStep` entry | Helped a small subset (e.g. "saranghae"-like repetition); **random seed dominates** — same prompt + lyrics produces vocal one run, humming the next |
| YingMusic chain `mm4.py:143` octave-snap quantiser | Patched out (also removed `+3.5` bias on line 134) | Eliminated total-silent-vocal failure mode in the chain; phonemes still warped |
| YingMusic `inference_cfg_rate` 0.7 → 0.4 | Audit hypothesis: lower = preserve content | Empirical opposite: **silenced the vocal entirely**. Reverted to 0.7. |
| YingMusic diffusion steps 100 → 200 (`yingmusic.ts:cloneAndRemix` default) | Sharper formants | RTF doubles to ~3.0; `CHAIN_TIMEOUT_MS` and `jobs.ts:RUNNING_TTL_MS` bumped accordingly. Quality barely changed on KO source. |

**Verdict:** ACE-Step's vocal model has a hard ceiling for Korean. The
underlying audio model can produce Korean-flavored phonemes when lyrics are
romanized AND the random seed cooperates AND the prompt explicitly requests
vocals AND the lyric structure resembles training-distribution pop ballads.
None of these are reliable. Anthem-style lyrics ("동해물과 백두산이…") with a
"국가풍" prompt produced fully instrumental output (no vocal at all) — the
model interprets the brief as no-vocal music.

### 2. DiffRhythm v1.2 (`ASLP-lab/DiffRhythm`)

Cloned upstream + built `server/diffrhythm/` container. Patched
`g2p/g2p_generation.py` to route hangul → "ko" cleaner branch (upstream
segmenter only handled `zh`/`en`, hangul fell through as `other` → unknown-
language exception).

Smoke-tested with two LRC patterns (simple repetitive + dense poetic) +
ko-KR style prompt. **Result: "이상한 말" — Korean phonemes unrecognizable.**
DiffRhythm's training data is documented as Chinese+English+instrumental
(4:5:1 ratio in the v2 paper); Korean k-pop claims on marketing pages are
vendor hype, not in the paper. The Korean cleaner exists but the model never
saw Korean songs during training.

### 3. YingMusic-SVC chain (existing Phase 2 infra)

Even with `mm4.py` patches:

- English-speaker reference (Brave Adventurer.mp3) on Korean ACE-Step source
  → vocal audible but phonemes warped toward English mouth shapes
- Korean-speaker reference (Gentle Butler 50s.mp3) on Korean ACE-Step source
  → vocal entirely silent for poetic lyrics, sometimes short fragments only

**Root cause** (audit + research-agent finding, mechanistically confirmed):
YingMusic uses Whisper-small as semantic content encoder + CN/EN-biased
flow-matching decoder. Phoneme bleed comes from **encoder bias, not decoder
training-language bias**. A JP-trained decoder on top of an English HuBERT
encoder still produces English-tinted output on Korean source. The decoder
cannot unmangle what the encoder mangled.

### 4. YuEGP (`olilanz/ai-yue-gp` community Docker)

Pulled `olilanz/ai-yue-gp` to evaluate `m-a-p/YuE-s1-7B-anneal-jp-kr-icl` (the
Korean-aware ICL variant) at Profile 3 (12 GB VRAM target). Build failed at
the venv-creation step: the upstream pin `nvidia-cudnn-cu12==9.1.0.70` is
**yanked from PyPI**; only 9.2.0.82+ remains. Pinning forward breaks torch
2.5.1 compatibility downstream. Manual rebuild estimated 2-4 hours with
uncertain payoff (research-agent quality estimate: "passable, K-pop accent
present" — comparable to DiffRhythm which empirically failed).

### 5. DiffSinger Korean voicebanks

Researched: Gahata Meiji DiffSinger v1.60 (Aug 2025, 16 languages including
Korean), Hoshino Hanami v1.0 (Sep 2024, free commercial use), LIEE: Immortal
Idol "Lilia" (Aug 2025, explicit `DIFFS KR` phonemizer). **Two structural
blockers:**

1. **Fixed character voices** — Hanami/Meiji/Lilia ARE the voice. Cloning a
   user's voice into a DiffSinger voicebank requires 3+ hours of clean
   labeled singing data per user, which doesn't fit the Mousike onboarding
   (10-60 s reference upload).
2. **MIDI input required** — DiffSinger consumes `note_seq` (pitches per
   note) as mandatory input. Korean lyric → MIDI melody auto-generation is
   itself unsolved: SongComposer/SongGLM/Text2midi train on English+Chinese
   only; no public Korean lyric↔MIDI parallel corpus exists for fine-tuning.
   MIDI extraction from ACE-Step instrumentals is a category error — you
   cannot extract a vocal melody from audio that has no vocal melody.

### 6. YingMusic-Singer-Plus (`ASLP-lab/YingMusic-Singer-Plus`)

Marketed as "annotation-free singing voice editing with melody guidance" —
appeared to fit our case exactly (timbre ref + melody clip + new lyrics →
sung output). Built container, patched the same hangul→`ko` routing in
`src/YingMusicSinger/utils/f5_tts/g2p/g2p_generation.py` (same F5-TTS-derived
segmenter as DiffRhythm).

Smoke-tested with EN melody clip + EN ref-text + Korean target-text, then
with ZH melody clip + ZH ref-text + Korean target-text. **Result: Korean
phonemes audible (the IPA tokenizer passes Korean through) but target lyrics
NOT faithfully sung — model produces Korean-flavored vocalizations that
don't match the input Korean text.** Paper documents "Unified IPA tokenizer
for Chinese and English"; Korean is not in the training distribution for
the generation distribution even though IPA can encode Korean phonemes
in principle. **IPA tokens in ≠ Korean generation out.**

### 7. TTS-to-singing alignment pipeline (Vocaloid-style)

Research-agent feasibility analysis: edge-tts → librosa/CREPE melody
extraction → rubberband pitch-shift TTS to follow melody → MFA Korean
forced alignment → time-stretch syllables to beats → mix.

Honest verdict (per research agent): "**robot karaoke / Vocaloid-2007**
uncanny valley." ±4 semitone shifts preserve Korean phonemes; K-pop chorus
melodies routinely span ±8+ semitones and break vowels. The weakest link
is **syllable→beat allocation** — Korean has 3-7 syllables per line, K-pop
melodies have 6-12 notes per line, real singers stretch one syllable across
multiple notes (melisma); naïve 1-syllable-per-quarter-note produces
telegraph-style cadence that sounds *less* like singing than the flat TTS
it started from. 5-8 dev-days for an "Auto-Tune-speech" aesthetic that is
not a Korean-pop product.

## Decision

**Korean songs use spoken-word TTS overlaid on an ACE-Step instrumental.
Voice cloning is deferred to a separate Y-2 work item using RVC v2 + KLM
Korean pretrain on the TTS output.**

Implemented in `server/jobs.ts:runJob` generate branch:

- When `vocalLanguage === "KO"` AND `lyricsOverride` present:
  - `runAceStep` is called WITHOUT lyrics (instrumental mode)
  - `synthesizeKoreanTts` (server/tts.ts) generates ko-KR-SunHiNeural mp3 in
    parallel via edge-tts CLI
  - `processAudioWithTtsOverlay` (server/audio.ts) mixes the two with a
    polish recipe: HPF + EQ + light compressor + 2-tap echo + static
    ducking of the instrumental + limiter
- Else: existing English/Chinese path is unchanged (ACE-Step sings the
  lyrics directly; YingMusic-SVC chain applies if user has a ready voice)

## Consequences

### Positive

- Korean is **reliably intelligible** at every generation. No random-seed
  roulette.
- Self-host story intact. No commercial API dependency.
- Builds on existing infra (`edge-tts` was already installed for watermark
  voice generation per `watermark.ts`).
- Sidesteps the entire YingMusic chain for Korean → no GPU contention with
  ACE-Step + lower wall-clock time.
- Static ducking (instrumental 0.45×) + alimiter avoids the
  `sidechaincompress` truncation bug discovered during Y-1 first integration
  test (sidechaincompress output duration is clamped to the shorter input,
  which caused 4-second total output regardless of requested duration).

### Negative

- Korean songs are **spoken-word, not sung.** Aesthetic is "narration over
  music" / rap / poetry recitation — NOT K-pop ballad. Product positioning
  must reflect this.
- Voice cloning is not yet wired for Korean (Y-2 work item). KO output uses
  the generic edge-tts SunHi voice until Y-2 lands RVC+KLM background
  training on voice upload.
- Caption sent to ACE-Step for the instrumental path appends `,
  instrumental, no vocals` to suppress the model's vocal track — relies on
  ACE-Step honoring the caption hint. Empirically reliable for "ballad" /
  "instrumental" style prompts; may need tuning for genres where ACE-Step's
  default is heavily vocal-led.
- The 2-second `adelay` on the TTS hardcodes an intro period. Longer
  intros, multiple verses, or mid-song breaks are not supported.

## What NOT to retry without new external developments

The following paths are documented dead ends — re-attempting any of them
without a material change in upstream (new model release, new training
corpus, hardware-class change) wastes investigation time:

1. **ACE-Step Korean tuning beyond what's already in `server/acestep.ts`**
   — every reachable knob has been tried. Korean is a model-level limit.
2. **DiffRhythm v1.x / v2 for Korean** — Korean is not in their training
   data; v2 paper explicitly documents the data split.
3. **YingMusic-SVC for Korean cross-language cloning** — the Whisper-small
   encoder is the bottleneck. Patching the chain doesn't help.
4. **YuEGP through `olilanz/ai-yue-gp`** — community Docker pinned a yanked
   dependency; rebuild not worth the time for "passable" Korean quality.
5. **DiffSinger Korean voicebanks for user-voice-cloning** — the voicebanks
   are fixed characters; per-user training requires hours of labeled data.
6. **YingMusic-Singer-Plus for Korean target_text** — IPA tokens encode
   Korean but the model's generation distribution doesn't faithfully render
   Korean targets. Patching the segmenter doesn't bridge the training gap.
7. **TTS-to-singing pitch-align pipeline** — robot-karaoke aesthetic;
   5-8 dev-days for an artifact most users won't experience as "singing."

## When to revisit

Re-evaluate when ANY of the following lands:

- **Tencent LeVo 2-medium / v2-fast** — 12 GB-friendly Korean-capable
  variants are on Tencent's roadmap per their HF README. PER 8.55% on
  trained languages (beats Suno v5). Monitor monthly.
- **An ASLP-lab follow-up that explicitly adds Korean training data** —
  team behind YingMusic / DiffRhythm / YingMusic-Singer-Plus. Watch their
  arxiv submissions and HF model card releases.
- **A Korean-pretrained content encoder for SVC** (`team-lucid/hubert-base-
  korean` swapped into so-vits-svc 5.0 has community confirmation of
  "more refined pronunciation" on Korean source). Build effort medium;
  worth a spike if the user case demands singing instead of spoken-word.

## References

- [YingMusic-SVC paper](https://arxiv.org/abs/2512.04793)
- [DiffRhythm v1 paper](https://arxiv.org/abs/2503.01183)
- [DiffRhythm v2 paper](https://arxiv.org/abs/2510.22950)
- [YuE paper](https://arxiv.org/abs/2503.08638)
- [YingMusic-Singer-Plus paper](https://arxiv.org/abs/2603.24589)
- [SongComposer (ACL 2025)](https://github.com/pjlab-songcomposer/songcomposer)
- [`team-lucid/hubert-base-korean`](https://huggingface.co/team-lucid/hubert-base-korean)
- [Tencent LeVo 2 / SongGeneration](https://github.com/tencent-ailab/SongGeneration)
- Internal session transcripts (2026-05-29 through 2026-06-01) document
  the empirical run details (file paths, ffmpeg recipes, BE log signatures)
  that aren't worth reproducing here.
