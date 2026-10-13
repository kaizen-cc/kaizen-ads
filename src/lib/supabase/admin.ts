import "server-only";
import { createClient } from "@supabase/supabase-js";

// Server-only connection with full rights, for work no single signed-in person can do:
// scheduled emails, error alerts and calendar meetings the server has verified.
export const adminConfigured = () => Boolean(process.env.SUPABASE_SECRET_KEY);

export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
