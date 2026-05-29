# YingMusic-SVC integration

Zero-shot singing voice conversion via [YingMusic-SVC](https://github.com/GiantAILab/YingMusic-SVC)
(MIT-licensed, DiT + Flow-GRPO, built on Seed-VC). Replaces the per-voice RVC+KLM
training pipeline (Phase 1) with a no-training inference path: the user uploads
30–60 s of clean reference vocal once, and every subsequent generation reuses
it as the target timbre — no `rvc_train` queue blocking.

## Why this, not the RVC+KLM pipeline we just shipped?

| | RVC v2 + KLM (Phase 1) | YingMusic-SVC (Phase 2) |
|---|---|---|
| Per-voice training | ~20 min @ 250ep on 4070 SUPER | **0 min** (zero-shot) |
| Inference VRAM | ~6–8 GB | **~1 GB** (PoC measured) |
| Multi-speaker reference | Output breaks (retrieval-based mixing can't disentangle) | Per-inference single reference, no conflict possible |
| Harmony / accompaniment | Untested, RVC ignores | Built-in `accom_separation/` (BR Separator) |
| Inference RTF | ~0.18 (very fast) | ~1.46 (still real-time-ish; 47 s → 68 s wall) |
| Korean support | KLM Korean pretrained base | Language-agnostic vocal conversion (verified by ear-test on KR speakers) |

PoC ear-test confirmed audible voice with no training and no multi-speaker
artifacts on a `Brave Adventurer → Gentle Butler` conversion.

## Setup

### 1. Clone the upstream repo (large, lives outside this repo)

```powershell
cd C:\WorkSpace
git clone --depth 1 https://github.com/GiantAILab/YingMusic-SVC.git
```

The Mousike-side docker-compose mounts this path as `/app`. Override with
`YINGMUSIC_SRC` in `.env` if you put it elsewhere.

### 2. Download the checkpoint (~731 MB)

```powershell
$dest = "C:\WorkSpace\YingMusic-SVC\ckpt"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
curl.exe -L -o "$dest\YingMusic-SVC-full.pt" `
  "https://huggingface.co/GiantAILab/YingMusic-SVC/resolve/main/YingMusic-SVC-full.pt"
```

Mounted at `/app/ckpt/YingMusic-SVC-full.pt` inside the container.

### 3. Build + start the service

```
docker compose up -d --build yingmusic
```

The image is ~14.7 GB (PyTorch 2.4 + CUDA 12.4 + heavy ML deps). First build
takes ~5 min; subsequent rebuilds are cached.

### 4. Smoke-test inference

```powershell
docker exec `
  -e "SOURCE=/data/sample/Brave Adventurer.mp3" `
  -e "TARGET=/data/sample/Gentle Butler.mp3" `
  -e "EXPNAME=smoke" `
  yingmusic yingmusic-infer
```

(Inputs are paths inside the container — `/data` is bind-mounted from
Mousike's `voice/` dir.)

Output lands at `<YINGMUSIC_SRC>\outputs\<expname>\<target>_<source>_<pitch>.wav`.
The `_<pitch>` suffix is auto-derived by `my_inference.py` from the F0
difference between source and target.

## Files

- `Dockerfile` — PyTorch 2.4 + CUDA 12.4 base with build tools for `webrtcvad`
- `requirements.filtered.txt` — the upstream `requirements.txt` minus the broken
  `--pre --index-url cu126` lines that conflict with the pinned `torch==2.4.0`
- `infer.sh` — single-inference wrapper; env vars `SOURCE` / `TARGET` /
  `EXPNAME` / `STEPS` override

## Roadmap from here

This branch (`pivot/phase-2-yingmusic`) is at the "PoC validated, integration
pending" point. Next:

1. `server/yingmusic.ts` Node client (mirrors `server/rvc.ts` pattern —
   spawn `docker exec yingmusic …` with JSON args).
2. `jobs.ts` new kind: `yingmusic_clone` (a single job, no training counterpart).
3. UI: replace the "학습 시작 → ~25분 대기" flow with "이 곡을 내 목소리로"
   button on Song cards.
4. `accom_separation/` + `--accompany` wired for ACE-Step → SVC chain
   ("AI가 만든 음악 음정에 맞게 내 목소리로 노래").
