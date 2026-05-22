// /create — sci-fi STUDIO. Full-screen, dark, neon. Replaces the in-shell
// 2-panel composer with a HUD-style editor: minimal header (back + brand +
// usage), two glass panels (LYRICS / SIGNAL CONFIG), and a luminous CTA.
//
// Same data flow as before — every input feeds the existing apiGenerate
// pipeline. No BE changes. The visual idiom is scoped via .sf-* classes so
// the home/library pages stay untouched.
import { type FormEvent } from "react";
import type { Usage, VocalLanguageChoice } from "../api";
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
import { SongCard, type SongAction } from "../components/SongCard";

interface CreatePageProps {
  onBack: () => void;
  usage: Usage;
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
const DURATION_OPTIONS: Array<{ value: AdvancedSettings["durationSec"]; label: string }> = [
  { value: "auto", label: "AUTO" },
  { value: 30, label: "30 s" },
  { value: 60, label: "60 s" },
  { value: 90, label: "90 s" },
  { value: 120, label: "120 s" },
  { value: 180, label: "180 s" },
];

export function CreatePage(props: CreatePageProps) {
  const {
    onBack, usage, prompt, setPrompt, lang, setLang, vocalLanguage,
    setVocalLanguage, advanced, setAdvanced, onSubmit, stage, loadingMsg,
    currentGen, playingId, progress, onPlay, onPause, onLike, onAction,
    songLengthLabel,
  } = props;

  function patch<K extends keyof AdvancedSettings>(key: K, value: AdvancedSettings[K]) {
    setAdvanced({ ...advanced, [key]: value });
  }

  const remaining = usage.limit != null ? Math.max(0, usage.limit - usage.used) : null;

  return (
    <>
      {/* HUD header */}
      <header className="sf-header">
        <div className="sf-header-left">
          <button type="button" className="sf-back" onClick={onBack}>
            ◀ EXIT
          </button>
          <div className="sf-brand">
            <span>MOUSIKE</span>
            <span className="sf-brand-divider">/</span>
            <span className="sf-brand-mode">STUDIO</span>
          </div>
        </div>
        <div className="sf-header-right">
          {remaining != null ? (
            <span className="sf-usage">
              CREDITS <b>{remaining}/{usage.limit}</b>
            </span>
          ) : (
            <span className="sf-usage">CREDITS <b>∞</b></span>
          )}
        </div>
      </header>

      <main className="sf-main">
        <form onSubmit={onSubmit}>
          <div className="sf-grid">

            {/* LYRICS panel */}
            <section className="sf-panel">
              <div className="sf-panel-head">
                <span className="sf-panel-head-bar" />
                LYRICS
                <span className="sf-panel-head-hint">optional · empty = instrumental</span>
              </div>
              <textarea
                className="sf-lyrics"
                value={advanced.lyrics}
                onChange={(e) => patch("lyrics", e.target.value.slice(0, LYRICS_MAX_LEN))}
                placeholder={"[Verse]\n첫 줄 가사를 적어주세요\n\n[Chorus]\n후렴구는 이렇게…\n\n[Bridge]\n다른 분위기의 한 단락도"}
                maxLength={LYRICS_MAX_LEN}
                spellCheck={false}
              />
              <div className="sf-lyrics-foot">
                <span>STRUCTURE TAGS · [Verse] [Chorus] [Bridge]</span>
                <span>{advanced.lyrics.length} / {LYRICS_MAX_LEN}</span>
              </div>
            </section>

            {/* SIGNAL CONFIG panel */}
            <section className="sf-panel">
              <div className="sf-panel-head">
                <span className="sf-panel-head-bar" />
                SIGNAL CONFIG
              </div>

              <div className="sf-field">
                <label className="sf-field-label" htmlFor="sf-prompt">▌ STYLE PROMPT</label>
                <input
                  id="sf-prompt"
                  className="sf-input"
                  type="text"
                  placeholder="잔잔한 카페 음악, 부드러운 기타…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  maxLength={PROMPT_MAX}
                />
                <span className="sf-field-hint">{prompt.length} / {PROMPT_MAX}</span>
              </div>

              <div className="sf-field-row">
                <div className="sf-field">
                  <label className="sf-field-label" htmlFor="sf-lang">▌ INPUT LANG</label>
                  <select id="sf-lang" className="sf-select" value={lang} onChange={(e) => setLang(e.target.value)}>
                    <option value="KO">한국어</option>
                    <option value="EN">English</option>
                  </select>
                </div>
                <div className="sf-field">
                  <label className="sf-field-label" htmlFor="sf-vocal">▌ VOCAL LANG</label>
                  <select
                    id="sf-vocal"
                    className="sf-select"
                    value={vocalLanguage}
                    onChange={(e) => setVocalLanguage(e.target.value as VocalLanguageChoice)}
                  >
                    <option value="auto">AUTO</option>
                    <option value="KO">한국어 (BETA)</option>
                    <option value="EN">영어</option>
                  </select>
                </div>
              </div>

              <div className="sf-field">
                <label className="sf-field-label" htmlFor="sf-genre">▌ GENRE</label>
                <select
                  id="sf-genre"
                  className="sf-select"
                  value={advanced.genre}
                  onChange={(e) => patch("genre", e.target.value as GenreCategory | "auto")}
                >
                  <option value="auto">AUTO (detect from prompt)</option>
                  {ALL_GENRES.map((g) => (
                    <option key={g.value} value={g.value}>{g.label}</option>
                  ))}
                </select>
              </div>

              <div className="sf-field-row">
                <div className="sf-field">
                  <label className="sf-field-label" htmlFor="sf-bpm">▌ BPM</label>
                  <select
                    id="sf-bpm"
                    className="sf-select"
                    value={advanced.bpm === "auto" ? "auto" : String(advanced.bpm)}
                    onChange={(e) => patch("bpm", e.target.value === "auto" ? "auto" : Number(e.target.value))}
                  >
                    <option value="auto">AUTO</option>
                    {[60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180].map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
                <div className="sf-field">
                  <label className="sf-field-label" htmlFor="sf-key">▌ KEY</label>
                  <select id="sf-key" className="sf-select" value={advanced.key} onChange={(e) => patch("key", e.target.value)}>
                    <option value="auto">AUTO</option>
                    {MUSICAL_KEYS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="sf-field">
                <label className="sf-field-label" htmlFor="sf-dur">▌ DURATION</label>
                <select
                  id="sf-dur"
                  className="sf-select"
                  value={advanced.durationSec === "auto" ? "auto" : String(advanced.durationSec)}
                  onChange={(e) => patch("durationSec", e.target.value === "auto" ? "auto" : Number(e.target.value))}
                >
                  {DURATION_OPTIONS.map((d) => (
                    <option key={String(d.value)} value={String(d.value)}>{d.label}</option>
                  ))}
                </select>
                <span className="sf-field-hint">tier cap applies · current → {songLengthLabel}</span>
              </div>
            </section>
          </div>

          {/* CTA */}
          <div className="sf-cta-row">
            <button type="submit" className="sf-cta" disabled={!prompt.trim() || stage === "loading"}>
              {stage === "loading" ? "◐ GENERATING…" : "⚡ GENERATE"}
            </button>
          </div>
        </form>

        {/* Result panel */}
        {(stage === "loading" || stage === "results") && (
          <section className="sf-result">
            <div className="sf-result-head">
              <h3 className="sf-result-title">
                {stage === "loading" ? "▒ TRANSMISSION IN PROGRESS" : "▓ TRANSMISSION RECEIVED"}
              </h3>
              <span className="sf-result-status">
                <span className="sf-status-dot" />
                {stage === "loading" ? (loadingMsg || "PROCESSING…") : "READY"}
              </span>
            </div>
            {stage === "results" && currentGen?.songs.map((song) => (
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
          </section>
        )}
      </main>
    </>
  );
}
