# RVC mute padding (`/app/logs/mute`)

RVC's training filelist pads short datasets with references to a
fixed "mute" (silence) sample at `/app/logs/mute/`. If those files are
absent, **train_nsf raises `FileNotFoundError` and dies before epoch 1
— and `train1key` silently swallows the crash and reports "All
processes have been completed!" with no model saved.** Same silent
failure shape as the earlier shm and pretrained-base bugs.

These files originate in the rvc-webui image (`/app/logs/mute/`), but
that path is shadowed by our `voice-train-logs` bind mount. Cleaning
`voice-train-logs/*` (which is a normal "wipe runtime data" operation)
would then nuke `mute/` and break the next training. To avoid that,
`docker-compose.yml` nested-binds this directory at `/app/logs/mute`
so the originals stay safe regardless of what happens inside
`voice-train-logs/`.

## Files (8, ~1.4 MB total — tracked in git)

| File | Role |
|---|---|
| `0_gt_wavs/mute40k.wav`, `mute32k.wav`, `mute48k.wav` | Ground-truth silent audio at each supported SR |
| `1_16k_wavs/mute.wav` | 16 kHz resample used by HuBERT |
| `2a_f0/mute.wav.npy`, `2b-f0nsf/mute.wav.npy` | Pre-computed F0 / F0-nsf of silence |
| `3_feature256/mute.npy`, `3_feature768/mute.npy` | Pre-computed HuBERT features (v1 256-dim, v2 768-dim) |

Small enough to live in the repo; eliminates a setup-step that's easy
to forget.

## Refresh from the image (only if these are ever lost)

```powershell
$dest = "C:\WorkSpace\Mousike\server\voice-rvc-mute"
docker run --rm -v "${dest}:/host" --entrypoint="" rvc-webui:latest sh -c "cp -r /app/logs/mute/. /host/"
```

The bind mounts read-write so RVC can write its `mute40k.spec.pt`
spectrogram cache; that file is `.gitignored` and gets regenerated as
needed.
