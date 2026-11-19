import "server-only";
import type { Staff } from "@/lib/auth";
import type { AccessCtx } from "@/lib/ai-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** What the shared access checks (src/lib/ai-access.ts) need for a tool that only gets the person: their session and the server's rights */
export async function accessFor(user: Staff): Promise<AccessCtx> {
  return { me: user, db: await createClient(), admin: createAdminClient() };
}
