"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Patterns across clients: an exec refreshes them now, and anyone deciding briefs turns one into a brief for a client
// that isn't using it yet (written in the background; it lands in Suggested briefs).

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

export async function briefPattern(patternId: string, clientId: string): Promise<Result> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can brief a pattern." };
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  // The person's own access decides whether they can see the client
  const db = await createClient();
  const [{ data: c }, { patternById, patternsForClient }] = await Promise.all([db.from("clients").select("id").eq("id", clientId).maybeSingle(), import("@/lib/patterns")]);
  const p = await patternById(db, patternId);
  if (!c || !p) return { ok: false, error: "Not found." };
  const { patterns } = await patternsForClient(db, clientId);
  if (!patterns.some((x) => x.id === p.id)) return { ok: false, error: "This pattern isn't for this client's kind of business." };
  const admin = createAdminClient();
  after(async () => {
    const { suggestForPattern } = await import("@/lib/suggestions");
    await suggestForPattern(admin, clientId, p, me.id).catch((e) => console.error("[patterns] brief", e instanceof Error ? e.message : e));
    revalidatePath("/pipeline");
  });
  return { ok: true };
}
