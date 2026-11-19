import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { veryBehind } from "@/lib/email-allotment-core";

// An email client VERY behind on their allotment (owner, Nov 19 2026): the client's Email Strategist and the Head of
// Email hear it in Kaizen OS (the bell), never by Slack. Once per client per billing cycle when it falls under half of
// where the cycle says it should be with more than half the cycle gone, and once more in the cycle's last week if any
// pool is still short of the bottom of its range. Strategy-only clients, clients with no tier or SOW, and months marked
// not signed or removed hold no allotment, so they're never flagged (src/lib/email-allotment-core.ts veryBehind).

type Db = SupabaseClient;

export async function emailPaceAlerts(admin: Db) {
  const [{ emailAllotments }, { data: clients }, { data: heads }] = await Promise.all([
    import("@/lib/email-request"),
    admin.from("clients").select("id, name, slug, services, services_extra, services_removed, strategy_only").is("archived_at", null).in("status", ["active", "onboarding"]),
    admin.from("profiles").select("id").eq("role", "head_of_email").eq("is_active", true),
  ]);
  const { servicesOf } = await import("@/lib/services");
  const email = (clients ?? []).filter((c) => (servicesOf(c) as string[]).includes("email-marketing") && !((c.strategy_only ?? []) as string[]).includes("email-marketing"));
  if (!email.length) return { clients: 0, flagged: 0 };
  const allotments = await emailAllotments(admin, email.map((c) => c.id as string));
  const { data: seats } = await admin.from("client_assignments").select("client_id, profile_id").eq("role", "email_strategist").in("client_id", email.map((c) => c.id as string));
  const headIds = (heads ?? []).map((h) => h.id as string);
  let flagged = 0;
  for (const c of email) {
    const a = allotments[c.id as string];
    const v = veryBehind(a);
    if (!v || !a?.cycle) continue;
    const to = [...new Set([...(seats ?? []).filter((s) => s.client_id === c.id).map((s) => s.profile_id as string), ...headIds])];
    if (!to.length) continue;
    const key = `asana_email:${v.kind === "last_week" ? "pace-late" : "pace"}:${c.id}:${a.cycle.start}`;
    const rows = to.map((profile_id) => ({
      profile_id,
      kind: "kpi",
      client_id: c.id,
      title: `${c.name}: ${v.kind === "last_week" ? "the cycle ends soon and the email allotment isn't done" : "very behind on the email allotment"}`,
      body: `${v.text} Plan the requests now so the month's deliverables go out.`,
      href: `/board/email/new?client=${c.slug}`,
      key,
      priority: "normal",
    }));
    const { data } = await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true }).select("id");
    if (data?.length) flagged++;
  }
  return { clients: email.length, flagged };
}
