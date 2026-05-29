# Adopt YingMusic-SVC for Phase 2 voice clone, demoting RVC+KLM to fallback

ADR 0005 picked RVC v2 self-hosted as our voice-clone backend. Phase 1 work shipped that path (commits `794e63b..e4e996d`), but ear-tested output exposed an architectural limit RVC v2 can't grow past: retrieval-based timbre mixing can't disentangle two reference speakers in a single voice's training set, so any user who uploads more than one speaker gets audibly broken output — independent of training fixes (shm, sweep TTL, KLM Korean pretrained, mute padding) we landed to make the pipeline work at all. ADR 0005's escape hatch ("if Phase 1 hits a structural quality ceiling, switch backends") is now tripped.

PoC on `pivot/phase-2-yingmusic` validated [YingMusic-SVC](https://github.com/GiantAILab/YingMusic-SVC) (DiT + Flow-GRPO, MIT, Nov 2025) end-to-end on the same 4070 SUPER. We move Phase 2 onto it.

## Considered Options

- **(a) YingMusic-SVC self-hosted (chosen).** Zero-shot — reference is conditioning, not a fine-tune. Singing-specific: trained-on-120-singers RVC timbre shifter as a *component*, F0-aware adaptor, energy-balanced flow-matching loss, accompaniment-separation module bundled. PoC: 1 GB VRAM at inference (vs RVC's 6–8 GB), 0-min "training," RTF ~1.46. MIT. Built on Seed-VC (archived) — we own that risk by vendoring intentionally.
- **(b) Stay on RVC + lock to single-speaker uploads via UI gate.** `e4e996d` is exactly this — surface "한 사람 목소리만" at upload. Cheap, no infra change. **Rejected as the primary backend** because it leaves the per-voice 20-min training step in the critical path and doesn't unlock the ACE-Step → SVC chain (RVC has no accompaniment story). Kept as a fallback.
- **(c) [R2-SVC](https://arxiv.org/abs/2510.20677) — Oct 2025, claims SOTA on harmony robustness.** **Rejected** for V2: paper + audio samples only, no code release as of 2026-05. Re-evaluate when code drops.
- **(d) Commercial API (ElevenLabs Instant / Resemble).** Architecture-wise these *are* what YingMusic-SVC implements (few-shot conditioning at inference, no weight updates). **Rejected** for the same reasons ADR 0005 rejected ElevenLabs: subscription + per-character costs, singing quality lags speaking quality, and we lose the ACE-Step integration surface.

## PoC results (the data the decision rests on)

| | RVC v2 + KLM (Phase 1) | YingMusic-SVC (Phase 2) |
|---|---|---|
| Per-voice training | ~20 min @ 250ep | **0 min** |
| Inference VRAM peak | ~6–8 GB | **~1 GB** |
| Multi-speaker reference | Output breaks (confirmed by ear-test) | Per-call single reference, no conflict possible |
| Accompaniment handling | None — RVC processes whole input | Built-in `accom_separation/` (BR Separator) |
| Inference RTF | ~0.18 | ~1.46 |
| Image size | 8 GB (rvc-webui) | 14.7 GB (PyTorch 2.4 + heavy ML deps) |
| Korean | KLM pretrained base required | Language-agnostic; ear-test confirmed on KR speakers |
| Setup-step gotchas hit | 4 silent failures (shm, sweep TTL, pretrained, mute) | 1 (webrtcvad needed build-essential) |

Ear-test: same target (`Gentle Butler.mp3`), same source (`Brave Adventurer.mp3`), KLM-trained model vs zero-shot — YingMusic output rated "잘 들린다."

## Consequences

- **Job kinds**: `rvc_train` becomes dead — Phase 2's `yingmusic_clone` is a single inference-only kind with no training counterpart. Migration is multi-step; both paths coexist during the cutover.
- **VRAM accounting** (revises ADR 0005's table — same 12 GB cap, lighter SVC slot):
  | Workload | VRAM peak |
  |---|---|
  | ACE-Step 1.5 inference | ~10–12 GB |
  | YingMusic-SVC inference | ~1 GB |
  | BR Separator (when wiring the ACE→SVC chain) | TBD, expected <2 GB |
  | RVC train / infer (legacy, fallback only) | 6–8 GB / 2–4 GB |
- **Voice intake UX changes structurally**. The Phase 1 flow (upload 30–180 s → wait 20 min training → click 들어보기) collapses to (upload 10–60 s once → every subsequent generation re-uses it as a target reference, no waiting). The `user_voices` table keeps display_name + sample audio but no longer carries training artifacts — `weight_path`/`index_path`/`epochs` become nullable and unused for new rows.
- **Source repo lives outside Mousike**. YingMusic-SVC (~50 MB code) and its checkpoint (731 MB) are cloned/downloaded into a sibling path, mounted at `/app`. `docker-compose.yml` reads `YINGMUSIC_SRC` from `.env`, defaulting to `../YingMusic-SVC`. README in `server/yingmusic/` has the setup commands.
- **Phase 1 fixes were not wasted**. The four silent-failure mitigations (`f20e4bd`, `6dfeded`, `7ae54f8`) and the per-kind sweep TTL stay — they protect the fallback path. The KLM pretrained dir stays mounted on `rvc` for the same reason.
- **Open questions for the integration commit (not yet landed)**:
  - `accom_separation/` is bundled but requires a separate BR Separator checkpoint download (`bs_roformer.ckpt`); deferred until we wire the ACE-Step chain.
  - `my_inference.py`'s output filename includes an auto-derived pitch suffix (e.g. `_-12.wav`) we don't pre-compute — `server/yingmusic.ts` reads the dir back to find the produced wav. If we need pitch control, add a CLI flag override.
  - Image is 14.7 GB. CI / fresh-clone setup cost is real; we ship it as `docker compose build yingmusic` rather than a registry pull, and document the wait.
  - Seed-VC base was archived Nov 2025. YingMusic's repo includes a snapshot of the parts it depends on, but a future upstream-incompatible change in PyTorch (e.g. removal of `torch.cuda.amp.autocast`) would force a code fork.

## Migration sequence

1. `pivot/phase-2-yingmusic`: PoC scripts + `server/yingmusic/` Dockerfile + `server/yingmusic.ts` client + this ADR. **Landed in this commit.**
2. Next: `jobs.ts` adds `yingmusic_clone`, `user_voices` schema migration to mark training fields optional, BE health-check gate for the yingmusic container.
3. UI: Song-card "이 곡을 내 목소리로" action; voice upload page drops the 학습 시작 button.
4. ACE-Step → BR Separator → YingMusic chain. `accom_separation/` ckpt downloaded, separator container or shared yingmusic image runs the separation step.
5. Once production traffic moves off `rvc_train`, mark RVC fallback-only in docker-compose and revisit removing it after a quiet period.
