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

### 2. Download the checkpoints

**YingMusic-SVC main checkpoint (~731 MB)** — required for any voice conversion:

```powershell
$dest = "C:\WorkSpace\YingMusic-SVC\ckpt"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
curl.exe -L -o "$dest\YingMusic-SVC-full.pt" `
  "https://huggingface.co/GiantAILab/YingMusic-SVC/resolve/main/YingMusic-SVC-full.pt"
```

Mounted at `/app/ckpt/YingMusic-SVC-full.pt` inside the container.

**BR Separator (`bs_roformer`) checkpoint** — required for the
ACE-Step → chain integration (`yingmusic-chain` runner). Without it the
chain pipeline fails with `FileNotFoundError` from `accom_separation/inference.py`.

```powershell
$brDest = "C:\WorkSpace\YingMusic-SVC\accom_separation\ckpt\bs_roformer"
New-Item -ItemType Directory -Force -Path $brDest | Out-Null
curl.exe -L -o "$brDest\bs_roformer.ckpt" `
  "https://huggingface.co/GiantAILab/YingMusic-SVC/resolve/main/bs_roformer.ckpt"
```

The checkpoint sits at the HF repo root next to `YingMusic-SVC-full.pt`
(NOT under any `accom_separation/` subpath, despite where it ends up
locally). `config_bd_roformer.yaml` ships in-repo; only the `.ckpt` is
missing.

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
  `--pre --index-url cu126` lines, plus `matplotlib` / `omegaconf` for the
  BR Separator's bs_roformer config loader
- `infer.sh` → `yingmusic-infer` — direct-clone wrapper (one diffusion pass,
  no separator, no remix); env vars `SOURCE` / `TARGET` / `EXPNAME` / `STEPS`
- `chain.sh` → `yingmusic-chain` — full chain: BR-separate the SOURCE
  (full-mix song) into vocals + instrumental, clone vocals onto TARGET,
  echo+reverb-mix the converted vocal back with the instrumental. Same
  env-var contract as infer.sh.

## Generation chain (Phase 2 default)

When a user has uploaded a reference voice, `POST /api/generate` runs:

1. ACE-Step produces a full-mix track from the prompt
2. `server/jobs.ts:chainAceOutputs` `docker cp`s the result into
   `audio-secure/_pending-<jobid>-<i>.mp3` (audio-secure is bind-mounted
   into the yingmusic container as `/data/_aceout`)
3. `yingmusic-chain` runs BR Separator → YingMusic clone with `--accompany`
4. The remixed wav from `/app/outputs/<expname>/accompany/` is watermarked
   and served as the user's song

Users without a ready voice skip the chain and get the plain ACE-Step output.
