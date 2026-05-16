import { formatTime } from "../data";
import type { Song } from "../types";
import { Icon } from "./Icon";

interface MiniPlayerProps {
  song: Song | null;
  playing: boolean;
  progress: number;
  onToggle: () => void;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
}

export function MiniPlayer({ song, playing, progress, onToggle, onNext, onPrev }: MiniPlayerProps) {
  if (!song) return null;
  const elapsed = Math.floor(progress * song.durationSec);
  return (
    <div className="mini-player">
      <div className="mp-art">
        <Icon name="music-2" size={14} />
      </div>
      <div className="mp-info">
        <div className="mp-title">{song.title}</div>
        <div className="mp-sub">{song.style} · {song.bpm} BPM</div>
      </div>
      <div className="mp-bar"><div className="mp-bar-fill" style={{ width: `${progress * 100}%` }} /></div>
      <span className="mp-time">{formatTime(elapsed)} / {formatTime(song.durationSec)}</span>
      <button className="mp-btn" onClick={onPrev} aria-label="이전"><Icon name="skip-back" size={14} /></button>
      <button className="mp-btn play" onClick={onToggle} aria-label={playing ? "일시정지" : "재생"}>
        <Icon name={playing ? "pause" : "play"} size={14} />
      </button>
      <button className="mp-btn" onClick={onNext} aria-label="다음"><Icon name="skip-forward" size={14} /></button>
    </div>
  );
}
