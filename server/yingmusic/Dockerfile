# YingMusic-SVC integration container (Mousike Phase 2).
# Base: PyTorch 2.4 + CUDA 12.4 matches upstream requirements.
# YingMusic source is bind-mounted at /app at runtime.
FROM pytorch/pytorch:2.4.0-cuda12.4-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg sox libsox-fmt-all git curl \
    build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.filtered.txt /tmp/req.txt
RUN pip install --no-cache-dir -r /tmp/req.txt

# Inference wrappers baked into the image — server/yingmusic.ts invokes
# these via `docker exec yingmusic <name>` with env vars:
#   yingmusic-infer  → direct clone (SOURCE/TARGET/EXPNAME[/STEPS])
#   yingmusic-chain  → ACE-Step mix → BR-separate → clone+remix chain
COPY infer.sh /usr/local/bin/yingmusic-infer
COPY chain.sh /usr/local/bin/yingmusic-chain
RUN chmod +x /usr/local/bin/yingmusic-infer /usr/local/bin/yingmusic-chain

ENV HF_HOME=/cache/hf TORCH_HOME=/cache/torch

# Stay up so server/yingmusic.ts can docker exec into us, mirroring rvc.
CMD ["sleep", "infinity"]
