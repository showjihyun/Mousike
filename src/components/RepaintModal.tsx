import { useState } from "react";
import type { Song } from "../types";

interface RepaintModalProps {
  song: Song;
  onClose: () => void;
  onSubmit: (startSec: number, endSec: number, caption: string) => void;
  loading: boolean;
}

export function RepaintModal({ song, onClose, onSubmit, loading }: RepaintModalProps) {
  const [startSec, setStartSec] = useState(30);
  const [endSec, setEndSec] = useState(60);
  const [caption, setCaption] = useState("");

  function handleSubmit() {
    if (startSec >= endSec) return;
    onSubmit(startSec, endSec, caption);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">✂️ 부분만 다시 만들기</span>
          <span className="modal-sub">"{song.title}"</span>
        </div>
        <div className="modal-body">
          <div className="modal-row">
            <label className="modal-label">시작 (초)</label>
            <input
              className="modal-input"
              type="number"
              min={0}
              max={endSec - 1}
              value={startSec}
              onChange={(e) => setStartSec(Number(e.target.value))}
              disabled={loading}
            />
          </div>
          <div className="modal-row">
            <label className="modal-label">끝 (초)</label>
            <input
              className="modal-input"
              type="number"
              min={startSec + 1}
              value={endSec}
              onChange={(e) => setEndSec(Number(e.target.value))}
              disabled={loading}
            />
          </div>
          <div className="modal-row">
            <label className="modal-label">어떻게 바꿀까요? (선택)</label>
            <input
              className="modal-input"
              type="text"
              placeholder="예: energetic drum break"
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
            disabled={loading || startSec >= endSec}
          >
            {loading ? "생성 중…" : "생성"}
          </button>
        </div>
      </div>
    </div>
  );
}
