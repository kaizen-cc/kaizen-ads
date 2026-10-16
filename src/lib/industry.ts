import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// What industry each client is in, and what's working for clients in the same industry. A pizza place's winning ad
// is a strong starting point for another restaurant: the request form shows these winners and the AI reads them.

import { INDUSTRIES, industryLabel, type Industry } from "@/lib/industries";
import { LIVE } from "@/lib/live";
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

const SYSTEM = `You sort a marketing agency's clients into industries, from everything the agency knows about each one: their marketing intake form, Brand Bible, the briefing from Slack, email and Drive, recent messages, their website and their ads.
industry: the closest one from the list. Go by how they sell, not only what they sell: a brand that sells mainly online and ships to customers (food boxes, supplements, apparel, bedding) is "ecommerce"; a restaurant, bar or cafe is somewhere people eat and drink ("restaurant"); a packaged product sold mainly through stores is "cpg"; a venue or experience people come to (paintball, nightclub, events) is "entertainment". The intake form and the website are the strongest evidence; the name alone is the weakest.
detail: two to four words, specific ("Pizza restaurant", "Kitchen remodeling", "Cosmetic dentistry", "Kayak rentals", "Nicotine-free pouches"). If there's genuinely too little to tell, use "other" and say what you can in detail.`;

/** What a client's website says about them: title, description and the start of the visible text. */
async function readSite(url: string | null) {
  if (!url) return null;
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const res = await fetch(href, { signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0 (KaizenAds industry reader)" }, redirect: "follow" });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400_000);
    const pick = (re: RegExp) => html.match(re)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
    const text = html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
    return [title && `Title: ${title}`, description && `Description: ${description}`, text && `Page: ${text}`].filter(Boolean).join("\n") || null;
  } catch {
    return null; // slow, blocked or down: the rest of what we know still counts
  }
}

/**
 * The AI sorts clients into industries from everything the client page knows. Clients the team set by hand are left
 * alone; force redoes the AI's own. Returns how many it set.
 */
export async function detectIndustries(admin: SupabaseClient, opts: { ids?: string[]; force?: boolean } = {}) {
  let q = admin.from("clients").select("id, name, website, industry, industry_source").is("archived_at", null).in("status", LIVE);
  if (opts.ids?.length) q = q.in("id", opts.ids);
  const { data: all } = await q;
  const todo = (all ?? []).filter((c) => c.industry_source !== "team" && (opts.force || !c.industry));
  if (!todo.length) return 0;
  const ids = todo.map((c) => c.id);
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [{ data: briefings }, { data: bibles }, { data: snaps }, { data: intakes }, { data: items }] = await Promise.all([
    admin.from("client_briefings").select("client_id, digest").in("client_id", ids),
    admin.from("client_brand_bibles").select("client_id, read_this_first").in("client_id", ids),
    admin.from("meta_snapshots").select("client_id, ads, fetched_at").in("client_id", ids).order("fetched_at", { ascending: false }).limit(ids.length * 3),
    admin.from("client_intakes").select("client_id, summary, answers, received_at").in("client_id", ids).order("received_at", { ascending: false }),
    admin.from("context_items").select("client_id, source, title, body, occurred_at").in("client_id", ids).neq("source", "drive").gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(ids.length * 10),
  ]);

  const first = <T extends { client_id: string }>(rows: T[] | null) => {
    const m = new Map<string, T>();
    for (const r of rows ?? []) if (!m.has(r.client_id)) m.set(r.client_id, r);
    return m;
  };
  const intakeOf = first(intakes);
  const bibleOf = first(bibles);
  const briefOf = first(briefings);
  const snapOf = first(snaps);
  const messages = new Map<string, string[]>();
  for (const i of items ?? []) {
    const list = messages.get(i.client_id) ?? [];
    if (list.length < 6) list.push(`${i.source === "gmail" ? "Email" : "Slack"}: ${[i.title, i.body].filter(Boolean).join(" · ").replace(/\s+/g, " ").slice(0, 220)}`);
    messages.set(i.client_id, list);
  }
  const sites = new Map<string, string | null>();
  for (let i = 0; i < todo.length; i += 6) {
    const chunk = todo.slice(i, i + 6);
    const read = await Promise.all(chunk.map((c) => readSite(c.website)));
    chunk.forEach((c, j) => sites.set(c.id, read[j]));
  }

  const block = (c: (typeof todo)[number]) => {
    const intake = intakeOf.get(c.id);
    const summary = intake?.summary as { business?: string; offer?: string; audience?: string } | null;
    const answers = !summary && intake ? (intake.answers as { q: string; a: string }[]).slice(0, 6).map((x) => `${x.q}: ${x.a}`).join(" / ").slice(0, 900) : null;
    const digest = briefOf.get(c.id)?.digest as { summary?: string; direction?: string } | null;
    const ads = ((snapOf.get(c.id)?.ads ?? []) as { name?: string; headline?: string | null; text?: string | null }[])
      .slice(0, 5)
      .map((a) => [a.headline, a.text?.slice(0, 140), a.name].filter(Boolean).join(" | "))
      .join(" // ")
      .slice(0, 800);
    return [
      `<client id="${c.id}">`,
      `Name: ${c.name}`,
      c.website && `Website address: ${c.website}`,
      summary && `Marketing intake: ${[summary.business, summary.offer && `Offer: ${summary.offer}`, summary.audience && `Audience: ${summary.audience}`].filter(Boolean).join(" ")}`,
      answers && `Marketing intake (answers): ${answers}`,
      sites.get(c.id) && `Their website:\n${sites.get(c.id)}`,
      bibleOf.get(c.id)?.read_this_first && `Brand Bible: ${bibleOf.get(c.id)!.read_this_first!.slice(0, 1200)}`,
      digest && `Briefing: ${[digest.summary, digest.direction].filter(Boolean).join(" ").slice(0, 900)}`,
      messages.get(c.id)?.length && `Recent messages:\n${messages.get(c.id)!.join("\n")}`,
      ads && `Their ads: ${ads}`,
      "</client>",
    ]
      .filter(Boolean)
      .join("\n");
  };

  let set = 0;
  for (let i = 0; i < todo.length; i += 8) {
    const batch = todo.slice(i, i + 8);
    const out = await askJson<{ clients: { id: string; industry: Industry; detail: string }[] }>({
      agent: "industry",
      label: "client industries",
      system: SYSTEM,
      schema: SCHEMA,
      prompt: `Industries: ${INDUSTRIES.map(([k, l]) => `${k} (${l})`).join(", ")}\n\n${batch.map(block).join("\n\n")}`,
    });
    const now = new Date().toISOString();
    for (const r of out.clients) {
      if (!batch.some((c) => c.id === r.id)) continue;
      // Never over a team-set industry
      const { error } = await admin
        .from("clients")
        .update({ industry: r.industry, industry_detail: r.detail.trim().slice(0, 80) || null, industry_source: "ai", industry_set_at: now, industry_version: 2 })
        .eq("id", r.id)
        .or("industry_source.is.null,industry_source.eq.ai");
      if (!error) set++;
    }
  }
  return set;
}

/** Hourly: redo industries the first, thin method set (a batch at a time), now that there's much more to go on. */
export async function refreshIndustries(admin: SupabaseClient, max = 24) {
  const { data } = await admin
    .from("clients")
    .select("id")
    .in("status", LIVE)
    .is("archived_at", null)
    .or("industry_source.is.null,industry_source.eq.ai")
    .lt("industry_version", 2)
    .order("creative_package", { ascending: false })
    .limit(max);
  const ids = (data ?? []).map((c) => c.id as string);
  return ids.length ? detectIndustries(admin, { ids, force: true }) : 0;
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
