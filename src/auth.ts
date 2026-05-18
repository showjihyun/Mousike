const BACKEND_URL = "http://localhost:8787";

export type Tier = "free" | "starter" | "pro";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  tier: Tier;
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const res = await fetch(`${BACKEND_URL}/auth/me`, { credentials: "include" });
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) throw new Error(`auth/me failed: ${res.status}`);
  const data = (await res.json()) as { user: AuthUser };
  return data.user;
}

export function goToLogin(): void {
  window.location.href = `${BACKEND_URL}/auth/google`;
}

export async function logout(): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}
