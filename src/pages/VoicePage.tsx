// Voice-clone page — Phase 2 of the musicai-stack pivot (ADR 0006).
// YingMusic-SVC zero-shot: upload one 10-60s reference clip → row goes
// straight to 'ready' → next generation auto-applies the voice via the
// ACE-Step + BR-separator chain. No training step, no demo button.
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  deleteVoice,
  fetchVoices,
  uploadVoiceSamples,
  type UserVoice,
  type VoiceStatus,
} from "../api";
import type { AuthUser, Tier } from "../auth";

interface VoicePageProps {
  user: AuthUser | null;
  onRequireLogin: () => void;
  onShowToast: (msg: string) => void;
}

// Legacy 'uploading' / 'training' / 'trained' come from pre-migration RVC
// rows; the migration wipes them so they shouldn't appear in practice,
// but the FE still renders them safely for any in-flight edge case.
const STATUS_LABELS: Record<VoiceStatus, { label: string; cls: string }> = {
  uploading: { label: "업로드 중", cls: "voice-status-pending" },
  training: { label: "학습 중", cls: "voice-status-training" },
  trained: { label: "준비 완료", cls: "voice-status-trained" },
  ready: { label: "준비 완료", cls: "voice-status-trained" },
  failed: { label: "실패", cls: "voice-status-failed" },
};

const TIER_CAP: Record<Tier, number> = { free: 1, starter: 1, pro: 3 };

const POLL_INTERVAL_MS = 5_000;

export function VoicePage({ user, onRequireLogin, onShowToast }: VoicePageProps) {
  const [voices, setVoices] = useState<UserVoice[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setVoices([]);
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchVoices();
        if (!cancelled) setVoices(list);
      } catch (e) {
        if (!cancelled) {
          onShowToast(`보이스 목록 로드 실패: ${e instanceof Error ? e.message : ""}`);
        }
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, onShowToast]);

  // Phase 2 voices land in a terminal state ('ready' or 'failed') the moment
  // upload returns, so polling has nothing to observe most of the time. Only
  // run the interval while a legacy RVC row is still 'uploading' or 'training'
  // — the only states whose status changes asynchronously.
  const hasPendingVoice = voices.some(
    (v) => v.status === "uploading" || v.status === "training",
  );
  useEffect(() => {
    if (!user || !hasPendingVoice) return;
    let cancelled = false;
    const interval = window.setInterval(() => {
      void fetchVoices().then((list) => {
        if (!cancelled) setVoices(list);
      }).catch(() => { /* transient — next tick retries */ });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user, hasPendingVoice]);

  const handleUploadSuccess = useCallback(
    (v: UserVoice) => {
      setVoices((vs) => [v, ...vs]);
      onShowToast(`"${v.displayName}" 준비 완료. 다음 곡 생성에 자동 적용됩니다.`);
    },
    [onShowToast],
  );

  const handleDelete = useCallback(
    async (voiceId: string, displayName: string) => {
      if (!window.confirm(`"${displayName}" 보이스를 삭제할까요? 업로드한 샘플이 모두 삭제됩니다.`)) {
        return;
      }
      try {
        await deleteVoice(voiceId);
        setVoices((vs) => vs.filter((v) => v.id !== voiceId));
        onShowToast("삭제했어요.");
      } catch (e) {
        onShowToast(`삭제 실패: ${e instanceof Error ? e.message : ""}`);
      }
    },
    [onShowToast],
  );

  if (!user) {
    return (
      <div className="voice-gate">
        <div className="voice-gate-emoji">🎤</div>
        <h1>내 목소리로 노래</h1>
        <p className="voice-gate-sub">
          보컬 샘플 한 개(10-60초)만 올리면 다음 곡부터 내 목소리로 불러줘요.
          시작하려면 로그인이 필요해요.
        </p>
        <button className="btn-primary" onClick={onRequireLogin}>
          로그인하기
        </button>
      </div>
    );
  }

  const cap = TIER_CAP[user.tier];
  const active = voices.filter((v) => v.status !== "failed").length;
  const canCreate = active < cap;

  return (
    <>
      <div className="voice-head">
        <h1>🎤 내 보이스</h1>
        <p className="voice-sub">
          보컬 샘플 한 개를 올리면 다음 곡 생성에 자동으로 내 목소리가 입혀져요.
          {" "}{tierLabel(user.tier)} {active}/{cap} 사용
        </p>
      </div>

      {canCreate ? (
        <UploadCard
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
          <div>아직 보이스가 없어요. 위에서 첫 보이스를 올려보세요.</div>
        </div>
      ) : (
        <div className="voice-list">
          {voices.map((v) => (
            <VoiceRow
              key={v.id}
              voice={v}
              onDelete={() => handleDelete(v.id, v.displayName)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function tierLabel(tier: Tier): string {
  if (tier === "pro") return "Pro";
  if (tier === "starter") return "Starter";
  return "Free";
}

interface UploadCardProps {
  onSuccess: (v: UserVoice) => void;
  onError: (msg: string) => void;
}

function UploadCard({ onSuccess, onError }: UploadCardProps) {
  const [displayName, setDisplayName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalMb = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024;

  function pickFiles(fileList: FileList | null) {
    if (!fileList) return;
    const all = Array.from(fileList);
    // YingMusic zero-shot uses exactly one reference clip — take the first
    // accepted file. If the picker returned a multi-file selection we
    // silently drop the extras instead of erroring; the UI hint already
    // says "1개" so this matches user expectation.
    const accepted = all.filter((f) => /\.(mp3|wav)$/i.test(f.name)).slice(0, 1);
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
    if (files.length < 1) {
      onError("샘플 파일 한 개를 첨부해주세요.");
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
              <div className="voice-dropzone-main">mp3/wav 파일 1개</div>
              <div className="voice-dropzone-hint">
                여기로 드래그하거나 아래 버튼 클릭. <strong>한 사람 목소리만</strong>,
                10-60초 깨끗한 보컬. 잡음이 적을수록 결과가 좋아져요.
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
                {files[0].name} · {totalMb.toFixed(1)}MB
              </div>
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
          disabled={submitting || !displayName.trim() || files.length < 1}
        >
          {submitting ? "업로드 중…" : "업로드"}
        </button>
        <span className="voice-upload-note">
          업로드하면 바로 사용 가능 · 다음 곡 생성에 자동 적용
        </span>
      </div>
    </div>
  );
}

interface VoiceRowProps {
  voice: UserVoice;
  onDelete: () => void;
}

function VoiceRow({ voice, onDelete }: VoiceRowProps) {
  const status = STATUS_LABELS[voice.status];
  const created = new Date(voice.createdAt);
  return (
    <div className="voice-row">
      <div className="voice-row-main">
        <div className="voice-row-name">{voice.displayName}</div>
        <div className="voice-row-meta">
          {voice.sampleSeconds ?? "?"}초 샘플 · {created.toLocaleDateString("ko-KR")}
        </div>
        {voice.error && <div className="voice-row-error">{voice.error}</div>}
      </div>
      <div className={`voice-status ${status.cls}`}>{status.label}</div>
      <div className="voice-row-actions">
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
