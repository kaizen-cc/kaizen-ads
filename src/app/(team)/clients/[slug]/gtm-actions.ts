"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { buildGtm, gtmGate } from "@/lib/gtm";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Anyone on the client's team: build (or update) the Meta go-to-market strategy now. Runs in the background. */
export async function buildGtmNow(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: mine } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return { ok: false, error: "You don't work on this client." };
  const admin = createAdminClient();
  const gate = await gtmGate(admin, clientId);
  if (gate.missing.length) {
    await admin.from("client_gtm_strategies").upsert({ client_id: clientId, status: "waiting", missing: gate.missing }, { onConflict: "client_id" });
    revalidatePath(`/clients/${slug}`);
    return { ok: false, error: `Before it can be built it needs ${gate.missing.join(", ")}.` };
  }
  await admin.from("client_gtm_strategies").upsert({ client_id: clientId, status: "building", started_at: new Date().toISOString(), error: null, missing: [] }, { onConflict: "client_id" });
  after(() => buildGtm(admin, clientId, me.id).then(() => undefined));
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

/** Execs and leads: reviewed, so every agent reads it as the client's strategy rather than a draft. */
export async function markGtmReviewed(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can mark it reviewed." };
  const supabase = await createClient();
  const { error } = await supabase.from("client_gtm_strategies").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}`);
  return error ? { ok: false, error: error.message } : { ok: true };
}
