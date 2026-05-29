#!/bin/bash
# ACE-Step → BR Separator → YingMusic clone + remix.
#
# Pipeline (single GPU pass per step):
#   1. BR Separator (bs_roformer) splits SOURCE into vocals + instrumental
#   2. YingMusic clones the vocals onto TARGET (user voice ref)
#   3. echo_then_reverb_save mixes the converted vocal back with the
#      instrumental → final wav (this is what we return to the caller)
#
# Env vars (set by server/yingmusic.ts:cloneAndRemix):
#   SOURCE     — host path to a full-mix wav/mp3 (ACE-Step output)
#   TARGET     — host path to the user's voice reference clip
#   EXPNAME    — unique tag; outputs land at /app/outputs/<EXPNAME>/...
#   STEPS      — YingMusic diffusion steps (optional, default 100)
#
# Final output (read by yingmusic.ts):
#   /app/outputs/<EXPNAME>/accompany/<vc_filename>.wav
#
# Intermediate (transient — left in place for debugging, GC'd by ops):
#   /app/outputs/<EXPNAME>_sep/input/mix.wav
#   /app/outputs/<EXPNAME>_sep/output/mix/{vocals,backing_vocal,instrumental,other}.wav

set -e

SOURCE="${SOURCE:?SOURCE env var required}"
TARGET="${TARGET:?TARGET env var required}"
EXPNAME="${EXPNAME:?EXPNAME env var required}"
STEPS="${STEPS:-100}"

SEP_ROOT="/app/outputs/${EXPNAME}_sep"
SEP_IN="${SEP_ROOT}/input"
SEP_OUT="${SEP_ROOT}/output"

echo "=== chain start expname=${EXPNAME}"
echo "=== source: ${SOURCE}"
echo "=== target: ${TARGET}"

# Step 1: stage the source into a flat dir BR Separator can scan.
# inference.py globs args.input_folder/*.* — we give it exactly one file
# so the output dir is deterministic at <store_dir>/mix/.
mkdir -p "${SEP_IN}"
cp "${SOURCE}" "${SEP_IN}/mix.wav"

echo "=== br-separator running"
cd /app/accom_separation
PYTHONWARNINGS="ignore" python inference.py \
  --model_type bs_roformer \
  --config_path ckpt/bs_roformer/config_bd_roformer.yaml \
  --start_check_point ckpt/bs_roformer/bs_roformer.ckpt \
  --input_folder "${SEP_IN}" \
  --store_dir "${SEP_OUT}" \
  --extract_other

VOCALS="${SEP_OUT}/mix/vocals.wav"
INSTRUMENTAL="${SEP_OUT}/mix/instrumental.wav"

if [ ! -f "${VOCALS}" ]; then
  echo "[chain] br-separator did not produce vocals.wav at ${VOCALS}" >&2
  exit 1
fi
if [ ! -f "${INSTRUMENTAL}" ]; then
  echo "[chain] br-separator did not produce instrumental.wav at ${INSTRUMENTAL}" >&2
  exit 1
fi

# Step 2: YingMusic clone with --accompany — the converted vocal gets
# echo+reverb applied and is mixed back with the instrumental inside
# my_inference.py's accompany branch.
echo "=== yingmusic running"
cd /app
python my_inference.py \
  --source "${VOCALS}" \
  --target "${TARGET}" \
  --diffusion-steps "${STEPS}" \
  --checkpoint /app/ckpt/YingMusic-SVC-full.pt \
  --expname "${EXPNAME}" \
  --cuda 0 \
  --fp16 True \
  --accompany "${INSTRUMENTAL}" \
  --config /app/configs/YingMusic-SVC.yml

ACCOMPANY_DIR="/app/outputs/${EXPNAME}/accompany"
if [ ! -d "${ACCOMPANY_DIR}" ]; then
  echo "[chain] yingmusic produced no accompany/ at ${ACCOMPANY_DIR}" >&2
  exit 1
fi

echo "=== chain done"
ls -la "${ACCOMPANY_DIR}"
