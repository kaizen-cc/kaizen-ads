import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarize, type SpendRow, type SpendSummary } from "@/lib/spend-core";

// The daily AI spend for the owner (Settings › Calls & usage) and the hourly check that tells the owner when a day runs
// past twice the 7-day average (docs/API-COST.md). Read with the server's rights after the owner check on the page.

const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

async function rows(admin: SupabaseClient, now: Date): Promise<SpendRow[]> {
  const from = new Date(now.getTime() - 39 * 86_400_000).toISOString();
  const to = new Date(now.getTime() + 86_400_000).toISOString();
  const { data, error } = await admin.rpc("owner_spend_rollup" as never, { p_from: from, p_to: to } as never);
  if (error) throw new Error(error.message);
  return (data ?? []) as SpendRow[];
}

export async function loadSpend(now = new Date()): Promise<SpendSummary> {
  return summarize(await rows(createAdminClient(), now), nyDay(now));
}

/** Hourly: today so far (or yesterday, whole) past twice the 7-day average tells the owner once that day, with what drove it */
export async function checkSpend(admin: SupabaseClient, now = new Date()) {
  const s = summarize(await rows(admin, now), nyDay(now));
  if (!s.spike) return { today: Math.round(s.todayCost), avg7: Math.round(s.avg7), spike: false };
  const day = s.spike.day;
  const drivers = (day === s.today ? s.topToday : []).slice(0, 3).map((l) => `${l.place} $${Math.round(l.cost)}`);
  const { data: owners } = await admin.from("profiles").select("id").eq("can_view_as", true).eq("is_active", true);
  const when = day === s.today ? "today so far" : "yesterday";
  if (owners?.length)
    await admin.from("notifications").upsert(
      owners.map((o) => ({
        profile_id: o.id,
        kind: "agent",
        title: `AI spend ${when}: $${Math.round(s.spike!.cost)}, over twice the 7-day average ($${Math.round(s.spike!.avg)})`,
        body: `${drivers.length ? `Most of it: ${drivers.join(", ")}. ` : ""}See what drove it in Settings › Calls & usage.`.slice(0, 1000),
        href: "/settings?tab=calls&view=usage",
        key: `spend:${day}`,
        priority: "critical",
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  return { today: Math.round(s.todayCost), avg7: Math.round(s.avg7), spike: true, day, cost: Math.round(s.spike.cost) };
}
