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
const ADS_MANAGER = (account: string, ids: string) => `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${account}&selected_ad_ids=${ids}`;

export type LaunchCheck = { key: string; label: string; level: "ok" | "warn" | "block"; detail: string };
type Asset = { fileId: string; aspect: string; kind: "image" | "video"; hash?: string; videoId?: string; thumbUrl?: string; name: string };
export type LaunchAd = { designId: string; designName: string; name: string; assets: Asset[]; check?: { ok: boolean; error: string | null } };
type AdsetOption = { id: string; name: string; campaignId: string; campaign: string; status: string; objective: string; optimization: string | null; destination: string | null; dynamic: boolean; leadForm: boolean; pixel: string | null; event: string | null; special: string[]; recentAds: string[]; spend14: number; pages: string[]; igs: string[] };
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
  cta: string;
  copy: { bodies: string[]; titles: string[]; descriptions: string[] };
  ads: LaunchAd[];
  structure: "placements+text" | "placements" | "text" | "single" | null;
  optOut: string[];
  reason: string;
  options: { adsets: AdsetOption[]; pages: { id: string; name: string }[]; igs: { id: string; name: string }[] };
  attempts: { structure: string; error: string | null }[];
};
export type Overrides = Partial<Pick<LaunchPlan, "adsetId" | "mode" | "newAdsetName" | "pageId" | "igId" | "link">> & { names?: Record<string, string> };

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
    t ? admin.from("kpi_targets").select("conversion").eq("client_id", (t as unknown as Ticket).client_id).eq("platform", "meta").eq("active", true).limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  type F = { id: string; path: string; thumb_path: string | null; mime: string; aspect: string | null; card: number | null; original_name: string };
  type D = { id: string; position: number; name: string; is_variation: boolean; current_version: number; client_status: string | null; design_versions: { version: number; design_files: F[] }[] };
  const list = ((designs ?? []) as unknown as D[])
    .filter((d) => d.client_status !== "changes")
    .map((d) => ({ id: d.id, name: d.name, position: d.position, files: d.design_versions.find((v) => v.version === d.current_version)?.design_files ?? [] }))
    .filter((d) => d.files.length);
  return { ticket: t as unknown as Ticket | null, copy: (copy?.ads ?? []) as { kind: string; headline: string; primaryText: string; linkDescription: string; cta: string }[], designs: list, conversion: (kpi?.conversion as string | undefined) ?? null };
}

/** The ad sets that can take new ads (with their recent ad names, Page and Instagram identity), the Pages and IG accounts. */
async function readAccount(admin: SupabaseClient, account: string) {
  const act = `act_${account}`;
  const live = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES"] }]);
  type P<T> = { data: T[] };
  const [camps, sets, ads, pages, igs] = await Promise.all([
    metaGraph<P<{ id: string; name: string; objective: string; special_ad_categories?: string[] }>>(`${act}/campaigns`, { fields: "name,objective,special_ad_categories", filtering: live, limit: "100" }),
    metaGraph<P<{ id: string; name: string; campaign_id: string; status: string; optimization_goal?: string; destination_type?: string; is_dynamic_creative?: boolean; promoted_object?: { pixel_id?: string; custom_event_type?: string; page_id?: string } }>>(`${act}/adsets`, {
      fields: "name,campaign_id,status,optimization_goal,destination_type,is_dynamic_creative,promoted_object",
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
  },
  required: ["adsetId", "mode", "newAdsetName", "adNames", "reason"],
  additionalProperties: false,
};

const PROPOSE_SYSTEM = `You place a client's newly approved ads in their Meta ad account, as Kaizen's media buyer would. You're given the ticket (what was made and why), the designs to launch, and the account's ad sets with their campaign, optimization and recent ad names.
Pick the ad set the new ads belong in: one already testing or running this kind of creative (same funnel stage, audience, offer and goal as the ticket), preferring an active ad set that spends. mode "existing" adds the ads to it. Use mode "clone" only when the ticket clearly calls for its own ad set (a new offer or angle that should be tested apart, or the best match is a "Best performers"/consolidation ad set that shouldn't take untested ads); then the ad set is copied (same targeting, pixel and optimization) and newAdsetName follows the names of the ad sets around it. Never pick an ad set for a different goal (a lead form ad set for website traffic, retargeting for cold creative).
Name each ad so it continues the pattern of the names in that ad set (same separators, order of parts, stage and geo tags, month format, IMG or Video numbering continuing from the highest, copy code such as "Stacked Copy" since the copy goes in stacked). Use the design's own name or the ticket's angle where the pattern has a concept slot. Never put a client's name where the pattern doesn't. If the ad set has no ads yet, follow the account's other ad names.
reason: two or three plain sentences on why this ad set and how the names follow the pattern. newAdsetName empty unless mode is clone.`;

/** Plans a launch (in the background of the request that started it): see the top of this file. */
export async function planLaunch(admin: SupabaseClient, launchId: string, overrides: Overrides = {}) {
  const { data: l } = await admin.from("launches").select("request_id, plan").eq("id", launchId).single();
  if (!l) return;
  const checks: LaunchCheck[] = [];
  const add = (key: string, label: string, level: LaunchCheck["level"], detail: string) => checks.push({ key, label, level, detail });
  try {
    await update(admin, launchId, { status: "planning", progress: "Reading the ticket", error: null });
    const { ticket, copy, designs, conversion } = await loadTicket(admin, l.request_id);
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
    const acct = await readAccount(admin, account);
    if (!acct.adsets.length) {
      add("adset", "Ad set", "block", sandbox ? "The sandbox account has no campaign or ad set yet: create a paused test campaign below." : "The account has no campaign or ad set to add ads to; set one up in Ads Manager first.");
      await update(admin, launchId, { status: "blocked", progress: null, checks, plan: { account, sandbox, options: { adsets: [], pages: acct.pages, igs: acct.igs } } });
      return;
    }

    // The ad set and names: the buyer's picks, else the Media Buyer's proposal
    let adsetId = overrides.adsetId ?? "";
    let mode: "existing" | "clone" = overrides.mode ?? "existing";
    let newAdsetName = overrides.newAdsetName ?? null;
    let names: Record<string, string> = overrides.names ?? {};
    let reason = (l.plan as LaunchPlan | null)?.reason ?? "";
    if (!adsetId) {
      await update(admin, launchId, { progress: "Picking the ad set and names" });
      const brief = JSON.stringify(ticket.brief ?? {}).slice(0, 2500);
      const out = await askJson<{ adsetId: string; mode: "existing" | "clone"; newAdsetName: string; adNames: { designId: string; name: string }[]; reason: string }>({
        agent: "launcher",
        label: "place a launch",
        system: PROPOSE_SYSTEM,
        schema: PROPOSE_SCHEMA,
        maxTokens: 4000,
        prompt: `<ticket>\n#${ticket.number} ${ticket.title} (${ticket.format})\nClient: ${ticket.clients.name}\nKPI counted: ${conversion ?? "unknown"}\nBrief: ${brief}\n</ticket>\n\n<designs>\n${singles.map((d) => `- designId ${d.id}: "${d.name}" (${d.files.map((f) => `${f.aspect ?? "?"} ${f.mime.startsWith("video") ? "video" : "image"}`).join(", ")})`).join("\n")}\n</designs>\n\n<ad_sets>\n${acct.adsets
          .slice(0, 60)
          .map((a) => `- id ${a.id} "${a.name}" [${a.status}] in "${a.campaign}" (${a.objective}${a.optimization ? `, optimizing ${a.optimization}` : ""}${a.leadForm ? ", instant form" : ""}${a.special.length ? `, special category ${a.special.join("/")}` : ""}), $${a.spend14} last 14 days\n    recent ads: ${a.recentAds.length ? a.recentAds.map((n) => `"${n}"`).join("; ") : "none"}`)
          .join("\n")}\n</ad_sets>`,
      });
      adsetId = acct.adsets.some((a) => a.id === out.adsetId) ? out.adsetId : acct.adsets[0].id;
      mode = out.mode;
      newAdsetName = out.mode === "clone" ? out.newAdsetName || null : null;
      names = Object.fromEntries(out.adNames.map((n) => [n.designId, n.name]));
      reason = out.reason;
    }
    const adset = acct.adsets.find((a) => a.id === adsetId)!;

    // The ad set can take these ads?
    if (adset.leadForm) add("adset", "Ad set", "block", `"${adset.name}" sends people to an instant form; ads with a lead form aren't launched from here yet.`);
    else if (adset.dynamic) add("adset", "Ad set", "block", `"${adset.name}" is a dynamic creative ad set, which takes one ad built differently; pick another or launch by hand.`);
    else if (!["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_AWARENESS", "CONVERSIONS", "LINK_CLICKS", "REACH", "BRAND_AWARENESS"].includes(adset.objective))
      add("adset", "Ad set", "block", `"${adset.campaign}" is a ${adset.objective} campaign; the launcher handles sales, leads (website), traffic, engagement and awareness.`);
    else add("adset", "Ad set", "ok", mode === "clone" ? `A new ad set, "${newAdsetName}", copied from "${adset.name}" (same targeting, pixel and optimization), paused, in "${adset.campaign}".` : `"${adset.name}" in "${adset.campaign}"${adset.status !== "ACTIVE" ? " (paused)" : ""}.`);
    if (adset.special.length) add("special", "Special ad category", "warn", `"${adset.campaign}" runs under ${adset.special.join(", ").toLowerCase()}: Meta reviews the copy and targeting against those rules.`);
    if (adset.pixel) add("pixel", "Pixel and event", conversion && adset.event && !new RegExp(conversion.replace(/s$/, ""), "i").test(adset.event) ? "warn" : "ok", `Optimizing for ${adset.event ?? adset.optimization ?? "?"} on pixel ${adset.pixel}${conversion ? `; the KPI counts ${conversion}` : ""}.`);

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
      cta,
      copy: { bodies, titles, descriptions },
      ads,
      structure: null,
      optOut: [...ENHANCEMENTS],
      reason,
      options: { adsets: acct.adsets, pages: acct.pages, igs: acct.igs },
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
    if (plan.structure === "placements") add("structure", "Copy", "warn", "Meta wouldn't take the stacked copy together with placement sizes here, so each ad carries the first primary text and headline only. Add the other text options in Ads Manager if you want them.");
    if (plan.structure === "text") add("structure", "Sizes", "warn", "Meta wouldn't take the per-placement sizes here, so each ad uses its feed size everywhere (with the stacked copy).");
    if (plan.structure === "single") add("structure", "Copy and sizes", "warn", "Meta only took a classic single ad here: the feed size with the first primary text and headline. Add the other text options and the 9x16 in Ads Manager.");
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
  const asset_feed_spec =
    structure !== "text" && vertical
      ? {
          ...text,
          [key]: [labelled(feed, "kz_feed"), labelled(vertical, "kz_vertical")],
          asset_customization_rules: [
            { customization_spec: FEED, [labelKey]: { name: "kz_feed" }, priority: 1 },
            { customization_spec: VERTICAL, [labelKey]: { name: "kz_vertical" }, priority: 2 },
          ],
          optimization_type: "PLACEMENT",
        }
      : { ...text, [key]: [media(feed)], optimization_type: "DEGREES_OF_FREEDOM" };
  return {
    name: ad.name.slice(0, 100),
    object_story_spec: { page_id: plan.pageId, ...(plan.igId ? { instagram_user_id: plan.igId } : {}) },
    asset_feed_spec,
    ...(plan.optOut.length ? { degrees_of_freedom_spec: { creative_features_spec: Object.fromEntries(plan.optOut.map((f) => [f, { enroll_status: "OPT_OUT" }])) } } : {}),
    ...(plan.urlTags ? { url_tags: plan.urlTags } : {}),
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
    const result = { adsetId, newAdset: plan.mode === "clone" ? adsetId : null, ads: made, link: ok.length ? ADS_MANAGER(plan.account, ok.map((m) => m.adId).join(",")) : null };
    await update(admin, launchId, {
      status: ok.length ? "launched" : "failed",
      progress: null,
      result,
      launched_at: ok.length ? new Date().toISOString() : null,
      error: ok.length === made.length ? null : made.filter((m) => m.error).map((m) => `${m.name}: ${m.error}`).join(" · ").slice(0, 500),
    });
    return { ok: ok.length, total: made.length, result, sandbox: plan.sandbox };
  } catch (e) {
    await update(admin, launchId, { status: "failed", progress: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    throw e;
  }
}

/** Sandbox only: a paused traffic campaign and ad set in Kaizen's own account, so there's somewhere to test launches. */
export async function makeSandboxCampaign(admin: SupabaseClient) {
  const s = await metaWriteSetting(admin);
  if (!s.sandbox) throw new Error("Only in sandbox mode.");
  const act = `act_${s.sandboxAccount}`;
  const c = await metaWrite<{ id: string }>(admin, s.sandboxAccount, `${act}/campaigns`, { name: "Kaizen | Kaizen Ads launcher test", objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: "[]", is_adset_budget_sharing_enabled: "false" }, false);
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
