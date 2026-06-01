#!/bin/bash
# DiffRhythm inference wrapper. Generates a full song (vocals + instrumental)
# from an LRC lyric file + a text style prompt. Output is one .wav per song.
#
# Env vars (set by server/diffrhythm.ts):
#   LRC_PATH       — host path to .lrc file (mounted via voice/audio binds)
#   REF_PROMPT     — text style prompt (e.g. "Korean acoustic ballad, gentle")
#   AUDIO_LENGTH   — output seconds (95 max for base, 285 for full)
#   EXPNAME        — unique tag; output lands at /app/outputs/<EXPNAME>/
#   CHUNKED        — "1" enables --chunked (8GB GPU mode); default "1"
#   STEPS          — diffusion steps; default unset (model default)
#
# Output (read by diffrhythm.ts):
#   /app/outputs/<EXPNAME>/output_*.wav  (one per batch entry; batch=1 here)
#
# Korean handling: LRC content can be raw hangul. DiffRhythm's g2p/korean.py
# converts to IPA via espeak-ng. No romaja preprocessing needed (unlike the
# ACE-Step path which uses kroman).

set -e

LRC_PATH="${LRC_PATH:?LRC_PATH env var required}"
REF_PROMPT="${REF_PROMPT:?REF_PROMPT env var required}"
AUDIO_LENGTH="${AUDIO_LENGTH:-30}"
EXPNAME="${EXPNAME:?EXPNAME env var required}"
CHUNKED_FLAG="--chunked"
if [ "${CHUNKED}" = "0" ]; then
  CHUNKED_FLAG=""
fi

OUT_DIR="/app/outputs/${EXPNAME}"

echo "=== diffrhythm start expname=${EXPNAME}"
echo "=== lrc: ${LRC_PATH}"
echo "=== ref-prompt: ${REF_PROMPT}"
echo "=== audio-length: ${AUDIO_LENGTH}s"
echo "=== chunked: ${CHUNKED_FLAG:-off}"

mkdir -p "${OUT_DIR}"

cd /app
python3 infer/infer.py \
  --lrc-path "${LRC_PATH}" \
  --ref-prompt "${REF_PROMPT}" \
  --audio-length "${AUDIO_LENGTH}" \
  --output-dir "${OUT_DIR}" \
  ${CHUNKED_FLAG} \
  --batch-infer-num 1

echo "=== diffrhythm done"
ls -la "${OUT_DIR}"
