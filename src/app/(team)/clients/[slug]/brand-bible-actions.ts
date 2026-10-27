"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { clientContext } from "@/lib/ai";
import { buildBible } from "@/lib/brand-bible";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { notLive } from "@/lib/live-guard";

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Execs and leads: research the client on the web, then build (or update) their Brand Bible from that research,
 * pasted sources (intake form, sales call) and everything the app already knows. Runs in the background; the
 * page shows progress until it's done.
 */
export async function buildBrandBible(clientId: string, slug: string, pasted: string): Promise<ActionResult> {
  { const why = await notLive(await createClient(), clientId); if (why) return { ok: false, error: why }; }
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can build a Brand Bible." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const supabase = await createClient();
  const [{ data: client }, ctx] = await Promise.all([supabase.from("clients").select("id").eq("id", clientId).maybeSingle(), clientContext(supabase, clientId)]);
  if (!client || !ctx) return { ok: false, error: "You don't work on this client." };

  const admin = createAdminClient();
  // Shown as building right away; the research and the Bible run after the response
  await admin.from("client_brand_bibles").upsert({ client_id: clientId, status: "building", error: null, started_at: new Date().toISOString(), generated_by: me.id });
  after(() => buildBible(admin, clientId, { pasted, by: me.id }));

  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}

/** The Head of Creative (or an exec) reviewed it: from now on its "Read this first" feeds the brief strategist, copywriter and reviewer. */
export async function markBrandBibleReviewed(clientId: string, slug: string): Promise<ActionResult> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only the head of creative or an exec can mark it reviewed." };
  const supabase = await createClient();
  const { error } = await supabase.from("client_brand_bibles").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId);
  revalidatePath(`/clients/${slug}`);
  return error ? { ok: false, error: error.message } : { ok: true };
}
