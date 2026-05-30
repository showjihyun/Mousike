#!/bin/bash
# Zero-shot inference for the Mousike PoC.
# Default: source=Brave Adventurer (Korean speech), target=Gentle Butler (different Korean speaker).
# Override via SOURCE / TARGET / EXPNAME env vars.

set -e

SOURCE="${SOURCE:-/data/sample/Brave Adventurer.mp3}"
TARGET="${TARGET:-/data/sample/Gentle Butler.mp3}"
EXPNAME="${EXPNAME:-poc_brave_to_butler}"
STEPS="${STEPS:-100}"

echo "=== source: $SOURCE"
echo "=== target: $TARGET"
echo "=== diffusion steps: $STEPS  fp16: True  cuda: 0"

cd /app

python my_inference.py \
  --source "$SOURCE" \
  --target "$TARGET" \
  --diffusion-steps "$STEPS" \
  --checkpoint /app/ckpt/YingMusic-SVC-full.pt \
  --expname "$EXPNAME" \
  --cuda 0 \
  --fp16 True \
  --config /app/configs/YingMusic-SVC.yml

echo "=== output:"
ls -la "/app/outputs/$EXPNAME/" 2>/dev/null || echo "no outputs/ — check stderr above"
