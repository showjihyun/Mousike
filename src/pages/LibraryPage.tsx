import { Fragment, useState } from "react";
import { daysAgoLabel, formatTime } from "../data";
import type { Generation, Song } from "../types";
import { FamilyTree } from "../components/FamilyTree";
import { Icon } from "../components/Icon";
import type { SongAction } from "../components/SongCard";

type LibraryView = "tree" | "list" | "liked";

interface LibraryPageProps {
  generations: Generation[];
  playingId: string | null;
  onPlay: (id: string) => void;
  onPause: () => void;
  onAction: (action: SongAction, song: Song) => void;
  onJumpToGen: (genId: string) => void;
}

interface SongWithGen extends Song {
  _gen: Generation;
}

export function LibraryPage({ generations, playingId, onPlay, onPause, onAction, onJumpToGen }: LibraryPageProps) {
  const [view, setView] = useState<LibraryView>("tree");

  const allSongs: SongWithGen[] = generations.flatMap((g) => g.songs.map((s) => ({ ...s, _gen: g })));
  const filtered = view === "liked" ? allSongs.filter((s) => s.liked) : allSongs;
  const totalLikes = allSongs.filter((s) => s.liked).length;

  return (
    <Fragment>
      <div className="library-head">
        <h1>내 라이브러리</h1>
      </div>
      <p className="library-sub">
        {generations.length}개 세대 · 총 {allSongs.length}곡 · {totalLikes}곡 좋아함
      </p>

      <div className="library-filter">
        <button className={`library-tab ${view === "tree" ? "active" : ""}`} onClick={() => setView("tree")}>
          🌱 진화 트리
        </button>
        <button className={`library-tab ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}>
          전체 ({allSongs.length})
        </button>
        <button className={`library-tab ${view === "liked" ? "active" : ""}`} onClick={() => setView("liked")}>
          좋아함 ({totalLikes})
        </button>
      </div>

      {view === "tree" && (
        <FamilyTree generations={generations} onJumpToGen={onJumpToGen} />
      )}

      {(view === "list" || view === "liked") && (
        filtered.length === 0 ? (
          <div className="empty-state">
            <div className="emoji">🎵</div>
            <div>아직 좋아한 곡이 없어요. 마음에 드는 곡에 ❤️ 를 눌러보세요.</div>
          </div>
        ) : (
          <div className="library-grid">
            {filtered.map((song, idx) => {
              const togglePlay = () => (playingId === song.id ? onPause() : onPlay(song.id));
              return (
                <div
                  key={song.id}
                  className="library-row"
                  role="button"
                  tabIndex={0}
                  onClick={togglePlay}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      togglePlay();
                    }
                  }}
                >
                  <div className="lr-idx">
                    <span className="num">{idx + 1}</span>
                    <span className="play"><Icon name={playingId === song.id ? "pause" : "play"} size={14} /></span>
                  </div>
                  <div>
                    <div className="lr-title">
                      {song.liked && <span style={{ color: "var(--accent-pink)", marginRight: 4 }}>❤</span>}
                      {song.title}
                    </div>
                    <div className="lr-prompt">{song.style} · {song.bpm} BPM · {song.vibe}</div>
                  </div>
                  <div className="lr-prompt">"{song._gen.prompt}"</div>
                  <div className="lr-date">{daysAgoLabel(song._gen.daysAgo ?? 0)}</div>
                  <div className="lr-dur">{formatTime(song.durationSec)}</div>
                  <button
                    className="lr-more"
                    onClick={(e) => { e.stopPropagation(); onAction("download", song); }}
                    aria-label="다운로드"
                    title="다운로드"
                  >
                    <Icon name="download" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )
      )}
    </Fragment>
  );
}
