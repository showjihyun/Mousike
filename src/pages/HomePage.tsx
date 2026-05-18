import { Fragment, type FormEvent } from "react";
import { PRESETS, POPULAR } from "../data";
import type { Generation, Preset, Song, Stage, VariationOptions, VariationType } from "../types";
import { Icon } from "../components/Icon";
import { LineageStrip } from "../components/LineageStrip";
import { PopularRow } from "../components/PopularRow";
import { SkeletonCard } from "../components/SkeletonCard";
import { SongCard, type SongAction } from "../components/SongCard";
import { VariationTray } from "../components/VariationTray";

interface HomePageProps {
  prompt: string;
  setPrompt: (p: string) => void;
  lang: string;
  setLang: (l: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onPresetClick: (p: Preset | { prompt: string }) => void;
  onStartFresh: () => void;
  stage: Stage;
  loadingMsg: string;
  pendingParent: VariationOptions | null;
  currentGen: Generation | null;
  lineageChain: Generation[];
  onJumpGen: (genId: string) => void;
  playingId: string | null;
  progress: number;
  onPlay: (id: string) => void;
  onPause: () => void;
  onLike: (id: string) => void;
  onAction: (action: SongAction, song: Song) => void;
  onVariation: (kind: VariationType) => void;
  findSong: (id: string) => Song | null;
  songLengthSec: number;
}

export function HomePage(props: HomePageProps) {
  const {
    prompt, setPrompt, lang, setLang, onSubmit, onPresetClick, onStartFresh,
    stage, loadingMsg, pendingParent, currentGen, lineageChain, onJumpGen,
    playingId, progress, onPlay, onPause, onLike, onAction, onVariation,
    songLengthSec,
  } = props;

  const likedInCurrent = currentGen ? currentGen.songs.filter((s) => s.liked).length : 0;
  const parentLabel = currentGen?.variationType === "restyle"
    ? "다른 스타일 변형"
    : currentGen?.variationType === "similar"
      ? "비슷한 분위기 변형"
      : currentGen?.variationType === "repaint"
        ? "부분 수정 변형"
        : currentGen?.variationType === "lego"
          ? "악기 변경 변형"
          : null;

  const pendingNode: Generation | null = stage === "loading" && pendingParent?.parentGenId
    ? {
        id: "__pending",
        prompt,
        parentGenId: pendingParent.parentGenId ?? null,
        parentSongId: pendingParent.parentSongId ?? null,
        variationType: pendingParent.variationType ?? null,
        songs: [],
        palette: ["#eee", "#ccc"],
        createdAt: new Date(),
      }
    : null;

  const showLineage = (currentGen && lineageChain.length >= 2) || pendingNode != null;
  const lineageDisplay = pendingNode ? [...lineageChain, pendingNode] : lineageChain;
  const lineageCurrentId = pendingNode ? pendingNode.id : currentGen?.id ?? null;

  return (
    <Fragment>
      {stage === "idle" && (
        <div className="hero">
          <span className="hero-eyebrow">
            <span style={{ color: "var(--accent-orange)" }}>NEW</span>
            <span>· 한국어 AI 음악 생성</span>
          </span>
          <h1 className="hero-title">
            한 줄로 시작하는<br />
            <span className="accent">음악 놀이터</span>
          </h1>
          <p className="hero-sub">
            "잔잔한 카페 음악" 한 줄이면 {songLengthSec}초 샘플 한 곡이 나옵니다.<br />
            마음에 드는 곡은 변형하고, 부분만 다시 만들고, 악기를 더해보세요.
          </p>
        </div>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <div className="composer-box">
          <input
            className="composer-input"
            type="text"
            placeholder="어떤 음악을 만들고 싶으세요?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
          <div className="composer-actions">
            <button
              type="button"
              className="lang-toggle"
              onClick={() => setLang(lang === "KO" ? "EN" : "KO")}
              title="입력 언어"
            >
              <Icon name="languages" size={12} /> {lang}
            </button>
            <button
              type="submit"
              className="generate-btn"
              disabled={!prompt.trim() || stage === "loading"}
            >
              {stage === "loading" ? (
                <Fragment>
                  <Icon name="loader-2" size={18} style={{ animation: "spin 1s linear infinite" }} />
                  생성 중
                </Fragment>
              ) : (
                <Fragment>
                  <Icon name="sparkles" size={18} />
                  곡 만들기
                </Fragment>
              )}
            </button>
          </div>
        </div>
        <div className="composer-meta">
          <div className="left">
            <span><kbd>Enter</kbd> 생성</span>
            <span>{songLengthSec}초 샘플 1곡</span>
            <span>약 {songLengthSec}초 소요</span>
          </div>
          <span>{prompt.length}/200</span>
        </div>
      </form>

      {stage === "idle" && (
        <div className="preset-section">
          <div className="preset-label">
            <Icon name="zap" size={12} />
            빠른 시작
          </div>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className="preset-chip"
                onClick={() => onPresetClick(p)}
              >
                <span className="preset-emoji" style={{ background: p.color }}>
                  {p.emoji}
                </span>
                <div className="preset-text">
                  <span className="preset-title">{p.title}</span>
                  <span className="preset-hint">{p.prompt}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {(stage === "loading" || stage === "results") && (
        <div className="stage-wrap">
          {showLineage && (
            <LineageStrip
              chain={lineageDisplay}
              currentGenId={lineageCurrentId}
              onJump={onJumpGen}
            />
          )}

          <div className="stage-header">
            <div>
              <h3 className="stage-title">
                {stage === "loading"
                  ? (pendingParent?.parentGenId ? "변형을 만드는 중…" : "방금 만든 곡들")
                  : (currentGen?.parentGenId ? "변형 결과" : "방금 만든 곡")}
              </h3>
              <p className="stage-sub">"{prompt}"</p>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {stage === "results" && (
                <button className="btn-ghost" onClick={() => onPresetClick({ prompt })} title="같은 프롬프트로 다시">
                  <Icon name="refresh-cw" size={13} /> 다시 만들기
                </button>
              )}
              <button className="btn-ghost" onClick={onStartFresh}>
                <Icon name="plus" size={13} /> 새 곡
              </button>
            </div>
          </div>

          {stage === "loading" && (
            <div className="loader-row">
              <span className="loader-pulse" />
              <span>{loadingMsg}</span>
            </div>
          )}

          <div className="result-grid">
            {stage === "loading"
              ? [0].map((i) => <SkeletonCard key={i} delay={i * 0.15} />)
              : currentGen?.songs.map((song, idx) => (
                  <SongCard
                    key={song.id}
                    song={song}
                    isPlaying={playingId === song.id}
                    progress={playingId === song.id ? progress : 0}
                    onPlay={onPlay}
                    onPause={onPause}
                    onLike={onLike}
                    onAction={onAction}
                    bloom={!!currentGen.parentGenId}
                    parentLabel={idx === 0 ? parentLabel : null}
                  />
                ))}
          </div>

          {stage === "results" && likedInCurrent > 0 && (
            <VariationTray likedCount={likedInCurrent} onVariation={onVariation} />
          )}
        </div>
      )}

      {stage === "idle" && <PopularRow items={POPULAR} onPlay={() => {}} />}
    </Fragment>
  );
}
