"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Reopen an item that closed itself (src/lib/done-check.ts): it comes back for everyone and its source goes back to
// how it was. Anyone who can see the client can do it (their own session reads the row).

export async function reopenAutoClosed(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  const { data } = await (await createClient()).from("done_checks").select("key").eq("key", key).maybeSingle();
  if (!data) return { ok: false, error: "That isn't there any more." };
  const { reopen } = await import("@/lib/done-check");
  const r = await reopen(createAdminClient(), key, me.id);
  if (r.ok) revalidatePath("/pipeline");
  return r;
}
