"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { worksSales } from "@/lib/sales-core";

// A sales call brief's one button: write it again now (re-reading the calendar event, the research and prior
// contact). For whoever runs the call, and the execs and leads.

export async function refreshBriefAction(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "While viewing as someone, nothing is rewritten for them." };
  const { getBrief, makeBrief, BRIEF_COLS } = await import("@/lib/sales-briefs");
  // Read through their own session first: only a brief they may see
  const mine = await getBrief(await createClient(), id);
  if (!mine || (mine.owner_id !== me.id && !worksSales(me))) return { ok: false, error: "That brief isn't yours." };
  const admin = createAdminClient();
  const { data: row } = await admin.from("sales_call_briefs").select(BRIEF_COLS).eq("id", id).single();
  const { data: people } = await admin.from("profiles").select("id, full_name, email, is_exec, is_lead").eq("is_active", true);
  const team = ((people ?? []) as { id: string; full_name: string; email: string | null; is_exec: boolean | null; is_lead: boolean | null }[]).filter((p) => p.email).map((p) => ({ id: p.id, email: p.email!.toLowerCase(), name: p.full_name, sells: Boolean(p.is_exec || p.is_lead) }));
  try {
    const r0 = row as unknown as import("@/lib/sales-briefs").BriefRow;
    // Rewritten by hand: no second bell (it rang when the brief was first delivered)
    const r = await makeBrief(admin, { ...r0, notified_at: r0.notified_at ?? new Date().toISOString() }, team);
    revalidatePath(`/sales/briefs/${id}`);
    return r.ok ? { ok: true } : r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "It couldn't be rewritten. Try again." };
  }
}
