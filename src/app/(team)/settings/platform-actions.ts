"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { parseCustomerId } from "@/lib/google-health";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// A client's Google Ads customer ID, added inline (Settings › Sync health's Google Ads card, or the client's Team &
// setup): saved as their Google KPI target, the same place the KPI board, the client page and the KPI sync read it,
// then pulled right away. Leads, execs and the head of Google.

type Result = { ok: true; id: string } | { ok: false; error: string };

export async function saveGoogleCustomerId(clientId: string, raw: string): Promise<Result> {
  const me = await requireStaff();
  if (!isExecOrLead(me) && me.role !== "head_of_google") return { ok: false, error: "Only a lead, an exec or the head of Google can add a Google Ads ID." };
  if (!adminConfigured()) return { ok: false, error: "Not set up here." };
  const parsed = parseCustomerId(raw);
  if (!parsed.ok) return parsed;
  const id = parsed.id;
  const digits = id.replace(/\D/g, "");
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!client) return { ok: false, error: "That client wasn't found." };

  // One Google Ads account belongs to one client
  const { data: elsewhere } = await admin.from("kpi_targets").select("client_id, clients(name)").eq("platform", "google").eq("active", true).neq("client_id", clientId).in("ad_account_id", [id, digits]).limit(1).maybeSingle();
  if (elsewhere) return { ok: false, error: `${id} is already on ${(elsewhere.clients as unknown as { name: string } | null)?.name ?? "another client"}'s KPI board.` };

  const { data: mine } = await admin.from("kpi_targets").select("id, ad_account_id, active").eq("client_id", clientId).eq("platform", "google");
  const same = (mine ?? []).find((t) => String(t.ad_account_id ?? "").replace(/\D/g, "") === digits);
  const empty = (mine ?? []).find((t) => !String(t.ad_account_id ?? "").replace(/\D/g, ""));
  const now = new Date().toISOString();
  const { error } = same
    ? await admin.from("kpi_targets").update({ ad_account_id: id, active: true, updated_by: me.id, updated_at: now }).eq("id", same.id)
    : empty
      ? await admin.from("kpi_targets").update({ ad_account_id: id, active: true, updated_by: me.id, updated_at: now }).eq("id", empty.id)
      : await admin.from("kpi_targets").insert({ client_id: clientId, platform: "google", ad_account_id: id, conversion: "conversions", updated_by: me.id });
  if (error) return { ok: false, error: `Saving the ID: ${error.message}` };

  // The first pull, after the answer: its result (or the reason it failed) shows on the next refresh
  after(async () => {
    await (await import("@/lib/kpi/sync")).refreshClientKpis(admin, clientId, true).catch(() => undefined);
  });
  revalidatePath("/settings");
  revalidatePath(`/clients/${client.slug as string}`);
  revalidatePath("/kpis");
  return { ok: true, id };
}
