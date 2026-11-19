import "server-only";
import { createClient } from "@supabase/supabase-js";
import { viewAsFetch } from "@/lib/view-as-fetch";

// Server-only connection with full rights, for work no single signed-in person can do:
// scheduled emails, error alerts and calendar meetings the server has verified.
// While the owner views as a teammate it can't write either (lib/view-as-core.ts): changes are refused and every
// request it sends runs read only in the database.
export const adminConfigured = () => Boolean(process.env.SUPABASE_SECRET_KEY);

export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: viewAsFetch(fetch, { header: true }) },
  });
}
