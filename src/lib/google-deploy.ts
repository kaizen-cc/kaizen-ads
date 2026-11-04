import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";

// "Use it on a client": a winning Google ad, keyword or search term from Ideas › Google, taken to one client as an
// action item. Three kinds:
// - copy: a responsive search ad around the idea, in the client's voice (headlines 30 characters, descriptions 90,
//   pins where they matter);
// - campaign: a campaign or ad group around it (structure, keywords with match types, negatives, landing page);
// - keywords: keywords to add, with the negatives that keep them clean.
// Written from the client's Brand Bible, Google go-to-market strategy, business model, the sub-vertical's Google
// playbook and the patterns across clients. The Google buyer approves, edits or declines it like a suggested brief.
// Approved, it's a checklist to apply by hand, or (when Google writes are switched on in Settings) pushed to Google
// Ads paused: keywords and the ad into an ad group the buyer picks, negatives onto a campaign. A whole new campaign is
// always built by hand from the checklist.

export type DeployKind = "copy" | "campaign" | "keywords";
export type Match = "exact" | "phrase" | "broad";
export type Kw = { text: string; match: Match };
/**
 * Where it goes in Google Ads: an ad group (and its campaign), or a new ad group made in a campaign; keywords go in
 * paused unless an exec or lead chose enabled. Kept on the plan when it's picked ahead (keyword research).
 */
export type DeployTarget = { campaignId: string | null; adGroupId: string | null; campaign: string | null; adGroup: string | null; newAdGroup?: string | null; status?: "PAUSED" | "ENABLED" };
export type DeployPlan = {
  summary: string;
  why: string;
  headlines: { text: string; pin: 0 | 1 | 2 | 3 }[];
  descriptions: { text: string; pin: 0 | 1 | 2 }[];
  path1: string;
  path2: string;
  finalUrl: string;
  campaignName: string;
  adGroups: { name: string; keywords: Kw[] }[];
  keywords: Kw[];
  negatives: Kw[];
  settings: string[];
  checklist: string[];
  /** Picked ahead (keyword research); the push picker starts from it */
  target?: DeployTarget;
};
export type Deploy = {
  id: string;
  clientId: string;
  client: string;
  clientSlug: string;
  ideaId: string | null;
  idea: { kind: string; text: string; result: string; client?: string };
  kind: DeployKind;
  note: string | null;
  status: "drafting" | "open" | "approved" | "declined" | "applied" | "partial" | "failed";
  plan: DeployPlan | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  decidedAt: string | null;
  declineReason: string | null;
  applied: { target?: Partial<DeployTarget>; results: { what: string; ok: boolean; error: string | null }[] } | null;
};

export const KIND_LABEL: Record<DeployKind, string> = { copy: "Ad copy around it", campaign: "A campaign around it", keywords: "Keywords to add" };

const S = { type: "string" };
const KW = { type: "object", properties: { text: S, match: { type: "string", enum: ["exact", "phrase", "broad"] } }, required: ["text", "match"], additionalProperties: false };
const SCHEMA = {
  type: "object",
  properties: {
    summary: S,
    why: S,
    headlines: { type: "array", items: { type: "object", properties: { text: S, pin: { type: "integer", enum: [0, 1, 2, 3] } }, required: ["text", "pin"], additionalProperties: false } },
    descriptions: { type: "array", items: { type: "object", properties: { text: S, pin: { type: "integer", enum: [0, 1, 2] } }, required: ["text", "pin"], additionalProperties: false } },
    path1: S,
    path2: S,
    finalUrl: S,
    campaignName: S,
    adGroups: { type: "array", items: { type: "object", properties: { name: S, keywords: { type: "array", items: KW } }, required: ["name", "keywords"], additionalProperties: false } },
    keywords: { type: "array", items: KW },
    negatives: { type: "array", items: KW },
    settings: { type: "array", items: S },
    checklist: { type: "array", items: S },
  },
  required: ["summary", "why", "headlines", "descriptions", "path1", "path2", "finalUrl", "campaignName", "adGroups", "keywords", "negatives", "settings", "checklist"],
  additionalProperties: false,
};

const SYSTEM = `You are Kaizen's senior Google Ads strategist. A Google buyer picked one of our winning Google items (a search ad, a keyword or a search term that converted clearly cheaper than its own client's target) and wants it used on another client. Write the action for that client, ready to apply.
The client comes first: their offer, voice, services, locations and rules (Brand Bible, Google go-to-market strategy, business model, what they told us) decide what's true and allowed. Borrow the idea's intent, angle and structure, never its words, brand, prices or claims. Never invent a price, discount, guarantee, review count or statistic; when the angle needs one the client hasn't confirmed, use what they have or put "[confirm: …]" and list it in the checklist. Rule one: what's proven profitable beats what's clever; use the Google playbook and the patterns across clients where they fit.
By kind (leave the other fields empty: [] or ""):
- copy: one responsive search ad. headlines: 10 to 15, each 30 characters or less, varied (benefit, proof, offer, the keyword, a call to action); pin: 0 (no pin) unless it must lead (1) or sit second (2) or third (3), at most 2 pinned. descriptions: 4, each 90 characters or less; pin 0 unless it must come first (1). path1 and path2: 15 characters or less each. finalUrl: the client's best matching page from what we know, else "".
- campaign: campaignName, adGroups (2 to 5, each with 5 to 15 tightly themed keywords and match types), negatives (5 to 20), settings (bidding, budget, geo, schedule, networks: one line each, from the strategy and targets), finalUrl, plus one ad's headlines and descriptions as above for the first ad group.
- keywords: keywords (5 to 20, with match types, exact and phrase first), negatives (3 to 15) that keep them clean, finalUrl when the page matters.
summary: one sentence saying what this is for this client. why: two or three sentences on why it should work here, citing the idea's numbers and anything in the client's context or the playbook that backs it.
checklist: the steps to apply it by hand in Google Ads, in order (where, what, which settings), plus anything to confirm with the client.
Plain words, no hype, no em dashes. Roles, never people's names.`;

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const kws = (a: Kw[], n: number) => {
  const seen = new Set<string>();
  return a
    .map((k) => ({ text: clip(k.text.toLowerCase().replace(/[[\]"]/g, ""), 80), match: k.match }))
    .filter((k) => k.text && !seen.has(`${k.text}|${k.match}`) && seen.add(`${k.text}|${k.match}`))
    .slice(0, n);
};

/** Within Google's limits: 15 headlines of 30, 4 descriptions of 90, paths of 15, at most 2 pins on each. */
export function tidyPlan(p: DeployPlan): DeployPlan {
  let pins = 0;
  let dpins = 0;
  return {
    ...p,
    summary: clip(p.summary, 400),
    why: clip(p.why, 1200),
    headlines: p.headlines
      .map((h) => ({ text: clip(h.text, 30), pin: h.pin }))
      .filter((h) => h.text)
      .slice(0, 15)
      .map((h) => ({ ...h, pin: h.pin && pins < 2 ? (pins++, h.pin) : 0 }) as DeployPlan["headlines"][number]),
    descriptions: p.descriptions
      .map((d) => ({ text: clip(d.text, 90), pin: d.pin }))
      .filter((d) => d.text)
      .slice(0, 4)
      .map((d) => ({ ...d, pin: d.pin && dpins < 2 ? (dpins++, d.pin) : 0 }) as DeployPlan["descriptions"][number]),
    path1: clip(p.path1, 15).replace(/\s+/g, "-"),
    path2: clip(p.path2, 15).replace(/\s+/g, "-"),
    finalUrl: clip(p.finalUrl, 500),
    campaignName: clip(p.campaignName, 120),
    adGroups: p.adGroups.slice(0, 8).map((g) => ({ name: clip(g.name, 120), keywords: kws(g.keywords, 30) })),
    keywords: kws(p.keywords, 40),
    negatives: kws(p.negatives, 40),
    settings: p.settings.map((x) => clip(x, 300)).slice(0, 10),
    checklist: p.checklist.map((x) => clip(x, 400)).slice(0, 15),
  };
}

/** The client's Google Ads account, if one is linked on the KPI board. */
export async function googleAccountOf(db: SupabaseClient, clientId: string) {
  const { data } = await db.from("kpi_targets").select("ad_account_id").eq("client_id", clientId).eq("platform", "google").not("ad_account_id", "is", null).limit(1).maybeSingle();
  return data?.ad_account_id ? String(data.ad_account_id).replace(/-/g, "") : null;
}

/** What the idea was, in a line, kept on the deploy so it survives the winner dropping out. */
function ideaSummary(r: Record<string, unknown>) {
  const c = (r.content ?? {}) as { headlines?: string[]; descriptions?: string[]; text?: string; match?: string; url?: string | null };
  const text = r.kind === "ad" ? `${(c.headlines ?? []).join(" | ")} — ${(c.descriptions ?? []).join(" ")}` : r.kind === "keyword" ? `${c.text} (${String(c.match ?? "").toLowerCase()} match)` : `"${c.text}"`;
  const result = r.roas ? `${Number(r.result ?? 0).toFixed(2)}x ROAS against ${Number(r.usual ?? 0).toFixed(2)}x, ${Math.round(Number(r.beat_by) * 100)}% better` : `$${Number(r.result ?? 0).toFixed(2)} per conversion against $${Number(r.usual ?? 0).toFixed(2)}, ${Math.round(Number(r.beat_by) * 100)}% cheaper`;
  return { kind: String(r.kind), text: text.replace(/\s*—\s*/g, " · ").slice(0, 900), result: `${result}, ${Math.round(Number(r.conversions ?? 0))} conversions on $${Math.round(Number(r.spend ?? 0))}` };
}

/** Starts one: saved as drafting, written in the background. */
export async function createDeploy(admin: SupabaseClient, o: { ideaId: string; clientId: string; kind: DeployKind; note: string; by: string }) {
  const { data: idea } = await admin.from("google_ideas").select("*, clients(name)").eq("id", o.ideaId).maybeSingle();
  if (!idea) throw new Error("That winner isn't in Ideas any more.");
  const summary = { ...ideaSummary(idea), client: (idea.clients as { name: string } | null)?.name ?? undefined };
  const { data, error } = await admin
    .from("google_deploys")
    .insert({ client_id: o.clientId, idea_id: o.ideaId, idea: summary, kind: o.kind, note: o.note.trim().slice(0, 1000) || null, status: "drafting", created_by: o.by })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Couldn't start it.");
  return data.id as string;
}

/** Writes the plan for a drafting deploy (or rewrites it with a note). */
export async function draftDeploy(admin: SupabaseClient, deployId: string, change?: string) {
  const { data: d } = await admin.from("google_deploys").select("*, clients(name)").eq("id", deployId).single();
  if (!d) return;
  try {
    const clientId = d.client_id as string;
    const [ctx, { data: bible }, gtm, playbook, patterns, model, setup] = await Promise.all([
      clientContext(admin, clientId),
      admin.from("client_brand_bibles").select("read_this_first, markdown").eq("client_id", clientId).maybeSingle(),
      import("@/lib/gtm").then(({ gtmForContext }) => gtmForContext(admin, clientId, "google")).catch(() => ""),
      import("@/lib/google-playbooks").then(({ googlePlaybookBlock }) => googlePlaybookBlock(admin, clientId)).catch(() => ""),
      import("@/lib/patterns").then(({ patternsBlock }) => patternsBlock(admin, clientId)).catch(() => ""),
      import("@/lib/business-model").then(async ({ businessModelOf, modelBlock }) => modelBlock(await businessModelOf(admin, clientId))).catch(() => ""),
      (async () => {
        const account = await googleAccountOf(admin, clientId);
        if (!account) return "No Google Ads account is linked yet.";
        const { googleAdsConfigured, googleWritableSetup } = await import("@/lib/context/google-ads");
        if (!googleAdsConfigured()) return "";
        const s = await googleWritableSetup(account);
        return `Campaigns now: ${s.campaigns.map((c) => `"${c.name}" (${c.status.toLowerCase()}, ${c.type.toLowerCase()})`).join("; ") || "none"}.\nAd groups: ${s.adGroups.slice(0, 60).map((g) => `"${g.name}" in "${g.campaign}"`).join("; ") || "none"}.`;
      })().catch(() => ""),
    ]);
    if (!ctx) throw new Error("Client not found");
    const idea = d.idea as { kind: string; text: string; result: string };
    const prev = d.plan as DeployPlan | null;
    const out = await askJson<DeployPlan>({
      agent: "google_launcher",
      label: `deploy a Google idea ${(d.clients as { name: string } | null)?.name ?? ""}`,
      clientId,
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 6000,
      prompt: `${contextBlock(ctx)}
${bible?.markdown ? `\n<brand_bible note="the foundation: what's true and allowed">\n${(bible.read_this_first ?? "").slice(0, 4000)}\n\n${String(bible.markdown).slice(0, 14000)}\n</brand_bible>\n` : ""}${gtm ? `\n<google_go_to_market>\n${gtm.slice(0, 14000)}\n</google_go_to_market>\n` : ""}${model ? `\n${model}\n` : ""}${playbook ? `\n${playbook}\n` : ""}${patterns ? `\n${patterns}\n` : ""}${setup ? `\n<their_google_ads_account>\n${setup}\n</their_google_ads_account>\n` : ""}
<the_idea from="another client's Google account, a winner">
Kind: ${idea.kind === "search_term" ? "a search term people typed before converting" : idea.kind === "keyword" ? "a keyword" : "a responsive search ad"}
${idea.text}
How it did: ${idea.result}
</the_idea>

Write it as: ${d.kind} (${KIND_LABEL[d.kind as DeployKind]}).${d.note ? `\nThe buyer's note: ${d.note}` : ""}${prev && change ? `\n\nThe current version:\n${JSON.stringify(prev).slice(0, 8000)}\nRewrite it with this change: ${change}` : ""}`,
    });
    await admin.from("google_deploys").update({ plan: tidyPlan(out), status: "open", error: null, updated_at: new Date().toISOString() }).eq("id", deployId);
  } catch (e) {
    await admin
      .from("google_deploys")
      .update({ status: d.plan ? "open" : "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400), updated_at: new Date().toISOString() })
      .eq("id", deployId);
  }
}

export function toDeploy(r: Record<string, unknown>): Deploy {
  const c = r.clients as { name: string; slug: string } | null;
  return {
    id: r.id as string,
    clientId: r.client_id as string,
    client: c?.name ?? "",
    clientSlug: c?.slug ?? "",
    ideaId: (r.idea_id as string) ?? null,
    idea: (r.idea ?? { kind: "", text: "", result: "" }) as Deploy["idea"],
    kind: r.kind as DeployKind,
    note: (r.note as string) ?? null,
    status: r.status as Deploy["status"],
    plan: (r.plan as DeployPlan) ?? null,
    error: (r.error as string) ?? null,
    createdBy: (r.created_by as string) ?? null,
    createdAt: r.created_at as string,
    decidedAt: (r.decided_at as string) ?? null,
    declineReason: (r.decline_reason as string) ?? null,
    applied: (r.applied as Deploy["applied"]) ?? null,
  };
}

/** A client's deploys still to act on or recently done (the client page's Google side). */
export async function loadDeploys(db: SupabaseClient, clientIds: string[], o: { open?: boolean } = {}) {
  if (!clientIds.length) return [] as Deploy[];
  let q = db.from("google_deploys").select("*, clients(name, slug)").in("client_id", clientIds).order("created_at", { ascending: false }).limit(40);
  if (o.open) q = q.in("status", ["drafting", "open", "approved", "failed"]);
  const { data } = await q;
  return (data ?? []).map(toDeploy);
}

const MATCH_API: Record<Match, string> = { exact: "EXACT", phrase: "PHRASE", broad: "BROAD" };
const HEAD_PIN = ["", "HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] as const;
const DESC_PIN = ["", "DESCRIPTION_1", "DESCRIPTION_2"] as const;

/**
 * Pushes an approved deploy to Google Ads, paused: the ad and keywords into the ad group picked (or a new ad group made
 * in the campaign picked), negatives onto the campaign picked. Each part is checked by Google first (validate only),
 * then sent on its own so one refusal doesn't stop the rest. Only with live changes on for the client (or everyone).
 */
export async function pushDeploy(admin: SupabaseClient, deployId: string, target: DeployTarget) {
  const { googleWritesOn } = await import("@/lib/ad-changes");
  const { data: d } = await admin.from("google_deploys").select("client_id, kind, plan, status").eq("id", deployId).single();
  if (!d?.plan || !["approved", "partial", "failed"].includes(d.status as string)) throw new Error("Approve it first.");
  if (d.kind === "campaign") throw new Error("A new campaign is built by hand from the checklist.");
  const account = await googleAccountOf(admin, d.client_id as string);
  if (!account) throw new Error("No Google Ads account is linked to this client on the KPI board.");
  if (!(await googleWritesOn(admin, account))) throw new Error("Live changes are off for this client's Google Ads: an exec switches them on in the client's Team & setup; until then, apply it by hand from the checklist.");
  const plan = d.plan as DeployPlan;
  const cust = `customers/${account}`;
  const state = target.status === "ENABLED" ? "ENABLED" : "PAUSED";
  const { googleMutate } = await import("@/lib/context/google-ads");
  const results: { what: string; ok: boolean; error: string | null }[] = [];
  // A new ad group first (keywords only), made in the campaign picked; its ID is what the keywords go into
  if (d.kind === "keywords" && !target.adGroupId && target.newAdGroup?.trim()) {
    if (!target.campaignId) throw new Error("Pick the campaign the new ad group goes into.");
    const name = target.newAdGroup.trim().slice(0, 120);
    const op = [{ create: { name, campaign: `${cust}/campaigns/${target.campaignId}`, status: state, type: "SEARCH_STANDARD" } }];
    try {
      await googleMutate(account, "adGroups", op, true);
      const made = await googleMutate(account, "adGroups", op, false);
      const id = made.results?.[0]?.resourceName?.split("/").pop() ?? null;
      if (!id) throw new Error("Google didn't say which ad group it made.");
      target = { ...target, adGroupId: id, adGroup: name };
      results.push({ what: `New ad group "${name}" (${state.toLowerCase()}) in "${target.campaign ?? "the campaign"}"`, ok: true, error: null });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      const now = new Date().toISOString();
      await admin.from("google_deploys").update({ status: "failed", applied: { target, results: [{ what: `New ad group "${name}"`, ok: false, error }] }, error, updated_at: now }).eq("id", deployId);
      return { status: "failed", results: [{ what: `New ad group "${name}"`, ok: false, error }] };
    }
  }
  const parts: { what: string; service: "adGroupAds" | "adGroupCriteria" | "campaignCriteria"; ops: unknown[] }[] = [];
  if (d.kind === "copy") {
    if (!target.adGroupId) throw new Error("Pick the ad group the ad goes into.");
    if (!plan.finalUrl) throw new Error("The ad needs a landing page: add one first.");
    parts.push({
      what: `Responsive search ad (paused) in "${target.adGroup ?? "the ad group"}"`,
      service: "adGroupAds",
      ops: [
        {
          create: {
            adGroup: `${cust}/adGroups/${target.adGroupId}`,
            status: "PAUSED",
            ad: {
              finalUrls: [plan.finalUrl],
              responsiveSearchAd: {
                headlines: plan.headlines.map((h) => ({ text: h.text, ...(h.pin ? { pinnedField: HEAD_PIN[h.pin] } : {}) })),
                descriptions: plan.descriptions.map((x) => ({ text: x.text, ...(x.pin ? { pinnedField: DESC_PIN[x.pin] } : {}) })),
                ...(plan.path1 ? { path1: plan.path1 } : {}),
                ...(plan.path2 ? { path2: plan.path2 } : {}),
              },
            },
          },
        },
      ],
    });
  }
  if (d.kind === "keywords" && plan.keywords.length) {
    if (!target.adGroupId) throw new Error("Pick the ad group the keywords go into.");
    const adGroup = `${cust}/adGroups/${target.adGroupId}`;
    // The final URL, when one was given, sits on each keyword (it wins over the ad's for clicks on that keyword)
    parts.push({ what: `${plan.keywords.length} keywords (${state.toLowerCase()}) in "${target.adGroup ?? "the ad group"}"`, service: "adGroupCriteria", ops: plan.keywords.map((k) => ({ create: { adGroup, status: state, keyword: { text: k.text, matchType: MATCH_API[k.match] }, ...(plan.finalUrl ? { finalUrls: [plan.finalUrl] } : {}) } })) });
  }
  if (plan.negatives.length && target.campaignId && d.kind === "keywords") {
    parts.push({ what: `${plan.negatives.length} negative keywords on "${target.campaign ?? "the campaign"}"`, service: "campaignCriteria", ops: plan.negatives.map((k) => ({ create: { campaign: `${cust}/campaigns/${target.campaignId}`, negative: true, keyword: { text: k.text, matchType: MATCH_API[k.match] } } })) });
  }
  if (!parts.length && !results.length) throw new Error("Nothing in it can be pushed.");
  for (const p of parts) {
    try {
      await googleMutate(account, p.service, p.ops, true);
      await googleMutate(account, p.service, p.ops, false);
      results.push({ what: p.what, ok: true, error: null });
    } catch (e) {
      results.push({ what: p.what, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const status = ok === results.length ? "applied" : ok ? "partial" : "failed";
  const now = new Date().toISOString();
  await admin.from("google_deploys").update({ status, applied: { target, results }, applied_at: now, error: status === "failed" ? results[0]?.error : null, updated_at: now }).eq("id", deployId);
  return { status, results };
}
