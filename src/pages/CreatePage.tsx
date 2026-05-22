// Suno-style custom editor surfaced at /create. Reuses every input the
// existing Spark composer + 고급 modal already collect — just presents them
// in a two-panel layout so power users (especially anyone driving real
// lyrics) don't bounce between the composer and the modal.
//
// Same `apiGenerate` underneath; this page produces no new state, just a
// different surface onto the existing pipeline.
import { type FormEvent } from "react";
import type { VocalLanguageChoice } from "../api";
import {
  ALL_GENRES,
  LYRICS_MAX_LEN,
  MUSICAL_KEYS,
  type AdvancedSettings,
  type Generation,
  type GenreCategory,
  type Song,
  type Stage,
  type VariationType,
} from "../types";
import { Icon } from "../components/Icon";
import { SkeletonCard } from "../components/SkeletonCard";
import { SongCard, type SongAction } from "../components/SongCard";
import { VariationTray } from "../components/VariationTray";

interface CreatePageProps {
  prompt: string;
  setPrompt: (p: string) => void;
  lang: string;
  setLang: (l: string) => void;
  vocalLanguage: VocalLanguageChoice;
  setVocalLanguage: (v: VocalLanguageChoice) => void;
  advanced: AdvancedSettings;
  setAdvanced: (a: AdvancedSettings) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  stage: Stage;
  loadingMsg: string;
  currentGen: Generation | null;
  playingId: string | null;
  progress: number;
  onPlay: (id: string) => void;
  onPause: () => void;
  onLike: (id: string) => void;
  onAction: (action: SongAction, song: Song) => void;
  onVariation: (kind: VariationType) => void;
  songLengthLabel: string;
}

const PROMPT_MAX = 200;
// 30s free / 90s starter / 180s pro — the BE caps to tier on submit, so
// listing the full range here is honest; the user just sees their slider
// clamped at submit if they exceeded their tier.
const DURATION_OPTIONS: Array<{ value: AdvancedSettings["durationSec"]; label: string }> = [
  { value: "auto", label: "자동 (티어 기본)" },
  { value: 30, label: "30초" },
  { value: 60, label: "60초" },
  { value: 90, label: "90초" },
  { value: 120, label: "2분" },
  { value: 180, label: "3분" },
];

export function CreatePage(props: CreatePageProps) {
  const {
    prompt, setPrompt, lang, setLang, vocalLanguage, setVocalLanguage,
    advanced, setAdvanced, onSubmit, stage, loadingMsg, currentGen,
    playingId, progress, onPlay, onPause, onLike, onAction, onVariation,
    songLengthLabel,
  } = props;

  function patch<K extends keyof AdvancedSettings>(key: K, value: AdvancedSettings[K]) {
    setAdvanced({ ...advanced, [key]: value });
  }

  const likedInCurrent = currentGen ? currentGen.songs.filter((s) => s.liked).length : 0;

  return (
    <form className="create-page" onSubmit={onSubmit}>
      <div className="create-grid">

        {/* Left: lyrics dominate */}
        <section className="create-left">
          <div className="create-section-head">
            <Icon name="music-2" size={14} />
            <span>가사</span>
            <span className="create-section-hint">비워두면 인스트루멘탈로 만들어요</span>
          </div>
          <textarea
            className="create-lyrics"
            value={advanced.lyrics}
            onChange={(e) => patch("lyrics", e.target.value.slice(0, LYRICS_MAX_LEN))}
            placeholder={"[Verse]\n첫 줄 가사를 적어주세요\n\n[Chorus]\n후렴구는 이렇게…\n\n[Bridge]\n다른 분위기의 한 단락도"}
            maxLength={LYRICS_MAX_LEN}
            spellCheck={false}
          />
          <div className="create-lyrics-foot">
            <span className="create-section-hint">
              구조 태그: [Verse] [Chorus] [Bridge]
            </span>
            <span className="create-char-count">{advanced.lyrics.length}/{LYRICS_MAX_LEN}</span>
          </div>
        </section>

        {/* Right: style + meta */}
        <section className="create-right">
          <div className="create-section-head">
            <Icon name="sparkles" size={14} />
            <span>스타일</span>
          </div>

          <label className="create-field">
            <span className="create-field-label">설명</span>
            <input
              className="create-input"
              type="text"
              placeholder="잔잔한 카페 음악, 부드러운 기타…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={PROMPT_MAX}
            />
            <span className="create-char-count">{prompt.length}/{PROMPT_MAX}</span>
          </label>

          <div className="create-field-row">
            <label className="create-field">
              <span className="create-field-label">
                <Icon name="languages" size={11} /> 입력 언어
              </span>
              <select
                className="create-input"
                value={lang}
                onChange={(e) => setLang(e.target.value)}
              >
                <option value="KO">한국어</option>
                <option value="EN">English</option>
              </select>
            </label>

            <label className="create-field">
              <span className="create-field-label">
                <Icon name="mic" size={11} /> 보컬 언어
              </span>
              <select
                className="create-input"
                value={vocalLanguage}
                onChange={(e) => setVocalLanguage(e.target.value as VocalLanguageChoice)}
              >
                <option value="auto">자동</option>
                <option value="KO">한국어 (베타)</option>
                <option value="EN">영어</option>
              </select>
            </label>
          </div>

          <label className="create-field">
            <span className="create-field-label">장르</span>
            <select
              className="create-input"
              value={advanced.genre}
              onChange={(e) => patch("genre", e.target.value as GenreCategory | "auto")}
            >
              <option value="auto">자동 (프롬프트에서 감지)</option>
              {ALL_GENRES.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </label>

          <div className="create-field-row">
            <label className="create-field">
              <span className="create-field-label">BPM</span>
              <select
                className="create-input"
                value={advanced.bpm === "auto" ? "auto" : String(advanced.bpm)}
                onChange={(e) => patch("bpm", e.target.value === "auto" ? "auto" : Number(e.target.value))}
              >
                <option value="auto">자동</option>
                {[60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180].map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>

            <label className="create-field">
              <span className="create-field-label">조성 (Key)</span>
              <select
                className="create-input"
                value={advanced.key}
                onChange={(e) => patch("key", e.target.value)}
              >
                <option value="auto">자동</option>
                {MUSICAL_KEYS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="create-field">
            <span className="create-field-label">길이</span>
            <select
              className="create-input"
              value={advanced.durationSec === "auto" ? "auto" : String(advanced.durationSec)}
              onChange={(e) => patch("durationSec", e.target.value === "auto" ? "auto" : Number(e.target.value))}
            >
              {DURATION_OPTIONS.map((d) => (
                <option key={String(d.value)} value={String(d.value)}>{d.label}</option>
              ))}
            </select>
            <span className="create-section-hint">티어를 초과하면 자동으로 줄여요 (지금: {songLengthLabel})</span>
          </label>
        </section>
      </div>

      <div className="create-footer">
        <button
          type="submit"
          className="create-submit"
          disabled={!prompt.trim() || stage === "loading"}
        >
          {stage === "loading" ? (
            <>
              <Icon name="loader-2" size={16} style={{ animation: "spin 1s linear infinite" }} />
              생성 중
            </>
          ) : (
            <>
              <Icon name="sparkles" size={16} />
              곡 만들기
            </>
          )}
        </button>
      </div>

      {(stage === "loading" || stage === "results") && (
        <div className="create-result">
          <div className="create-result-head">
            <h3 className="create-result-title">
              {stage === "loading" ? "곡을 만드는 중…" : "방금 만든 곡"}
            </h3>
            {stage === "loading" && loadingMsg && (
              <span className="create-result-loading-msg">
                <span className="loader-pulse" />
                {loadingMsg}
              </span>
            )}
          </div>
          <div className="create-result-grid">
            {stage === "loading"
              ? <SkeletonCard delay={0} />
              : currentGen?.songs.map((song) => (
                  <SongCard
                    key={song.id}
                    song={song}
                    isPlaying={playingId === song.id}
                    progress={playingId === song.id ? progress : 0}
                    onPlay={onPlay}
                    onPause={onPause}
                    onLike={onLike}
                    onAction={onAction}
                  />
                ))}
          </div>
          {stage === "results" && likedInCurrent > 0 && (
            <VariationTray likedCount={likedInCurrent} onVariation={onVariation} />
          )}
        </div>
      )}
    </form>
  );
}
