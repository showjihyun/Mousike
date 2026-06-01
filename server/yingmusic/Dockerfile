# YingMusic-SVC integration container (Mousike Phase 2).
# Base: PyTorch 2.4 + CUDA 12.4 matches upstream requirements.
# YingMusic source is bind-mounted at /app at runtime.
FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg sox libsox-dev libsox-fmt-all git curl \
    build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*
# libsox-dev is what provides the unversioned /usr/lib/x86_64-linux-gnu/libsox.so
# symlink that torchaudio's sox_effects backend dlopens at echo+reverb time
# (Remix/auger.py via my_inference.py --accompany). Without it the chain runs
# all the way through inference and dies right before the final remix with
# `OSError: libsox.so: cannot open shared object file`. libsox-fmt-all alone
# brings in libsox3 (the versioned lib) but not the .so symlink.

WORKDIR /app
COPY requirements.filtered.txt /tmp/req.txt
RUN pip install --no-cache-dir -r /tmp/req.txt

# Inference wrappers baked into the image — server/yingmusic.ts invokes
# these via `docker exec yingmusic <name>` with env vars:
#   yingmusic-infer  → direct clone (SOURCE/TARGET/EXPNAME[/STEPS])
#   yingmusic-chain  → ACE-Step mix → BR-separate → clone+remix chain
# sed strips any stray CRs so a Windows dev with autocrlf=true that
# slipped CRLF into the working tree can't poison the in-container
# shebang (#!/bin/bash\r → kernel "no such file or directory" on exec).
COPY infer.sh /usr/local/bin/yingmusic-infer
COPY chain.sh /usr/local/bin/yingmusic-chain
RUN sed -i 's/\r$//' /usr/local/bin/yingmusic-infer /usr/local/bin/yingmusic-chain \
 && chmod +x /usr/local/bin/yingmusic-infer /usr/local/bin/yingmusic-chain

ENV HF_HOME=/cache/hf TORCH_HOME=/cache/torch

# Stay up so server/yingmusic.ts can docker exec into us, mirroring rvc.
CMD ["sleep", "infinity"]
