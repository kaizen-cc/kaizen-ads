import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nyParts } from "@/lib/kpi/calc";
import { refreshClientKpis } from "@/lib/kpi/sync";
import { queueReports } from "@/lib/reports/run";
import { linkAdAccounts, metaConfigured } from "@/lib/context/meta";
import { sheetConfigured, syncAccountSheet } from "@/lib/account-sheet";
import { clientReadiness } from "@/lib/readiness";

// A client going live again (restored from the archive, set back to active from paused, or made active again in
// Kaizen Track) goes straight back into the cycle instead of waiting for each scheduled run: the KPI row, fresh
// numbers, this week's and this month's reports while they're still due, and the sprint check-ins. A client with no
// ad account yet is looked for the way a new one is (Meta by name, the Account Overview and ops sheets). Then the
// readiness check (src/lib/readiness.ts): anything still missing goes to whoever brought them back (or the execs). Everything else
// (Slack, Drive, Asana, the briefing, fatigue, the market) already runs for every live client on its next pass.

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function backInCycle(admin: SupabaseClient, clientId: string, byId?: string | null) {
  let { data: c } = await admin.from("clients").select("id, name, slug, status, archived_at, meta_ad_account_id").eq("id", clientId).maybeSingle();
  if (!c || c.archived_at || !["active", "onboarding"].includes(c.status)) return { skipped: "not live" };
  const out: Record<string, unknown> = {};

  // No ad account yet: link Meta by name, and read the sheets (they add KPI rows, buyers and missing IDs)
  const { count: rows } = await admin.from("kpi_targets").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("active", true);
  if (!c.meta_ad_account_id && metaConfigured()) await linkAdAccounts(admin).catch((e) => (out.metaLink = String(e)));
  if (!rows && sheetConfigured()) await syncAccountSheet(admin).catch((e) => (out.sheet = String(e)));
  ({ data: c } = await admin.from("clients").select("id, name, slug, status, archived_at, meta_ad_account_id").eq("id", clientId).maybeSingle());
  if (!c) return out;

  // A Meta account with no KPI row gets one, with the client's Meta buyer as owner (as new accounts do)
  if (c.meta_ad_account_id) {
    const { data: has } = await admin.from("kpi_targets").select("id").eq("client_id", clientId).eq("platform", "meta").limit(1);
    if (!has?.length) {
      const { data: buyer } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", "meta_buyer").limit(1).maybeSingle();
      await admin.from("kpi_targets").insert({ client_id: clientId, platform: "meta", ad_account_id: c.meta_ad_account_id, conversion: "purchases", owner_id: buyer?.profile_id ?? null });
      out.kpiRowAdded = true;
    }
  }

  // Fresh numbers: while paused nothing was pulled, and reports only go to accounts that spent
  try {
    await refreshClientKpis(admin, clientId, true);
    out.kpis = "refreshed";
  } catch (e) {
    out.kpis = e instanceof Error ? e.message : String(e);
  }

  // Reports still due: this week's (Monday to Wednesday) and last month's recap (through the 5th)
  const ny = nyParts(new Date());
  const weekday = DAY[new Date(`${ny.date}T12:00:00Z`).getUTCDay()];
  if (["Mon", "Tue", "Wed"].includes(weekday)) out.weekly = await queueReports(admin, "weekly", ny.date, clientId);
  if (ny.day <= 5) out.monthly = await queueReports(admin, "monthly", ny.date, clientId);

  // Sprint check-ins pick up now rather than at their old time
  const { data: sprints } = await admin.from("optimization_sprints").update({ next_check_at: new Date().toISOString() }).eq("client_id", clientId).eq("status", "active").select("id");
  out.sprints = sprints?.length ?? 0;

  // Anything still missing for the system to run them: whoever brought them back (or the execs, when Track or the
  // enrollment form did) hears it once a day, with a link to the page where the readiness check asks for it
  const r = await clientReadiness(admin, clientId);
  out.missing = r.checks.filter((k) => !k.ok && k.need === "needed").map((k) => k.key);
  if (!r.ready) {
    const { data: execs } = byId ? { data: [{ id: byId }] } : await admin.from("profiles").select("id").eq("role", "executive").eq("is_active", true).not("joined_at", "is", null);
    const gaps = r.checks.filter((k) => !k.ok && k.need === "needed").map((k) => k.label.replace(/^An? /, "").toLowerCase());
    await admin.from("notifications").upsert(
      (execs ?? []).map((e) => ({
        profile_id: e.id,
        kind: "client",
        title: `${c!.name} is live again, but needs ${gaps.join(", ")}`,
        body: "Until then part of the cycle can't run for them (the KPI board, reports, check-ins). Open their page: the readiness check asks for each one and brings everything up.",
        href: `/clients/${c!.slug}?ready=1`,
        key: `back-readiness:${clientId}:${new Date().toISOString().slice(0, 10)}`,
        priority: "normal",
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  }
  return out;
}
