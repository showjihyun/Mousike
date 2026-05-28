# Use self-hosted RVC for voice cloning on the local RTX 4070 SUPER

Pivoting to musicai-style full-stack (ADR 0004) requires a voice-cloning backend. We chose **RVC** (Retrieval-based Voice Conversion) self-hosted on the same local box that already runs the ACE-Step Docker container (RTX 4070 SUPER, 12GB VRAM), with training and inference both serialized into a single GPU queue and Pro-tier users given priority on the next-job slot.

## Considered Options

- **(a) RVC self-hosted (chosen).** Model weights MIT-licensed, free. Designed for singing — matches the "내 목소리로 노래" value proposition. Training ~15-25 min per voice (200-300 epochs), inference ~0.3-0.5× realtime — both fit the 4070 SUPER's 12GB *with strict serial scheduling*. Operational cost = electricity only. Queue contention is the dominant risk: a single training run blocks ~20 min of song generation.
- **(b) ElevenLabs Voice Cloning API.** Best speaking-clone quality, instant clone (~60s sample → ready), ToS-clean with built-in consent verification. **Rejected** because singing quality lags speaking quality, and the product's whole point is sung output. Subscription + per-character usage compounds at scale.
- **(c) so-vits-svc self-hosted.** Cleaner sustained-vocal output than RVC. **Rejected** because default training settings (8-16GB VRAM) exceed the 4070 SUPER's 12GB headroom once ACE-Step's ~10-12GB resident model is accounted for; the smaller-batch fallback degrades quality enough to lose the only reason to prefer it.
- **(d) Replicate-hosted RVC training, local inference (hybrid).** Avoids queue blocking for training (~$0.5-2 per voice, elastic), keeps inference cheap on the local GPU. Strong second choice. **Rejected for V1** primarily to keep stack-count low and avoid Replicate billing setup before the product is validated. Defined as an escape hatch — see Consequences.

## VRAM accounting

| Workload | VRAM peak | Notes |
|---|---|---|
| ACE-Step 1.5 inference | ~10-12GB | Single resident model fills the card |
| RVC training (batch 7, 200ep) | 6-8GB | Cannot coexist with ACE-Step on 12GB |
| RVC inference (3-min song) | 2-4GB | Cannot coexist with ACE-Step on 12GB |
| Demucs htdemucs (stem split) | 4-8GB | Used in Phase 2; same serialization constraint |

On 12GB, **all four workloads must serialize.** Treating this as a hard constraint up front avoids a class of "it worked on my machine then OOMed in prod" bugs.

## Consequences

- A unified GPU job queue handles four kinds on the same card: `acestep_generate` (existing), `rvc_train` (Phase 1), `rvc_infer` (Phase 1), `demucs_split` (Phase 2). No concurrent execution.
- **Pro priority**: between *queued* jobs, Pro-tier jobs jump to the next slot. Jobs already *running* finish regardless — RVC training cannot be preempted without losing meaningful checkpoint progress.
- Training (~20 min) is the worst blocking event. Mitigations to evaluate during Phase 1: (i) cap free-tier training epochs to ~100 (faster but lower fidelity, with an honest "베타" label), (ii) show live queue depth + ETA in UI, (iii) reserve a max daily training slot count per tier to bound worst-case backlog.
- New DB shape: `user_voices` table (`id`, `user_id`, `display_name`, `weight_path`, `index_path`, `trained_at`, `sample_seconds`, `epochs`, `status`). `status ∈ {'uploading', 'training', 'trained', 'failed'}`. Migration number TBD when Phase 1 lands.
- Voice samples (multi-file mp3/wav, typically 2-3 per user matching musicai's intake) need an upload path. ADR 0003's single-file endpoint extends to multi-file with a different retention policy: source samples auto-delete when their parent `user_voices` row reaches `status='trained'` (the `.pth` weight is the persistent artifact, not the raw audio). Implementation in Phase 1.
- **Escape hatch**: if observed queue-block time per week exceeds (threshold TBD in Phase 1) or if a single user's training visibly degrades Pro-tier generation latency, training moves to Replicate (option d) with zero user-visible UI change. The `rvc_train` job kind is the abstraction point.
- License posture: RVC base weights are MIT, but the model was trained on data of unclear provenance — same gray-area risk as Suno itself. We accept this for V1 and surface it via a checkbox at voice-upload time ("내 목소리이며 학습·생성에 사용 권한이 있음을 확인합니다") that follows ElevenLabs' consent-verification spirit. We do *not* offer celebrity-voice training as a product surface.

## Korean pretrained base (KLM)

RVC ships with `assets/pretrained_v2/f0G40k.pth` / `f0D40k.pth` pretrained on English + Chinese vocals. Fine-tuning a Korean target on top of that base produces a robotic clone — the bundled base model has no Korean phonemes, so 250 epochs on tiny user data never recovers natural Korean prosody. Confirmed by ear-test against the same model retrained on a Korean base.

We use **KLM (Korean Language Model)** — RVC v2 40k pretrained by SeoulStreamingStation on Korean voice actors + vocalists, with phonetic coverage tuned for Korean (bilabial/alveolar/velar/uvular/glottal). Fine-tuning starts with the model already understanding Korean phonemes and converges to a natural-sounding clone.

- Variant: `KLM43_X3` (most recent 40k pair as of 2026-05). Older variants (`KLM40`, `KLM42_T4`, fp32 series) live in the same HF dir for comparison.
- Source: [Politrees/RVC_resources](https://huggingface.co/Politrees/RVC_resources/tree/main/pretrained/v2/40k/KLM).
- Files (1.3 GB total) are gitignored; download per `server/voice-pretrained/README.md`. `docker-compose.yml` bind-mounts them at `/app/assets/pretrained_klm/`, and `server/rvc.ts` passes the paths as `pretrainG`/`pretrainD` to `train1key` (positions [11]/[12]).
- Watch-out: `train1key` does **not** fall back to the bundled weights when these args are empty — it logs `No pretrained Generator` and trains from random init, which 50-250 ep on tiny data never recovers from (output is pure noise). The path strings are required.
