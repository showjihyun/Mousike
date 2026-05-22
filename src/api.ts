import type { AdvancedSettings, Generation } from "./types";

const BACKEND_URL = "http://localhost:8787";
const POLL_INTERVAL_MS = 2_000;

// Browsers throw `TypeError: Failed to fetch` for CORS / network / refused
// connection. Surface a Korean message users can act on instead of leaking the
// raw English string into the toast.
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && /failed to fetch|networkerror|network error/i.test(e.message);
}
const NETWORK_ERR_KO = "백엔드에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.";

export interface BackendSong {
  id: string;
  audioUrl: string;
  prompt: string;
  translatedCaption?: string;
  vocalLanguage?: "KO" | "EN" | "unknown";
}

export interface BackendResponse {
  songs: BackendSong[];
}

export type Lang = "KO" | "EN";

// What the FE sends on /api/generate. "auto" lets the BE pick via the
// vocal-language auto rule (see CONTEXT.md).
export type VocalLanguageChoice = "auto" | "KO" | "EN";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobView {
  id: string;
  kind: "generate" | "repaint" | "lego";
  status: JobStatus;
  queuePosition?: number;
  result?: BackendResponse;
  error?: string;
  createdAt: string;
}

export interface JobProgress {
  status: JobStatus;
  queuePosition?: number;
}

export type ProgressCallback = (p: JobProgress) => void;

async function enqueueJob(
  endpoint: "generate" | "repaint" | "lego",
  body: unknown,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (isNetworkError(e)) throw new Error(NETWORK_ERR_KO);
    throw e;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

async function fetchJob(jobId: string): Promise<JobView> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/jobs/${jobId}`, { credentials: "include" });
  } catch (e) {
    if (isNetworkError(e)) throw new Error(NETWORK_ERR_KO);
    throw e;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  return (await res.json()) as JobView;
}

// Poll until the job finishes. onProgress fires once per poll with the latest
// status + queue position so the caller can drive UI. Failed/missing jobs
// throw; the caller surfaces an error toast.
async function pollJob(jobId: string, onProgress?: ProgressCallback): Promise<BackendSong[]> {
  while (true) {
    const view = await fetchJob(jobId);
    onProgress?.({ status: view.status, queuePosition: view.queuePosition });
    if (view.status === "done") {
      return view.result?.songs ?? [];
    }
    if (view.status === "failed") {
      throw new Error(view.error ?? "생성에 실패했어요");
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export async function generate(
  prompt: string,
  lang: Lang,
  vocalLanguage: VocalLanguageChoice,
  advanced: AdvancedSettings,
  onProgress?: ProgressCallback,
): Promise<BackendSong[]> {
  const jobId = await enqueueJob("generate", { prompt, lang, vocalLanguage, advanced });
  return pollJob(jobId, onProgress);
}

export async function repaint(args: {
  sourceAudioUrl: string;
  startSec: number;
  endSec: number;
  caption?: string;
  parentSongId?: string;
  onProgress?: ProgressCallback;
}): Promise<BackendSong[]> {
  const { onProgress, ...body } = args;
  const jobId = await enqueueJob("repaint", body);
  return pollJob(jobId, onProgress);
}

interface RawGeneration extends Omit<Generation, "createdAt" | "songs"> {
  createdAt: string;
  songs: Array<Omit<Generation["songs"][number], "createdAt"> & { createdAt: string }>;
}

function reviveGeneration(raw: RawGeneration): Generation {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    songs: raw.songs.map((s) => ({ ...s, createdAt: new Date(s.createdAt) })),
  };
}

export async function fetchGenerations(): Promise<Generation[]> {
  const res = await fetch(`${BACKEND_URL}/api/generations`, { credentials: "include" });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  const data = (await res.json()) as { generations: RawGeneration[] };
  return data.generations.map(reviveGeneration);
}

export async function postGeneration(gen: Generation): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(gen),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
}

export interface Usage {
  used: number;
  limit: number | null;
  periodLabel: string;
  windowStart: string;
}

export async function fetchUsage(): Promise<Usage> {
  const res = await fetch(`${BACKEND_URL}/api/usage`, { credentials: "include" });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  return (await res.json()) as Usage;
}

export interface CheckoutResponse {
  orderId: string;
  amount: number;
  orderName: string;
  customerEmail: string;
  customerName: string;
}

export async function fetchBillingConfig(): Promise<{ clientKey: string }> {
  const res = await fetch(`${BACKEND_URL}/api/billing/config`);
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  return (await res.json()) as { clientKey: string };
}

export type ReceiptType = "소득공제" | "지출증빙";

export async function postCheckout(args: {
  tier: "starter" | "pro";
  receiptType?: ReceiptType;
  registrationNo?: string;
  receiptEmail?: string;
}): Promise<CheckoutResponse> {
  const res = await fetch(`${BACKEND_URL}/api/billing/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  return (await res.json()) as CheckoutResponse;
}

export async function postConfirm(args: {
  paymentKey: string;
  orderId: string;
  amount: number;
}): Promise<{ ok: true; tier: "starter" | "pro"; expiresAt: string }> {
  const res = await fetch(`${BACKEND_URL}/api/billing/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  return (await res.json()) as { ok: true; tier: "starter" | "pro"; expiresAt: string };
}

export async function downloadCertBlob(songId: string): Promise<Blob> {
  const res = await fetch(`${BACKEND_URL}/api/cert/${songId}`, { credentials: "include" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  // Sanity check — if a proxy/captive portal hijacks the response with HTML,
  // we'd otherwise save the HTML as a .pdf and the user opens a broken file.
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("pdf")) {
    throw new Error("응답이 PDF가 아닙니다");
  }
  return res.blob();
}

export async function patchSongLiked(songId: string, liked: boolean): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/songs/${songId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ liked }),
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
}

export async function lego(args: {
  sourceAudioUrl: string;
  instruments: string[];
  caption?: string;
  parentSongId?: string;
  onProgress?: ProgressCallback;
}): Promise<BackendSong[]> {
  const { onProgress, ...body } = args;
  const jobId = await enqueueJob("lego", body);
  return pollJob(jobId, onProgress);
}

// --- Voice clone (Phase 1 of the musicai-stack pivot, ADR 0005) -------------

export type VoiceStatus = "uploading" | "training" | "trained" | "failed";

export interface UserVoice {
  id: string;
  displayName: string;
  sampleSeconds: number | null;
  epochs: number;
  status: VoiceStatus;
  error: string | null;
  createdAt: string;
  trainedAt: string | null;
}

// BE returns snake_case via the supabase-js client. Same revival pattern as
// reviveGeneration but voices stay as ISO strings on the FE — there's no
// Date math the UI does on them.
interface RawUserVoice {
  id: string;
  display_name: string;
  sample_seconds: number | null;
  epochs: number;
  status: VoiceStatus;
  error: string | null;
  created_at: string;
  trained_at: string | null;
}

function toUserVoice(r: RawUserVoice): UserVoice {
  return {
    id: r.id,
    displayName: r.display_name,
    sampleSeconds: r.sample_seconds,
    epochs: r.epochs,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    trainedAt: r.trained_at,
  };
}

export async function fetchVoices(): Promise<UserVoice[]> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/voices`, { credentials: "include" });
  } catch (e) {
    if (isNetworkError(e)) throw new Error(NETWORK_ERR_KO);
    throw e;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as { voices: RawUserVoice[] };
  return data.voices.map(toUserVoice);
}

export async function uploadVoiceSamples(
  displayName: string,
  files: File[],
): Promise<UserVoice> {
  const form = new FormData();
  form.append("displayName", displayName);
  for (const f of files) form.append("files", f);
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/api/voice-samples`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
  } catch (e) {
    if (isNetworkError(e)) throw new Error(NETWORK_ERR_KO);
    throw e;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as {
    voiceId: string;
    sampleSeconds: number;
    epochs: number;
    status: VoiceStatus;
  };
  // The BE responds with a subset of the row — synthesise the full UserVoice
  // shape so the caller can prepend it to the list without a refetch race.
  return {
    id: data.voiceId,
    displayName,
    sampleSeconds: data.sampleSeconds,
    epochs: data.epochs,
    status: data.status,
    error: null,
    createdAt: new Date().toISOString(),
    trainedAt: null,
  };
}
