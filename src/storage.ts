// localStorage-backed persistence for library state.
// Schema is versioned so future shape changes can invalidate stale data.
import type { Generation } from "./types";

const SCHEMA_VERSION = 1;
const KEY_GENERATIONS = `mousike:v${SCHEMA_VERSION}:generations`;
const KEY_CREDITS = `mousike:v${SCHEMA_VERSION}:credits`;

// JSON.stringify turns Date into ISO strings; revive them back into Date on the
// `createdAt` key only (scoping by key avoids accidentally parsing user prompts
// that happen to look like ISO timestamps).
function reviveCreatedAt(key: string, value: unknown): unknown {
  if (key === "createdAt" && typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return value;
}

export function loadGenerations(): Generation[] | null {
  try {
    const raw = localStorage.getItem(KEY_GENERATIONS);
    if (!raw) return null;
    const parsed = JSON.parse(raw, reviveCreatedAt);
    return Array.isArray(parsed) ? (parsed as Generation[]) : null;
  } catch {
    return null;
  }
}

export function saveGenerations(generations: Generation[]): void {
  try {
    localStorage.setItem(KEY_GENERATIONS, JSON.stringify(generations));
  } catch {
    // Quota or private-mode failure: drop silently — the in-memory state still works.
  }
}

export function loadCredits(): number | null {
  try {
    const raw = localStorage.getItem(KEY_CREDITS);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function saveCredits(credits: number): void {
  try {
    localStorage.setItem(KEY_CREDITS, String(credits));
  } catch {
    // see saveGenerations
  }
}
