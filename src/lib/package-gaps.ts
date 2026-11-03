import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// A client paying for creative and getting nothing: any billing period on a creative package (monthly, a sprint or a
// one-off) that ended with nothing made for them is flagged to the head of creative and the leads, and shown on the
// client page's package panel; one far into its period with nothing started is flagged as at risk. Made counts the
// same way the allotment does: tickets made in Kaizen Ads and creative counted in Asana, in the billing period.

const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

/** The billing period a day falls in, for a billing day of the month (1–28) */
export function periodOf(billingDay: number | null, at = new Date()) {
  const b = Math.max(1, Math.min(28, billingDay ?? 1));
  const ny = new Date(at.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const start = new Date(ny.getFullYear(), ny.getMonth() - (ny.getDate() >= b ? 0 : 1), b);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, b);
  return { start, end };
}

export type PackageGap = { missed: { start: string; end: string } | null; atRisk: { start: string; end: string; elapsed: number } | null };

/** For each client on a creative package: the last full period with nothing made, and whether this one is at risk */
export async function packageGaps(admin: SupabaseClient, onlyClient?: string): Promise<Map<string, PackageGap>> {
  let q = admin.from("clients").select("id, name, billing_day, created_at, creative_package_until").eq("creative_package", true).is("archived_at", null).in("status", ["active", "onboarding"]);
  if (onlyClient) q = q.eq("id", onlyClient);
  const { data: clients } = await q;
  const out = new Map<string, PackageGap>();
  if (!clients?.length) return out;
  const ids = clients.map((c) => c.id as string);
  const since = new Date(Date.now() - 70 * 86_400_000).toISOString();
  const [{ data: reqs }, { data: tasks }] = await Promise.all([
    admin.from("requests").select("client_id, created_at").in("client_id", ids).is("deleted_at", null).gte("created_at", since),
    admin.from("asana_tasks").select("client_id, counted_at").in("client_id", ids).gte("counted_at", since),
  ]);
  const made = new Map<string, number[]>();
  for (const r of reqs ?? []) made.set(r.client_id as string, [...(made.get(r.client_id as string) ?? []), Date.parse(r.created_at as string)]);
  for (const t of tasks ?? []) made.set(t.client_id as string, [...(made.get(t.client_id as string) ?? []), Date.parse(t.counted_at as string)]);
  const now = new Date();
  for (const c of clients) {
    const cur = periodOf((c.billing_day as number | null) ?? null, now);
    const prev = periodOf((c.billing_day as number | null) ?? null, new Date(cur.start.getTime() - 86_400_000));
    const times = made.get(c.id as string) ?? [];
    const inside = (p: { start: Date; end: Date }) => times.some((t) => t >= p.start.getTime() && t < p.end.getTime());
    // Only a period they were with us for the whole of, and on a package that covered it
    const covered = Date.parse(c.created_at as string) <= prev.start.getTime() && (!c.creative_package_until || String(c.creative_package_until) >= ymd(prev.end));
    const elapsed = (now.getTime() - cur.start.getTime()) / (cur.end.getTime() - cur.start.getTime());
    const gap: PackageGap = {
      missed: covered && !inside(prev) ? { start: ymd(prev.start), end: ymd(prev.end) } : null,
      atRisk: elapsed >= 0.6 && !inside(cur) ? { start: ymd(cur.start), end: ymd(cur.end), elapsed: Math.round(elapsed * 100) } : null,
    };
    if (gap.missed || gap.atRisk) out.set(c.id as string, gap);
  }
  return out;
}

/** Daily: the head of creative and the leads hear about each client paid for creative and given nothing */
export async function flagPackageGaps(admin: SupabaseClient) {
  const gaps = await packageGaps(admin);
  if (!gaps.size) return { flagged: 0 };
  const [{ data: clients }, { data: people }] = await Promise.all([
    admin.from("clients").select("id, name, slug").in("id", [...gaps.keys()]),
    admin.from("profiles").select("id").eq("is_active", true).or("role.eq.head_of_creative,is_lead.eq.true"),
  ]);
  const ids = (people ?? []).map((p) => p.id as string);
  const rows = (clients ?? []).flatMap((c) => {
    const g = gaps.get(c.id as string)!;
    return ids.map((id) =>
      g.missed
        ? { profile_id: id, kind: "client", title: `${c.name}: nothing made in a paid creative period`.slice(0, 200), body: `They're on a creative package, and nothing was made for them from ${g.missed.start} to ${g.missed.end}. Make it up this period, or talk to them before they ask for a refund.`, href: `/clients/${c.slug}`, client_id: c.id, key: `package-gap:${c.id}:${g.missed.start}`, priority: "critical" }
        : { profile_id: id, kind: "client", title: `${c.name}: nothing started this creative period`.slice(0, 200), body: `${g.atRisk!.elapsed}% through their billing period (${g.atRisk!.start} to ${g.atRisk!.end}) with nothing made yet on their creative package.`, href: `/clients/${c.slug}`, client_id: c.id, key: `package-risk:${c.id}:${g.atRisk!.start}`, priority: "normal" },
    );
  });
  if (rows.length) await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true });
  return { flagged: gaps.size };
}
