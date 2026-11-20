import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { servicesOf } from "@/lib/services";
import { runBounded } from "@/lib/bounded";
import { adPostIds, needsBoostFlag, toBoosted, type BoostedPost, type BoostedRow } from "@/lib/social-boosts-core";

// Boosted posts (Head of Social, Nov 19 2026): the ads team's ads that run an organic post, matched to the post, with
// their spend (the view social_boosted_posts). The sync asks Meta which post each recent ad of a social client runs
// (once, then every two weeks); the KPI sheet, the assistant and the alerts read the view. A client with Social Media
// and Meta ads but nothing boosted in 30 days tells its Social Media Manager and Meta buyer in Kaizen OS once a month.

type Db = SupabaseClient;
const RECHECK_DAYS = 14;

/** Each client's boosted posts over the last 30 days, the most spend first */
export async function boostedPosts(db: Db, clientIds?: string[]): Promise<Record<string, BoostedPost[]>> {
  let q = db.from("social_boosted_posts").select("*").order("spend_30d", { ascending: false });
  if (clientIds?.length) q = q.in("client_id", clientIds);
  const { data, error } = await q.limit(2000);
  if (error) return {};
  const out: Record<string, BoostedPost[]> = {};
  for (const r of (data ?? []) as BoostedRow[]) (out[r.client_id] ??= []).push(toBoosted(r));
  return out;
}

/** The clients with Social Media (not archived), with what else they buy */
async function socialClients(admin: Db) {
  const { data } = await admin.from("clients").select("id, name, slug, services, services_extra, services_removed, strategy_only, meta_ad_account_id").is("archived_at", null).in("status", ["active", "onboarding"]);
  return (data ?? []).filter((c) => (servicesOf(c) as string[]).includes("social-media"));
}

/** Which post each recent ad of a social client runs, asked of Meta for ads not read in two weeks */
export async function syncAdPosts(admin: Db, opts: { budgetMs?: number } = {}) {
  const deadline = Date.now() + (opts.budgetMs ?? 90_000);
  const clients = await socialClients(admin);
  if (!clients.length) return { ads: 0 };
  const ids = clients.map((c) => c.id as string);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const { data: days } = await admin.from("meta_ad_daily").select("ad_id, client_id, ad_account_id, ad_name, metrics").in("client_id", ids).gte("date", since).limit(20000);
  const ads = new Map<string, { client: string; account: string | null; name: string | null }>();
  for (const d of days ?? []) if (Number((d.metrics as Record<string, unknown> | null)?.spend) > 0) ads.set(d.ad_id as string, { client: d.client_id as string, account: (d.ad_account_id as string | null) ?? null, name: (d.ad_name as string | null) ?? null });
  if (!ads.size) return { ads: 0 };
  const { data: had } = await admin.from("meta_ad_posts").select("ad_id, checked_at").in("ad_id", [...ads.keys()]);
  const fresh = new Set((had ?? []).filter((h) => Date.now() - Date.parse(h.checked_at as string) < RECHECK_DAYS * 86_400_000).map((h) => h.ad_id as string));
  const todo = [...ads.keys()].filter((id) => !fresh.has(id));
  const { metaGraph } = await import("@/lib/context/meta");
  let read = 0;
  await runBounded(todo, { limit: 4 }, async (adId) => {
    if (Date.now() > deadline) return;
    const a = ads.get(adId)!;
    try {
      const r = await metaGraph<{ name?: string; creative?: { effective_object_story_id?: string; effective_instagram_media_id?: string } }>(adId, { fields: "name,creative{effective_object_story_id,effective_instagram_media_id}" });
      const ids = adPostIds(r);
      await admin.from("meta_ad_posts").upsert({ ad_id: adId, client_id: a.client, ad_account_id: a.account, ad_name: r.name ?? a.name, story_id: ids.storyId, ig_media_id: ids.igMediaId, checked_at: new Date().toISOString() });
      read++;
    } catch {
      // An ad Meta won't describe (deleted, no access): tried again next run
    }
  });
  return { ads: ads.size, read, left: todo.length - read };
}

/** Nothing boosted in 30 days on a client with Social Media and Meta ads: its Social Media Manager and Meta buyer hear it once a month */
export async function boostAlerts(admin: Db) {
  const clients = await socialClients(admin);
  if (!clients.length) return { flagged: 0 };
  const ids = clients.map((c) => c.id as string);
  const [boosted, { data: links }, { data: seats }, { data: tiers }] = await Promise.all([
    boostedPosts(admin, ids),
    admin.from("social_accounts").select("client_id, page_id, ig_id").in("client_id", ids),
    admin.from("client_assignments").select("client_id, profile_id, role").in("client_id", ids).in("role", ["social_manager", "meta_buyer"]),
    admin.from("client_service_tiers").select("client_id, service_tiers(label)").in("client_id", ids).eq("service", "facebook-ads"),
  ]);
  // Meta on Performance (conversions only) isn't boosting anything by design
  const performanceOnly = new Set(((tiers ?? []) as unknown as { client_id: string; service_tiers: { label: string } | null }[]).filter((t) => t.service_tiers?.label === "Performance").map((t) => t.client_id));
  const linked = new Set((links ?? []).filter((l) => l.page_id || l.ig_id).map((l) => l.client_id as string));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  let flagged = 0;
  for (const c of clients) {
    const meta = (servicesOf(c) as string[]).includes("facebook-ads") && !performanceOnly.has(c.id as string);
    const flag = needsBoostFlag({ social: true, meta, linked: linked.has(c.id as string), strategyOnly: ((c.strategy_only ?? []) as string[]).includes("social-media"), boosted: boosted[c.id as string]?.length ?? 0, dayOfMonth: Number(today.slice(8, 10)) });
    if (!flag) continue;
    const to = [...new Set((seats ?? []).filter((s) => s.client_id === c.id).map((s) => s.profile_id as string))];
    if (!to.length) continue;
    const rows = to.map((profile_id) => ({
      profile_id,
      kind: "kpi",
      client_id: c.id,
      title: `${c.name}: no organic posts boosted in the last 30 days`,
      body: "None of their ads is running one of their Facebook or Instagram posts. The social strategist and the media buyer can pick the best recent posts to boost together.",
      href: `/kpis?p=social&open=${c.id}`,
      key: `social:boost-none:${c.id}:${today.slice(0, 7)}`,
      priority: "normal",
    }));
    const { data } = await admin.from("notifications").upsert(rows, { onConflict: "profile_id,key", ignoreDuplicates: true }).select("id");
    if (data?.length) flagged++;
  }
  return { flagged };
}
