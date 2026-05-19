// Frontend half of the Toss checkout. The server's /api/billing/checkout
// mints the orderId + amount; we just hand them to the Toss SDK and let it
// redirect the user. After payment the user lands back on /billing/success
// (or /billing/fail) and App.tsx finishes the confirm round-trip.
import { loadTossPayments } from "@tosspayments/payment-sdk";
import { fetchBillingConfig, postCheckout, type ReceiptType } from "./api";

export async function startCheckout(args: {
  tier: "starter" | "pro";
  receiptType?: ReceiptType;
  registrationNo?: string;
  receiptEmail?: string;
}): Promise<void> {
  const [{ clientKey }, order] = await Promise.all([
    fetchBillingConfig(),
    postCheckout(args),
  ]);
  if (!clientKey) {
    throw new Error("결제 기능이 아직 설정되지 않았어요");
  }
  const tossPayments = await loadTossPayments(clientKey);
  const origin = window.location.origin;
  // requestPayment never resolves on success — it redirects to successUrl.
  // It rejects with a user-cancellation error if they close the modal.
  await tossPayments.requestPayment("카드", {
    amount: order.amount,
    orderId: order.orderId,
    orderName: order.orderName,
    customerEmail: order.customerEmail,
    customerName: order.customerName,
    successUrl: `${origin}/billing/success`,
    failUrl: `${origin}/billing/fail`,
  });
}
