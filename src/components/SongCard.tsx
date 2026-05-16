import { formatTime } from "../data";
import type { Song } from "../types";
import { Icon } from "./Icon";
import { Waveform } from "./Waveform";

export type SongAction = "download" | "certificate" | "share";

interface SongCardProps {
  song: Song;
  isPlaying: boolean;
  progress: number;
  onPlay: (id: string) => void;
  onPause: () => void;
  onLike: (id: string) => void;
  onAction: (action: SongAction, song: Song) => void;
  locked?: boolean;
  bloom?: boolean;
  parentLabel?: string | null;
}

export function SongCard({
  song,
  isPlaying,
  progress,
  onPlay,
  onPause,
  onLike,
  onAction,
  locked = false,
  bloom = false,
  parentLabel,
}: SongCardProps) {
  const elapsed = Math.floor(progress * song.durationSec);

  return (
    <div className={`song-card ${isPlaying ? "playing" : ""} ${bloom ? "bloom" : ""}`}>
      <button
        className={`heart-btn ${song.liked ? "liked" : ""}`}
        onClick={() => onLike(song.id)}
        aria-label="좋아요"
      >
        <Icon name="heart" size={16} />
      </button>

      <div className="song-card-head">
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          {parentLabel && (
            <span className="parent-badge">
              <Icon name="git-branch" size={10} /> {parentLabel}
            </span>
          )}
          <h4 className="song-title">{song.title}</h4>
        </div>
        <span className="song-tag">{song.style.toUpperCase()}</span>
      </div>

      <div className="player-block">
        <button
          className="play-btn"
          onClick={() => (isPlaying ? onPause() : onPlay(song.id))}
          aria-label={isPlaying ? "일시정지" : "재생"}
        >
          <Icon name={isPlaying ? "pause" : "play"} size={16} />
        </button>
        <Waveform bars={song.waveform} progress={progress} playing={isPlaying} />
      </div>

      <div className="timestamp">
        <span>{formatTime(elapsed)}</span>
        <span>{formatTime(song.durationSec)}</span>
      </div>

      <div className="meta-strip">
        <span className="meta-chip"><Icon name="activity" size={11} /> {song.bpm} BPM</span>
        <span className="meta-chip">{song.key}</span>
        <span className="meta-chip">{song.vibe}</span>
        {song.instruments.map((it, i) => (
          <span key={i} className="meta-sep" style={{ color: "var(--fg-muted)" }}>
            · {it}
          </span>
        ))}
      </div>

      <div className="card-actions">
        <button
          className={`card-action ${locked ? "locked" : ""}`}
          onClick={() => !locked && onAction("download", song)}
          disabled={locked}
          title={locked ? "Pro 플랜에서 사용 가능" : "WAV 다운로드"}
        >
          <Icon name={locked ? "lock" : "download"} size={13} />
          다운로드
        </button>
        <button className="card-action" onClick={() => onAction("certificate", song)}>
          <Icon name="shield-check" size={13} />
          인증서
        </button>
        <button className="card-action" onClick={() => onAction("share", song)}>
          <Icon name="share-2" size={13} />
          공유
        </button>
      </div>
    </div>
  );
}
