import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { metaGraph } from "@/lib/context/meta";
import { metaWrite, metaWriteSetting, writeBlocked } from "@/lib/meta-write";

// The launcher: a ticket's approved creative and copy, pushed to Meta as PAUSED ads for the buyer to QA and turn on.
//
// Rules (agreed 2026-10-26): ads go into an existing ad set the buyer picks, or a new ad set copied from one (same
// targeting, pixel, optimization) in the same campaign; the launcher never creates campaigns or touches budgets. One ad
// per design: its sizes become placement assets (4x5 or 1x1 in feeds, 9x16 in Stories and Reels) and the approved copy
// set goes in stacked (every primary text, headline and description as Meta's text options). Advantage+ creative
// enhancements are switched off, so the client sees what they approved. Names continue the ad set's own pattern.
//
// Planning reads the account, has the Media Buyer (launcher skill) propose the ad set and names, runs Kaizen's checks,
// uploads the media to the account's library and has Meta dry-run each creative (validate_only). If Meta refuses a
// structure, the next one down is tried (placements and stacked text → placements → stacked text → a classic single
// ad) and the buyer sees which one passed. Every write passes the sandbox gate (src/lib/meta-write.ts).

const BUCKET = "creative";
/**
 * The new ads in Ads Manager's editor, scoped to their campaign and ad set: the ads open ready to check and turn on.
 * (selected_ad_ids alone only ticks them in whatever view opens, usually every ad in the account.)
 */
export function adsManagerLink(account: string, adIds: string[], adsetId: string, campaignId?: string | null) {
  const q = new URLSearchParams({ act: account, ...(campaignId ? { selected_campaign_ids: campaignId } : {}), selected_adset_ids: adsetId, selected_ad_ids: adIds.join(",") });
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?${q}`;
}
const campaignOf = (plan: LaunchPlan, adsetId: string) => [...plan.options.adsets, ...(plan.options.allAdsets ?? [])].find((a) => a.id === adsetId)?.campaignId ?? null;

export type LaunchCheck = { key: string; label: string; level: "ok" | "warn" | "block"; detail: string };
type Asset = { fileId: string; aspect: string; kind: "image" | "video"; hash?: string; videoId?: string; thumbUrl?: string; name: string };
export type LaunchAd = { designId: string; designName: string; name: string; assets: Asset[]; check?: { ok: boolean; error: string | null } };
type AdsetOption = { id: string; name: string; campaignId: string; campaign: string; status: string; objective: string; optimization: string | null; destination: string | null; dynamic: boolean; leadForm: boolean; pixel: string | null; event: string | null; special: string[]; recentAds: string[]; spend14: number; pages: string[]; igs: string[]; daily?: number | null; lifetime?: number | null; campaignDaily?: number | null };
export type LaunchPlan = {
  account: string;
  sandbox: boolean;
  adsetId: string;
  mode: "existing" | "clone";
  newAdsetName: string | null;
  pageId: string | null;
  igId: string | null;
  link: string | null;
  urlTags: string | null;
  budget?: Budget;
  cta: string;
  copy: { bodies: string[]; titles: string[]; descriptions: string[] };
  ads: LaunchAd[];
  structure: "placements+text" | "placements" | "text" | "single" | null;
  optOut: string[];
  reason: string;
  /** allAdsets: every ad set to move a launched ad to, when it's more than where ads land (the sandbox) */
  options: { adsets: AdsetOption[]; pages: { id: string; name: string }[]; igs: { id: string; name: string }[]; allAdsets?: AdsetOption[] };
  attempts: { structure: string; error: string | null }[];
};
export type Overrides = Partial<Pick<LaunchPlan, "adsetId" | "mode" | "newAdsetName" | "pageId" | "igId" | "link">> & { names?: Record<string, string>; dailyBudget?: number | null };
/** level: where the budget lives (the ad set, the campaign for CBO, a lifetime budget that's left alone). value: the
 *  daily budget the launch sets (null: unchanged). suggested: the Media Buyer's, with why. Dollars. */
export type Budget = { level: "adset" | "campaign" | "lifetime" | null; current: number | null; suggested: number | null; value: number | null; why: string };

// Meta's CTA buttons, from the labels the copy uses
const CTA: Record<string, string> = {
  "shop now": "SHOP_NOW", "learn more": "LEARN_MORE", "sign up": "SIGN_UP", "book now": "BOOK_TRAVEL", "book": "BOOK_TRAVEL", "contact us": "CONTACT_US", "get offer": "GET_OFFER",
  "get quote": "GET_QUOTE", "apply now": "APPLY_NOW", "download": "DOWNLOAD", "order now": "ORDER_NOW", "subscribe": "SUBSCRIBE", "call now": "CALL_NOW", "send message": "MESSAGE_PAGE",
  "message": "MESSAGE_PAGE", "watch more": "WATCH_MORE", "see menu": "SEE_MENU", "get directions": "GET_DIRECTIONS", "request time": "REQUEST_TIME", "schedule": "BOOK_NOW", "book now ": "BOOK_NOW",
  "buy tickets": "BUY_TICKETS", "donate now": "DONATE_NOW", "get started": "GET_STARTED", "listen now": "LISTEN_NOW", "play game": "PLAY_GAME", "install now": "INSTALL_MOBILE_APP",
};
const ctaOf = (label: string | undefined) => CTA[(label ?? "").trim().toLowerCase()] ?? "LEARN_MORE";

// Advantage+ creative enhancements to switch off; any Meta doesn't know on this API version is dropped and retried
const ENHANCEMENTS = [
  "image_touchups", "image_brightness_and_contrast", "text_optimizations", "enhance_cta", "image_templates", "image_uncrop", "adapt_to_placement",
  "video_auto_crop", "inline_comment", "description_automation", "add_text_overlay", "image_animation", "music", "text_translation", "site_extensions", "product_extensions",
];

async function update(admin: SupabaseClient, id: string, patch: Record<string, unknown>) {
  await admin.from("launches").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

type Ticket = { id: string; number: number; title: string; format: string; landing_url: string | null; client_id: string; brief: unknown; clients: { name: string; website: string | null; meta_ad_account_id: string | null } };

/** The ticket, its approved copy and its designs' current files (only those the client didn't send back). */
async function loadTicket(admin: SupabaseClient, requestId: string) {
  const { data: t } = await admin.from("requests").select("id, number, title, format, landing_url, client_id, brief, clients(name, website, meta_ad_account_id)").eq("id", requestId).single();
  const [{ data: copy }, { data: designs }, { data: kpi }] = await Promise.all([
    admin.from("copy_sets").select("ads, status").eq("request_id", requestId).eq("status", "approved").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    admin
      .from("designs")
      .select("id, position, name, is_variation, current_version, client_status, design_versions(version, design_files(id, path, thumb_path, mime, aspect, card, original_name))")
      .eq("request_id", requestId)
      .order("position"),
    t ? admin.from("kpi_targets").select("conversion, monthly_budget").eq("client_id", (t as unknown as Ticket).client_id).eq("platform", "meta").eq("active", true).limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  type F = { id: string; path: string; thumb_path: string | null; mime: string; aspect: string | null; card: number | null; original_name: string };
  type D = { id: string; position: number; name: string; is_variation: boolean; current_version: number; client_status: string | null; design_versions: { version: number; design_files: F[] }[] };
  const list = ((designs ?? []) as unknown as D[])
    .filter((d) => d.client_status !== "changes")
    .map((d) => ({ id: d.id, name: d.name, position: d.position, files: d.design_versions.find((v) => v.version === d.current_version)?.design_files ?? [] }))
    .filter((d) => d.files.length);
  return { ticket: t as unknown as Ticket | null, copy: (copy?.ads ?? []) as { kind: string; headline: string; primaryText: string; linkDescription: string; cta: string }[], designs: list, conversion: (kpi?.conversion as string | undefined) ?? null, monthlyBudget: kpi?.monthly_budget != null ? Number(kpi.monthly_budget) : null };
}

/** The ad sets that can take new ads (with their recent ad names, Page and Instagram identity), the Pages and IG accounts. */
async function readAccount(admin: SupabaseClient, account: string) {
  const act = `act_${account}`;
  const live = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"] }]);
  type P<T> = { data: T[] };
  const [camps, sets, ads, pages, igs] = await Promise.all([
    metaGraph<P<{ id: string; name: string; objective: string; special_ad_categories?: string[]; daily_budget?: string }>>(`${act}/campaigns`, { fields: "name,objective,special_ad_categories,daily_budget", filtering: live, limit: "100" }),
    metaGraph<P<{ id: string; name: string; campaign_id: string; status: string; optimization_goal?: string; destination_type?: string; is_dynamic_creative?: boolean; promoted_object?: { pixel_id?: string; custom_event_type?: string; page_id?: string }; daily_budget?: string; lifetime_budget?: string }>>(`${act}/adsets`, {
      fields: "name,campaign_id,status,optimization_goal,destination_type,is_dynamic_creative,promoted_object,daily_budget,lifetime_budget",
      filtering: live,
      limit: "200",
    }),
    metaGraph<P<{ id: string; name: string; adset_id: string; created_time: string; creative?: { object_story_spec?: { page_id?: string; instagram_user_id?: string }; instagram_user_id?: string; actor_id?: string } }>>(`${act}/ads`, {
      fields: "name,adset_id,created_time,creative{object_story_spec{page_id,instagram_user_id},instagram_user_id,actor_id}",
      filtering: live,
      limit: "400",
    }),
    metaGraph<P<{ id: string; name: string }>>(`${act}/promote_pages`, { fields: "name", limit: "100" }).catch(() => ({ data: [] })),
    metaGraph<P<{ id: string; username?: string }>>(`${act}/instagram_accounts`, { fields: "username", limit: "100" }).catch(() => ({ data: [] })),
  ]);
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const { data: days } = await admin.from("meta_ad_daily").select("adset_id, metrics").in("ad_account_id", [account, act]).gte("date", since);
  const spend = new Map<string, number>();
  for (const d of days ?? []) spend.set(d.adset_id as string, (spend.get(d.adset_id as string) ?? 0) + Number((d.metrics as { spend?: string } | null)?.spend ?? 0));
  const campOf = new Map(camps.data.map((c) => [c.id, c]));
  const adsets: AdsetOption[] = sets.data
    .filter((s) => campOf.has(s.campaign_id))
    .map((s) => {
      const mine = ads.data.filter((a) => a.adset_id === s.id).sort((a, b) => b.created_time.localeCompare(a.created_time));
      const c = campOf.get(s.campaign_id)!;
      return {
        id: s.id,
        name: s.name,
        campaignId: s.campaign_id,
        daily: s.daily_budget ? Number(s.daily_budget) / 100 : null,
        lifetime: s.lifetime_budget ? Number(s.lifetime_budget) / 100 : null,
        campaignDaily: c.daily_budget ? Number(c.daily_budget) / 100 : null,
        campaign: c.name,
        status: s.status,
        objective: c.objective,
        optimization: s.optimization_goal ?? null,
        destination: s.destination_type ?? null,
        dynamic: Boolean(s.is_dynamic_creative),
        leadForm: s.destination_type === "ON_AD" || s.optimization_goal === "LEAD_GENERATION",
        pixel: s.promoted_object?.pixel_id ?? null,
        event: s.promoted_object?.custom_event_type ?? null,
        special: (c.special_ad_categories ?? []).filter((x) => x && x !== "NONE"),
        recentAds: mine.slice(0, 8).map((a) => a.name),
        spend14: Math.round(spend.get(s.id) ?? 0),
        pages: mine.map((a) => a.creative?.object_story_spec?.page_id ?? a.creative?.actor_id).filter((x): x is string => Boolean(x)),
        igs: mine.map((a) => a.creative?.object_story_spec?.instagram_user_id ?? a.creative?.instagram_user_id).filter((x): x is string => Boolean(x)),
      };
    })
    .sort((a, b) => b.spend14 - a.spend14 || Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE"));
  return { adsets, pages: pages.data.map((p) => ({ id: p.id, name: p.name })), igs: igs.data.map((i) => ({ id: i.id, name: i.username ?? i.id })) };
}

const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    adsetId: { type: "string" },
    mode: { type: "string", enum: ["existing", "clone"] },
    newAdsetName: { type: "string" },
    adNames: { type: "array", items: { type: "object", properties: { designId: { type: "string" }, name: { type: "string" } }, required: ["designId", "name"], additionalProperties: false } },
    reason: { type: "string" },
    dailyBudget: { type: "number" },
    budgetWhy: { type: "string" },
  },
  required: ["adsetId", "mode", "newAdsetName", "adNames", "reason", "dailyBudget", "budgetWhy"],
  additionalProperties: false,
};

const PROPOSE_SYSTEM = `You place a client's newly approved ads in their Meta ad account, as Kaizen's media buyer would. You're given the ticket (what was made and why), the designs to launch, and the account's ad sets with their campaign, optimization and recent ad names.
Pick the ad set the new ads belong in: one already testing or running this kind of creative (same funnel stage, audience, offer and goal as the ticket), preferring an active ad set that spends. mode "existing" adds the ads to it. Use mode "clone" only when the ticket clearly calls for its own ad set (a new offer or angle that should be tested apart, or the best match is a "Best performers"/consolidation ad set that shouldn't take untested ads); then the ad set is copied (same targeting, pixel and optimization) and newAdsetName follows the names of the ad sets around it. Never pick an ad set for a different goal (a lead form ad set for website traffic, retargeting for cold creative).
Name each ad so it continues the pattern of the names in that ad set (same separators, order of parts, stage and geo tags, month format, IMG or Video numbering continuing from the highest, copy code such as "Stacked Copy" since the copy goes in stacked). Use the design's own name or the ticket's angle where the pattern has a concept slot. Never put a client's name where the pattern doesn't. If the ad set has no ads yet, follow the account's other ad names.
When this client has launch rules (from their buyers moving ads the launcher placed), they win over your own judgment: follow them, and say in reason which rule you followed.
reason: two or three plain sentences on why this ad set and how the names follow the pattern. newAdsetName empty unless mode is clone.
dailyBudget: the daily budget in dollars the ad set should run at with these ads in it, where its budget lives (the campaign's when the campaign holds it). Work from the account's monthly budget (a month is about 30.4 days), what it spends now and how many ads would share it: room for each ad to get through learning, never a total that runs the account past its monthly budget. For mode existing, the ad set's current budget when it already has room (only raise it when the new ads clearly need it); for a new ad set (clone), a starting budget to test with, in line with the ad sets around it. 0 when it has a lifetime budget or nothing tells you enough. budgetWhy: one plain sentence.`;

/** Plans a launch (in the background of the request that started it): see the top of this file. */
export async function planLaunch(admin: SupabaseClient, launchId: string, overrides: Overrides = {}) {
  const { data: l } = await admin.from("launches").select("request_id, plan").eq("id", launchId).single();
  if (!l) return;
  const checks: LaunchCheck[] = [];
  const add = (key: string, label: string, level: LaunchCheck["level"], detail: string) => checks.push({ key, label, level, detail });
  try {
    await update(admin, launchId, { status: "planning", progress: "Reading the ticket", error: null });
    const { ticket, copy, designs, conversion, monthlyBudget } = await loadTicket(admin, l.request_id);
    if (!ticket) throw new Error("Ticket not found");
    const setting = await metaWriteSetting(admin);
    const clientAccount = (ticket.clients.meta_ad_account_id ?? "").replace(/\D/g, "");
    const sandbox = setting.sandbox;
    const account = sandbox ? setting.sandboxAccount : clientAccount;

    if (sandbox) add("sandbox", "Sandbox", "warn", `A test launch into Kaizen's own ad account (${setting.sandboxAccount}). Nothing reaches ${ticket.clients.name}'s account, and the ticket stays in Ready to launch.`);
    if (!account) add("account", "Ad account", "block", `${ticket.clients.name} has no Meta ad account on their page.`);
    const blocked = account ? await writeBlocked(admin, account) : null;
    if (blocked) add("access", "Write access", "block", blocked);

    // Copy: the approved set, stacked
    if (!copy.length) add("copy", "Approved copy", "block", "There's no approved copy on this ticket yet.");
    const bodies = [...new Set(copy.map((c) => c.primaryText?.trim()).filter(Boolean))].slice(0, 5);
    const titles = [...new Set(copy.map((c) => c.headline?.trim()).filter(Boolean))].slice(0, 5);
    const descriptions = [...new Set(copy.map((c) => c.linkDescription?.trim()).filter(Boolean))].slice(0, 5);
    if (copy.length) {
      const long = titles.filter((t) => t.length > 40).length + descriptions.filter((d) => d.length > 30).length;
      add("copy", "Approved copy", long ? "warn" : "ok", `${bodies.length} primary texts, ${titles.length} headlines and ${descriptions.length} descriptions go in stacked as Meta's text options.${long ? ` ${long} headline or description runs past Kaizen's limit (40 / 30 characters): Meta may cut it off.` : ""}`);
    }
    const cta = ctaOf(mostCommon(copy.map((c) => c.cta)) ?? undefined);

    // Designs and their sizes
    const carousel = designs.filter((d) => d.files.some((f) => f.card != null && f.card > 0));
    if (carousel.length) add("carousel", "Carousels", "block", `${carousel.map((d) => d.name).join(", ")}: carousels aren't launched from here yet; launch those by hand.`);
    const singles = designs.filter((d) => !carousel.includes(d));
    if (!singles.length && !carousel.length) add("creative", "Creative", "block", "No approved creative files on this ticket.");
    const noFeed = singles.filter((d) => !d.files.some((f) => f.aspect === "4x5" || f.aspect === "1x1"));
    const noVertical = singles.filter((d) => !d.files.some((f) => f.aspect === "9x16"));
    if (noFeed.length) add("sizes", "Sizes", "warn", `${noFeed.map((d) => d.name).join(", ")} has no 4x5 or 1x1: its ${noFeed[0].files[0]?.aspect ?? "only"} file is used everywhere.`);
    else if (noVertical.length) add("sizes", "Sizes", "warn", `${noVertical.map((d) => d.name).join(", ")} has no 9x16: Stories and Reels get the feed size, letterboxed.`);
    else if (singles.length) add("sizes", "Sizes", "ok", "Every design has a feed size (4x5 or 1x1) and a 9x16 for Stories and Reels.");

    // Link
    const link = overrides.link ?? (l.plan as LaunchPlan | null)?.link ?? ticket.landing_url ?? ticket.clients.website ?? null;
    if (!link) add("link", "Link", "block", "No landing page on the ticket and no website on the client page.");
    else {
      const ok = await fetch(link, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) })
        .then((r) => r.ok || (r.status >= 300 && r.status < 400))
        .catch(() => false);
      add("link", "Link", ok ? "ok" : "warn", ok ? `${link} opens.` : `${link} didn't open from here; check it before turning the ad on.`);
    }

    if (checks.some((c) => c.level === "block" && ["account", "access"].includes(c.key))) {
      await update(admin, launchId, { status: "blocked", progress: null, checks, plan: { ...(l.plan ?? {}), account, sandbox } });
      return;
    }

    await update(admin, launchId, { progress: "Reading the ad account", account, sandbox });
    let acct = await readAccount(admin, account);
    // Every ad set in the account, for moving a launched ad later (in the sandbox, more than where it lands)
    let everyAdset: AdsetOption[] | null = null;
    // Sandbox tests all go into one paused test campaign, never into Kaizen's own running ad sets; made the first time
    if (sandbox) {
      const isTest = (a: AdsetOption) => a.campaign.includes(SANDBOX_CAMPAIGN);
      if (!acct.adsets.some(isTest)) {
        await update(admin, launchId, { progress: "Setting up the sandbox test campaign" });
        await makeSandboxCampaign(admin).catch(() => null);
        acct = await readAccount(admin, account);
      }
      if (acct.adsets.some(isTest)) {
        everyAdset = acct.adsets;
        acct = { ...acct, adsets: acct.adsets.filter(isTest) };
      }
    }
    if (!acct.adsets.length) {
      add("adset", "Ad set", "block", sandbox ? "The sandbox account has no campaign or ad set yet: create a paused test campaign below." : "The account has no campaign or ad set to add ads to; set one up in Ads Manager first.");
      await update(admin, launchId, { status: "blocked", progress: null, checks, plan: { account, sandbox, options: { adsets: [], pages: acct.pages, igs: acct.igs } } });
      return;
    }

    // The ad set and names: the buyer's picks, else the Media Buyer's proposal
    // A pick that's no longer on offer (the ad set was paused away, or the sandbox narrowed the list): pick again
    let adsetId = overrides.adsetId && acct.adsets.some((a) => a.id === overrides.adsetId) ? overrides.adsetId : "";
    let mode: "existing" | "clone" = overrides.mode ?? "existing";
    let newAdsetName = overrides.newAdsetName ?? null;
    let names: Record<string, string> = overrides.names ?? {};
    let reason = (l.plan as LaunchPlan | null)?.reason ?? "";
    let suggested = (l.plan as LaunchPlan | null)?.budget?.suggested ?? null;
    let budgetWhy = (l.plan as LaunchPlan | null)?.budget?.why ?? "";
    if (!adsetId) {
      await update(admin, launchId, { progress: "Picking the ad set and names" });
      // Where this client's buyers have moved ads before, and why: the rules come first
      const rules = await clientLaunchRules(admin, ticket.client_id);
      const rulesBlock = rules.length ? `<this_clients_launch_rules>\n${rules.map((r) => `- ${r}`).join("\n")}\n</this_clients_launch_rules>\n\n` : "";
      const brief = JSON.stringify(ticket.brief ?? {}).slice(0, 2500);
      const out = await askJson<{ adsetId: string; mode: "existing" | "clone"; newAdsetName: string; adNames: { designId: string; name: string }[]; reason: string; dailyBudget: number; budgetWhy: string }>({
        agent: "launcher",
        label: "place a launch",
        system: PROPOSE_SYSTEM,
        schema: PROPOSE_SCHEMA,
        maxTokens: 4000,
        prompt: `${rulesBlock}<budget>\nMonthly budget for this account: ${monthlyBudget != null ? `$${monthlyBudget}` : "not set"}. Spend across its ad sets, last 14 days: $${Math.round(acct.adsets.reduce((n, a) => n + a.spend14, 0))}.\n</budget>\n\n<ticket>\n#${ticket.number} ${ticket.title} (${ticket.format})\nClient: ${ticket.clients.name}\nKPI counted: ${conversion ?? "unknown"}\nBrief: ${brief}\n</ticket>\n\n<designs>\n${singles.map((d) => `- designId ${d.id}: "${d.name}" (${d.files.map((f) => `${f.aspect ?? "?"} ${f.mime.startsWith("video") ? "video" : "image"}`).join(", ")})`).join("\n")}\n</designs>\n\n<ad_sets>\n${acct.adsets
          .slice(0, 60)
          .map((a) => `- id ${a.id} "${a.name}" [${a.status}] in "${a.campaign}" (${a.objective}${a.optimization ? `, optimizing ${a.optimization}` : ""}${a.leadForm ? ", instant form" : ""}${a.special.length ? `, special category ${a.special.join("/")}` : ""}), ${a.campaignDaily != null ? `campaign budget $${a.campaignDaily}/day` : a.daily != null ? `budget $${a.daily}/day` : a.lifetime != null ? `lifetime budget $${a.lifetime}` : "no budget read"}, $${a.spend14} last 14 days\n    recent ads: ${a.recentAds.length ? a.recentAds.map((n) => `"${n}"`).join("; ") : "none"}`)
          .join("\n")}\n</ad_sets>`,
      });
      adsetId = acct.adsets.some((a) => a.id === out.adsetId) ? out.adsetId : acct.adsets[0].id;
      mode = out.mode;
      newAdsetName = out.mode === "clone" ? out.newAdsetName || null : null;
      names = Object.fromEntries(out.adNames.map((n) => [n.designId, n.name]));
      reason = out.reason;
      suggested = out.dailyBudget > 0 ? Math.round(out.dailyBudget * 100) / 100 : null;
      budgetWhy = out.budgetWhy;
    }
    const adset = acct.adsets.find((a) => a.id === adsetId) ?? acct.adsets[0];
    adsetId = adset.id;

    // The ad set can take these ads?
    if (adset.leadForm) add("adset", "Ad set", "block", `"${adset.name}" sends people to an instant form; ads with a lead form aren't launched from here yet.`);
    else if (adset.dynamic) add("adset", "Ad set", "block", `"${adset.name}" is a dynamic creative ad set, which takes one ad built differently; pick another or launch by hand.`);
    else if (!["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_AWARENESS", "CONVERSIONS", "LINK_CLICKS", "REACH", "BRAND_AWARENESS"].includes(adset.objective))
      add("adset", "Ad set", "block", `"${adset.campaign}" is a ${adset.objective} campaign; the launcher handles sales, leads (website), traffic, engagement and awareness.`);
    else add("adset", "Ad set", "ok", mode === "clone" ? `A new ad set, "${newAdsetName}", copied from "${adset.name}" (same targeting, pixel and optimization), paused, in "${adset.campaign}".` : `"${adset.name}" in "${adset.campaign}"${adset.status !== "ACTIVE" ? " (paused)" : ""}.`);
    if (adset.special.length) add("special", "Special ad category", "warn", `"${adset.campaign}" runs under ${adset.special.join(", ").toLowerCase()}: Meta reviews the copy and targeting against those rules.`);
    if (adset.pixel) add("pixel", "Pixel and event", conversion && adset.event && !new RegExp(conversion.replace(/s$/, ""), "i").test(adset.event) ? "warn" : "ok", `Optimizing for ${adset.event ?? adset.optimization ?? "?"} on pixel ${adset.pixel}${conversion ? `; the KPI counts ${conversion}` : ""}.`);

    // Budget: where it lives, what it is, what the Media Buyer suggests, what will be set. A new ad set gets one on its
    // own; an existing ad set's budget only changes when the buyer sets it (it may be carrying other ads)
    const level: Budget["level"] = adset.campaignDaily != null ? "campaign" : adset.daily != null ? "adset" : adset.lifetime != null ? "lifetime" : null;
    const currentBudget = level === "campaign" ? adset.campaignDaily! : level === "adset" ? adset.daily! : level === "lifetime" ? adset.lifetime! : null;
    const asked = overrides.dailyBudget !== undefined ? overrides.dailyBudget : ((l.plan as LaunchPlan | null)?.budget?.value ?? undefined);
    const value = level === "lifetime" || level === null ? null : asked !== undefined ? asked : mode === "clone" ? (suggested ?? currentBudget) : null;
    const budget: Budget = { level, current: currentBudget, suggested, value, why: budgetWhy };
    const $ = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const where = level === "campaign" ? `the campaign "${adset.campaign}" (budget shared by its ad sets)` : mode === "clone" ? "the new ad set" : `"${adset.name}"`;
    if (level === "lifetime") add("budget", "Budget", "ok", `"${adset.name}" runs on a lifetime budget of ${$(currentBudget!)}; it's left as it is.`);
    else if (level === null) add("budget", "Budget", "warn", "Couldn't read this ad set's budget; check it in Ads Manager.");
    else
      add(
        "budget",
        "Budget",
        value != null && currentBudget != null && value > currentBudget * 1.5 ? "warn" : "ok",
        `${value != null && value !== currentBudget ? `${$(value)}/day on ${where} (now ${$(currentBudget!)}).` : `${$(currentBudget!)}/day on ${where}, unchanged.`}${suggested != null && suggested !== value ? ` The Media Buyer suggests ${$(suggested)}.` : ""}${monthlyBudget != null ? ` Monthly budget ${$(monthlyBudget)} (about ${$(Math.round(monthlyBudget / 30.4))}/day).` : ""}`,
      );

    // Identity: the Page and Instagram account the ad set's ads already use
    const pageId = overrides.pageId ?? mostCommon(adset.pages) ?? mostCommon(acct.adsets.flatMap((a) => a.pages)) ?? acct.pages[0]?.id ?? null;
    const igId = overrides.igId !== undefined ? overrides.igId : (mostCommon(adset.igs) ?? mostCommon(acct.adsets.flatMap((a) => a.igs)) ?? null);
    const pageName = acct.pages.find((p) => p.id === pageId)?.name ?? pageId;
    if (!pageId) add("page", "Facebook Page", "block", "No Page this account can advertise for; the system user needs the client's Page assigned in Business Manager.");
    else add("page", "Facebook Page", "ok", `${pageName}${adset.pages.includes(pageId) ? " (the one this ad set's ads use)" : ""}.`);
    add("instagram", "Instagram account", igId ? "ok" : "warn", igId ? `${acct.igs.find((i) => i.id === igId)?.name ?? igId}.` : "None found: on Instagram the ad shows as the Facebook Page. Assign the Instagram account in Business Manager to fix it.");

    // Media already in this account's library from an earlier check (never across accounts)
    const prev = (l.plan as LaunchPlan | null)?.account === account ? ((l.plan as LaunchPlan).ads ?? []) : [];
    const ads: LaunchAd[] = singles.map((d) => ({
      designId: d.id,
      designName: d.name,
      name: (names[d.id] || prev.find((p) => p.designId === d.id)?.name || `${d.name} | Stacked Copy`).slice(0, 250),
      assets: d.files
        .filter((f) => f.card == null || f.card === 0)
        .map((f) => ({ fileId: f.id, aspect: f.aspect ?? "?", kind: f.mime.startsWith("video") ? ("video" as const) : ("image" as const), name: f.original_name, ...(prev.flatMap((p) => p.assets).find((a) => a.fileId === f.id) ?? {}) })),
    }));

    const plan: LaunchPlan = {
      account,
      sandbox,
      adsetId,
      mode,
      newAdsetName,
      pageId,
      igId,
      link,
      urlTags: setting.urlTags ?? null,
      budget,
      cta,
      copy: { bodies, titles, descriptions },
      ads,
      structure: null,
      optOut: [...ENHANCEMENTS],
      reason,
      options: { adsets: acct.adsets, pages: acct.pages, igs: acct.igs, ...(everyAdset ? { allAdsets: everyAdset } : {}) },
      attempts: [],
    };

    if (checks.some((c) => c.level === "block")) {
      await update(admin, launchId, { status: "blocked", progress: null, checks, plan });
      return;
    }

    // Media into the account's library, then Meta's dry run of each creative
    await update(admin, launchId, { progress: "Uploading the creative to the ad account", plan, checks });
    await uploadAssets(admin, plan);
    await update(admin, launchId, { progress: "Checking each ad with Meta", plan });
    await dryRun(admin, plan);
    const failed = plan.ads.filter((a) => !a.check?.ok);
    const refused = failed.find((a) => a.check?.error && accessError(a.check.error));
    if (refused) add("access", "Permission", "block", accessHelp(refused.check!.error!));
    if (refused) {
      // nothing about the ad's structure is known yet
    } else if (plan.structure === "placements") add("structure", "Copy", "warn", "Meta wouldn't take the stacked copy together with placement sizes here, so each ad carries the first primary text and headline only. Add the other text options in Ads Manager if you want them.");
    else if (plan.structure === "text") add("structure", "Sizes", "warn", "Meta wouldn't take the per-placement sizes here, so each ad uses its feed size everywhere (with the stacked copy).");
    else if (plan.structure === "single") add("structure", "Copy and sizes", "warn", "Meta only took a classic single ad here: the feed size with the first primary text and headline. Add the other text options and the 9x16 in Ads Manager.");
    add(
      "enhancements",
      "Advantage+ enhancements",
      plan.optOut.length >= ENHANCEMENTS.length - 4 ? "ok" : "warn",
      plan.optOut.length ? `Switched off (${plan.optOut.length}), so the ad runs as the client approved it.` : "Meta wouldn't take the switches here: check Advantage+ creative is off in Ads Manager before turning the ad on.",
    );
    add("meta", "Meta's dry run", failed.length ? "block" : "ok", failed.length ? failed.map((a) => `${a.name}: ${a.check?.error}`).join(" · ") : `Meta checked all ${plan.ads.length} ${plan.ads.length === 1 ? "ad" : "ads"} and would accept ${plan.ads.length === 1 ? "it" : "them"}.`);
    await update(admin, launchId, { status: failed.length ? "blocked" : "ready", progress: null, checks, plan });
  } catch (e) {
    await update(admin, launchId, { status: "failed", progress: null, checks, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
  }
}

/** Each file into the account's library once: images by their bytes (a hash back), videos by a link Meta downloads. */
async function uploadAssets(admin: SupabaseClient, plan: LaunchPlan) {
  for (const ad of plan.ads)
    for (const a of ad.assets) {
      if ((a.kind === "image" && a.hash) || (a.kind === "video" && a.videoId)) continue;
      const { data: f } = await admin.from("design_files").select("path, thumb_path").eq("id", a.fileId).single();
      if (!f) continue;
      if (a.kind === "image") {
        const { data: blob } = await admin.storage.from(BUCKET).download(f.path);
        if (!blob) throw new Error(`Couldn't read ${a.name} from storage`);
        const bytes = Buffer.from(await blob.arrayBuffer()).toString("base64");
        const r = await metaWrite<{ images?: Record<string, { hash: string }> }>(admin, plan.account, `act_${plan.account}/adimages`, { bytes }, false);
        a.hash = Object.values(r.images ?? {})[0]?.hash;
        if (!a.hash) throw new Error(`Meta didn't return a hash for ${a.name}`);
      } else {
        const { data: url } = await admin.storage.from(BUCKET).createSignedUrl(f.path, 3600);
        if (!url?.signedUrl) throw new Error(`Couldn't link ${a.name}`);
        const r = await metaWrite<{ id: string }>(admin, plan.account, `act_${plan.account}/advideos`, { file_url: url.signedUrl, name: a.name }, false);
        a.videoId = r.id;
        // Meta processes the video before an ad can use it; its poster comes from our thumbnail, else Meta's
        for (let i = 0; i < 40; i++) {
          const s = await metaGraph<{ status?: { video_status?: string } }>(r.id, { fields: "status" }).catch(() => null);
          if (s?.status?.video_status === "ready") break;
          if (s?.status?.video_status === "error") throw new Error(`Meta couldn't process ${a.name}`);
          await new Promise((res) => setTimeout(res, 6000));
        }
        const thumb = f.thumb_path ? (await admin.storage.from(BUCKET).createSignedUrl(f.thumb_path, 60 * 60 * 24 * 7)).data?.signedUrl : null;
        const metaThumb = await metaGraph<{ data: { uri: string; is_preferred: boolean }[] }>(`${r.id}/thumbnails`, {}).catch(() => ({ data: [] }));
        a.thumbUrl = metaThumb.data.find((t) => t.is_preferred)?.uri ?? metaThumb.data[0]?.uri ?? thumb ?? undefined;
      }
    }
}

const FEED = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "marketplace", "video_feeds", "search"], instagram_positions: ["stream", "explore", "explore_home", "profile_feed"] };
const VERTICAL = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] };

/** The creative for one ad, in one of three structures (see the top of this file). */
function creativeSpec(plan: LaunchPlan, ad: LaunchAd, structure: "placements+text" | "placements" | "text") {
  const feed = ad.assets.find((a) => a.aspect === "4x5") ?? ad.assets.find((a) => a.aspect === "1x1") ?? ad.assets[0];
  const vertical = ad.assets.find((a) => a.aspect === "9x16" && a !== feed);
  const video = feed.kind === "video";
  const media = (a: Asset): Record<string, unknown> => (a.kind === "video" ? { video_id: a.videoId, thumbnail_url: a.thumbUrl } : { hash: a.hash });
  const labelled = (a: Asset, label: string) => ({ ...media(a), adlabels: [{ name: label }] });
  const one = structure === "placements";
  const text = {
    bodies: (one ? plan.copy.bodies.slice(0, 1) : plan.copy.bodies).map((t) => ({ text: t })),
    titles: (one ? plan.copy.titles.slice(0, 1) : plan.copy.titles).map((t) => ({ text: t })),
    descriptions: (one ? plan.copy.descriptions.slice(0, 1) : plan.copy.descriptions).map((t) => ({ text: t })),
    link_urls: [{ website_url: plan.link }],
    call_to_action_types: [plan.cta],
    ad_formats: [video ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
  };
  const key = video ? "videos" : "images";
  const labelKey = video ? "video_label" : "image_label";
  if (structure === "text" || !vertical) return textOptionsSpec(plan, ad);
  const asset_feed_spec =
    {
          ...text,
          [key]: [labelled(feed, "kz_feed"), labelled(vertical, "kz_vertical")],
          asset_customization_rules: [
            { customization_spec: FEED, [labelKey]: { name: "kz_feed" }, priority: 1 },
            { customization_spec: VERTICAL, [labelKey]: { name: "kz_vertical" }, priority: 2 },
          ],
          optimization_type: "PLACEMENT",
        };
  return {
    name: ad.name.slice(0, 100),
    object_story_spec: { page_id: plan.pageId, ...(plan.igId ? { instagram_user_id: plan.igId } : {}) },
    asset_feed_spec,
    ...(plan.optOut.length ? { degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(plan.optOut.map((f) => [f, { enroll_status: "OPT_OUT" }])) } } : {}),
    ...(plan.urlTags ? { url_tags: plan.urlTags } : {}),
  };
}

/**
 * One size, every text option: the ad is a normal link (or video) ad with its first text, and the other primary texts,
 * headlines and descriptions ride along as Meta's text variations (asset_feed_spec, DEGREES_OF_FREEDOM).
 */
function textOptionsSpec(plan: LaunchPlan, ad: LaunchAd) {
  const base = classicSpec(plan, ad);
  return {
    ...base,
    asset_feed_spec: {
      bodies: plan.copy.bodies.map((t) => ({ text: t })),
      titles: plan.copy.titles.map((t) => ({ text: t })),
      descriptions: plan.copy.descriptions.map((t) => ({ text: t })),
      optimization_type: "DEGREES_OF_FREEDOM",
    },
  };
}

/** The classic single ad (no asset feed): the feed size, the first primary text and headline. The last resort. */
function classicSpec(plan: LaunchPlan, ad: LaunchAd) {
  const feed = ad.assets.find((a) => a.aspect === "4x5") ?? ad.assets.find((a) => a.aspect === "1x1") ?? ad.assets[0];
  const cta = { type: plan.cta, value: { link: plan.link } };
  const story =
    feed.kind === "video"
      ? { video_data: { video_id: feed.videoId, image_url: feed.thumbUrl, message: plan.copy.bodies[0] ?? "", title: plan.copy.titles[0] ?? "", link_description: plan.copy.descriptions[0] ?? "", call_to_action: cta } }
      : { link_data: { image_hash: feed.hash, link: plan.link, message: plan.copy.bodies[0] ?? "", name: plan.copy.titles[0] ?? "", description: plan.copy.descriptions[0] ?? "", call_to_action: cta } };
  return {
    name: ad.name.slice(0, 100),
    object_story_spec: { page_id: plan.pageId, ...(plan.igId ? { instagram_user_id: plan.igId } : {}), ...story },
    ...(plan.optOut.length ? { degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(plan.optOut.map((f) => [f, { enroll_status: "OPT_OUT" }])) } } : {}),
    ...(plan.urlTags ? { url_tags: plan.urlTags } : {}),
  };
}

const specFor = (plan: LaunchPlan, ad: LaunchAd, structure: NonNullable<LaunchPlan["structure"]>) => (structure === "single" ? classicSpec(plan, ad) : creativeSpec(plan, ad, structure));

const params = (spec: Record<string, unknown>) => Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));

/**
 * Meta's dry run of each creative. The structure is settled on the first ad (the richest Meta accepts), and any
 * enhancement switch Meta doesn't know on this API version is dropped and the check tried again.
 */
/** Meta refusing the asker rather than the ad: a missing permission, a Page role, an account problem */
export const accessError = (m: string) => /permission|not authorized|advertiser role|page role|development mode|must be in public|\(#10\)|\(#200\)|\(#2\d\d\)|\(#190\)|disabled|unsettled/i.test(m);

/** In plain words: what someone has to do in Business Manager for this error */
export function accessHelp(m: string) {
  const page = m.match(/Page (\d{6,})/)?.[1];
  if (/development mode|must be in public/i.test(m))
    return "The Meta app Kaizen Ads uses is in Development mode, and Meta only lets a Live app create ad posts. In developers.facebook.com → the app: add a Privacy Policy URL, category and icon under App settings → Basic, then switch App Mode to Live.";
  if (/application does not have permission/i.test(m))
    return `Meta says the app's token can't post as the Page${page ? ` ${page}` : ""}: the system user's token needs pages_manage_ads, pages_read_engagement and pages_show_list. Settings → Sync health → Check write access shows what the token has and what to do.`;
  if (/page/i.test(m) && /permission|role/i.test(m))
    return `The system user needs the Advertise permission ("Create ads") on the Facebook Page${page ? ` ${page}` : ""}: Business Manager → Settings → Pages → the Page → Assign people → the system user.`;
  if (/disabled|unsettled/i.test(m)) return "The ad account isn't active (billing or a restriction): check it in Business Manager.";
  return "The system user needs Manage campaigns on this ad account (Business Manager → Settings → Ad accounts → Assign people).";
}

async function dryRun(admin: SupabaseClient, plan: LaunchPlan) {
  const hasVertical = plan.ads.some((a) => a.assets.some((x) => x.aspect === "9x16"));
  const ladder: NonNullable<LaunchPlan["structure"]>[] = hasVertical ? ["placements+text", "placements", "text", "single"] : ["text", "single"];
  const tryOne = async (ad: LaunchAd, structure: NonNullable<LaunchPlan["structure"]>) => {
    for (let i = 0; i < 12; i++) {
      try {
        await metaWrite(admin, plan.account, `act_${plan.account}/adcreatives`, params(specFor(plan, ad, structure)), true);
        return null;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        // An enhancement Meta doesn't recognize: drop it and check again; the whole switch block as a last resort
        const named = plan.optOut.find((f) => m.includes(f));
        if (named) plan.optOut = plan.optOut.filter((f) => f !== named);
        else if (plan.optOut.length && /creative_features_spec|degrees_of_freedom|enroll_status|creative feature/i.test(m)) plan.optOut = [];
        else return m;
      }
    }
    return "Meta kept refusing the enhancement switches";
  };
  const first = plan.ads[0];
  if (!first) return;
  for (const s of ladder) {
    const err = await tryOne(first, s);
    plan.attempts.push({ structure: s, error: err });
    if (!err) {
      plan.structure = s;
      break;
    }
    // Refused for who's asking (a permission, the Page, the account), not for how the ad is built: a simpler ad
    // won't change that, so stop here and say what's missing
    if (accessError(err)) {
      plan.structure = s;
      first.check = { ok: false, error: err };
      for (const ad of plan.ads.slice(1)) ad.check = { ok: false, error: "Not checked: Meta refused access (see above)." };
      return;
    }
  }
  if (!plan.structure) {
    first.check = { ok: false, error: plan.attempts.at(-1)?.error ?? "Meta refused it" };
    plan.structure = ladder.at(-1)!;
  } else first.check = { ok: true, error: null };
  for (const ad of plan.ads.slice(1)) {
    const err = await tryOne(ad, plan.structure);
    ad.check = { ok: !err, error: err };
  }
}

/**
 * Creates it all, paused: the ad set copy when asked for, then each creative and ad. Each ad on its own, so one refusal
 * doesn't stop the rest. Returns what was made, with links into Ads Manager.
 */
export async function runLaunch(admin: SupabaseClient, launchId: string) {
  const { data: l } = await admin.from("launches").select("plan, status").eq("id", launchId).single();
  const plan = l?.plan as LaunchPlan | null;
  if (!l || !plan || l.status !== "ready") throw new Error("This launch isn't ready.");
  await update(admin, launchId, { status: "launching", progress: "Creating the ads in Meta" });
  try {
    let adsetId = plan.adsetId;
    if (plan.mode === "clone") {
      const copy = await metaWrite<{ copied_adset_id?: string }>(admin, plan.account, `${plan.adsetId}/copies`, { deep_copy: "false", status_option: "PAUSED" }, false);
      if (!copy.copied_adset_id) throw new Error("Meta didn't return the new ad set");
      adsetId = copy.copied_adset_id;
      if (plan.newAdsetName) await metaWrite(admin, plan.account, adsetId, { name: plan.newAdsetName.slice(0, 250) }, false);
    }
    // The budget the plan settled on, set where it lives; a refusal here doesn't stop the ads
    let budgetNote: string | null = null;
    const b = plan.budget;
    if (b?.value != null && b.value > 0 && (b.level === "adset" || b.level === "campaign") && b.value !== b.current) {
      const target = b.level === "campaign" ? plan.options.adsets.find((a) => a.id === plan.adsetId)?.campaignId : adsetId;
      if (target) await metaWrite(admin, plan.account, target, { daily_budget: String(Math.round(b.value * 100)) }, false).catch((e) => (budgetNote = `Budget not changed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const made: { designId: string; name: string; adId: string | null; creativeId: string | null; error: string | null }[] = [];
    for (const ad of plan.ads) {
      try {
        const c = await metaWrite<{ id: string }>(admin, plan.account, `act_${plan.account}/adcreatives`, params(specFor(plan, ad, plan.structure ?? "single")), false);
        const a = await metaWrite<{ id: string }>(admin, plan.account, `act_${plan.account}/ads`, { name: ad.name.slice(0, 250), adset_id: adsetId, creative: JSON.stringify({ creative_id: c.id }), status: "PAUSED" }, false);
        made.push({ designId: ad.designId, name: ad.name, adId: a.id, creativeId: c.id, error: null });
      } catch (e) {
        made.push({ designId: ad.designId, name: ad.name, adId: null, creativeId: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const ok = made.filter((m) => m.adId);
    const result = { adsetId, newAdset: plan.mode === "clone" ? adsetId : null, ads: made, link: ok.length ? adsManagerLink(plan.account, ok.map((m) => m.adId!), adsetId, campaignOf(plan, plan.adsetId)) : null };
    await update(admin, launchId, {
      status: ok.length ? "launched" : "failed",
      progress: null,
      result,
      launched_at: ok.length ? new Date().toISOString() : null,
      error: [ok.length === made.length ? null : made.filter((m) => m.error).map((m) => `${m.name}: ${m.error}`).join(" · "), budgetNote].filter(Boolean).join(" · ").slice(0, 500) || null,
    });
    return { ok: ok.length, total: made.length, result, sandbox: plan.sandbox };
  } catch (e) {
    await update(admin, launchId, { status: "failed", progress: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    throw e;
  }
}

/** Sandbox only: a paused traffic campaign and ad set in Kaizen's own account, so there's somewhere to test launches. */
const SANDBOX_CAMPAIGN = "Kaizen Ads launcher test";

export async function makeSandboxCampaign(admin: SupabaseClient) {
  const s = await metaWriteSetting(admin);
  if (!s.sandbox) throw new Error("Only in sandbox mode.");
  const act = `act_${s.sandboxAccount}`;
  const c = await metaWrite<{ id: string }>(admin, s.sandboxAccount, `${act}/campaigns`, { name: `Kaizen | ${SANDBOX_CAMPAIGN}`, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false" }, false);
  await metaWrite(admin, s.sandboxAccount, `${act}/adsets`, {
    name: "Stage 1 | US | TOF | Launcher test",
    campaign_id: c.id,
    status: "PAUSED",
    daily_budget: "100",
    billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    destination_type: "WEBSITE",
    targeting: JSON.stringify({ geo_locations: { countries: ["US"] }, age_min: 18, age_max: 65 }),
  }, false);
  return c.id;
}

// ─── Automatic: launched when the ticket reaches Ready to launch, completed when the ad is turned on ───────────

type TicketRow = { id: string; number: number; title: string; client_id: string; buyer_id: string | null; stage: string; clients: { name: string } | null };

/** Whose the launch is: the ticket's buyer, else the client's Meta buyer. */
async function buyerOf(admin: SupabaseClient, t: TicketRow) {
  if (t.buyer_id) return t.buyer_id;
  const { data } = await admin.from("client_assignments").select("profile_id").eq("client_id", t.client_id).eq("role", "meta_buyer").limit(1).maybeSingle();
  return (data?.profile_id as string | undefined) ?? null;
}

/** A note on the ticket from Kaizen Ads, the ticket handed to the buyer, and a notification to them. */
async function handTo(admin: SupabaseClient, t: TicketRow, buyer: string | null, note: string, n: { title: string; body: string; priority: "critical" | "normal"; key: string }) {
  await admin.from("request_events").insert({ request_id: t.id, kind: "comment", actor_id: null, body: note.slice(0, 2000) });
  if (!buyer) return;
  await admin.from("requests").update({ assignee_id: buyer }).eq("id", t.id);
  await admin
    .from("notifications")
    .upsert({ profile_id: buyer, kind: "launch", title: n.title.slice(0, 200), body: n.body.slice(0, 500), href: `/board?t=${t.number}`, key: n.key, priority: n.priority }, { onConflict: "profile_id,key", ignoreDuplicates: true });
}

/**
 * A ticket that just reached Ready to launch: plan it, and when every check passes create the ads paused and hand the
 * ticket to the buyer with the link to turn them on. When anything stops it, the buyer gets the ticket with the reason,
 * and the Launch panel on it is where they finish it by hand. Runs once per ticket (a launch that exists is left be).
 */
export async function autoLaunch(admin: SupabaseClient, requestId: string, launchId?: string) {
  const { data: t } = await admin.from("requests").select("id, number, title, client_id, buyer_id, stage, clients(name)").eq("id", requestId).is("deleted_at", null).maybeSingle();
  const ticket = t as unknown as TicketRow | null;
  if (!ticket || ticket.stage !== "ready_for_launch") return "not ready";
  // launchId: "Start it now" made the row already; otherwise only a ticket with no launch yet
  let l: { id: string } | null = launchId ? { id: launchId } : null;
  if (!l) {
    const { data: had } = await admin.from("launches").select("id").eq("request_id", requestId).limit(1);
    if (had?.length) return "already";
    l = (await admin.from("launches").insert({ request_id: requestId, client_id: ticket.client_id, account: "", auto: true }).select("id").single()).data;
  }
  if (!l) return "couldn't start";
  await planLaunch(admin, l.id);
  const client = ticket.clients?.name ?? "the client";
  const buyer = await buyerOf(admin, ticket);
  const { data: planned } = await admin.from("launches").select("status, checks, error, sandbox").eq("id", l.id).single();

  if (planned?.status === "ready") {
    try {
      const r = await runLaunch(admin, l.id);
      const names = r.result.ads.filter((a) => a.adId).map((a) => a.name);
      if (r.ok) {
        const where = r.sandbox ? "in Kaizen's sandbox account (a test)" : `in ${client}'s ad account`;
        await handTo(
          admin,
          ticket,
          buyer,
          `Launched automatically, paused, ${where}: ${names.join("; ")}.${r.ok < r.total ? ` ${r.total - r.ok} didn't go through; see the Launch panel.` : ""} Check ${r.ok === 1 ? "it" : "them"} in Ads Manager${r.result.link ? ` (${r.result.link})` : ""} and turn ${r.ok === 1 ? "it" : "them"} on there.${r.sandbox ? " While the sandbox is on, the real launch is done by hand." : " This ticket moves to Launched by itself once Meta shows it on."}`,
          {
            title: `${client}: ${r.ok} ${r.ok === 1 ? "ad" : "ads"} ready to turn on${r.sandbox ? " (sandbox test)" : ""}`,
            body: `Created paused from #${ticket.number} ${ticket.title}. Check ${r.ok === 1 ? "it" : "them"} in Ads Manager and turn ${r.ok === 1 ? "it" : "them"} on.`,
            priority: "normal",
            key: `launch:${l.id}`,
          },
        );
        return "launched";
      }
    } catch {
      // falls through to the hand-off below with the launch's error
    }
  }

  // Stopped: the buyer gets it, with why
  const { data: after } = await admin.from("launches").select("checks, error").eq("id", l.id).single();
  const reasons = [...((after?.checks ?? []) as LaunchCheck[]).filter((c) => c.level === "block").map((c) => `${c.label}: ${c.detail}`), ...(after?.error ? [after.error] : [])];
  await handTo(admin, ticket, buyer, `Couldn't launch this automatically. ${reasons.join(" · ").slice(0, 1500) || "Meta refused it."} Fix that, then launch it from the Launch panel on this ticket.`, {
    title: `${client}: launch needs you`,
    body: `#${ticket.number} couldn't go to Meta automatically: ${(reasons[0] ?? "Meta refused it").slice(0, 300)}`,
    priority: "critical",
    key: `launch-failed:${l.id}`,
  });
  return "handed to the buyer";
}

/**
 * The ads launched (paused) whose ticket still waits in Ready to launch: once Meta shows one turned on, the ticket
 * moves to Launched by itself. Sandbox tests never complete a ticket.
 */
export async function watchLaunches(admin: SupabaseClient) {
  const { data } = await admin
    .from("launches")
    .select("id, request_id, result, requests!inner(stage)")
    .eq("status", "launched")
    .eq("sandbox", false)
    .is("live_at", null)
    .eq("requests.stage", "ready_for_launch")
    .limit(40);
  let moved = 0;
  for (const l of data ?? []) {
    const ads = ((l.result as { ads?: { adId: string | null; name: string }[] } | null)?.ads ?? []).filter((a) => a.adId);
    if (!ads.length) continue;
    const res = await metaGraph<Record<string, { status?: string; effective_status?: string }>>("", { ids: ads.map((a) => a.adId).join(","), fields: "status,effective_status" }).catch(() => null);
    if (!res) continue;
    const on = ads.filter((a) => res[a.adId!]?.status === "ACTIVE");
    if (!on.length) continue;
    await admin.rpc("system_move_request", { p_request: l.request_id, p_stage: "launched", p_note: `Turned on in Meta: ${on.map((a) => a.name).join("; ")}`.slice(0, 1000) });
    await admin.from("launches").update({ live_at: new Date().toISOString() }).eq("id", l.id);
    moved++;
  }
  return moved;
}

/** The scheduled step: launch what's waiting (a few per run), then complete what's been turned on. */
export async function launchStep(admin: SupabaseClient, budgetMs = 600_000) {
  const until = Date.now() + budgetMs;
  const { data: waiting } = await admin
    .from("requests")
    .select("id")
    .eq("stage", "ready_for_launch")
    .is("deleted_at", null)
    .gte("stage_entered_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
    .order("stage_entered_at")
    .limit(10);
  const out: Record<string, string> = {};
  for (const r of waiting ?? []) {
    if (Date.now() > until - 240_000) break;
    out[r.id] = await autoLaunch(admin, r.id);
  }
  const live = await watchLaunches(admin).catch(() => 0);
  const moved = await watchHandMoves(admin).catch(() => 0);
  return { moved, launched: Object.values(out).filter((x) => x === "launched").length, handed: Object.values(out).filter((x) => x === "handed to the buyer").length, live };
}

// ─── Moving a launched ad, and learning where a client's ads belong ─────────────────────────────────────────

/** The client's active launch rules, newest first, as the launcher reads them. */
export async function clientLaunchRules(admin: SupabaseClient, clientId: string) {
  const { data } = await admin.from("launch_rules").select("rule, from_adset, to_adset").eq("client_id", clientId).eq("active", true).order("created_at", { ascending: false }).limit(12);
  type A = { name?: string; campaign?: string } | null;
  return (data ?? []).map((r) => {
    const f = r.from_adset as A;
    const t = r.to_adset as A;
    return `${r.rule}${f?.name && t?.name ? ` (a buyer moved an ad from "${f.name}" to "${t.name}"${t.campaign ? ` in "${t.campaign}"` : ""})` : ""}`;
  });
}

type AdsetRef = { id: string; name: string; campaign: string; campaignId?: string | null };

async function adsetRef(id: string): Promise<AdsetRef> {
  const a = await metaGraph<{ id: string; name: string; campaign?: { id: string; name: string } }>(id, { fields: "name,campaign{id,name}" }).catch(() => null);
  return { id, name: a?.name ?? id, campaign: a?.campaign?.name ?? "", campaignId: a?.campaign?.id ?? null };
}

/**
 * A buyer's correction becomes knowledge: a launch rule the launcher reads first for this client, the same line in the
 * client's memory (so every agent knows it), and, when the same kind of correction shows up across clients, a
 * suggested edit to the launcher's playbook for an exec to approve in Settings.
 */
async function learnPlacement(admin: SupabaseClient, launchId: string, clientId: string, from: AdsetRef, to: AdsetRef, reason: string, by: string | null, via: "app" | "ads_manager") {
  const rule = reason.trim().slice(0, 600);
  if (!rule) return;
  await admin.from("launch_rules").insert({ client_id: clientId, launch_id: launchId, rule, from_adset: from, to_adset: to, via, created_by: by });
  await admin.from("client_memory").insert({ client_id: clientId, kind: "prefer", source: "team", created_by: by, body: `Where new ads go: ${rule} (moved from "${from.name}" to "${to.name}").`.slice(0, 1000) });
  await suggestGeneralRule(admin).catch((e) => console.error("launch rules pattern", e));
}

/** Across clients: once a few corrections point the same way, the launcher proposes it as a Kaizen-wide rule. */
async function suggestGeneralRule(admin: SupabaseClient) {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data: rules } = await admin.from("launch_rules").select("client_id, rule, from_adset, to_adset, clients(name)").eq("active", true).gte("created_at", since).order("created_at", { ascending: false }).limit(60);
  if (!rules || rules.length < 3 || new Set(rules.map((r) => r.client_id)).size < 2) return;
  // One suggestion at a time: not while the last one (two weeks) is still waiting
  const { data: recent } = await admin.from("ai_agent_chats").select("id").eq("agent_key", "launcher").eq("role", "coach").like("content", "From launch corrections%").gte("created_at", new Date(Date.now() - 14 * 86_400_000).toISOString()).limit(1);
  if (recent?.length) return;
  const out = await askJson<{ general: boolean; title: string; body: string; reason: string }>({
    agent: "launcher",
    label: "launch rules pattern",
    system: `You look at how Kaizen's media buyers corrected where the launcher placed new ads, across clients. If several corrections from different clients point to the same general rule (a kind of creative, offer or funnel stage that belongs in a kind of ad set), write it as one rule for the launcher's playbook. Only a real pattern across clients; a rule that fits one client stays with that client. Refer to ad sets by their role (cold prospecting, best performers, retargeting, testing), never by client or person names.`,
    schema: { type: "object", properties: { general: { type: "boolean" }, title: { type: "string" }, body: { type: "string" }, reason: { type: "string" } }, required: ["general", "title", "body", "reason"], additionalProperties: false },
    maxTokens: 2000,
    prompt: rules
      .map((r) => `- ${(r.clients as unknown as { name: string } | null)?.name ?? "a client"}: "${r.rule}" (from "${(r.from_adset as AdsetRef | null)?.name ?? "?"}" to "${(r.to_adset as AdsetRef | null)?.name ?? "?"}")`)
      .join("\n"),
  });
  if (!out.general || !out.body.trim()) return;
  await admin.from("ai_agent_chats").insert({
    agent_key: "launcher",
    role: "coach",
    content: "From launch corrections: buyers across clients keep moving new ads the same way. I'd add this to the launcher's playbook so it places them right the first time.",
    changes: [{ op: "add_item", item_id: "", kind: "knowledge", scope: "agent", title: out.title.slice(0, 120), body: out.body, model: "", effort: "", reason: out.reason }],
  });
}

type Made = { designId: string; name: string; adId: string | null; creativeId: string | null; error: string | null };
type Result = { adsetId: string; newAdset: string | null; ads: Made[]; link: string | null };

/**
 * Moves a launched ad to the ad set it belongs in: the same creative (nothing uploaded again) as a new paused ad there
 * (or in a new ad set copied from the one picked), then the old ad is archived (out of the running account, kept in
 * Meta's history). The buyer's reason is learned.
 */
export type MoveTarget = {
  /** existing: into this ad set. clone: a new ad set copied from it, same campaign. campaign: a new campaign (same
   *  objective and special ad category as this ad set's), with a copy of this ad set in it, all paused */
  mode: "existing" | "clone" | "campaign";
  adsetId: string;
  newAdsetName?: string | null;
  newCampaignName?: string | null;
  dailyBudget?: number | null;
};

export async function moveLaunch(admin: SupabaseClient, launchId: string, by: string, target: MoveTarget, reason: string) {
  const { data: l } = await admin.from("launches").select("client_id, plan, result, moves, status").eq("id", launchId).single();
  const plan = l?.plan as LaunchPlan | null;
  const result = l?.result as Result | null;
  if (!l || !plan || !result || l.status !== "launched") throw new Error("Only a launched ad can be moved.");
  if (!reason.trim()) throw new Error("Say why it goes there: that's what the launcher learns from.");
  const from = await adsetRef(result.adsetId);
  let adsetId = target.adsetId;
  if (target.mode === "campaign") {
    // A new campaign built like the ad set picked: its objective and special ad category, budget on the ad set
    const tpl = await metaGraph<{ campaign?: { id: string; objective: string; special_ad_categories?: string[] }; daily_budget?: string }>(target.adsetId, { fields: "daily_budget,campaign{objective,special_ad_categories}" });
    if (!tpl.campaign) throw new Error("Couldn't read the ad set to copy from.");
    if (!target.newCampaignName?.trim()) throw new Error("Name the new campaign.");
    const camp = await metaWrite<{ id: string }>(
      admin,
      plan.account,
      `act_${plan.account}/campaigns`,
      { name: target.newCampaignName.trim().slice(0, 250), objective: tpl.campaign.objective, status: "PAUSED", special_ad_categories: JSON.stringify((tpl.campaign.special_ad_categories ?? []).filter((c) => c && c !== "NONE")), is_adset_budget_sharing_enabled: "false" },
      false,
    );
    const copy = await metaWrite<{ copied_adset_id?: string }>(admin, plan.account, `${target.adsetId}/copies`, { campaign_id: camp.id, deep_copy: "false", status_option: "PAUSED" }, false);
    if (!copy.copied_adset_id) throw new Error("Meta made the campaign but didn't return the new ad set.");
    adsetId = copy.copied_adset_id;
    await metaWrite(
      admin,
      plan.account,
      adsetId,
      { ...(target.newAdsetName?.trim() ? { name: target.newAdsetName.trim().slice(0, 250) } : {}), ...(target.dailyBudget && target.dailyBudget > 0 ? { daily_budget: String(Math.round(target.dailyBudget * 100)) } : {}) },
      false,
    );
  } else if (target.mode === "clone") {
    const copy = await metaWrite<{ copied_adset_id?: string }>(admin, plan.account, `${target.adsetId}/copies`, { deep_copy: "false", status_option: "PAUSED" }, false);
    if (!copy.copied_adset_id) throw new Error("Meta didn't return the new ad set");
    adsetId = copy.copied_adset_id;
    if (target.newAdsetName) await metaWrite(admin, plan.account, adsetId, { name: target.newAdsetName.slice(0, 250) }, false);
  }
  const to = await adsetRef(adsetId);
  const ads: Made[] = [];
  for (const a of result.ads) {
    if (!a.adId || !a.creativeId) {
      ads.push(a);
      continue;
    }
    const made = await metaWrite<{ id: string }>(admin, plan.account, `act_${plan.account}/ads`, { name: a.name.slice(0, 250), adset_id: adsetId, creative: JSON.stringify({ creative_id: a.creativeId }), status: "PAUSED" }, false);
    await metaWrite(admin, plan.account, a.adId, { status: "ARCHIVED" }, false).catch(() => null);
    ads.push({ ...a, adId: made.id });
  }
  const ok = ads.filter((a) => a.adId);
  await update(admin, launchId, {
    result: { ...result, adsetId, ads, link: ok.length ? adsManagerLink(plan.account, ok.map((a) => a.adId!), adsetId, to.campaignId) : null },
    moves: [...((l.moves ?? []) as unknown[]), { at: new Date().toISOString(), by, from, to, reason: reason.trim(), via: "app" }],
    pending_move: null,
  });
  await learnPlacement(admin, launchId, plan.sandbox ? await sandboxClient(admin, l.client_id) : l.client_id, from, to, reason, by, "app");
  return { to };
}

/** Where a sandbox test's lessons go: the internal sandbox client, so a test never teaches a real client's placements. */
async function sandboxClient(admin: SupabaseClient, fallback: string) {
  const s = await metaWriteSetting(admin);
  const { data } = await admin.from("clients").select("id").eq("internal", true).eq("meta_ad_account_id", s.sandboxAccount).limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? fallback;
}

/** The buyer explains a move they made by hand in Ads Manager; it's learned the same way. */
export async function explainHandMove(admin: SupabaseClient, launchId: string, by: string, reason: string) {
  const { data: l } = await admin.from("launches").select("client_id, sandbox, pending_move, moves").eq("id", launchId).single();
  const p = l?.pending_move as { from: AdsetRef; to: AdsetRef } | null;
  if (!l || !p) throw new Error("Nothing to explain.");
  if (!reason.trim()) throw new Error("Say why it goes there.");
  await update(admin, launchId, { pending_move: null, moves: [...((l.moves ?? []) as unknown[]), { at: new Date().toISOString(), by, from: p.from, to: p.to, reason: reason.trim(), via: "ads_manager" }] });
  await learnPlacement(admin, launchId, l.sandbox ? await sandboxClient(admin, l.client_id) : l.client_id, p.from, p.to, reason, by, "ads_manager");
}

/**
 * Launched ads moved by hand in Ads Manager (their ad set isn't the one we put them in): the move is recorded and the
 * buyer is asked why, so the launcher learns from it like a move made here.
 */
export async function watchHandMoves(admin: SupabaseClient) {
  const { data } = await admin
    .from("launches")
    .select("id, request_id, result, pending_move, sandbox, requests!inner(number, title, buyer_id, client_id, clients(name))")
    .eq("status", "launched")
    .is("pending_move", null)
    .gte("launched_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
    .limit(40);
  let asked = 0;
  for (const l of data ?? []) {
    const result = l.result as Result | null;
    const ads = (result?.ads ?? []).filter((a) => a.adId);
    if (!result || !ads.length) continue;
    const res = await metaGraph<Record<string, { adset_id?: string }>>("", { ids: ads.map((a) => a.adId).join(","), fields: "adset_id" }).catch(() => null);
    const moved = ads.map((a) => res?.[a.adId!]?.adset_id).find((id) => id && id !== result.adsetId);
    if (!moved) continue;
    const [from, to] = await Promise.all([adsetRef(result.adsetId), adsetRef(moved)]);
    await update(admin, l.id, { pending_move: { from, to, seen: new Date().toISOString() }, result: { ...result, adsetId: moved } });
    const t = l.requests as unknown as { number: number; title: string; buyer_id: string | null; client_id: string; clients: { name: string } | null };
    const buyer = t.buyer_id ?? ((await admin.from("client_assignments").select("profile_id").eq("client_id", t.client_id).eq("role", "meta_buyer").limit(1).maybeSingle()).data?.profile_id as string | undefined) ?? null;
    if (buyer && !l.sandbox)
      await admin.from("notifications").upsert(
        {
          profile_id: buyer,
          kind: "launch",
          title: `${t.clients?.name ?? "A client"}: you moved the ad to "${to.name}". Why there?`,
          body: `One line on why it belongs in "${to.name}" rather than "${from.name}", and the launcher places this client's next ads there first.`,
          href: `/board?t=${t.number}`,
          key: `launch-moved:${l.id}:${moved}`,
          priority: "normal",
        },
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
    asked++;
  }
  return asked;
}
