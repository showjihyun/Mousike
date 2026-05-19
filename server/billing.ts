// Toss Payments one-time checkout. The flow:
//   1. POST /api/billing/checkout  → server mints orderId + pending row,
//                                    returns details for the Toss SDK
//   2. SPA hands those to the SDK which redirects to Toss → user pays
//   3. Toss redirects back to /billing/success?paymentKey&orderId&amount
//   4. SPA POSTs that triple to /api/billing/confirm → server calls
//      Toss confirm API → on DONE, flips user tier + sets tier_expires_at
//
// Idempotency: orderId is the row PK; confirm short-circuits if the row is
// already 'paid'. Tier flip extends to 30 days from the confirm time
// regardless of prior expiry (refresh, not stack — simpler UX).
import { randomBytes } from "crypto";
import type { Express } from "express";
import { getSupabase } from "./db.js";
import { requireAuth, type AuthUser, type Tier } from "./auth.js";

type PaidTier = Extract<Tier, "starter" | "pro">;

export const TIER_PRICES_KRW: Record<PaidTier, number> = {
  starter: 9_900,
  pro: 29_000,
};

const TIER_LABEL: Record<PaidTier, string> = {
  starter: "Starter (30일)",
  pro: "Pro (30일)",
};

const ACCESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TOSS_CONFIRM_URL = "https://api.tosspayments.com/v1/payments/confirm";

type ReceiptType = "소득공제" | "지출증빙";

interface PaymentRow {
  id: string;
  user_id: string;
  tier: PaidTier;
  amount_krw: number;
  status: "pending" | "paid" | "failed" | "refunded";
  receipt_type: ReceiptType | null;
  receipt_registration_no: string | null;
  receipt_email: string | null;
}

function isReceiptType(v: unknown): v is ReceiptType {
  return v === "소득공제" || v === "지출증빙";
}

// 휴대폰 (11d) for 소득공제, 사업자등록번호 (10d) for 지출증빙. Allow 10-13
// digits to leave room for either with or without hyphens stripped client-side.
function isRegistrationNo(v: unknown): v is string {
  return typeof v === "string" && /^\d{10,13}$/.test(v);
}

function mintOrderId(): string {
  return `mousike_${randomBytes(10).toString("hex")}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPaidTier(v: unknown): v is PaidTier {
  return v === "starter" || v === "pro";
}

export function mountBilling(app: Express): void {
  // Public endpoint — client key is meant to be embedded in the browser.
  // Returning it from the server keeps a single source of truth in .env.
  app.get("/api/billing/config", (_req, res) => {
    res.json({ clientKey: process.env.TOSS_CLIENT_KEY ?? "" });
  });

  app.post("/api/billing/checkout", requireAuth, async (req, res) => {
    const { tier, receiptType, registrationNo, receiptEmail } = req.body as {
      tier?: unknown;
      receiptType?: unknown;
      registrationNo?: unknown;
      receiptEmail?: unknown;
    };
    if (!isPaidTier(tier)) {
      res.status(400).json({ error: "tier must be 'starter' or 'pro'" });
      return;
    }
    // Receipt is optional — either fully provided (type + reg no) or omitted.
    const wantsReceipt = receiptType != null || registrationNo != null;
    if (wantsReceipt && !(isReceiptType(receiptType) && isRegistrationNo(registrationNo))) {
      res.status(400).json({ error: "receiptType + registrationNo must be valid" });
      return;
    }
    if (receiptEmail != null && (typeof receiptEmail !== "string" || receiptEmail.length > 254)) {
      res.status(400).json({ error: "receiptEmail invalid" });
      return;
    }

    try {
      const user = req.user as AuthUser;
      const orderId = mintOrderId();
      const amount = TIER_PRICES_KRW[tier];
      const sb = getSupabase();
      const { error } = await sb.from("payments").insert({
        id: orderId,
        user_id: user.id,
        tier,
        amount_krw: amount,
        status: "pending",
        receipt_type: wantsReceipt ? (receiptType as ReceiptType) : null,
        receipt_registration_no: wantsReceipt ? (registrationNo as string) : null,
        receipt_email: typeof receiptEmail === "string" ? receiptEmail : null,
      });
      if (error) throw error;
      res.json({
        orderId,
        amount,
        orderName: `Mousike ${TIER_LABEL[tier]}`,
        customerEmail: user.email,
        customerName: user.name ?? user.email,
      });
    } catch (err) {
      console.error("[billing/checkout] error:", errorMessage(err));
      res.status(500).json({ error: "checkout failed" });
    }
  });

  app.post("/api/billing/confirm", requireAuth, async (req, res) => {
    const { paymentKey, orderId, amount } = req.body as {
      paymentKey?: unknown;
      orderId?: unknown;
      amount?: unknown;
    };
    if (typeof paymentKey !== "string" || typeof orderId !== "string" || typeof amount !== "number") {
      res.status(400).json({ error: "paymentKey, orderId, amount required" });
      return;
    }

    try {
      const user = req.user as AuthUser;
      const sb = getSupabase();
      const { data, error } = await sb
        .from("payments")
        .select("id, user_id, tier, amount_krw, status, receipt_type, receipt_registration_no, receipt_email")
        .eq("id", orderId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      const row = data as PaymentRow | null;
      if (!row) {
        res.status(404).json({ error: "order not found" });
        return;
      }
      if (row.amount_krw !== amount) {
        // Client tried to confirm with a different amount than the pending
        // order — refuse before forwarding to Toss.
        res.status(400).json({ error: "amount mismatch" });
        return;
      }
      // Idempotent re-confirm. Toss themselves also reject a second confirm,
      // but short-circuiting here saves the round-trip.
      if (row.status === "paid") {
        res.json({ ok: true, tier: row.tier });
        return;
      }
      if (row.status !== "pending") {
        res.status(409).json({ error: `order is ${row.status}` });
        return;
      }

      const secretKey = process.env.TOSS_SECRET_KEY;
      if (!secretKey) {
        console.error("[billing/confirm] TOSS_SECRET_KEY not set");
        res.status(500).json({ error: "billing not configured" });
        return;
      }
      const auth = Buffer.from(`${secretKey}:`).toString("base64");
      const confirmBody: Record<string, unknown> = { paymentKey, orderId, amount };
      if (row.receipt_type && row.receipt_registration_no) {
        confirmBody.cashReceipt = {
          type: row.receipt_type,
          registrationNumber: row.receipt_registration_no,
        };
      }
      const tossRes = await fetch(TOSS_CONFIRM_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(confirmBody),
        signal: AbortSignal.timeout(15_000),
      });

      if (!tossRes.ok) {
        const tossErr = await tossRes.json().catch(() => ({}));
        console.error("[billing/confirm] Toss error:", tossRes.status, tossErr);
        await sb.from("payments")
          .update({ status: "failed" })
          .eq("id", orderId)
          .eq("status", "pending");
        res.status(402).json({ error: "payment confirmation failed" });
        return;
      }

      const expiresAt = new Date(Date.now() + ACCESS_WINDOW_MS).toISOString();
      const paidAt = new Date().toISOString();

      const { error: payErr } = await sb.from("payments")
        .update({ status: "paid", toss_payment_key: paymentKey, paid_at: paidAt })
        .eq("id", orderId);
      if (payErr) throw payErr;

      const { error: userErr } = await sb.from("users")
        .update({ tier: row.tier, tier_expires_at: expiresAt })
        .eq("id", row.user_id);
      if (userErr) throw userErr;

      res.json({ ok: true, tier: row.tier, expiresAt });
    } catch (err) {
      console.error("[billing/confirm] error:", errorMessage(err));
      res.status(500).json({ error: "confirm failed" });
    }
  });
}
