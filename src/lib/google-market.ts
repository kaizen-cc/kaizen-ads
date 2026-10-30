import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { auctionInsights, keywordIdeas } from "@/lib/context/google-ads";
import { LIVE } from "@/lib/live";

// Google in the market, by industry (sub-vertical), straight from Google through our own Google Ads access:
// - What people search: Keyword Planner ideas around what converts for our clients there (their winning search terms
//   and keywords) and the industry's name, with monthly volume, the last 12 months, competition and top-of-page bids.
// - Who we're up against: Auction Insights from our clients' accounts in that industry, the other advertisers in the
//   same searches, how often they show and how often they outrank us (read only where the account's access allows it).
// Refreshed weekly.

const KEEP_SEARCHES = 60;

export async function updateGoogleMarket(admin: SupabaseClient, deadline = Date.now() + 240_000) {
  const { data: targets } = await admin
    .from("kpi_targets")
    .select("client_id, ad_account_id, clients!inner(vertical_id, archived_at, status, industry_detail)")
    .eq("active", true)
    .eq("platform", "google")
    .not("ad_account_id", "is", null)
    .is("clients.archived_at", null)
    .in("clients.status", LIVE);
  // Each industry with a Google client: its accounts, and the clients in it
  const byVertical = new Map<string, { accounts: Set<string>; clients: Set<string>; details: Set<string> }>();
  for (const t of targets ?? []) {
    const c = t.clients as unknown as { vertical_id: string | null; industry_detail: string | null };
    if (!c.vertical_id) continue;
    const v = byVertical.get(c.vertical_id) ?? { accounts: new Set(), clients: new Set(), details: new Set() };
    v.accounts.add(String(t.ad_account_id));
    v.clients.add(t.client_id as string);
    if (c.industry_detail) v.details.add(c.industry_detail);
    byVertical.set(c.vertical_id, v);
  }
  const { data: names } = byVertical.size ? await admin.from("verticals").select("id, name").in("id", [...byVertical.keys()]) : { data: [] };
  const nameOf = new Map((names ?? []).map((n) => [n.id as string, n.name as string]));

  let searches = 0;
  let competitors = 0;
  const failed: string[] = [];
  const auctionsBlocked: string[] = [];
  for (const [verticalId, v] of byVertical) {
    if (Date.now() > deadline) break;
    const now = new Date().toISOString();
    // Seeds: what's converting for our clients here, then the industry itself
    const { data: wins } = await admin.from("google_ideas").select("kind, content, conversions").in("client_id", [...v.clients]).in("kind", ["search_term", "keyword"]).order("conversions", { ascending: false }).limit(15);
    const seeds = [...new Set([...(wins ?? []).map((w) => String((w.content as { text?: string }).text ?? "").toLowerCase()).filter(Boolean), ...[...v.details].map((d) => d.toLowerCase()), (nameOf.get(verticalId) ?? "").toLowerCase()].filter((x) => x && x.length <= 80))].slice(0, 20);
    const account = [...v.accounts][0];
    if (seeds.length) {
      try {
        const ideas = (await keywordIdeas(account, seeds)).filter((i) => i.searches > 0).sort((a, b) => b.searches - a.searches).slice(0, KEEP_SEARCHES);
        if (ideas.length) {
          await admin.from("google_market").delete().eq("vertical_id", verticalId).eq("kind", "search");
          const { error } = await admin.from("google_market").insert(ideas.map((i) => ({ vertical_id: verticalId, kind: "search", key: i.text.toLowerCase(), data: { ...i, seeded: seeds.includes(i.text.toLowerCase()) }, updated_at: now })));
          if (error) throw new Error(error.message);
          searches += ideas.length;
        }
      } catch (e) {
        failed.push(`${nameOf.get(verticalId) ?? verticalId} (searches): ${e instanceof Error ? e.message : e}`);
      }
    }
    // The other advertisers in our clients' auctions here, across their accounts (each domain averaged over them)
    const seen = new Map<string, { domain: string; accounts: number; impressionShare: number[]; overlap: number[]; outranking: number[]; above: number[]; top: number[] }>();
    for (const acc of v.accounts) {
      if (Date.now() > deadline) break;
      try {
        for (const d of await auctionInsights(acc)) {
          if (/^you$/i.test(d.domain)) continue;
          const s = seen.get(d.domain) ?? { domain: d.domain, accounts: 0, impressionShare: [], overlap: [], outranking: [], above: [], top: [] };
          s.accounts++;
          if (d.impressionShare != null) s.impressionShare.push(d.impressionShare);
          if (d.overlap != null) s.overlap.push(d.overlap);
          if (d.outranking != null) s.outranking.push(d.outranking);
          if (d.above != null) s.above.push(d.above);
          if (d.top != null) s.top.push(d.top);
          seen.set(d.domain, s);
        }
      } catch (e) {
        auctionsBlocked.push(`${acc}: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
      }
    }
    if (seen.size) {
      const avg = (l: number[]) => (l.length ? Math.round((l.reduce((a, b) => a + b, 0) / l.length) * 1000) / 1000 : null);
      const rows = [...seen.values()]
        .map((s) => ({ domain: s.domain, accounts: s.accounts, impressionShare: avg(s.impressionShare), overlap: avg(s.overlap), outranking: avg(s.outranking), above: avg(s.above), top: avg(s.top) }))
        .sort((a, b) => (b.impressionShare ?? 0) - (a.impressionShare ?? 0))
        .slice(0, 25);
      await admin.from("google_market").delete().eq("vertical_id", verticalId).eq("kind", "competitor");
      await admin.from("google_market").insert(rows.map((r) => ({ vertical_id: verticalId, kind: "competitor", key: r.domain, data: r, updated_at: now })));
      competitors += rows.length;
    }
  }
  return { industries: byVertical.size, searches, competitors, failed: failed.slice(0, 5), auctionInsights: auctionsBlocked.length ? `not readable on ${auctionsBlocked.length} account(s): ${auctionsBlocked[0]}` : "ok" };
}

export type MarketSearch = { text: string; searches: number; competition: string; competitionIndex: number; bidLow: number; bidHigh: number; months: number[]; seeded: boolean };
export type MarketCompetitor = { domain: string; accounts: number; impressionShare: number | null; overlap: number | null; outranking: number | null; above: number | null; top: number | null };
export type MarketIndustry = { id: string; name: string; parent: string | null; clients: string[]; searches: MarketSearch[]; competitors: MarketCompetitor[]; updatedAt: string | null };

/** Every industry with Google market data, with the clients we run Google for in it. */
export async function loadGoogleMarket(db: SupabaseClient): Promise<MarketIndustry[]> {
  const { data } = await db.from("google_market").select("vertical_id, kind, data, updated_at, verticals(name, parent_id)").limit(3000);
  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.vertical_id as string))];
  const [{ data: clients }, { data: parents }] = ids.length
    ? await Promise.all([
        db.from("clients").select("name, vertical_id").in("vertical_id", ids).is("archived_at", null).in("status", LIVE),
        db.from("verticals").select("id, name").in("id", [...new Set(rows.map((r) => (r.verticals as unknown as { parent_id: string | null } | null)?.parent_id).filter((x): x is string => Boolean(x)))]),
      ])
    : [{ data: [] }, { data: [] }];
  const parentName = new Map((parents ?? []).map((p) => [p.id as string, p.name as string]));
  return ids
    .map((id) => {
      const mine = rows.filter((r) => r.vertical_id === id);
      const v = mine[0]?.verticals as unknown as { name: string; parent_id: string | null } | null;
      return {
        id,
        name: v?.name ?? "Industry",
        parent: v?.parent_id ? (parentName.get(v.parent_id) ?? null) : null,
        clients: (clients ?? []).filter((c) => c.vertical_id === id).map((c) => c.name as string).sort(),
        searches: mine.filter((r) => r.kind === "search").map((r) => r.data as MarketSearch).sort((a, b) => b.searches - a.searches),
        competitors: mine.filter((r) => r.kind === "competitor").map((r) => r.data as MarketCompetitor).sort((a, b) => (b.impressionShare ?? 0) - (a.impressionShare ?? 0)),
        updatedAt: mine.map((r) => r.updated_at as string).sort().at(-1) ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
