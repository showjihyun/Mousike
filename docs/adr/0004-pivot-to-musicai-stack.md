# Pivot from "Suno-bridge wedge" to musicai-style full-stack

Three days ago (commit b3e004b) we committed a 6-week wedge plan positioning Mousike as a "Suno-bridge" — accept user-uploaded Suno tracks and run our existing `repaint`/`lego` derivations on them, deliberately *not* shipping voice cloning, cover, or distribution. Today we reverse that: Mousike will build the full musicai.co.kr-style pipeline (voice clone → cover → 자작곡 → 발매 linkout) as a self-serve web product. The wedge plan is **superseded** — it stays in the repo for context but should not drive any new work.

## Considered Options

- **(a) Execute wedge plan as written.** Lower risk (Sprint 1 deliverable already specified in ADR 0003), tight 6-week scope, narrow positioning. Trades upside: caps Mousike at "Suno helper" which positions it as a feature, not a product.
- **(b) Pivot to musicai-style full-stack (chosen).** Bigger surface (6-8 weeks just for Phase 1-2, Phase 3 partial). Trades wedge KPI clarity for a positioning that competes head-on with a paying-customer market we can observe (musicai.co.kr's three tiers: 129,900 / 199,000 / 499,000 원). Self-serve at lower price (or subscription) can undercut their concierge model.
- **(c) Wedge + small voice-clone PoC sidecar.** Tried to have both. Rejected because solo capacity was already ~110h over the 6-week wedge plan; sidecar work doesn't fit without cutting the wedge.

## Consequences

- `docs/plan/wedge-repaint-roadmap.md` is marked SUPERSEDED. Sprint 1's upload endpoint (ADR 0003) still has value — uploaded mp3s now serve as **cover-song instrumentals** (Tier 1) rather than "Suno tracks to repaint" — so ADR 0003's storage and retention story carries over, recontextualized.
- Voice-sample uploads have a different lifecycle (delete after `user_voices.status='trained'`, not 24h fixed) and need multi-file support — covered in ADR 0005.
- The 6-week wedge KPIs (K1 external traffic, K2 upload→repaint conversion, K3 paid converts) are dropped. New KPIs for musicai-stack are deferred until Phase 1 ships, since we need real cost data before setting conversion targets.
- Wedge's "explicitly not doing" list (LoRA, cover, distribution) is inverted — those are now the core roadmap.
- Tier ladder (Free 30s / Starter 90s / Pro 3min, see [[tier-policy]]) may need restructuring once voice-cloning costs are real; deferred to end of Phase 1.
- `docs/plan/master-canvas.md` (Month 4+) status unchanged — still postponed.

Roadmap phases (each gets its own follow-up ADR for technical decisions):

| Phase | Scope | Est. duration |
|---|---|---|
| 0 | This ADR + wedge retirement + ADR 0005 (voice-clone engine) | done |
| 1 | Voice-clone MVP — multi-file voice upload, RVC training queue, "내 목소리 데모" playback page | 2-3 weeks |
| 2 | Cover (Tier 1) + 자작곡 (Tier 2) — Demucs stem split, RVC-on-instrumental, Suno 3-demo + selection flow, auto-mastering | 2-3 weeks |
| 3 | 발매 prep — album-art generation, DistroKid/Amuse affiliate linkout (no direct distribution API) | 1-2 weeks |

Direct API integration with distributors (KOMCA mechanical license for covers, ISRC/UPC issuance, payout/KYC) is **explicitly out of scope** even for Phase 3 — those require partnerships or licensing that don't fit a self-serve V1.
