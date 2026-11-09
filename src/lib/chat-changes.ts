import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { buildGoogle, buildMeta, checkOps, type MetaRaw, type PlannedOp } from "@/lib/ad-changes";
import { adStats, statsText, targetOf, windowLabel, type StatsTarget } from "@/lib/ad-stats";
import { findLinks, type Metrics, type ObjRef } from "@/lib/chat-change-core";
import { googleQuery, googleWritableSetup, type WritableSetup } from "@/lib/context/google-ads";
import { metaGraph } from "@/lib/context/meta";
import { conversionFor } from "@/lib/kpi/conversions";
import { metaWritableSetup, type MetaSetup } from "@/lib/meta-write";
import { SLOTS, canHold } from "@/lib/roles";
import { canChangeBuyer } from "@/lib/chat-permissions";
import { canOn, personById } from "@/lib/chat-permissions-server";

// Changes asked for in the client desk chat (on the client page and on the KPI board): "pause every ad under 0.5% CTR
// in the prospecting campaign", "move the winner from engagement to conversions", "swap the link on the BFCM ads",
// "make Rahul the Meta buyer". The chat never writes: the buyer agent reads the live account, picks the exact objects
// and writes a plan (each object before → after, shown with its creative and numbers), the platform checks every write
// without making it, and only a buyer, a head of the platform, a lead or an exec confirms it. Then each object links
// straight to where it is in Ads Manager or Google Ads, to check it landed.

export type ChatPlatform = "meta" | "google" | "team";

/** A new change from the chat: the row the plan card follows, planned in the background. Null when there's nothing to change. */
export async function startChatChange(admin: SupabaseClient, clientId: string, profileId: string, platform: ChatPlatform, instruction: string, targetId?: string | null): Promise<{ id: string } | { error: string }> {
  // Only someone who may change this account (or the client's buyer) starts a plan for it: every surface comes here
  const person = await personById(admin, profileId);
  if (!person) return { error: "Only active team members can plan changes." };
  const allowed = platform === "team" ? canChangeBuyer(person) : await canOn(admin, person, "ads.change", { platform, clientId });
  if (!allowed.ok) return { error: allowed.reason };
  let target: { id: string; ad_account_id: string | null } | null = null;
  if (platform !== "team") {
    const { data: ts } = await admin.from("kpi_targets").select("id, ad_account_id").eq("client_id", clientId).eq("platform", platform).eq("active", true).not("ad_account_id", "is", null).order("created_at");
    // A step from a report or a KPI names its own account; otherwise the client's first one on the platform
    target = (ts ?? []).find((t) => t.id === targetId) ?? (ts ?? [])[0] ?? null;
    if (!target?.ad_account_id) return { error: `There's no ${platform === "meta" ? "Meta" : "Google Ads"} account linked to this client on the KPI board, so I can't reach it.` };
  }
  const { data, error } = await admin
    .from("ad_changes")
    .insert({
      target_id: target?.id ?? null,
      client_id: clientId,
      platform,
      account: target ? String(target.ad_account_id).replace(/\D/g, "") : "",
      source: "chat",
      title: instruction.slice(0, 200),
      request: instruction.slice(0, 2000),
      asked_by: profileId,
      planned_by: profileId,
    })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Couldn't start it." };
  return { id: data.id as string };
}

/** Plans a chat change: reads the live account, asks the buyer agent, describes every object, checks every write. */
export async function planChatChange(admin: SupabaseClient, id: string) {
  const { data: ch } = await admin.from("ad_changes").select("client_id, platform, account, request, target_id").eq("id", id).single();
  if (!ch) return;
  try {
    const r = ch.platform === "meta" ? await planMeta(admin, ch.client_id, ch.account, ch.target_id, ch.request ?? "") : ch.platform === "google" ? await planGoogle(admin, ch.client_id, ch.account, ch.target_id, ch.request ?? "") : await planTeam(admin, ch.client_id, ch.request ?? "");
    const checked = ch.platform === "team" ? r.ops.map((o) => ({ ...o, check: { ok: true, error: null } })) : await checkOps(admin, ch.platform, ch.account, r.ops);
    await admin
      .from("ad_changes")
      .update({ status: checked.length ? "ready" : "nothing", ops: checked, note: r.note, error: null, updated_at: new Date().toISOString() })
      .eq("id", id);
  } catch (e) {
    await admin.from("ad_changes").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", id);
  }
}

// ─── Numbers ────────────────────────────────────────────────────────────────

type Target = StatsTarget;

const n = (v: unknown) => Number(v) || 0;
const r2 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// Each object's last 7 and 30 complete days, counted by the account's own KPI (src/lib/ad-stats.ts)
const metaStats = adStats;
const mtext = statsText;

// ─── Meta ───────────────────────────────────────────────────────────────────

const S = { type: "string" };
const META_SCHEMA = {
  type: "object",
  properties: {
    note: S,
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["meta_status", "meta_budget", "meta_rename", "meta_copy_ad", "meta_link"] },
          level: { type: "string", enum: ["campaign", "adset", "ad"] },
          id: S,
          status: { type: "string", enum: ["PAUSED", "ACTIVE", ""] },
          amount: { type: "number" },
          name: S,
          target_id: S,
          url: S,
          only: S,
          tags: S,
          selected: { type: "boolean" },
          why: S,
        },
        required: ["kind", "level", "id", "status", "amount", "name", "target_id", "url", "only", "tags", "selected", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["note", "ops"],
  additionalProperties: false,
};

const META_SYSTEM = `You're the media buyer turning a teammate's request in chat into the exact changes in a client's Meta ad account. You get the request, the account's live setup with IDs, and each object's last 7 and 30 days counted by the account's own KPI (with its target).
The changes that exist:
- meta_status: pause or turn on a campaign, ad set or ad (level, id, status PAUSED or ACTIVE).
- meta_budget: a campaign's or ad set's DAILY budget in dollars (level, id, amount). The budget lives on the campaign when it has one (Advantage campaign budget), else on the ad set; never a lifetime budget.
- meta_rename: rename a campaign, ad set or ad (level, id, name = the new name).
- meta_copy_ad: copy an ad into another ad set (id = the ad, target_id = the ad set it goes into, status PAUSED unless they said to turn it on). The original keeps running unless they also asked to pause it (then add a meta_status for it).
- meta_link: a new destination link or new UTMs on an ad (id = the ad, url = the new link or "" when only UTMs change, only = the old link to replace when only some cards should change or "" for every link, tags = the full new UTM string or "").
Rules:
- Do only what they asked, on exactly the objects it covers. When they give a condition ("CTR under 0.5%", "spent over $50 with no purchases"), apply it to the numbers you're given and include every object that meets it, nothing else.
- "The winner", "the best ad", "what's working": profitability first. The winner is the ad with the best cost per result (or ROAS) against the target over the last 30 days with real spend behind it (at least about twice the target cost, or the most spend among the profitable ones), never one with a few lucky results. Give it selected true and up to 2 runner-ups as the same change with selected false, best first, each why with its numbers, so the buyer can pick.
- A top-of-funnel ad with frequency under 1.25, good spend, average CPM and above-average CTR but no conversions is a conversation starter: don't pause it in a "pause what's not converting" request unless they named it; say so in note.
- Moving an ad from one campaign to another is meta_copy_ad into an ad set of the target campaign (pick the ad set that matches the ad's audience or the main active one), plus pausing the original only if they said move and not copy. Say which you did in note.
- Everything else is selected true. If something is ambiguous (two campaigns could be "the engagement campaign"), make nothing for it and ask in note. If nothing can be done with these changes (new campaigns, audiences, targeting, creative), return no ops and say in note what has to be done by hand.
- note: one or two plain sentences on what the plan does (and anything you left out or need answered). why: a few words per change, with the numbers that decided it. Leave unused fields empty: "", 0. Refer to people by role, never by name.`;

function metaSetupText(s: MetaSetup, stats: Awaited<ReturnType<typeof metaStats>>, target: Target) {
  const $ = (x: number | null) => (x == null ? "" : `$${x}`);
  const line = (id: string) => {
    const { m7, m30 } = stats.of(id);
    return `30 days: ${mtext(m30, stats.roas)}; 7 days: ${mtext(m7, stats.roas)}`;
  };
  return [
    `KPI: ${stats.result}${target?.target != null ? `, target ${stats.roas ? `ROAS ${target.target}` : `$${target.target} per result`}` : ", no target set"}`,
    `Windows (complete days, today left out as Ads Manager does): 7 days = ${windowLabel(stats.d7)}, 30 days = ${windowLabel(stats.d30)}. Quote numbers only from here.`,
    "\nCAMPAIGNS",
    ...s.campaigns.map((c) => `- id ${c.id} "${c.name}" [${c.status}] ${c.objective}${c.dailyBudget != null ? `, daily budget ${$(c.dailyBudget)}` : c.lifetimeBudget != null ? ", lifetime budget" : ", budget on the ad sets"} · ${line(c.id)}`),
    "\nAD SETS",
    ...s.adsets.map((a) => `- id ${a.id} "${a.name}" [${a.status}] in "${a.campaign}"${a.dailyBudget != null ? `, daily budget ${$(a.dailyBudget)}` : ""}${a.optimization ? `, optimizing for ${a.optimization}` : ""} · ${line(a.id)}`),
    "\nADS",
    ...s.ads.slice(0, 250).map((a) => `- id ${a.id} "${a.name}" [${a.status}] in "${a.adset}" (${a.campaign}) · ${line(a.id)}`),
  ].join("\n");
}

type MetaChatRaw = MetaRaw & { name: string; target_id: string; url: string; only: string; tags: string; selected: boolean };

/** An ad's look for the plan card: thumbnail (or carousel cards), text, headline, button, where it goes, Meta's preview link. */
async function metaCreatives(ids: string[]) {
  const out = new Map<string, NonNullable<ObjRef["creative"]>>();
  type C = { thumbnail_url?: string; image_url?: string; body?: string; title?: string; call_to_action_type?: string; video_id?: string; object_story_spec?: { link_data?: { message?: string; name?: string; picture?: string; child_attachments?: { picture?: string; name?: string }[] }; video_data?: { message?: string; title?: string; image_url?: string } }; asset_feed_spec?: unknown };
  await Promise.all(
    [...new Set(ids)].slice(0, 24).map(async (id) => {
      const r = await metaGraph<{ preview_shareable_link?: string; creative?: C }>(id, { fields: "preview_shareable_link,creative{thumbnail_url,image_url,body,title,call_to_action_type,video_id,object_story_spec,asset_feed_spec}" }).catch(() => null);
      const c = r?.creative;
      if (!r) return;
      const ld = c?.object_story_spec?.link_data;
      const vd = c?.object_story_spec?.video_data;
      out.set(id, {
        thumb: c?.image_url ?? c?.thumbnail_url ?? ld?.picture ?? vd?.image_url ?? null,
        video: Boolean(c?.video_id || vd),
        body: c?.body ?? ld?.message ?? vd?.message ?? null,
        headline: c?.title ?? ld?.name ?? vd?.title ?? null,
        cta: c?.call_to_action_type ?? null,
        url: findLinks(c?.object_story_spec ?? c?.asset_feed_spec ?? null)[0] ?? null,
        preview: r.preview_shareable_link ?? null,
        cards: ld?.child_attachments?.length ? ld.child_attachments.slice(0, 10).map((x) => ({ thumb: x.picture ?? null, headline: x.name ?? null })) : undefined,
      });
    }),
  );
  return out;
}

async function planMeta(admin: SupabaseClient, clientId: string, account: string, targetId: string | null, request: string) {
  const [setup, target] = await Promise.all([metaWritableSetup(admin, account), targetOf(admin, targetId)]);
  const stats = await metaStats(admin, account, target);
  const out = await askJson<{ note: string; ops: MetaChatRaw[] }>({
    agent: "launcher",
    label: "chat ad change meta",
    clientId,
    system: META_SYSTEM,
    schema: META_SCHEMA,
    maxTokens: 8000,
    prompt: `<request>\n${request}\n</request>\n\n<account_setup>\n${metaSetupText(setup, stats, target)}\n</account_setup>`,
  });
  const raw = out.ops ?? [];
  // Status and budgets: the same checks as an audit's changes (unknown IDs dropped, "from" read from Meta)
  const base = buildMeta(raw.filter((r) => r.kind === "meta_status" || r.kind === "meta_budget"), setup);
  const ops: PlannedOp[] = base.ops.map((o) => ({ ...o, selected: raw.find((r) => r.id === (o as { objectId: string }).objectId && r.kind === o.kind)?.selected ?? true }));
  const dropped = [...base.dropped];
  const blank = { check: null, result: null };
  for (const r of raw) {
    const ad = setup.ads.find((x) => x.id === r.id);
    const any = r.level === "campaign" ? setup.campaigns.find((x) => x.id === r.id) : r.level === "adset" ? setup.adsets.find((x) => x.id === r.id) : ad;
    if (r.kind === "meta_rename") {
      if (!any || !r.name.trim() || r.name.trim() === any.name) continue;
      ops.push({ kind: "meta_rename", level: r.level as "campaign" | "adset" | "ad", objectId: any.id, name: any.name, parent: null, from: any.name, to: r.name.trim().slice(0, 400), why: r.why, warning: null, selected: r.selected, ...blank });
    } else if (r.kind === "meta_copy_ad") {
      const dest = setup.adsets.find((x) => x.id === r.target_id);
      if (!ad || !dest) {
        dropped.push(`copy of ${r.id} (ad or ad set not found)`);
        continue;
      }
      ops.push({ kind: "meta_copy_ad", objectId: ad.id, name: ad.name, parent: `${ad.adset} · ${ad.campaign}`, targetAdsetId: dest.id, targetAdset: `${dest.name} · ${dest.campaign}`, status: r.status === "ACTIVE" ? "ACTIVE" : "PAUSED", why: r.why, warning: r.status === "ACTIVE" ? "The copy starts spending right away." : null, selected: r.selected, ...blank });
    } else if (r.kind === "meta_link") {
      if (!ad || (!/^https?:\/\//i.test(r.url) && !r.tags.trim())) {
        dropped.push(`link change on ${r.id}`);
        continue;
      }
      ops.push({ kind: "meta_link", objectId: ad.id, name: ad.name, parent: `${ad.adset} · ${ad.campaign}`, from: null, to: r.url.trim(), only: r.only.trim() || null, tags: r.tags.trim() || null, why: r.why, warning: "Meta makes a new creative with the change and puts it on the ad: it goes back through review, and the post's likes and comments start fresh.", selected: r.selected, ...blank });
    }
  }
  // How each object looks and performs, for the plan card
  const creatives = await metaCreatives(ops.flatMap((o) => (o.kind === "meta_copy_ad" || o.kind === "meta_link" || (o.kind === "meta_status" && o.level === "ad") || (o.kind === "meta_rename" && o.level === "ad") ? [(o as { objectId: string }).objectId] : [])));
  const refOf = (level: "campaign" | "adset" | "ad", id: string): ObjRef | null => {
    const c = level === "campaign" ? setup.campaigns.find((x) => x.id === id) : null;
    const s = level === "adset" ? setup.adsets.find((x) => x.id === id) : null;
    const a = level === "ad" ? setup.ads.find((x) => x.id === id) : null;
    const o = c ?? s ?? a;
    if (!o) return null;
    const campaignId = c?.id ?? s?.campaignId ?? (a ? setup.adsets.find((x) => x.id === a.adsetId)?.campaignId : null) ?? null;
    return {
      platform: "meta",
      level,
      id,
      name: o.name,
      path: [s?.campaign ?? a?.campaign ?? "", a?.adset ?? ""].filter(Boolean),
      status: o.status,
      account,
      campaignId,
      adGroupId: a?.adsetId ?? s?.id ?? null,
      ...stats.of(id),
      result: stats.result,
      target: target?.target ?? null,
      roas: stats.roas,
      creative: level === "ad" ? (creatives.get(id) ?? null) : null,
    };
  };
  for (const o of ops) {
    const x = o as PlannedOp & { objectId?: string; level?: "campaign" | "adset" | "ad" };
    x.ref = refOf(o.kind === "meta_copy_ad" || o.kind === "meta_link" ? "ad" : (x.level ?? "ad"), x.objectId ?? "");
    if (o.kind === "meta_link") (o as { from: string | null }).from = x.ref?.creative?.url ?? null;
    if (o.kind === "meta_copy_ad") x.dest = refOf("adset", o.targetAdsetId);
  }
  return { ops, note: [out.note, dropped.length ? `Left out: ${dropped.join("; ")}.` : ""].filter(Boolean).join(" ") };
}

// ─── Google ─────────────────────────────────────────────────────────────────

const GOOGLE_SCHEMA = {
  type: "object",
  properties: {
    note: S,
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["campaign_status", "ad_group_status", "campaign_budget", "target_cpa", "target_roas", "negative_keywords", "google_ad_status", "google_keyword_status", "google_ad_url"] },
          id: S,
          status: { type: "string", enum: ["PAUSED", "ENABLED", ""] },
          amount: { type: "number" },
          keywords: { type: "array", items: { type: "object", properties: { text: S, match: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] } }, required: ["text", "match"], additionalProperties: false } },
          url: S,
          selected: { type: "boolean" },
          why: S,
        },
        required: ["kind", "id", "status", "amount", "keywords", "url", "selected", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["note", "ops"],
  additionalProperties: false,
};

const GOOGLE_SYSTEM = `You're the Google Ads buyer turning a teammate's request in chat into the exact changes in a client's Google Ads account. You get the request, the account's live setup with IDs and the last 30 days per campaign, ad group, ad and keyword.
The changes that exist: campaign_status (id = campaign ID), ad_group_status (id = ad group ID), campaign_budget (daily, dollars), target_cpa (dollars), target_roas (ratio, 4 = 400%), negative_keywords (id = campaign ID, keywords with match, prefer EXACT or PHRASE), google_ad_status (pause or enable an ad: id = "adGroupId~adId"), google_keyword_status (pause or enable a keyword: id = "adGroupId~criterionId"), google_ad_url (an ad's final URL: id = "adGroupId~adId", url).
Rules: do only what they asked, on exactly the objects it covers; with a condition, apply it to the numbers and include every object that meets it. Brand campaigns and brand searches are never "winners". Profitability first when they ask about winners or what's not working. Everything is selected true unless it's a runner-up candidate (then false, best first). Ambiguous: make nothing for it and ask in note. Nothing doable with these changes: no ops, and say in note what's done by hand. note: one or two plain sentences. why: a few words with the numbers. Unused fields empty: "", 0, []. Refer to people by role.`;

type GoogleChatRaw = { kind: string; id: string; status: string; amount: number; keywords: { text: string; match: "EXACT" | "PHRASE" | "BROAD" }[]; url: string; selected: boolean; why: string };
type GRow = Record<string, Record<string, unknown>>;
const micros = (v: unknown) => Math.round(n(v) / 10_000) / 100;

function gMetrics(r: GRow | undefined): Metrics | null {
  if (!r?.metrics) return null;
  const spend = micros(r.metrics.costMicros);
  const conv = Math.round(n(r.metrics.conversions) * 10) / 10;
  const imp = n(r.metrics.impressions);
  return { spend, results: conv, cpr: conv ? r2(spend / conv) : null, ctr: imp ? r2((n(r.metrics.clicks) / imp) * 100) : null, freq: null };
}

async function planGoogle(admin: SupabaseClient, clientId: string, account: string, targetId: string | null, request: string) {
  const q = (s: string) => googleQuery(account, s).catch(() => [] as GRow[]);
  const [setup, target, camps30, camps7, groups30, ads, kws] = await Promise.all([
    googleWritableSetup(account),
    targetOf(admin, targetId),
    q("SELECT campaign.id, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM campaign WHERE segments.date DURING LAST_30_DAYS"),
    q("SELECT campaign.id, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM campaign WHERE segments.date DURING LAST_7_DAYS"),
    q("SELECT ad_group.id, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM ad_group WHERE segments.date DURING LAST_30_DAYS"),
    q("SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status, ad_group.id, ad_group.name, campaign.id, campaign.name, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND segments.date DURING LAST_30_DAYS LIMIT 300"),
    q("SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group.id, ad_group.name, campaign.id, campaign.name, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED' AND segments.date DURING LAST_30_DAYS ORDER BY metrics.cost_micros DESC LIMIT 300"),
  ]);
  const byId = (rows: GRow[], key: "campaign" | "adGroup") => new Map(rows.map((r) => [String(r[key]?.id), r]));
  const c30 = byId(camps30, "campaign");
  const c7 = byId(camps7, "campaign");
  const g30 = byId(groups30, "adGroup");
  const adList = ads.map((r) => {
    const ad = r.adGroupAd?.ad as Record<string, unknown> | undefined;
    const rsa = ad?.responsiveSearchAd as { headlines?: { text: string }[]; descriptions?: { text: string }[] } | undefined;
    return { id: String(ad?.id), adGroupId: String(r.adGroup?.id), adGroup: String(r.adGroup?.name), campaignId: String(r.campaign?.id), campaign: String(r.campaign?.name), status: String(r.adGroupAd?.status), name: String(ad?.name ?? rsa?.headlines?.[0]?.text ?? `Ad ${ad?.id}`), url: ((ad?.finalUrls as string[] | undefined) ?? [])[0] ?? null, headlines: (rsa?.headlines ?? []).map((h) => h.text), descriptions: (rsa?.descriptions ?? []).map((d) => d.text), m30: gMetrics(r) };
  });
  const kwList = kws.map((r) => {
    const c = r.adGroupCriterion as Record<string, unknown> | undefined;
    const k = c?.keyword as { text?: string; matchType?: string } | undefined;
    return { id: String(c?.criterionId), adGroupId: String(r.adGroup?.id), adGroup: String(r.adGroup?.name), campaignId: String(r.campaign?.id), campaign: String(r.campaign?.name), status: String(c?.status), text: String(k?.text ?? ""), match: String(k?.matchType ?? ""), m30: gMetrics(r) };
  });
  const roas = Boolean(target && conversionFor(target.conversion).roas);
  const setupText = (s: WritableSetup) =>
    [
      `KPI target: ${target?.target != null ? (roas ? `ROAS ${target.target}` : `$${target.target} per conversion`) : "not set"}`,
      "\nCAMPAIGNS",
      ...s.campaigns.map((c) => `- id ${c.id} "${c.name}" [${c.status}, ${c.type}] bidding ${c.bidding}, daily budget ${c.budget != null ? `$${c.budget}` : "?"}${c.sharedBudget ? " (shared)" : ""} · 30 days: ${mtext(gMetrics(c30.get(c.id)), false)}`),
      "\nAD GROUPS",
      ...s.adGroups.slice(0, 150).map((g) => `- id ${g.id} "${g.name}" [${g.status}] in "${g.campaign}" · 30 days: ${mtext(gMetrics(g30.get(g.id)), false)}`),
      "\nADS",
      ...adList.slice(0, 150).map((a) => `- id ${a.adGroupId}~${a.id} "${a.name}" [${a.status}] in "${a.adGroup}" (${a.campaign}) → ${a.url ?? "?"} · 30 days: ${mtext(a.m30, false)}`),
      "\nKEYWORDS",
      ...kwList.slice(0, 200).map((k) => `- id ${k.adGroupId}~${k.id} ${k.match} "${k.text}" [${k.status}] in "${k.adGroup}" (${k.campaign}) · 30 days: ${mtext(k.m30, false)}`),
      "\nSEARCH TERMS SPENDING WITH NO CONVERSIONS (30 days)",
      ...s.wasteTerms.map((t) => `- "${t.term}" in "${t.campaign}" (campaign ${t.campaignId}): $${t.spend}`),
    ].join("\n");
  const out = await askJson<{ note: string; ops: GoogleChatRaw[] }>({
    agent: "google_launcher",
    label: "chat ad change google",
    clientId,
    system: GOOGLE_SYSTEM,
    schema: GOOGLE_SCHEMA,
    maxTokens: 8000,
    prompt: `<request>\n${request}\n</request>\n\n<account_setup>\n${setupText(setup)}\n</account_setup>`,
  });
  const raw = out.ops ?? [];
  const base = buildGoogle(raw.filter((r) => !r.kind.startsWith("google_")), setup);
  const ops: PlannedOp[] = base.ops.map((o) => ({ ...o, selected: true }));
  const dropped = [...base.dropped];
  const blank = { check: null, result: null };
  for (const r of raw.filter((x) => x.kind.startsWith("google_"))) {
    const [adGroupId, objId] = r.id.split("~");
    if (r.kind === "google_keyword_status") {
      const k = kwList.find((x) => x.adGroupId === adGroupId && x.id === objId);
      if (!k || !["PAUSED", "ENABLED"].includes(r.status) || k.status === r.status) {
        dropped.push(`keyword ${r.id}`);
        continue;
      }
      ops.push({ kind: "google_keyword_status", adGroupId, criterionId: k.id, name: k.text, campaign: k.campaign, from: k.status, to: r.status as "PAUSED" | "ENABLED", why: r.why, warning: null, selected: r.selected, ...blank });
      continue;
    }
    const a = adList.find((x) => x.adGroupId === adGroupId && x.id === objId);
    if (!a) {
      dropped.push(`ad ${r.id}`);
      continue;
    }
    if (r.kind === "google_ad_status" && ["PAUSED", "ENABLED"].includes(r.status) && a.status !== r.status)
      ops.push({ kind: "google_ad_status", adGroupId, adId: a.id, name: a.name, campaign: a.campaign, from: a.status, to: r.status as "PAUSED" | "ENABLED", why: r.why, warning: null, selected: r.selected, ...blank });
    else if (r.kind === "google_ad_url" && /^https?:\/\//i.test(r.url))
      ops.push({ kind: "google_ad_url", adGroupId, adId: a.id, name: a.name, campaign: a.campaign, from: a.url, to: r.url.trim(), why: r.why, warning: "The ad goes back through Google's review.", selected: r.selected, ...blank });
  }
  // Each object as the buyer sees it
  for (const o of ops) {
    const x = o as PlannedOp & Record<string, string>;
    const camp = setup.campaigns.find((c) => c.id === x.campaignId);
    const group = setup.adGroups.find((g) => g.id === (x.adGroupId ?? ""));
    if (o.kind === "google_ad_status" || o.kind === "google_ad_url") {
      const a = adList.find((y) => y.id === o.adId)!;
      x.ref = { platform: "google", level: "ad", id: a.id, name: a.name, path: [a.campaign, a.adGroup], status: a.status, account, campaignId: a.campaignId, adGroupId: a.adGroupId, m30: a.m30, m7: null, result: "conversion", target: target?.target ?? null, roas, creative: { thumb: null, video: false, body: a.descriptions.slice(0, 2).join(" · ") || null, headline: a.headlines.slice(0, 3).join(" | ") || null, cta: null, url: a.url, preview: null } } as ObjRef;
    } else if (o.kind === "google_keyword_status") {
      const k = kwList.find((y) => y.id === o.criterionId && y.adGroupId === o.adGroupId)!;
      x.ref = { platform: "google", level: "keyword", id: k.id, name: `${k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text}`, path: [k.campaign, k.adGroup], status: k.status, account, campaignId: k.campaignId, adGroupId: k.adGroupId, m30: k.m30, m7: null, result: "conversion", target: target?.target ?? null, roas } as ObjRef;
    } else if (o.kind === "ad_group_status" && group) {
      x.ref = { platform: "google", level: "ad_group", id: group.id, name: group.name, path: [group.campaign], status: group.status, account, campaignId: group.campaignId, adGroupId: group.id, m30: gMetrics(g30.get(group.id)), m7: null, result: "conversion", target: target?.target ?? null, roas } as ObjRef;
    } else if (camp) {
      x.ref = { platform: "google", level: "campaign", id: camp.id, name: camp.name, path: [], status: camp.status, account, campaignId: camp.id, m30: gMetrics(c30.get(camp.id)), m7: gMetrics(c7.get(camp.id)), result: "conversion", target: target?.target ?? null, roas } as ObjRef;
    }
  }
  return { ops, note: [out.note, dropped.length ? `Left out: ${dropped.join("; ")}.` : ""].filter(Boolean).join(" ") };
}

// ─── Team ───────────────────────────────────────────────────────────────────

const TEAM_SCHEMA = {
  type: "object",
  properties: { note: S, slot: { type: "string", enum: ["meta_buyer", "google_buyer", ""] }, profile_id: S },
  required: ["note", "slot", "profile_id"],
  additionalProperties: false,
};

/** "Make X the Meta buyer": the person, from the people who can hold the seat. */
async function planTeam(admin: SupabaseClient, clientId: string, request: string) {
  const [{ data: people }, { data: seats }] = await Promise.all([
    admin.from("profiles").select("id, full_name, role, also_buys").eq("is_active", true).order("full_name"),
    admin.from("client_assignments").select("role, profile_id, profiles(full_name)").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]),
  ]);
  const slots = SLOTS.filter((s) => s.value === "meta_buyer" || s.value === "google_buyer");
  const eligible = (people ?? []).filter((p) => slots.some((s) => canHold(s, p as { role: string; also_buys?: boolean | null })));
  const out = await askJson<{ note: string; slot: string; profile_id: string }>({
    agent: "launcher",
    label: "chat team change",
    system: "You turn a teammate's request to change a client's media buyer into the seat (meta_buyer or google_buyer) and the person's id from the list. Only a person listed for that seat. When the request doesn't name a clear person or seat, leave both empty and ask in note. note: one plain sentence.",
    schema: TEAM_SCHEMA,
    maxTokens: 1500,
    bare: true,
    prompt: `<request>\n${request}\n</request>\n\n<now>\n${(seats ?? []).map((s) => `${s.role}: ${(s.profiles as unknown as { full_name: string } | null)?.full_name ?? "?"}`).join("\n") || "no buyers set"}\n</now>\n\n<people>\n${slots
      .map((s) => `${s.value} can be: ${eligible.filter((p) => canHold(s, p as { role: string; also_buys?: boolean | null })).map((p) => `${p.full_name} (id ${p.id})`).join(", ")}`)
      .join("\n")}\n</people>`,
  });
  const slot = slots.find((s) => s.value === out.slot);
  const person = eligible.find((p) => p.id === out.profile_id);
  if (!slot || !person || !canHold(slot, person as { role: string; also_buys?: boolean | null })) return { ops: [] as PlannedOp[], note: out.note || "Who should it be, and for Meta or Google?" };
  const now = (seats ?? []).find((s) => s.role === slot.value);
  const op: PlannedOp = {
    kind: "assign_buyer",
    slot: slot.value as "meta_buyer" | "google_buyer",
    fromId: (now?.profile_id as string | undefined) ?? null,
    from: (now?.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    toId: person.id as string,
    to: person.full_name as string,
    why: "Asked in the chat",
    warning: slot.value === "meta_buyer" ? "The account's work (KPI, open tickets, sprint) moves to them and their handoff is written." : null,
    check: null,
    result: null,
    selected: true,
    ref: { platform: "team", level: "person", id: person.id as string, name: person.full_name as string, path: [slot.label], status: null, account: "" },
  };
  if (op.kind === "assign_buyer" && op.fromId === op.toId) return { ops: [], note: `${op.to} is already the ${slot.label}.` };
  return { ops: [op], note: out.note };
}
