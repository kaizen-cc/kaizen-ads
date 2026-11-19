import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { socialVeryBehind } from "@/lib/social-allotment-core";

// A social client VERY behind on their allotment (owner, Nov 19 2026): the client's Social Media Manager and the Head
// of Social hear it in Kaizen OS (the bell), never by Slack. Once per client per billing cycle when it falls under half
// of where the cycle says it should be with more than half the cycle gone, and once more in the cycle's last week if any
// pool is still short of the bottom of its range. Strategy-only clients, clients with no tier, and clients without
// Social Media hold no allotment, and a client with no linked Page or Instagram can't be read, so they're never
// flagged (src/lib/social-allotment-core.ts socialVeryBehind).

type Db = SupabaseClient;

export async function socialPaceAlerts(admin: Db) {
  const [{ socialAllotments }, { servicesOf }, { data: clients }, { data: heads }] = await Promise.all([
    import("@/lib/social-allotment"),
    import("@/lib/services"),
    admin.from("clients").select("id, name, slug, services, services_extra, services_removed, strategy_only").is("archived_at", null).in("status", ["active", "onboarding"]),
    admin.from("profiles").select("id").eq("role", "head_of_social").eq("is_active", true),
  ]);
  const social = (clients ?? []).filter((c) => (servicesOf(c) as string[]).includes("social-media") && !((c.strategy_only ?? []) as string[]).includes("social-media"));
  if (!social.length) return { clients: 0, flagged: 0 };
  const ids = social.map((c) => c.id as string);
  const [allotments, { data: seats }, { data: links }] = await Promise.all([
    socialAllotments(admin, ids),
    admin.from("client_assignments").select("client_id, profile_id").eq("role", "social_manager").in("client_id", ids),
    admin.from("social_accounts").select("client_id, page_id, ig_id").in("client_id", ids),
  ]);
  // A client whose Page and Instagram aren't linked can't be read, so nothing it posted is counted: never flag it
  const linked = new Set((links ?? []).filter((l) => l.page_id || l.ig_id).map((l) => l.client_id as string));
  const headIds = (heads ?? []).map((h) => h.id as string);
  let flagged = 0;
  for (const c of social) {
    if (!linked.has(c.id as string)) continue;
    const a = allotments[c.id as string];
    const v = socialVeryBehind(a);
    if (!v || !a?.cycle) continue;
    const to = [...new Set([...(seats ?? []).filter((s) => s.client_id === c.id).map((s) => s.profile_id as string), ...headIds])];
    if (!to.length) continue;
    const key = `social:${v.kind === "last_week" ? "pace-late" : "pace"}:${c.id}:${a.cycle.start}`;
    const rows = to.map((profile_id) => ({
      profile_id,
      kind: "kpi",
      client_id: c.id,
      title: `${c.name}: ${v.kind === "last_week" ? "the cycle ends soon and the social allotment isn't done" : "very behind on the social allotment"}`,
      body: `${v.text} Plan and schedule the posts now so the month's package goes out.`,
      href: `/clients/${c.slug}?tab=team`,
      key,
      priority: "normal",
    }));
    const { data } = await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true }).select("id");
    if (data?.length) flagged++;
  }
  return { clients: social.length, flagged };
}
