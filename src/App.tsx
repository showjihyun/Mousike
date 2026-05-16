// ============================================================
// Mousike — Main App
// Home (Spark Mode) with lineage tracking + Library (with tree view)
// ============================================================
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { MiniPlayer } from "./components/MiniPlayer";
import type { SongAction } from "./components/SongCard";
import { Toast } from "./components/Toast";
import { Topbar } from "./components/Topbar";
import { SEED_GENERATIONS, makeGeneration } from "./data";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { loadCredits, loadGenerations, saveCredits, saveGenerations } from "./storage";
import type {
  Generation,
  Page,
  Preset,
  Song,
  Stage,
  VariationOptions,
  VariationType,
} from "./types";

const LOADING_MESSAGES = [
  "한국어를 영문 프롬프트로 변환하는 중…",
  "분위기를 잡는 중…",
  "악기를 고르는 중…",
  "BPM과 키를 결정하는 중…",
  "4가지 변형을 만드는 중…",
  "마무리 마스터링 중…",
];

const TOAST_MS = 2200;
const GENERATION_MS = 3000;
const LOADING_MSG_INTERVAL_MS = 700;
const PROGRESS_TICK_MS = 250;
const PROGRESS_TICK_SEC = PROGRESS_TICK_MS / 1000;

export function App() {
  const [page, setPage] = useState<Page>("home");

  // Composer
  const [prompt, setPrompt] = useState("");
  const [lang, setLang] = useState("KO");

  // Generation state — list of all generations (with parent links).
  // Lazy initializer so localStorage is read once, not on every render.
  const [generations, setGenerations] = useState<Generation[]>(() => loadGenerations() ?? SEED_GENERATIONS);
  const [currentGenId, setCurrentGenId] = useState<string | null>(null);

  // UI stage
  const [stage, setStage] = useState<Stage>("idle");
  const [loadingMsg, setLoadingMsg] = useState("");
  const [pendingParent, setPendingParent] = useState<VariationOptions | null>(null);

  // Player state
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [credits, setCredits] = useState<number>(() => loadCredits() ?? 3);
  const [toast, setToast] = useState<string | null>(null);

  const findSong = useCallback(
    (id: string): Song | null => {
      for (const g of generations) {
        const s = g.songs.find((s) => s.id === id);
        if (s) return s;
      }
      return null;
    },
    [generations],
  );

  const findGen = useCallback(
    (id: string): Generation | null => generations.find((g) => g.id === id) ?? null,
    [generations],
  );

  // Persist library + credits whenever they change.
  useEffect(() => { saveGenerations(generations); }, [generations]);
  useEffect(() => { saveCredits(credits); }, [credits]);

  // Auto-advance progress when something is playing
  useEffect(() => {
    if (!playingId) return;
    const song = findSong(playingId);
    if (!song) return;
    const interval = window.setInterval(() => {
      setProgress((p) => {
        const next = p + PROGRESS_TICK_SEC / song.durationSec;
        if (next >= 1) {
          setPlayingId(null);
          return 0;
        }
        return next;
      });
    }, PROGRESS_TICK_MS);
    return () => window.clearInterval(interval);
  }, [playingId, findSong]);

  const currentGen = currentGenId ? findGen(currentGenId) : null;

  const lineageChain = useMemo<Generation[]>(() => {
    if (!currentGen) return [];
    const chain: Generation[] = [currentGen];
    let cur: Generation | null = currentGen;
    while (cur && cur.parentGenId) {
      const parent = findGen(cur.parentGenId);
      if (!parent) break;
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }, [currentGen, findGen]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), TOAST_MS);
  }

  function generate(promptText: string, opts: VariationOptions = {}) {
    if (!promptText.trim()) return;
    if (credits <= 0) {
      showToast("오늘 무료 생성 한도를 모두 사용했어요. Pro로 업그레이드하세요!");
      return;
    }
    setStage("loading");
    setPrompt(promptText);
    setPlayingId(null);
    setProgress(0);
    setPendingParent(opts);

    let i = 0;
    setLoadingMsg(LOADING_MESSAGES[0]);
    const msgInterval = window.setInterval(() => {
      i = (i + 1) % LOADING_MESSAGES.length;
      setLoadingMsg(LOADING_MESSAGES[i]);
    }, LOADING_MSG_INTERVAL_MS);

    window.setTimeout(() => {
      window.clearInterval(msgInterval);
      const newGen = makeGeneration({
        prompt: promptText,
        parentGenId: opts.parentGenId ?? null,
        parentSongId: opts.parentSongId ?? null,
        variationType: opts.variationType ?? null,
      });
      newGen.daysAgo = 0;
      setGenerations((gs) => [newGen, ...gs]);
      setCurrentGenId(newGen.id);
      setStage("results");
      setCredits((c) => Math.max(0, c - 1));
      setPlayingId(newGen.songs[0].id);
      setProgress(0);
      setPendingParent(null);
    }, GENERATION_MS);
  }

  function handlePlay(id: string) {
    if (playingId === id) return;
    setPlayingId(id);
    setProgress(0);
  }

  function handlePause() {
    setPlayingId(null);
  }

  function handleToggleMini() {
    if (playingId) setPlayingId(null);
    else if (currentGen?.songs[0]) handlePlay(currentGen.songs[0].id);
  }

  function handleLike(id: string) {
    setGenerations((gs) =>
      gs.map((g) => ({
        ...g,
        songs: g.songs.map((s) => (s.id === id ? { ...s, liked: !s.liked } : s)),
      })),
    );
  }

  function handleAction(action: SongAction, song: Song) {
    if (action === "download") showToast(`"${song.title}" 다운로드를 시작합니다.`);
    else if (action === "certificate") showToast("저작권 안전성 인증서 PDF를 발급했어요.");
    else if (action === "share") showToast("공유 링크가 클립보드에 복사됐어요.");
  }

  function handleVariation(kind: VariationType) {
    if (!currentGen) return;
    const liked = currentGen.songs.find((s) => s.liked);
    if (!liked) {
      showToast("먼저 마음에 드는 곡에 ❤️ 를 눌러주세요.");
      return;
    }
    const newPrompt = kind === "similar"
      ? `${liked.prompt} (비슷한 분위기로)`
      : `${liked.prompt} (다른 스타일로)`;
    generate(newPrompt, {
      parentGenId: currentGen.id,
      parentSongId: liked.id,
      variationType: kind,
    });
  }

  function handleJumpToGen(genId: string) {
    const gen = findGen(genId);
    if (!gen) return;
    setCurrentGenId(genId);
    setStage("results");
    setPrompt(gen.prompt);
    setPlayingId(gen.songs[0].id);
    setProgress(0);
    setPage("home");
  }

  function handlePresetClick(p: Preset | { prompt: string }) {
    setPrompt(p.prompt);
    generate(p.prompt);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    generate(prompt);
  }

  function handleStartFresh() {
    setStage("idle");
    setCurrentGenId(null);
    setPrompt("");
    setPlayingId(null);
  }

  const playingSong = playingId ? findSong(playingId) : null;

  return (
    <div className="app" data-screen-label={page === "home" ? "01 Home" : "02 Library"}>
      <Topbar page={page} onPage={setPage} credits={credits} onHome={handleStartFresh} />

      <div className="main">
        <div className="main-inner">
          {page === "home" && (
            <HomePage
              prompt={prompt}
              setPrompt={setPrompt}
              lang={lang}
              setLang={setLang}
              onSubmit={handleSubmit}
              onPresetClick={handlePresetClick}
              onStartFresh={handleStartFresh}
              stage={stage}
              loadingMsg={loadingMsg}
              pendingParent={pendingParent}
              currentGen={currentGen}
              lineageChain={lineageChain}
              onJumpGen={handleJumpToGen}
              playingId={playingId}
              progress={progress}
              onPlay={handlePlay}
              onPause={handlePause}
              onLike={handleLike}
              onAction={handleAction}
              onVariation={handleVariation}
              credits={credits}
              findSong={findSong}
            />
          )}
          {page === "library" && (
            <LibraryPage
              generations={generations}
              playingId={playingId}
              onPlay={handlePlay}
              onPause={handlePause}
              onAction={handleAction}
              onJumpToGen={handleJumpToGen}
            />
          )}
        </div>
      </div>

      <MiniPlayer
        song={playingSong}
        playing={!!playingId}
        progress={progress}
        onToggle={handleToggleMini}
        onClose={() => setPlayingId(null)}
        onNext={() => {
          if (!currentGen) return;
          const idx = currentGen.songs.findIndex((r) => r.id === playingId);
          const nextIdx = (idx + 1) % currentGen.songs.length;
          handlePlay(currentGen.songs[nextIdx].id);
        }}
        onPrev={() => {
          if (!currentGen) return;
          const idx = currentGen.songs.findIndex((r) => r.id === playingId);
          const prevIdx = (idx - 1 + currentGen.songs.length) % currentGen.songs.length;
          handlePlay(currentGen.songs[prevIdx].id);
        }}
      />

      <Toast message={toast} />
    </div>
  );
}
