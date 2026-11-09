"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { canSeeReports } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** A client's report prefs: send Meta and TikTok as one weekly report (the default), or separately. Buyers and execs. */
export async function setTikTokSeparate(clientId: string, slug: string, separate: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  if (!canSeeReports(me)) return { ok: false, error: "Reports are for the media buyers and the executives." };
  const { data: visible } = await (await createClient()).from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!visible) return { ok: false, error: "Client not found." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  const { data } = await admin.from("client_report_prefs").select("client_id").eq("client_id", clientId).maybeSingle();
  const { error } = data
    ? await admin.from("client_report_prefs").update({ tiktok_separate: separate, updated_at: new Date().toISOString() }).eq("client_id", clientId)
    : await admin.from("client_report_prefs").insert({ client_id: clientId, notes: [], tiktok_separate: separate });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/clients/${slug}`);
  return { ok: true };
}
