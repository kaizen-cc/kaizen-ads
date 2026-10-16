"use server";

import { revalidatePath } from "next/cache";
import { requireExec } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/** Mark fixed: if it happens again it reopens and emails again. */
export async function resolveError(fingerprint: string) {
  await requireExec();
  await createAdminClient().from("error_events").update({ resolved_at: new Date().toISOString(), last_alert_at: null }).eq("fingerprint", fingerprint);
  revalidatePath("/settings");
}

/** Still recorded, never emailed again. */
export async function muteError(fingerprint: string) {
  await requireExec();
  const now = new Date().toISOString();
  await createAdminClient().from("error_events").update({ muted_at: now, resolved_at: now }).eq("fingerprint", fingerprint);
  revalidatePath("/settings");
}

/** Hand an error to Claude (GitHub issue → pull request to approve). */
export async function fixWithClaude(fingerprint: string): Promise<{ url?: string; error?: string }> {
  await requireExec();
  const { createFixIssue } = await import("@/lib/claude-fix");
  const r = await createFixIssue(fingerprint);
  revalidatePath("/settings");
  return r;
}
