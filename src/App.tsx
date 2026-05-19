// ============================================================
// Mousike — Main App
// Home (Spark Mode) with lineage tracking + Library (with tree view)
// ============================================================
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generate as apiGenerate,
  repaint as apiRepaint,
  lego as apiLego,
  fetchGenerations,
  postGeneration,
  patchSongLiked,
  fetchUsage,
  downloadCertBlob,
  type Lang,
  type Usage,
} from "./api";
import { type AuthUser, fetchCurrentUser, goToLogin, logout as apiLogout } from "./auth";
import { LegoModal } from "./components/LegoModal";
import { LoginModal } from "./components/LoginModal";
import { UpgradeModal } from "./components/UpgradeModal";
import { MiniPlayer } from "./components/MiniPlayer";
import { RepaintModal } from "./components/RepaintModal";
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

// Three tries with 500ms / 1000ms backoff. Returns true if any attempt
// succeeds, false after the last attempt fails. Callers decide whether the
// failure is worth surfacing.
async function withRetry(fn: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fn();
      return true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return false;
}

const LOADING_MESSAGES = [
  "한국어를 영문 프롬프트로 변환하는 중…",
  "분위기를 잡는 중…",
  "악기를 고르는 중…",
  "BPM과 키를 결정하는 중…",
  "곡을 만드는 중…",
  "마무리 마스터링 중…",
];

const TOAST_MS = 2200;
const LOADING_MSG_INTERVAL_MS = 700;

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
  const audioRef = useRef<HTMLAudioElement>(null);

  // Variation modals
  const [repaintFor, setRepaintFor] = useState<{ song: Song; genId: string } | null>(null);
  const [legoFor, setLegoFor] = useState<{ song: Song; genId: string } | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

  // Auth: null = not loaded yet OR anonymous. Fetched once on mount.
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loginPromptReason, setLoginPromptReason] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Server-truth usage for logged-in users. Anonymous users keep the client-only
  // 3/day cap via `credits`/localStorage below.
  const [serverUsage, setServerUsage] = useState<Usage | null>(null);

  useEffect(() => {
    fetchCurrentUser()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  // On login: load library + credits from Supabase. If the server library is
  // empty but localStorage has data, upload the local copy first so the user
  // keeps what they had. Logout restoration is done synchronously in the
  // logout handler so the save effect can't overwrite localStorage with the
  // logged-in snapshot mid-transition.
  useEffect(() => {
    if (!user) {
      setServerUsage(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [serverGens, usage] = await Promise.all([
          fetchGenerations(),
          fetchUsage(),
        ]);
        if (cancelled) return;
        const localGens = loadGenerations();
        const shouldMigrate = serverGens.length === 0 && localGens && localGens.length > 0;
        if (shouldMigrate && localGens) {
          await Promise.allSettled(localGens.map((g) => postGeneration(g)));
          if (cancelled) return;
          setGenerations(localGens);
          showToast("라이브러리를 계정으로 옮겼어요");
        } else {
          setGenerations(serverGens.length > 0 ? serverGens : SEED_GENERATIONS);
        }
        setServerUsage(usage);
      } catch (e) {
        if (cancelled) return;
        showToast(`라이브러리 동기화 실패: ${e instanceof Error ? e.message : ""}`);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

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

  // Persist library + credits — but only while anonymous. When logged in,
  // Supabase is the source of truth (and localStorage stays frozen at the
  // pre-login state so logout restores the anonymous view).
  useEffect(() => { if (!user) saveGenerations(generations); }, [generations, user]);
  useEffect(() => { if (!user) saveCredits(credits); }, [credits, user]);

  // Drive audio element from playingId; report progress via audio events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!playingId) {
      audio.pause();
      return;
    }
    const song = findSong(playingId);
    if (!song?.audioUrl) {
      // Old localStorage songs have no real audio — don't attempt playback
      setPlayingId(null);
      return;
    }
    if (audio.src !== song.audioUrl) {
      audio.src = song.audioUrl;
      audio.dataset.songId = song.id;
    }
    audio.play().catch(() => setPlayingId(null));
  }, [playingId, findSong]);

  // Attach audio event listeners once (element is stable across renders)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setProgress(audio.currentTime / audio.duration);
    const onEnded = () => { setPlayingId(null); setProgress(0); };
    const onLoadedMetadata = () => {
      // Match by id stored in dataset — `audio.src` returns the browser-
      // resolved absolute URL, which doesn't always equal song.audioUrl as
      // a string (origins, query strings, etc.).
      const songId = audio.dataset.songId;
      if (!songId) return;
      const dur = audio.duration;
      if (!Number.isFinite(dur)) return;
      setGenerations((gs) =>
        gs.map((g) => ({
          ...g,
          songs: g.songs.map((s) => (s.id === songId ? { ...s, durationSec: dur } : s)),
        })),
      );
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, []);

  const currentGen = currentGenId ? findGen(currentGenId) : null;

  // Logged-in: serverUsage from /api/usage. Anonymous: a synthetic Usage built
  // from localStorage credits so Topbar + checks have one shape to work with.
  const displayUsage: Usage = user && serverUsage
    ? serverUsage
    : { used: 3 - credits, limit: 3, periodLabel: "오늘", windowStart: "" };
  const overQuota = displayUsage.limit !== null && displayUsage.used >= displayUsage.limit;

  function consumeOneUse() {
    if (user && serverUsage) {
      setServerUsage({ ...serverUsage, used: serverUsage.used + 1 });
    } else {
      setCredits((c) => Math.max(0, c - 1));
    }
  }

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

  async function generate(promptText: string, opts: VariationOptions = {}) {
    if (!promptText.trim()) return;
    if (overQuota) {
      showToast(`${displayUsage.periodLabel} 한도를 모두 사용했어요. ${user ? "Pro로 업그레이드하세요!" : "로그인하면 더 많이 생성할 수 있어요."}`);
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

    try {
      const backendSongs = await apiGenerate(promptText, lang as Lang, (p) => {
        // First real status from the server wins over the canned rotation —
        // a queue position is more informative than "분위기를 잡는 중…".
        if (p.status === "queued") {
          window.clearInterval(msgInterval);
          const ahead = (p.queuePosition ?? 1) - 1;
          setLoadingMsg(ahead > 0 ? `${ahead}명 앞에 대기 중…` : "곧 시작합니다…");
        } else if (p.status === "running") {
          window.clearInterval(msgInterval);
          setLoadingMsg("곡을 만드는 중…");
        }
      });
      const newGen = makeGeneration({
        prompt: promptText,
        parentGenId: opts.parentGenId ?? null,
        parentSongId: opts.parentSongId ?? null,
        variationType: opts.variationType ?? null,
      });
      newGen.songs = newGen.songs.map((s, idx) => ({
        ...s,
        audioUrl: backendSongs[idx]?.audioUrl,
      }));
      newGen.daysAgo = 0;
      setGenerations((gs) => [newGen, ...gs]);
      setCurrentGenId(newGen.id);
      setStage("results");
      consumeOneUse();
      setPlayingId(newGen.songs[0].id);
      setProgress(0);
      if (user) {
        withRetry(() => postGeneration(newGen)).then((ok) => {
          if (!ok) showToast(`"${newGen.songs[0].title}" 저장 실패 — 새로고침 시 사라질 수 있어요`);
        });
      }
    } catch (e) {
      showToast(`생성 실패: ${e instanceof Error ? e.message : "백엔드를 확인하세요"}`);
      setStage("idle");
    } finally {
      window.clearInterval(msgInterval);
      setPendingParent(null);
    }
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
    const song = findSong(id);
    if (!song) return;
    const newLiked = !song.liked;
    setGenerations((gs) =>
      gs.map((g) => ({
        ...g,
        songs: g.songs.map((s) => (s.id === id ? { ...s, liked: newLiked } : s)),
      })),
    );
    if (user) withRetry(() => patchSongLiked(id, newLiked));
  }

  async function downloadSong(song: Song) {
    if (!song.audioUrl) {
      showToast("이 곡에는 다운로드할 오디오가 없어요.");
      return;
    }
    if (!user) {
      setLoginPromptReason("곡을 다운로드하려면 로그인이 필요합니다.");
      return;
    }
    // Swap the public /audio path for the auth-gated /api/download endpoint so
    // a stale session falls back to 401 instead of silently leaking the file.
    const filename = song.audioUrl.split("/audio/")[1];
    const downloadUrl = filename
      ? song.audioUrl.replace(`/audio/${filename}`, `/api/download/${filename}`)
      : song.audioUrl;
    try {
      const res = await fetch(downloadUrl, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${song.title}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`"${song.title}" 다운로드를 시작했어요.`);
    } catch (e) {
      showToast(`다운로드 실패: ${e instanceof Error ? e.message : "다시 시도하세요"}`);
    }
  }

  async function downloadCert(song: Song) {
    if (!user) {
      setLoginPromptReason("저작권 인증서 발급은 로그인이 필요합니다.");
      return;
    }
    try {
      const blob = await downloadCertBlob(song.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mousike-cert-${song.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast(`"${song.title}" 인증서를 발급했어요.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "다시 시도하세요";
      const friendly = msg === "song not found"
        ? "이 곡은 아직 서버에 저장되지 않아 인증서를 발급할 수 없어요."
        : msg;
      showToast(`인증서 발급 실패: ${friendly}`);
    }
  }

  function handleAction(action: SongAction, song: Song) {
    if (action === "download") downloadSong(song);
    else if (action === "certificate") downloadCert(song);
    else if (action === "share") showToast("공유 기능은 곧 추가됩니다.");
  }

  function handleVariation(kind: VariationType) {
    if (!currentGen) return;
    const liked = currentGen.songs.find((s) => s.liked);
    if (!liked) {
      showToast("먼저 마음에 드는 곡에 ❤️ 를 눌러주세요.");
      return;
    }
    if (kind === "repaint") {
      if (!liked.audioUrl) {
        showToast("이 곡에는 오디오가 없어 부분 수정이 불가합니다.");
        return;
      }
      if (!user) {
        setLoginPromptReason("부분 수정 기능은 로그인 후 이용할 수 있어요.");
        return;
      }
      setRepaintFor({ song: liked, genId: currentGen.id });
      return;
    }
    if (kind === "lego") {
      if (!liked.audioUrl) {
        showToast("이 곡에는 오디오가 없어 악기 변경이 불가합니다.");
        return;
      }
      if (!user) {
        setLoginPromptReason("악기 변경 기능은 로그인 후 이용할 수 있어요.");
        return;
      }
      setLegoFor({ song: liked, genId: currentGen.id });
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

  async function handleRepaintSubmit(startSec: number, endSec: number, caption: string) {
    if (!repaintFor) return;
    if (overQuota) {
      showToast(`${displayUsage.periodLabel} 한도를 모두 사용했어요.`);
      setRepaintFor(null);
      return;
    }
    const { song, genId } = repaintFor;
    setModalLoading(true);
    try {
      const backendSongs = await apiRepaint({
        sourceAudioUrl: song.audioUrl!,
        startSec,
        endSec,
        caption: caption || undefined,
        parentSongId: song.id,
      });
      const newGen = makeGeneration({
        prompt: song.prompt,
        parentGenId: genId,
        parentSongId: song.id,
        variationType: "repaint",
      });
      newGen.songs = newGen.songs.map((s, idx) => ({
        ...s,
        audioUrl: backendSongs[idx]?.audioUrl,
      }));
      newGen.daysAgo = 0;
      setGenerations((gs) => [newGen, ...gs]);
      setCurrentGenId(newGen.id);
      setStage("results");
      consumeOneUse();
      setPlayingId(newGen.songs[0].id);
      setProgress(0);
      setRepaintFor(null);
      if (user) {
        withRetry(() => postGeneration(newGen)).then((ok) => {
          if (!ok) showToast(`"${newGen.songs[0].title}" 저장 실패 — 새로고침 시 사라질 수 있어요`);
        });
      }
    } catch (e) {
      showToast(`부분 수정 실패: ${e instanceof Error ? e.message : "백엔드를 확인하세요"}`);
    } finally {
      setModalLoading(false);
    }
  }

  async function handleLegoSubmit(instruments: string[], caption: string) {
    if (!legoFor) return;
    if (overQuota) {
      showToast(`${displayUsage.periodLabel} 한도를 모두 사용했어요.`);
      setLegoFor(null);
      return;
    }
    const { song, genId } = legoFor;
    setModalLoading(true);
    try {
      const backendSongs = await apiLego({
        sourceAudioUrl: song.audioUrl!,
        instruments,
        caption: caption || undefined,
        parentSongId: song.id,
      });
      const newGen = makeGeneration({
        prompt: song.prompt,
        parentGenId: genId,
        parentSongId: song.id,
        variationType: "lego",
      });
      newGen.songs = newGen.songs.map((s, idx) => ({
        ...s,
        audioUrl: backendSongs[idx]?.audioUrl,
      }));
      newGen.daysAgo = 0;
      setGenerations((gs) => [newGen, ...gs]);
      setCurrentGenId(newGen.id);
      setStage("results");
      consumeOneUse();
      setPlayingId(newGen.songs[0].id);
      setProgress(0);
      setLegoFor(null);
      if (user) {
        withRetry(() => postGeneration(newGen)).then((ok) => {
          if (!ok) showToast(`"${newGen.songs[0].title}" 저장 실패 — 새로고침 시 사라질 수 있어요`);
        });
      }
    } catch (e) {
      showToast(`악기 변경 실패: ${e instanceof Error ? e.message : "백엔드를 확인하세요"}`);
    } finally {
      setModalLoading(false);
    }
  }

  function handleJumpToGen(genId: string) {
    const gen = findGen(genId);
    if (!gen || gen.songs.length === 0) return;
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

  // Mirror server/index.ts:durationForUser. Pro gets 3-minute full tracks;
  // starter sits at the 90s sample length; free + anonymous get the 30s sample.
  const songLengthSec = user?.tier === "pro" ? 180 : user?.tier === "starter" ? 90 : 30;
  const songLengthLabel = songLengthSec >= 120
    ? `${Math.floor(songLengthSec / 60)}분`
    : `${songLengthSec}초`;

  return (
    <div className="app" data-screen-label={page === "home" ? "01 Home" : "02 Library"}>
      <Topbar
        page={page}
        onPage={setPage}
        usage={displayUsage}
        onHome={handleStartFresh}
        user={user}
        onLogin={goToLogin}
        onLogout={async () => {
          // Reset client state even if the network call fails — otherwise a
          // server unreachable at logout time would leave the user logged-in
          // in the UI but with a session the server has invalidated.
          try {
            await apiLogout();
          } finally {
            setGenerations(loadGenerations() ?? SEED_GENERATIONS);
            setCredits(loadCredits() ?? 3);
            setUser(null);
          }
        }}
        onUpgrade={() => setUpgradeOpen(true)}
        onHelp={() => showToast("도움말은 아직 준비 중이에요!")}
      />

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
              findSong={findSong}
              songLengthLabel={songLengthLabel}
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

      <audio ref={audioRef} style={{ display: "none" }} />

      <MiniPlayer
        song={playingSong}
        playing={!!playingId}
        progress={progress}
        onToggle={handleToggleMini}
        onClose={() => setPlayingId(null)}
        onNext={() => {
          if (!currentGen || currentGen.songs.length === 0) return;
          const idx = currentGen.songs.findIndex((r) => r.id === playingId);
          const nextIdx = (idx + 1) % currentGen.songs.length;
          handlePlay(currentGen.songs[nextIdx].id);
        }}
        onPrev={() => {
          if (!currentGen || currentGen.songs.length === 0) return;
          const idx = currentGen.songs.findIndex((r) => r.id === playingId);
          const prevIdx = (idx - 1 + currentGen.songs.length) % currentGen.songs.length;
          handlePlay(currentGen.songs[prevIdx].id);
        }}
      />

      <Toast message={toast} />

      {repaintFor && (
        <RepaintModal
          song={repaintFor.song}
          onClose={() => !modalLoading && setRepaintFor(null)}
          onSubmit={handleRepaintSubmit}
          loading={modalLoading}
        />
      )}

      {legoFor && (
        <LegoModal
          song={legoFor.song}
          onClose={() => !modalLoading && setLegoFor(null)}
          onSubmit={handleLegoSubmit}
          loading={modalLoading}
        />
      )}

      {loginPromptReason && (
        <LoginModal
          reason={loginPromptReason}
          onClose={() => setLoginPromptReason(null)}
        />
      )}

      {upgradeOpen && (
        <UpgradeModal
          currentTier={user?.tier ?? null}
          onClose={() => setUpgradeOpen(false)}
        />
      )}
    </div>
  );
}
