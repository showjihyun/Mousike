# Korean RVC pretrained base (KLM)

This dir holds the **KLM (Korean Language Model)** RVC v2 40k pretrained
weights, bind-mounted into the rvc container at
`/app/assets/pretrained_klm/` (see `docker-compose.yml`). `server/rvc.ts`
passes these as `pretrainG`/`pretrainD` to `train1key`.

## Why this, not the bundled `assets/pretrained_v2/f0G40k.pth`?

RVC's bundled 40k pretrained was trained on English/Chinese vocals.
Fine-tuning a Korean target on top of it produces a robotic, "almost
speaking but off" clone — the base model has to learn Korean phonemes
through 250 epochs of fine-tuning on tiny user data, which it never
really does. KLM was pretrained by SeoulStreamingStation on Korean voice
actors + vocalists, with phonetic coverage tuned for Korean
(bilabial/alveolar/velar/uvular/glottal); fine-tuning on top of it
starts with the model already understanding KR phonemes and converges
to a natural-sounding clone instead.

A/B confirmed via direct ear-test: same model, same input, KLM base →
notably more natural than the bundled base.

## Files (gitignored, 1.3 GB total — fetch manually)

| File | Size | Role |
|---|---|---|
| `G_KLM43_X3_40k.pth` | 418 MB | Generator (passed as `pretrainG`) |
| `D_KLM43_X3_40k.pth` | 818 MB | Discriminator (passed as `pretrainD`) |

Source: [Politrees/RVC_resources on Hugging Face](https://huggingface.co/Politrees/RVC_resources/tree/main/pretrained/v2/40k/KLM)
(originally by [SeoulStreamingStation](https://huggingface.co/SeoulStreamingStation)).
KLM43_X3 is the most recent 40k pair as of 2026-05; older variants
(`KLM40`, `KLM42_T4`, `KLM42_fp32_T1/T2/T3`) are in the same HF dir if
you want to compare.

## Download

PowerShell:

```powershell
$base = "https://huggingface.co/Politrees/RVC_resources/resolve/main/pretrained/v2/40k/KLM"
foreach ($f in "G_KLM43_X3_40k.pth","D_KLM43_X3_40k.pth") {
  curl.exe -L -o "$PSScriptRoot\$f" "$base/$f"
}
```

bash / curl:

```bash
BASE="https://huggingface.co/Politrees/RVC_resources/resolve/main/pretrained/v2/40k/KLM"
for f in G_KLM43_X3_40k.pth D_KLM43_X3_40k.pth; do
  curl -L -o "$(dirname "$0")/$f" "$BASE/$f"
done
```

After download, recreate the rvc container so the mount picks up the
new files:

```
docker compose up -d --force-recreate rvc
```

Verify inside the container:

```
docker exec rvc ls -la /app/assets/pretrained_klm/
# expect: G_KLM43_X3_40k.pth, D_KLM43_X3_40k.pth
```

## License

KLM is shared by SeoulStreamingStation for community use. Check the HF
model card for terms before commercial use. The .pth files themselves
are not redistributed in this repo.
