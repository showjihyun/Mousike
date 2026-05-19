import { useEffect, useState } from "react";
import type { Tier } from "../auth";
import type { ReceiptType } from "../api";
import { startCheckout } from "../billing";

interface UpgradeModalProps {
  currentTier: Tier | null; // null = anonymous (logged out)
  loggedIn: boolean;
  onClose: () => void;
  onRequireLogin: () => void;
  onError: (msg: string) => void;
}

interface Plan {
  id: Tier;
  name: string;
  price: string;
  highlight?: boolean;
  features: string[];
}

const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "₩0",
    features: [
      "30초 샘플 1곡",
      "하루 3곡 생성",
      "Mousike 음성 워터마크",
      "저작권 인증서 발급",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    price: "₩9,900 / 월",
    features: [
      "90초 샘플 트랙",
      "한 달 30곡 생성",
      "워터마크 없음",
      "저작권 인증서 발급",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "₩29,000 / 월",
    highlight: true,
    features: [
      "3분 풀 트랙",
      "무제한 생성",
      "워터마크 없음",
      "저작권 인증서 발급",
      "우선 처리 (예정)",
    ],
  },
];

export function UpgradeModal({ currentTier, loggedIn, onClose, onRequireLogin, onError }: UpgradeModalProps) {
  const [busyTier, setBusyTier] = useState<"starter" | "pro" | null>(null);
  // Receipt form state. Empty receiptType = "no receipt".
  const [receiptType, setReceiptType] = useState<ReceiptType | "">("");
  const [registrationNo, setRegistrationNo] = useState("");
  const [receiptEmail, setReceiptEmail] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busyTier) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busyTier]);

  function digitsOnly(s: string): string {
    return s.replace(/\D/g, "");
  }

  async function handleBuy(tier: "starter" | "pro") {
    if (!loggedIn) {
      onRequireLogin();
      return;
    }
    if (receiptType && !/^\d{10,13}$/.test(registrationNo)) {
      const expected = receiptType === "소득공제" ? "휴대폰번호 (11자리)" : "사업자등록번호 (10자리)";
      onError(`영수증 발급은 ${expected}가 필요해요.`);
      return;
    }
    setBusyTier(tier);
    try {
      await startCheckout({
        tier,
        ...(receiptType && { receiptType, registrationNo }),
        ...(receiptEmail && { receiptEmail }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "결제를 시작하지 못했어요";
      // Toss SDK rejects user-cancellation with a specific code — silence
      // that one so we don't toast on every cancel.
      if (!/cancel/i.test(message) && !/PAY_PROCESS_CANCELED/.test(message)) {
        onError(message);
      }
      setBusyTier(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busyTier && onClose()}>
      <div className="modal-card upgrade-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">✨ 플랜 비교</span>
          <span className="modal-sub">30일 단건 결제. 자동 결제(정기결제)는 곧 추가됩니다.</span>
        </div>
        <div className="modal-body">
          <div className="plan-grid">
            {PLANS.map((p) => {
              const isCurrent = currentTier === p.id;
              const isPaid = p.id === "starter" || p.id === "pro";
              return (
                <div
                  key={p.id}
                  className={`plan-col ${p.highlight ? "plan-col-highlight" : ""} ${isCurrent ? "plan-col-current" : ""}`}
                >
                  <div className="plan-head">
                    <div className="plan-name">{p.name}</div>
                    {isCurrent && <div className="plan-badge">현재 플랜</div>}
                  </div>
                  <div className="plan-price">{p.price}</div>
                  <ul className="plan-features">
                    {p.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {isPaid && (
                    <button
                      className="modal-btn-submit plan-buy"
                      onClick={() => handleBuy(p.id as "starter" | "pro")}
                      disabled={busyTier !== null || isCurrent}
                    >
                      {busyTier === p.id
                        ? "결제 페이지로…"
                        : isCurrent
                          ? "이용 중"
                          : "결제하기"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="receipt-form">
            <div className="modal-label" style={{ marginBottom: 6 }}>현금영수증 (선택)</div>
            <div className="receipt-type-row">
              <label className={`receipt-chip ${receiptType === "" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="receiptType"
                  checked={receiptType === ""}
                  onChange={() => { setReceiptType(""); setRegistrationNo(""); }}
                />
                발급 안 함
              </label>
              <label className={`receipt-chip ${receiptType === "소득공제" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="receiptType"
                  checked={receiptType === "소득공제"}
                  onChange={() => { setReceiptType("소득공제"); setRegistrationNo(""); }}
                />
                개인 (소득공제)
              </label>
              <label className={`receipt-chip ${receiptType === "지출증빙" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="receiptType"
                  checked={receiptType === "지출증빙"}
                  onChange={() => { setReceiptType("지출증빙"); setRegistrationNo(""); }}
                />
                사업자 (지출증빙)
              </label>
            </div>
            {receiptType && (
              <div className="receipt-fields">
                <input
                  className="modal-input"
                  type="text"
                  inputMode="numeric"
                  placeholder={receiptType === "소득공제" ? "휴대폰번호 (- 없이)" : "사업자등록번호 (- 없이)"}
                  value={registrationNo}
                  onChange={(e) => setRegistrationNo(digitsOnly(e.target.value))}
                  maxLength={13}
                  disabled={busyTier !== null}
                />
                <input
                  className="modal-input"
                  type="email"
                  placeholder="영수증 발송 이메일 (선택)"
                  value={receiptEmail}
                  onChange={(e) => setReceiptEmail(e.target.value)}
                  maxLength={254}
                  disabled={busyTier !== null}
                />
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn-cancel" onClick={onClose} disabled={busyTier !== null}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
