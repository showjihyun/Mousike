import { useEffect, useState } from "react";
import {
  ALL_GENRES,
  DEFAULT_ADVANCED,
  LYRICS_MAX_LEN,
  MUSICAL_KEYS,
  type AdvancedSettings,
  type GenreCategory,
} from "../types";

interface AdvancedModalProps {
  initial: AdvancedSettings;
  maxDurationSec: number;
  onClose: () => void;
  onSubmit: (settings: AdvancedSettings) => void;
}

const DURATION_OPTIONS = [15, 30, 60, 90, 120, 180];

function clampBpm(raw: string): number | "auto" {
  if (!raw) return "auto";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "auto";
  return Math.min(180, Math.max(60, Math.round(n)));
}

export function AdvancedModal({ initial, maxDurationSec, onClose, onSubmit }: AdvancedModalProps) {
  const [s, setS] = useState<AdvancedSettings>(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pickGenre(g: GenreCategory | "auto") {
    setS((prev) => ({ ...prev, genre: g }));
  }

  function setBpmAuto() { setS((prev) => ({ ...prev, bpm: "auto" })); }
  function setBpmValue(raw: string) { setS((prev) => ({ ...prev, bpm: clampBpm(raw) })); }

  function setKey(v: string) {
    setS((prev) => ({ ...prev, key: v === "auto" ? "auto" : v }));
  }

  function setDuration(v: string) {
    setS((prev) => ({ ...prev, durationSec: v === "auto" ? "auto" : Number(v) }));
  }

  function setLyrics(v: string) {
    setS((prev) => ({ ...prev, lyrics: v.slice(0, LYRICS_MAX_LEN) }));
  }

  function handleSubmit() { onSubmit(s); }
  function handleReset() { setS(DEFAULT_ADVANCED); }

  const durationsForTier = DURATION_OPTIONS.filter((d) => d <= maxDurationSec);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">⚙️ 고급 설정</span>
          <span className="modal-sub">자동에 두면 기본 동작을 그대로 사용해요</span>
        </div>
        <div className="modal-body">
          <section className="adv-section">
            <div className="adv-label">장르</div>
            <div className="adv-chip-row">
              <button
                type="button"
                className={`adv-chip ${s.genre === "auto" ? "selected" : ""}`}
                onClick={() => pickGenre("auto")}
              >자동 감지</button>
              {ALL_GENRES.map((g) => (
                <button
                  type="button"
                  key={g.value}
                  className={`adv-chip ${s.genre === g.value ? "selected" : ""}`}
                  onClick={() => pickGenre(g.value)}
                >{g.label}</button>
              ))}
            </div>
          </section>

          <section className="adv-section">
            <div className="adv-label">BPM (빠르기)</div>
            <div className="adv-row">
              <label className={`adv-chip ${s.bpm === "auto" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="bpm-mode"
                  checked={s.bpm === "auto"}
                  onChange={setBpmAuto}
                  style={{ display: "none" }}
                />
                자동
              </label>
              <input
                className="adv-number"
                type="number"
                min={60}
                max={180}
                step={1}
                value={s.bpm === "auto" ? "" : s.bpm}
                placeholder="60–180"
                onChange={(e) => setBpmValue(e.target.value)}
              />
            </div>
          </section>

          <section className="adv-section">
            <div className="adv-label">조성 (Key)</div>
            <select
              className="adv-select"
              value={s.key}
              onChange={(e) => setKey(e.target.value)}
            >
              <option value="auto">자동</option>
              {MUSICAL_KEYS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </section>

          <section className="adv-section">
            <div className="adv-label">길이</div>
            <select
              className="adv-select"
              value={s.durationSec}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option value="auto">자동 ({maxDurationSec}초)</option>
              {durationsForTier.map((d) => (
                <option key={d} value={d}>{d}초</option>
              ))}
            </select>
          </section>

          <section className="adv-section">
            <div className="adv-label">가사 (선택)</div>
            <textarea
              className="adv-textarea"
              value={s.lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              placeholder={"비워두면 인스트루멘탈로 생성돼요.\n구조 태그 사용 가능: [Verse] [Chorus] [Bridge]"}
              rows={6}
              maxLength={LYRICS_MAX_LEN}
              spellCheck={false}
            />
            <div className="adv-char-count">{s.lyrics.length}/{LYRICS_MAX_LEN}</div>
          </section>
        </div>
        <div className="modal-footer">
          <button className="modal-btn-cancel" onClick={handleReset}>모두 자동으로</button>
          <button className="modal-btn-submit" onClick={handleSubmit}>적용</button>
        </div>
      </div>
    </div>
  );
}
