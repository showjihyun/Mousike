import type { VariationType } from "../types";
import { Icon } from "./Icon";

interface VariationTrayProps {
  likedCount: number;
  onVariation: (kind: VariationType) => void;
}

export function VariationTray({ likedCount, onVariation }: VariationTrayProps) {
  return (
    <div className="variation-tray">
      <div className="variation-tray-header">
        <Icon name="sparkles" size={14} />
        <span>
          <b>{likedCount}곡</b>에 좋아요를 눌렀어요. 더 만들어볼까요?
        </span>
      </div>
      <div className="variation-buttons">
        <button className="variation-btn" onClick={() => onVariation("similar")}>
          <span className="vb-emoji">✨</span>
          <span className="vb-title">비슷한 분위기로</span>
          <span className="vb-sub">같은 무드, 새 버전</span>
        </button>
        <button className="variation-btn" onClick={() => onVariation("restyle")}>
          <span className="vb-emoji">🎨</span>
          <span className="vb-title">다른 스타일로</span>
          <span className="vb-sub">멜로디 유지, 톤 변경</span>
        </button>
        <button className="variation-btn" onClick={() => onVariation("repaint")}>
          <span className="vb-emoji">✂️</span>
          <span className="vb-title">부분만 다시</span>
          <span className="vb-sub">구간 지정 재생성</span>
        </button>
        <button className="variation-btn" onClick={() => onVariation("lego")}>
          <span className="vb-emoji">🎸</span>
          <span className="vb-title">악기 추가/빼기</span>
          <span className="vb-sub">레이어 토글</span>
        </button>
      </div>
    </div>
  );
}
