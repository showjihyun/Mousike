import { goToLogin } from "../auth";

interface LoginModalProps {
  reason: string;
  onClose: () => void;
}

export function LoginModal({ reason, onClose }: LoginModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🔑 로그인이 필요해요</span>
          <span className="modal-sub">{reason}</span>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            구글 계정으로 로그인하면 다운로드, 부분 수정, 악기 변경이 가능합니다.
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn-cancel" onClick={onClose}>
            취소
          </button>
          <button className="modal-btn-submit" onClick={goToLogin}>
            Google로 로그인
          </button>
        </div>
      </div>
    </div>
  );
}
