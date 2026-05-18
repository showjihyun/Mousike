import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing required env var: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}
