# DiffRhythm (Phase D — Korean song generator). Replaces ACE-Step for KO
# lyrics because ACE-Step's vocal model can't reliably sing Korean phonemes
# regardless of tuning. DiffRhythm has a built-in Korean g2p path
# (g2p/g2p/korean.py → IPA via espeak-ng), so we feed hangul directly.
#
# Apache 2.0, ~8 GB VRAM with --chunked (fits 4070 SUPER's 12 GB alongside
# yingmusic when only one runs at a time). Source mounted at /app, so the
# image only carries the Python + espeak-ng + pip deps.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg espeak-ng git curl \
    build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.filtered.txt /tmp/req.txt
RUN pip install --no-cache-dir -r /tmp/req.txt

# espeak-ng IPA backend — DiffRhythm's korean_to_ipa needs the .so to find
# the language data via phonemizer.
ENV PHONEMIZER_ESPEAK_LIBRARY=/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1
ENV PHONEMIZER_ESPEAK_PATH=/usr/bin

# Inference wrapper baked in. server/diffrhythm.ts invokes via
# `docker exec diffrhythm diffrhythm-infer` with env vars (LRC/REF_PROMPT/
# AUDIO_LENGTH/EXPNAME). sed strips CRLF in case the script slipped through
# autocrlf=true on Windows.
COPY infer.sh /usr/local/bin/diffrhythm-infer
RUN sed -i 's/\r$//' /usr/local/bin/diffrhythm-infer \
 && chmod +x /usr/local/bin/diffrhythm-infer

ENV HF_HOME=/cache/hf TORCH_HOME=/cache/torch
ENV PYTHONPATH=/app

# Stay up for docker exec, same pattern as yingmusic + rvc.
CMD ["sleep", "infinity"]
