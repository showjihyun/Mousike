// Voice-clone page — Phase 1 of the musicai-stack pivot (ADR 0005).
// Upload 2-5 vocal samples → click 학습 시작 → server trains an RVC model →
// click 들어보기 to hear the trained voice singing the canned backing
// track. The 들어보기 result plays inline from an audio element scoped to
// the active row.
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  deleteVoice,
  fetchVoices,
  requestVoiceDemo,
  startVoiceTraining,
  uploadVoiceSamples,
  type UserVoice,
  type VoiceStatus,
} from "../api";
import type { AuthUser, Tier } from "../auth";
import { Icon } from "../components/Icon";

interface VoicePageProps {
  user: AuthUser | null;
  onRequireLogin: () => void;
  onShowToast: (msg: string) => void;
}

const STATUS_LABELS: Record<VoiceStatus, { label: string; cls: string }> = {
  uploading: { label: "업로드 완료", cls: "voice-status-pending" },
  training: { label: "학습 중", cls: "voice-status-training" },
  trained: { label: "준비 완료", cls: "voice-status-trained" },
  failed: { label: "실패", cls: "voice-status-failed" },
};

const TIER_CAP: Record<Tier, number> = { free: 1, starter: 1, pro: 3 };
const TIER_EPOCHS: Record<Tier, number> = { free: 100, starter: 200, pro: 250 };

const POLL_INTERVAL_MS = 5_000;

interface DemoState {
  voiceId: string;
  status: "loading" | "ready" | "error";
  audioUrl?: string;
  error?: string;
}

export function VoicePage({ user, onRequireLogin, onShowToast }: VoicePageProps) {
  const [voices, setVoices] = useState<UserVoice[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [demo, setDemo] = useState<DemoState | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!user) {
      setVoices([]);
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    async function refresh(initial: boolean) {
      try {
        const list = await fetchVoices();
        if (!cancelled) setVoices(list);
      } catch (e) {
        if (!cancelled && initial) {
          onShowToast(`보이스 목록 로드 실패: ${e instanceof Error ? e.message : ""}`);
        }
      } finally {
        if (!cancelled && initial) setInitialLoading(false);
      }
    }
    refresh(true);
    const interval = window.setInterval(() => refresh(false), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user, onShowToast]);

  // Autoplay the demo once the audio element gets a fresh src. play() can
  // reject if the browser blocks autoplay — surface that as a toast so
  // the user knows to interact.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || demo?.status !== "ready" || !demo.audioUrl) return;
    audio.src = demo.audioUrl;
    audio.play().catch((e: unknown) => {
      onShowToast(`재생 실패: ${e instanceof Error ? e.message : ""}`);
    });
  }, [demo, onShowToast]);

  const handleUploadSuccess = useCallback(
    (v: UserVoice) => {
      setVoices((vs) => [v, ...vs]);
      onShowToast(`"${v.displayName}" 업로드 완료. 학습 시작 버튼을 눌러주세요.`);
    },
    [onShowToast],
  );

  const handleTrain = useCallback(
    async (voiceId: string) => {
      try {
        await startVoiceTraining(voiceId);
        onShowToast("학습 시작했어요. 완료까지 보통 10-25분.");
        // Optimistic: flip the local row to training so the badge updates
        // immediately instead of waiting up to 5s for the next poll tick.
        setVoices((vs) =>
          vs.map((v) => (v.id === voiceId ? { ...v, status: "training" as VoiceStatus, error: null } : v)),
        );
      } catch (e) {
        onShowToast(`학습 시작 실패: ${e instanceof Error ? e.message : ""}`);
      }
    },
    [onShowToast],
  );

  const handleDemo = useCallback(
    async (voiceId: string) => {
      setDemo({ voiceId, status: "loading" });
      try {
        const songs = await requestVoiceDemo(voiceId);
        const url = songs[0]?.audioUrl;
        if (!url) throw new Error("결과에 오디오가 없어요");
        setDemo({ voiceId, status: "ready", audioUrl: url });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        setDemo({ voiceId, status: "error", error: msg });
        onShowToast(`들어보기 실패: ${msg}`);
      }
    },
    [onShowToast],
  );

  const handleDelete = useCallback(
    async (voiceId: string, displayName: string) => {
      if (!window.confirm(`"${displayName}" 보이스를 삭제할까요? 학습된 모델과 샘플이 모두 삭제됩니다.`)) {
        return;
      }
      try {
        await deleteVoice(voiceId);
        setVoices((vs) => vs.filter((v) => v.id !== voiceId));
        if (demo?.voiceId === voiceId) setDemo(null);
        onShowToast("삭제했어요.");
      } catch (e) {
        onShowToast(`삭제 실패: ${e instanceof Error ? e.message : ""}`);
      }
    },
    [demo, onShowToast],
  );

  if (!user) {
    return (
      <div className="voice-gate">
        <div className="voice-gate-emoji">🎤</div>
        <h1>내 목소리로 노래</h1>
        <p className="voice-gate-sub">
          보컬 샘플 2-5개를 업로드하면 내 목소리로 부르는 곡을 만들 수 있어요.
          시작하려면 로그인이 필요해요.
        </p>
        <button className="btn-primary" onClick={onRequireLogin}>
          로그인하기
        </button>
      </div>
    );
  }

  const cap = TIER_CAP[user.tier];
  const epochsForTier = TIER_EPOCHS[user.tier];
  const active = voices.filter((v) => v.status !== "failed").length;
  const canCreate = active < cap;

  return (
    <>
      <div className="voice-head">
        <h1>🎤 내 보이스</h1>
        <p className="voice-sub">
          내 목소리를 학습시켜 곡에 입혀보세요. {tierLabel(user.tier)} {active}/{cap} 사용 ·
          학습 {epochsForTier} epoch
          {user.tier === "free" && (
            <span className="voice-beta-label"> (베타 · 빠른 학습 / 낮은 품질)</span>
          )}
        </p>
      </div>

      {canCreate ? (
        <UploadCard
          tier={user.tier}
          onSuccess={handleUploadSuccess}
          onError={onShowToast}
        />
      ) : (
        <div className="voice-cap-notice">
          {tierLabel(user.tier)} 한도({cap}개)에 도달했어요.
          {user.tier !== "pro" && " Pro로 업그레이드하면 3개까지 만들 수 있어요."}
        </div>
      )}

      {initialLoading ? (
        <div className="voice-empty">
          <div>불러오는 중…</div>
        </div>
      ) : voices.length === 0 ? (
        <div className="voice-empty">
          <div className="emoji">🎤</div>
          <div>아직 보이스가 없어요. 위에서 첫 보이스를 만들어보세요.</div>
        </div>
      ) : (
        <div className="voice-list">
          {voices.map((v) => (
            <VoiceRow
              key={v.id}
              voice={v}
              demo={demo?.voiceId === v.id ? demo : null}
              onTrain={() => handleTrain(v.id)}
              onDemo={() => handleDemo(v.id)}
              onDelete={() => handleDelete(v.id, v.displayName)}
            />
          ))}
        </div>
      )}

      {/* Single shared audio element — only one demo plays at a time. */}
      <audio ref={audioRef} style={{ display: "none" }} controls={false} />
    </>
  );
}

function tierLabel(tier: Tier): string {
  if (tier === "pro") return "Pro";
  if (tier === "starter") return "Starter";
  return "Free";
}

interface UploadCardProps {
  tier: Tier;
  onSuccess: (v: UserVoice) => void;
  onError: (msg: string) => void;
}

function UploadCard({ tier, onSuccess, onError }: UploadCardProps) {
  const [displayName, setDisplayName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalMb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;

  function pickFiles(fileList: FileList | null) {
    if (!fileList) return;
    const all = Array.from(fileList);
    const accepted = all.filter((f) => /\.(mp3|wav)$/i.test(f.name)).slice(0, 5);
    if (accepted.length === 0 && all.length > 0) {
      onError("mp3 또는 wav 파일만 첨부할 수 있어요.");
      return;
    }
    setFiles(accepted);
  }

  // Replace <label> with explicit click handler — some browsers + extension
  // setups (and disabled inputs) suppress the implicit label→input click
  // bridge, leading to "the dropzone does nothing." Triggering .click() on
  // the ref is the more reliable path and is also the natural anchor for
  // drag-drop handlers.
  function handleZoneClick() {
    if (submitting) return;
    inputRef.current?.click();
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (submitting) return;
    e.preventDefault();
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    // dragleave fires on entering child elements too — only clear when the
    // pointer actually leaves the dropzone rectangle.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragging(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (submitting) return;
    pickFiles(e.dataTransfer.files);
  }

  async function handleSubmit() {
    if (submitting) return;
    const name = displayName.trim();
    if (!name) {
      onError("보이스 이름을 입력해주세요.");
      return;
    }
    if (files.length < 2) {
      onError("샘플 파일 2-5개를 첨부해주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const v = await uploadVoiceSamples(name, files);
      setDisplayName("");
      setFiles([]);
      onSuccess(v);
    } catch (e) {
      onError(`업로드 실패: ${e instanceof Error ? e.message : ""}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="voice-upload-card">
      <div className="voice-upload-head">새 보이스 만들기</div>
      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value.slice(0, 64))}
        placeholder="보이스 이름 (예: 내 목소리)"
        className="voice-input"
        disabled={submitting}
        maxLength={64}
      />
      {/* dropzone: drag-drop ONLY. No click handler on the div itself —
          a previous version intercepted clicks meant for the upload button
          below because the div's hit-area extended past the visible dashed
          box. File selection is now a dedicated button rendered inside. */}
      <div
        className={`voice-dropzone ${dragging ? "voice-dropzone-active" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          multiple
          onChange={(e) => pickFiles(e.target.files)}
          disabled={submitting}
          style={{ display: "none" }}
        />
        <div className="voice-dropzone-inner">
          {files.length === 0 ? (
            <>
              <div className="voice-dropzone-emoji">🎙️</div>
              <div className="voice-dropzone-main">mp3/wav 파일 2-5개</div>
              <div className="voice-dropzone-hint">
                여기로 드래그하거나 아래 버튼 클릭. 총 30-180초 깨끗한 보컬.
              </div>
              <button
                type="button"
                className="voice-dropzone-pick-btn"
                onClick={handleZoneClick}
                disabled={submitting}
              >
                파일 선택
              </button>
            </>
          ) : (
            <>
              <div className="voice-dropzone-emoji">✓</div>
              <div className="voice-dropzone-main">
                {files.length}개 파일 · {totalMb.toFixed(1)}MB
              </div>
              <ul className="voice-file-list">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>{f.name}</li>
                ))}
              </ul>
              <button
                type="button"
                className="voice-dropzone-pick-btn"
                onClick={handleZoneClick}
                disabled={submitting}
              >
                다시 선택
              </button>
            </>
          )}
        </div>
      </div>
      <div className="voice-upload-actions">
        <button
          className="btn-primary"
          onClick={handleSubmit}
          disabled={submitting || !displayName.trim() || files.length < 2}
        >
          {submitting ? "업로드 중…" : "업로드"}
        </button>
        <span className="voice-upload-note">
          업로드 후 학습 버튼을 눌러 시작 (~{tier === "pro" ? 25 : tier === "starter" ? 20 : 10}분 소요)
        </span>
      </div>
    </div>
  );
}

interface VoiceRowProps {
  voice: UserVoice;
  demo: DemoState | null;
  onTrain: () => void;
  onDemo: () => void;
  onDelete: () => void;
}

function VoiceRow({ voice, demo, onTrain, onDemo, onDelete }: VoiceRowProps) {
  const status = STATUS_LABELS[voice.status];
  const created = new Date(voice.createdAt);
  return (
    <div className="voice-row">
      <div className="voice-row-main">
        <div className="voice-row-name">{voice.displayName}</div>
        <div className="voice-row-meta">
          {voice.sampleSeconds ?? "?"}초 샘플 · {voice.epochs} epoch ·
          {" "}
          {created.toLocaleDateString("ko-KR")}
        </div>
        {voice.error && <div className="voice-row-error">{voice.error}</div>}
      </div>
      <div className={`voice-status ${status.cls}`}>{status.label}</div>
      <div className="voice-row-actions">
        {(voice.status === "uploading" || voice.status === "failed") && (
          <button className="btn-ghost voice-row-btn" onClick={onTrain}>
            {voice.status === "failed" ? "다시 시도" : "학습 시작"}
          </button>
        )}
        {voice.status === "trained" && (
          <button
            className="btn-ghost voice-row-btn"
            onClick={onDemo}
            disabled={demo?.status === "loading"}
            title={demo?.status === "loading" ? "처리 중… (1-2분)" : "들어보기"}
          >
            <Icon name="play" size={14} />
            {demo?.status === "loading" ? "처리 중…" : "들어보기"}
          </button>
        )}
        <button
          className="btn-ghost voice-row-btn voice-row-delete"
          onClick={onDelete}
          aria-label="삭제"
          title="삭제"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
