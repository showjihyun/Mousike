import type { Tier } from "../auth";

interface UpgradeModalProps {
  currentTier: Tier | null; // null = anonymous (logged out)
  onClose: () => void;
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
    highlight: true,
    features: [
      "90초 풀 트랙",
      "한 달 30곡 생성",
      "워터마크 없음",
      "저작권 인증서 발급",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "₩29,000 / 월",
    features: [
      "90초 풀 트랙",
      "무제한 생성",
      "워터마크 없음",
      "저작권 인증서 발급",
      "우선 처리 (예정)",
    ],
  },
];

export function UpgradeModal({ currentTier, onClose }: UpgradeModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card upgrade-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">✨ 플랜 비교</span>
          <span className="modal-sub">결제 기능 준비 중 — Toss 연동 예정</span>
        </div>
        <div className="modal-body">
          <div className="plan-grid">
            {PLANS.map((p) => {
              const isCurrent = currentTier === p.id;
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
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn-submit" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
