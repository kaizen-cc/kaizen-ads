"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Patterns across clients: an exec refreshes them now. Briefing one for a client that isn't using it yet starts from
// its quick preview (src/components/quick-brief-sheet.tsx), written in the background only when someone chooses it.

type Result = { ok: true } | { ok: false; error: string };

export async function refreshPatterns(): Promise<Result> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only execs can refresh the patterns." };
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const admin = createAdminClient();
  after(async () => {
    const { runPatterns } = await import("@/lib/patterns");
    await runPatterns(admin, 270_000).catch((e) => console.error("[patterns] refresh", e instanceof Error ? e.message : e));
    revalidatePath("/pipeline");
  });
  return { ok: true };
}
