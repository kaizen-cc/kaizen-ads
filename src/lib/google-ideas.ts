import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { googleIdeaRows, type GoogleIdeaRow } from "@/lib/context/google-ads";
import { conversionFor } from "@/lib/kpi/conversions";
import { LIVE } from "@/lib/live";

// Ideas for Google: what's won in our Google Ads accounts. Three kinds: ads (a responsive search ad's copy), keywords,
// and the search terms people typed before they converted.
// - Hall of Fame: over the last 180 days, enough spend and conversions, and a cost per conversion at or under the
//   client's KPI target (ROAS at or above it), or 20% better than the account's own when there's no target. Kept six
//   months after it last qualified.
// - Live winners: the last 30 days and still running, held to the same bar (the target, or 20% better than the account).
// Updated once a day; the AI's read of why one won is written the first time someone points at it.

const DAY = 86_400_000;
const KEEP_MS = 182 * DAY;
const FLOOR = {
  fame: { ad: { spend: 300, conv: 5 }, keyword: { spend: 150, conv: 3 }, search_term: { spend: 40, conv: 3 } },
  live: { ad: { spend: 100, conv: 3 }, keyword: { spend: 50, conv: 2 }, search_term: { spend: 20, conv: 2 } },
} as const;

export type GoogleKind = "ad" | "keyword" | "search_term";
type Item = { kind: GoogleKind; key: string; campaign: string | null; adGroup: string | null; content: Record<string, unknown>; spend: number; clicks: number; impressions: number; conversions: number; value: number; enabled: boolean };

const num = (v: unknown) => Number(v) || 0;
const g = (r: GoogleIdeaRow, path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], r);
const stats = (r: GoogleIdeaRow) => ({ spend: num(g(r, "metrics.costMicros")) / 1e6, clicks: num(g(r, "metrics.clicks")), impressions: num(g(r, "metrics.impressions")), conversions: num(g(r, "metrics.conversions")), value: num(g(r, "metrics.conversionsValue")) });

/** The rows of one kind summed by what they are (the same keyword in two ad groups is one keyword). */
function items(rows: GoogleIdeaRow[], kind: GoogleKind): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const r of rows) {
    let key: string;
    let content: Record<string, unknown>;
    let enabled = String(g(r, "campaign.status") ?? "ENABLED") === "ENABLED";
    if (kind === "ad") {
      key = String(g(r, "adGroupAd.ad.id") ?? "");
      const texts = (p: string) => ((g(r, p) ?? []) as { text?: string }[]).map((x) => x.text ?? "").filter(Boolean);
      content = { headlines: texts("adGroupAd.ad.responsiveSearchAd.headlines"), descriptions: texts("adGroupAd.ad.responsiveSearchAd.descriptions"), url: ((g(r, "adGroupAd.ad.finalUrls") ?? []) as string[])[0] ?? null, path1: g(r, "adGroupAd.ad.responsiveSearchAd.path1") ?? null, path2: g(r, "adGroupAd.ad.responsiveSearchAd.path2") ?? null };
      enabled &&= String(g(r, "adGroupAd.status")) === "ENABLED";
    } else if (kind === "keyword") {
      const text = String(g(r, "adGroupCriterion.keyword.text") ?? "");
      const match = String(g(r, "adGroupCriterion.keyword.matchType") ?? "");
      key = `${text.toLowerCase()}|${match}`;
      content = { text, match };
      enabled &&= String(g(r, "adGroupCriterion.status")) === "ENABLED";
    } else {
      const text = String(g(r, "searchTermView.searchTerm") ?? "");
      key = text.toLowerCase();
      content = { text };
    }
    if (!key || key === "|") continue;
    const s = stats(r);
    const cur = out.get(key);
    if (cur) {
      cur.spend += s.spend;
      cur.clicks += s.clicks;
      cur.impressions += s.impressions;
      cur.conversions += s.conversions;
      cur.value += s.value;
      cur.enabled ||= enabled;
    } else out.set(key, { kind, key, campaign: (g(r, "campaign.name") as string) ?? null, adGroup: (g(r, "adGroup.name") as string) ?? null, content, ...s, enabled });
  }
  return out;
}

const resultOf = (i: { spend: number; conversions: number; value: number }, roas: boolean) => (roas ? (i.spend ? i.value / i.spend : null) : i.conversions ? i.spend / i.conversions : null);
/** How much better than the reference: +0.3 = 30% better (cheaper per conversion, or a higher ROAS). */
const better = (v: number | null, ref: number | null, roas: boolean) => (v == null || !ref ? null : roas ? (v - ref) / ref : (ref - v) / ref);

/** Re-reads every live client's Google Ads account and updates the Hall of Fame and the live winners. */
export async function updateGoogleIdeas(admin: SupabaseClient, deadline = Date.now() + 240_000) {
  const { data: targets } = await admin
    .from("kpi_targets")
    .select("client_id, ad_account_id, conversion, target, clients!inner(archived_at, status)")
    .eq("active", true)
    .eq("platform", "google")
    .not("ad_account_id", "is", null)
    .is("clients.archived_at", null)
    .in("clients.status", LIVE);
  // One account once (a client with two KPIs on the same account), judged on its first KPI
  const accounts = new Map<string, { client_id: string; account: string; roas: boolean; target: number | null }>();
  for (const t of targets ?? []) {
    const account = String(t.ad_account_id);
    if (accounts.has(account)) continue;
    accounts.set(account, { client_id: t.client_id as string, account, roas: Boolean(conversionFor(t.conversion as string).roas), target: t.target == null ? null : Number(t.target) || null });
  }
  let checked = 0;
  let fame = 0;
  let live = 0;
  const failed: string[] = [];
  for (const a of accounts.values()) {
    if (Date.now() > deadline) break;
    try {
      const d = await googleIdeaRows(a.account);
      checked++;
      const sum = (rows: GoogleIdeaRow[]) => rows.reduce((o, r) => ({ spend: o.spend + stats(r).spend, conversions: o.conversions + stats(r).conversions, value: o.value + stats(r).value }), { spend: 0, conversions: 0, value: 0 });
      const usual180 = resultOf(sum(d.t180), a.roas);
      const usual30 = resultOf(sum(d.t30), a.roas);
      // Held to the KPI target when there is one; otherwise 20% better than the account usually does
      const bench = a.target ?? usual180;
      const basis = a.target ? "target" : "account";
      const now = new Date().toISOString();
      const rows: Record<string, unknown>[] = [];
      for (const kind of ["ad", "keyword", "search_term"] as const) {
        const long = items(kind === "ad" ? d.ads180 : kind === "keyword" ? d.kw180 : d.st180, kind);
        const short = items(kind === "ad" ? d.ads30 : kind === "keyword" ? d.kw30 : d.st30, kind);
        for (const key of new Set([...long.keys(), ...short.keys()])) {
          const l = long.get(key);
          const s = short.get(key);
          const fl = FLOOR.fame[kind];
          const lv = FLOOR.live[kind];
          const lr = l ? resultOf(l, a.roas) : null;
          const lb = better(lr, bench, a.roas);
          const isFame = Boolean(l && l.spend >= fl.spend && l.conversions >= fl.conv && lb != null && lb >= (basis === "target" ? 0 : 0.2));
          const sr = s ? resultOf(s, a.roas) : null;
          // Live: the same bar over the last 30 days (the target when there is one, else 20% better than the account)
          const liveBench = a.target ?? usual30;
          const sb = better(sr, liveBench, a.roas);
          const isLive = Boolean(s && (kind === "search_term" || s.enabled) && s.spend >= lv.spend && s.conversions >= lv.conv && sb != null && sb >= (a.target ? 0 : 0.2));
          if (!isFame && !isLive) continue;
          const base = (l ?? s)!;
          rows.push({
            client_id: a.client_id,
            account: a.account,
            kind,
            key,
            campaign: base.campaign,
            ad_group: base.adGroup,
            content: base.content,
            spend: Math.round((l?.spend ?? s!.spend) * 100) / 100,
            clicks: l?.clicks ?? s!.clicks,
            impressions: l?.impressions ?? s!.impressions,
            conversions: Math.round((l?.conversions ?? s!.conversions) * 10) / 10,
            value: Math.round((l?.value ?? s!.value) * 100) / 100,
            roas: a.roas,
            result: lr == null ? sr : Math.round(lr * 100) / 100,
            usual: bench == null ? null : Math.round(bench * 100) / 100,
            basis,
            beat_by: Math.round((lb ?? sb ?? 0) * 1000) / 1000,
            live: isLive,
            live_result: sr == null ? null : Math.round(sr * 100) / 100,
            live_beat_by: sb == null ? null : Math.round(sb * 1000) / 1000,
            fame: isFame,
            ...(isFame ? { qualified_at: now, expires_at: new Date(Date.now() + KEEP_MS).toISOString() } : {}),
            updated_at: now,
          });
        }
      }
      // What's no longer winning live stops being live; the Hall of Fame keeps its six months
      await admin.from("google_ideas").update({ live: false }).eq("account", a.account).eq("live", true);
      // Keep a Hall of Fame entry's place when it's only live now (its fame and expiry don't drop)
      const { data: had } = rows.length ? await admin.from("google_ideas").select("kind, key, fame, expires_at").eq("client_id", a.client_id) : { data: [] };
      const prev = new Map((had ?? []).map((h) => [`${h.kind}|${h.key}`, h]));
      for (const r of rows) {
        const p = prev.get(`${r.kind}|${r.key}`);
        if (!r.fame && p?.fame && Date.parse(p.expires_at as string) > Date.now()) r.fame = true;
      }
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await admin.from("google_ideas").upsert(rows.slice(i, i + 200), { onConflict: "client_id,kind,key" });
        if (error) throw new Error(error.message);
      }
      fame += rows.filter((r) => r.fame).length;
      live += rows.filter((r) => r.live).length;
    } catch (e) {
      failed.push(`${a.account}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { accounts: accounts.size, checked, fame, live, failed: failed.slice(0, 5) };
}

export type GoogleIdea = {
  id: string;
  kind: GoogleKind;
  clientId: string;
  client: string;
  clientSlug: string;
  vertical: string | null;
  campaign: string | null;
  adGroup: string | null;
  content: { headlines?: string[]; descriptions?: string[]; url?: string | null; path1?: string | null; path2?: string | null; text?: string; match?: string };
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
  roas: boolean;
  result: number | null;
  usual: number | null;
  basis: "target" | "account";
  beatBy: number;
  live: boolean;
  liveResult: number | null;
  liveBeatBy: number | null;
  /** A search for the client's own name (or in a brand campaign): it always wins, and isn't an idea for anyone else */
  branded: boolean;
  insight: GoogleInsight | null;
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Whether a winner is the client's own brand: a brand campaign or ad group, or a search with the client's name in it. */
function isBranded(client: string, kind: string, campaign: string | null, adGroup: string | null, text: string | undefined) {
  if (/(^|[^a-z])brand(ed)?([^a-z]|$)/i.test(`${campaign ?? ""} ${adGroup ?? ""}`)) return true;
  if (kind === "ad" || !text) return false;
  const t = squash(text);
  const whole = squash(client);
  if (whole.length >= 4 && t.includes(whole)) return true;
  // Any distinctive word of the name ("Crust" in Crust Pizza Co., "Aldecoa", "E11even"), not the generic ones
  const generic = /^(the|and|co|inc|llc|group|pizza|coffee|miami|law|dental|med|spa|clinic|studio|shop|store|company|marketing|services?|solutions?)$/;
  return client
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !generic.test(w))
    .some((w) => t.includes(w));
}

export type GoogleInsight = { observation: string; why: string; angle: string; takeaways: string[]; deploy: { copy: string; keywords: string[]; campaign: string } };

/** The Hall of Fame (fame: true) or the live winners (live: true), best first. */
export async function loadGoogleIdeas(db: SupabaseClient, which: "fame" | "live"): Promise<GoogleIdea[]> {
  let q = db.from("google_ideas").select("*, clients(name, slug, verticals(name))").limit(400);
  q = which === "fame" ? q.eq("fame", true).gt("expires_at", new Date().toISOString()).order("beat_by", { ascending: false }) : q.eq("live", true).order("live_beat_by", { ascending: false });
  const { data } = await q;
  return (data ?? []).map((r) => {
    const c = r.clients as unknown as { name: string; slug: string; verticals: { name: string } | null } | null;
    return {
      id: r.id,
      kind: r.kind,
      clientId: r.client_id,
      client: c?.name ?? "",
      clientSlug: c?.slug ?? "",
      vertical: c?.verticals?.name ?? null,
      campaign: r.campaign,
      adGroup: r.ad_group,
      content: r.content ?? {},
      spend: Number(r.spend),
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      conversions: Number(r.conversions),
      roas: r.roas,
      result: r.result == null ? null : Number(r.result),
      usual: r.usual == null ? null : Number(r.usual),
      basis: r.basis,
      beatBy: Number(r.beat_by),
      live: r.live,
      liveResult: r.live_result == null ? null : Number(r.live_result),
      liveBeatBy: r.live_beat_by == null ? null : Number(r.live_beat_by),
      branded: isBranded(c?.name ?? "", r.kind, r.campaign, r.ad_group, (r.content as { text?: string } | null)?.text),
      insight: (r.insight as GoogleInsight | null) ?? null,
    };
  });
}

const SCHEMA = {
  type: "object",
  properties: {
    observation: { type: "string" },
    why: { type: "string" },
    angle: { type: "string" },
    takeaways: { type: "array", items: { type: "string" } },
    deploy: {
      type: "object",
      properties: { copy: { type: "string" }, keywords: { type: "array", items: { type: "string" } }, campaign: { type: "string" } },
      required: ["copy", "keywords", "campaign"],
      additionalProperties: false,
    },
  },
  required: ["observation", "why", "angle", "takeaways", "deploy"],
  additionalProperties: false,
};

const SYSTEM = `You are the senior Google Ads strategist at Kaizen, a performance agency, reading one of our winning Google Ads items for the team: a responsive search ad's copy, a keyword, or a search term people typed before converting. It's a winner because it converts clearly cheaper (or at a higher ROAS) than its target or its own account.
observation: what the numbers show, 2 to 3 sentences: how it compares, the volume behind it, the click-through and conversion rate when they tell something. Only numbers given; never invent one.
why: why it most likely wins, 2 to 4 sentences: the search intent it catches, how the copy matches that intent (the promise, the proof, the offer, the call to action), the match type, what it filters out. Specific to this one, not generic advice.
angle: the selling idea or intent in a few words.
takeaways: 2 or 3 short, concrete things another client's Google account could borrow (the structure, not the words).
deploy: how to use it on another client in the same kind of business: copy, one line on the headlines and descriptions to write around it; keywords, 3 to 8 keywords or search terms to add (with match type in brackets, e.g. [exact] or "phrase"); campaign, one line on the campaign or ad group to build around it.
Plain, direct, no hype.`;

/** The AI's read of why one item won, and how to use it on another client (kept a week, then rewritten). */
export async function readGoogleIdea(admin: SupabaseClient, id: string): Promise<GoogleInsight | null> {
  const { data: r } = await admin.from("google_ideas").select("*, clients(name, industry_detail)").eq("id", id).maybeSingle();
  if (!r) return null;
  if (r.insight && r.insight_at && Date.now() - Date.parse(r.insight_at) < 7 * DAY) return r.insight as GoogleInsight;
  const c = r.clients as unknown as { name: string; industry_detail: string | null } | null;
  const content = r.content as GoogleIdea["content"];
  const what =
    r.kind === "ad"
      ? `A responsive search ad.\nHeadlines: ${(content.headlines ?? []).join(" | ")}\nDescriptions: ${(content.descriptions ?? []).join(" | ")}\nLanding page: ${content.url ?? "unknown"}`
      : r.kind === "keyword"
        ? `A keyword: "${content.text}" (${String(content.match ?? "").toLowerCase()} match)`
        : `A search term people typed before converting: "${content.text}"`;
  const unit = r.roas ? "ROAS" : "cost per conversion";
  const fmt = (v: unknown) => (v == null ? "unknown" : r.roas ? `${Number(v).toFixed(2)}x` : `$${Number(v).toFixed(2)}`);
  const out = await askJson<GoogleInsight>({
    agent: "winners",
    label: "read a Google winner",
    system: SYSTEM,
    schema: SCHEMA,
    maxTokens: 2000,
    prompt: `Client: ${c?.name ?? "a client"}${c?.industry_detail ? ` (${c.industry_detail})` : ""}
Campaign: ${r.campaign ?? "unknown"}${r.ad_group ? ` · ad group: ${r.ad_group}` : ""}

${what}

Over its run: $${Number(r.spend).toFixed(0)} spent, ${Number(r.clicks)} clicks from ${Number(r.impressions)} impressions${Number(r.impressions) ? ` (CTR ${((Number(r.clicks) / Number(r.impressions)) * 100).toFixed(2)}%)` : ""}, ${Number(r.conversions)} conversions${Number(r.clicks) ? ` (conversion rate ${((Number(r.conversions) / Number(r.clicks)) * 100).toFixed(1)}%)` : ""}.
Its ${unit}: ${fmt(r.result)} against ${r.basis === "target" ? "the client's target" : "the account's own"} of ${fmt(r.usual)}.${r.live && r.live_result != null ? `\nThe last 30 days: ${fmt(r.live_result)}, ${Math.round(Number(r.live_beat_by) * 100)}% better than the account.` : ""}`,
  });
  await admin.from("google_ideas").update({ insight: out, insight_at: new Date().toISOString() }).eq("id", id);
  return out;
}
