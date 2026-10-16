import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// What industry each client is in, and what's working for clients in the same industry. A pizza place's winning ad
// is a strong starting point for another restaurant: the request form shows these winners and the AI reads them.

import { INDUSTRIES, industryLabel, type Industry } from "@/lib/industries";
export { INDUSTRIES, industryLabel, type Industry };

const SCHEMA = {
  type: "object",
  properties: {
    clients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          industry: { type: "string", enum: INDUSTRIES.map(([k]) => k) },
          detail: { type: "string" },
        },
        required: ["id", "industry", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["clients"],
  additionalProperties: false,
};

const SYSTEM = `You sort a marketing agency's clients into industries, from what the agency knows about each one (name, website, notes, the copy of their ads).
industry: the closest one from the list. Go by how they sell, not only what they sell: a brand that sells mainly online and ships to customers (food boxes, supplements, apparel, bedding) is "ecommerce", while a restaurant is somewhere people eat; a packaged product sold mainly through stores is "cpg". detail: two to four words, specific ("Pizza restaurant", "Kitchen remodeling", "Cosmetic dentistry", "Kayak rentals", "Nicotine-free pouches"). If there's too little to tell, use "other" and say what you can in detail.`;

/**
 * The AI sorts clients into industries. Clients the team set by hand are left alone; force redoes the AI's own.
 * Returns how many it set.
 */
export async function detectIndustries(admin: SupabaseClient, opts: { ids?: string[]; force?: boolean } = {}) {
  let q = admin.from("clients").select("id, name, website, industry, industry_source").neq("status", "offboarded");
  if (opts.ids?.length) q = q.in("id", opts.ids);
  const { data: all } = await q;
  const todo = (all ?? []).filter((c) => c.industry_source !== "team" && (opts.force || !c.industry));
  if (!todo.length) return 0;
  const ids = todo.map((c) => c.id);
  const [{ data: briefings }, { data: bibles }, { data: snaps }] = await Promise.all([
    admin.from("client_briefings").select("client_id, digest").in("client_id", ids),
    admin.from("client_brand_bibles").select("client_id, read_this_first").in("client_id", ids),
    admin.from("meta_snapshots").select("client_id, ads, fetched_at").in("client_id", ids).order("fetched_at", { ascending: false }).limit(ids.length * 3),
  ]);
  const digest = new Map((briefings ?? []).map((b) => [b.client_id, JSON.stringify(b.digest ?? {}).slice(0, 500)]));
  const bible = new Map((bibles ?? []).map((b) => [b.client_id, (b.read_this_first ?? "").slice(0, 400)]));
  const adsOf = new Map<string, string>();
  for (const s of snaps ?? []) {
    if (adsOf.has(s.client_id)) continue;
    const ads = (s.ads ?? []) as { name?: string; headline?: string | null; text?: string | null }[];
    adsOf.set(s.client_id, ads.slice(0, 4).map((a) => [a.headline, a.text?.slice(0, 120), a.name].filter(Boolean).join(" | ")).join(" // ").slice(0, 600));
  }

  let set = 0;
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const out = await askJson<{ clients: { id: string; industry: Industry; detail: string }[] }>({
      agent: "briefing",
      label: "client industries",
      system: SYSTEM,
      schema: SCHEMA,
      prompt: `Industries: ${INDUSTRIES.map(([k, l]) => `${k} (${l})`).join(", ")}

${batch
  .map((c) =>
    [`<client id="${c.id}">`, `Name: ${c.name}`, c.website && `Website: ${c.website}`, digest.get(c.id) && `Notes: ${digest.get(c.id)}`, bible.get(c.id) && `Brand: ${bible.get(c.id)}`, adsOf.get(c.id) && `Ads: ${adsOf.get(c.id)}`, "</client>"]
      .filter(Boolean)
      .join("\n"),
  )
  .join("\n\n")}`,
    });
    const now = new Date().toISOString();
    for (const r of out.clients) {
      if (!batch.some((c) => c.id === r.id)) continue;
      // Never over a team-set industry
      const { error } = await admin
        .from("clients")
        .update({ industry: r.industry, industry_detail: r.detail.trim().slice(0, 80) || null, industry_source: "ai", industry_set_at: now })
        .eq("id", r.id)
        .or("industry_source.is.null,industry_source.eq.ai");
      if (!error) set++;
    }
  }
  return set;
}

export type Winner = {
  id: string; // the ad's id in Meta
  client: string;
  clientId: string;
  clientSlug: string;
  industry: string | null;
  detail: string | null;
  name: string;
  headline: string | null;
  text: string | null;
  thumbnail: string | null;
  live: boolean | null; // delivering in the last sync (null: not known yet)
  result: string | null;
  results: number;
  costPerResult: number;
  usual: number; // that account's typical cost per result
  ratio: number; // usual / this ad's: 2 = half the usual cost
  spend: number;
  ctr: number;
  syncedAt: string;
};

type SnapAd = { id: string; name: string; headline: string | null; text: string | null; thumbnail: string | null; image?: string | null; live?: boolean; spend?: number; results?: number; result?: string | null; costPerResult?: number | null; ctr?: number };
type Peer = { id: string; name: string; slug: string; industry: string | null; industry_detail: string | null };

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * The ads beating their own account: enough spend and results to count ($100, 3 results), and a cost per result at
 * least 1.2x better than that account's typical one. Best first, at most `perClient` from one client.
 */
export type WinnerScope = { accounts: number; ads: number; eligible: number; withoutData: number };

async function scoreWinners(db: SupabaseClient, peers: Peer[], opts: { perClient: number; limit: number; scope?: WinnerScope }): Promise<Winner[]> {
  if (!peers.length) return [];
  const { data: snaps } = await db
    .from("meta_snapshots")
    .select("client_id, ads, fetched_at")
    .in("client_id", peers.map((p) => p.id))
    .order("fetched_at", { ascending: false })
    .limit(peers.length * 3);
  const seen = new Set<string>();
  const winners: Winner[] = [];
  for (const s of snaps ?? []) {
    if (seen.has(s.client_id)) continue;
    seen.add(s.client_id);
    const peer = peers.find((p) => p.id === s.client_id)!;
    const ads = ((s.ads ?? []) as SnapAd[]).filter((a) => (a.spend ?? 0) >= 100 && (a.results ?? 0) >= 3 && a.costPerResult);
    if (opts.scope) {
      opts.scope.accounts++;
      opts.scope.ads += ((s.ads ?? []) as SnapAd[]).length;
      opts.scope.eligible += ads.length;
    }
    if (ads.length < 2) continue;
    const usual = median(ads.map((a) => a.costPerResult!));
    for (const a of ads) {
      const ratio = usual / a.costPerResult!;
      if (ratio < 1.2) continue;
      winners.push({
        id: a.id,
        client: peer.name,
        clientId: peer.id,
        clientSlug: peer.slug,
        industry: peer.industry,
        detail: peer.industry_detail,
        name: a.name,
        headline: a.headline,
        text: a.text,
        thumbnail: a.image ?? a.thumbnail,
        live: a.live ?? null,
        result: a.result ?? null,
        results: a.results ?? 0,
        costPerResult: a.costPerResult!,
        usual,
        ratio: Math.round(ratio * 10) / 10,
        spend: a.spend ?? 0,
        ctr: a.ctr ?? 0,
        syncedAt: s.fetched_at,
      });
    }
  }
  winners.sort((a, b) => b.ratio - a.ratio);
  const per = new Map<string, number>();
  return winners.filter((w) => (per.set(w.clientId, (per.get(w.clientId) ?? 0) + 1).get(w.clientId) ?? 0) <= opts.perClient).slice(0, opts.limit);
}

/** The best ads across the other clients in an industry (for a request and the AI). */
export async function industryWinners(db: SupabaseClient, industry: string, excludeClientId?: string, limit = 6): Promise<Winner[]> {
  const { data: peers } = await db.from("clients").select("id, name, slug, industry, industry_detail").eq("industry", industry).neq("status", "offboarded");
  return scoreWinners(db, ((peers ?? []) as Peer[]).filter((p) => p.id !== excludeClientId), { perClient: 2, limit });
}

/** The winners library: the best ads across every client we run. Pass scope to learn what was looked at. */
export async function allWinners(db: SupabaseClient, scope?: WinnerScope): Promise<Winner[]> {
  const { data: peers } = await db.from("clients").select("id, name, slug, industry, industry_detail, meta_ad_account_id").neq("status", "offboarded");
  const list = (peers ?? []) as (Peer & { meta_ad_account_id: string | null })[];
  const winners = await scoreWinners(db, list, { perClient: 8, limit: 300, scope });
  // Accounts linked to Meta that haven't had ad-level numbers pulled yet (they fill in over the next syncs)
  if (scope) scope.withoutData = Math.max(0, list.filter((p) => p.meta_ad_account_id).length - scope.accounts);
  return winners;
}

/** The winners as context for the AI. Other clients' names stay out: it's what worked, not whose it was. */
export function winnersBlock(industry: string | null, detail: string | null, winners: Winner[]) {
  if (!industry || !winners.length) return "";
  return `<what_works_for_similar_clients>
Ads that are beating their own account right now, from other Kaizen clients in ${industryLabel(industry) ?? industry}${detail ? ` (this client: ${detail})` : ""}. Learn from the angle, the hook and the structure; don't copy them word for word, and never mention another client.
${winners
  .map((w) => `- ${w.detail ?? "Similar business"}: "${w.headline ?? w.name}"${w.text ? ` · copy: ${w.text.slice(0, 220)}` : ""} · ${w.ratio}x better than that account's usual cost per ${w.result ?? "result"}${w.ctr ? ` · CTR ${w.ctr}%` : ""}`)
  .join("\n")}
</what_works_for_similar_clients>`;
}
