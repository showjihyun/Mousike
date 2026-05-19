import type { Generation } from "./types";

const BACKEND_URL = "http://localhost:8787";
const POLL_INTERVAL_MS = 2_000;

export interface BackendSong {
  id: string;
  audioUrl: string;
  prompt: string;
  translatedCaption?: string;
}

export interface BackendResponse {
  songs: BackendSong[];
}

export type Lang = "KO" | "EN";

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
  const res = await fetch(`${BACKEND_URL}/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Backend error ${res.status}`);
  }
  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

async function fetchJob(jobId: string): Promise<JobView> {
  const res = await fetch(`${BACKEND_URL}/api/jobs/${jobId}`, { credentials: "include" });
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
  onProgress?: ProgressCallback,
): Promise<BackendSong[]> {
  const jobId = await enqueueJob("generate", { prompt, lang });
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

export async function postCheckout(args: {
  tier: "starter" | "pro";
  businessNo?: string;
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
