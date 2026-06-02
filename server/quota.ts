// Per-tier usage quotas, backed by the usage_log table.
// - free:    3 generations per rolling 24h
// - starter: 30 per rolling 30 days
// - pro:     unlimited (logged but never blocked)
//
// Anonymous calls have no row to count against and are gated by the IP
// rate limit middleware in index.ts instead.
import { getSupabase } from "./db.js";

export type UsageAction = "generate" | "repaint" | "lego";

export interface UsageState {
  used: number;
  limit: number | null;       // null = unlimited
  periodLabel: string;        // shown verbatim in UI: "오늘", "이번 달", "무제한"
  windowStart: string;        // ISO timestamp the count is from
}

interface TierRule {
  windowMs: number;
  limit: number | null;
  periodLabel: string;
}

const TIER_RULES: Record<string, TierRule> = {
  free:    { windowMs: 24 * 60 * 60 * 1000,           limit: 3,    periodLabel: "오늘" },
  starter: { windowMs: 30 * 24 * 60 * 60 * 1000,      limit: 30,   periodLabel: "이번 달" },
  pro:     { windowMs: 24 * 60 * 60 * 1000,           limit: null, periodLabel: "무제한" },
};

// Voice-clone caps. Phase 2 (ADR 0006): Free + Starter can keep one
// YingMusic reference voice; Pro keeps three on file. Anonymous callers
// can't upload at all (no row to hang a user_voices.user_id on).
const TIER_VOICE_CAPS: Record<string, number> = {
  free:    1,
  starter: 1,
  pro:     3,
};

export function tierVoiceCap(tier: string | null): number {
  if (tier === null) return 0;
  return TIER_VOICE_CAPS[tier] ?? 0;
}

// Phase D Y-2: RVC+KLM background training epochs per tier. Fewer epochs =
// faster wall-clock (~10min at 100ep vs ~25min at 250ep on a 4070 SUPER)
// at the cost of fidelity. Free's 100ep is the "beta — quick + rough"
// tradeoff; Pro's 250ep is the production target. Triggered automatically
// from POST /api/voice-samples — the user doesn't pick this.
const TIER_RVC_TRAIN_EPOCHS: Record<string, number> = {
  free:    100,
  starter: 200,
  pro:     250,
};

export function tierRvcTrainEpochs(tier: string | null): number {
  if (tier === null) return 0;
  return TIER_RVC_TRAIN_EPOCHS[tier] ?? TIER_RVC_TRAIN_EPOCHS.free;
}

export async function readUsage(userId: string, tier: string): Promise<UsageState> {
  const rule = TIER_RULES[tier] ?? TIER_RULES.free;
  const windowStart = new Date(Date.now() - rule.windowMs).toISOString();
  const sb = getSupabase();
  const { count, error } = await sb
    .from("usage_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", windowStart);
  if (error) throw error;
  return { used: count ?? 0, limit: rule.limit, periodLabel: rule.periodLabel, windowStart };
}

export async function logUsage(userId: string, action: UsageAction): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("usage_log").insert({ user_id: userId, action });
  if (error) throw error;
}
