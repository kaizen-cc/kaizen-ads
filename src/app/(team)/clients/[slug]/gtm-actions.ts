"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { aiEnabled } from "@/lib/ai";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { GTM_TABLE, buildGtm, gtmGate, type GtmPlatform } from "@/lib/gtm";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { notLive } from "@/lib/live-guard";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Anyone on the client's team: build (or update) the Meta go-to-market strategy now. Runs in the background. */
export async function buildGtmNow(clientId: string, slug: string, platform: GtmPlatform = "meta"): Promise<ActionResult> {
  if (!(platform in GTM_TABLE)) return { ok: false, error: "Not found." };
  const table = GTM_TABLE[platform];
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  if (!aiEnabled() || !adminConfigured()) return { ok: false, error: "The AI isn't connected here." };
  const supabase = await createClient();
  const { data: mine } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!mine) return { ok: false, error: "You don't work on this client." };
  const admin = createAdminClient();
  const gate = await gtmGate(admin, clientId);
  if (gate.missing.length) {
    await admin.from(table).upsert({ client_id: clientId, status: "waiting", missing: gate.missing }, { onConflict: "client_id" });
    revalidatePath(`/clients/${slug}`);
    return { ok: false, error: `Before it can be built it needs ${gate.missing.join(", ")}.` };
  }
  await admin.from(table).upsert({ client_id: clientId, status: "building", started_at: new Date().toISOString(), error: null, missing: [] }, { onConflict: "client_id" });
  after(() => buildGtm(admin, clientId, me.id, platform).then(() => undefined));
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

/** Execs and leads: reviewed, so every agent reads it as the client's strategy rather than a draft. */
export async function markGtmReviewed(clientId: string, slug: string, platform: GtmPlatform = "meta"): Promise<ActionResult> {
  if (!(platform in GTM_TABLE)) return { ok: false, error: "Not found." };
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can mark it reviewed." };
  const supabase = await createClient();
  const { error } = await supabase.from(GTM_TABLE[platform]).update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}`);
  return error ? { ok: false, error: error.message } : { ok: true };
}
