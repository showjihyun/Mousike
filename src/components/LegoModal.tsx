import { useState } from "react";
import type { Song } from "../types";

const INSTRUMENT_OPTIONS = ["기타", "피아노", "드럼", "베이스", "신디사이저", "보컬"] as const;

interface LegoModalProps {
  song: Song;
  onClose: () => void;
  onSubmit: (instruments: string[], caption: string) => void;
  loading: boolean;
}

export function LegoModal({ song, onClose, onSubmit, loading }: LegoModalProps) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [caption, setCaption] = useState("");

  function toggle(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function handleSubmit() {
    if (checked.size === 0) return;
    onSubmit(Array.from(checked), caption);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">🎸 악기 추가/빼기</span>
          <span className="modal-sub">"{song.title}"</span>
        </div>
        <div className="modal-body">
          <div className="modal-label" style={{ marginBottom: 8 }}>악기 선택 (하나 이상)</div>
          <div className="lego-grid">
            {INSTRUMENT_OPTIONS.map((name) => (
              <label key={name} className={`lego-chip ${checked.has(name) ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked.has(name)}
                  onChange={() => toggle(name)}
                  disabled={loading}
                  style={{ display: "none" }}
                />
                {name}
              </label>
            ))}
          </div>
          <div className="modal-row" style={{ marginTop: 12 }}>
            <label className="modal-label">추가 설명 (선택)</label>
            <input
              className="modal-input"
              type="text"
              placeholder="예: 더 강렬하게"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              disabled={loading}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn-cancel" onClick={onClose} disabled={loading}>
            취소
          </button>
          <button
            className="modal-btn-submit"
            onClick={handleSubmit}
            disabled={loading || checked.size === 0}
          >
            {loading ? "생성 중…" : "생성"}
          </button>
        </div>
      </div>
    </div>
  );
}
