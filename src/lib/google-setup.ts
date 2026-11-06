import "server-only";
import { googleQuery } from "@/lib/context/google-ads";
import { coverageLines, type SetupFact, type SetupFacts } from "@/lib/setup-check";

// What's already set up in a Google Ads account, read before an audit (and each sprint check) so it never recommends
// what's already there: audiences on each campaign and ad group (and whether they target or only observe), the
// account's lists with their size and match rate, conversion actions and how they count, assets at account and campaign
// level, negative keyword lists, bidding, locations, languages and schedules, Performance Max asset groups and their
// audience signals, and auto-applied recommendations. Every part is read on its own: one Google refuses is left out
// and said so, never assumed missing. Read only.

type Row = Record<string, Record<string, unknown>>;
type Obj = Record<string, unknown>;
const o = (v: unknown) => (v ?? {}) as Obj;
const num = (v: unknown) => Number(v) || 0;
const micros = (v: unknown) => (v == null || v === "" ? null : Math.round(Number(v) / 10_000) / 100);
const words = (v: unknown) => String(v ?? "").toLowerCase().replaceAll("_", " ");
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

export type GoogleSnapshot = {
  text: string;
  facts: SetupFacts;
  /** The parts Google wouldn't give us */
  unread: string[];
};

/** Audience kinds, as the buyer says them */
type Kind = "customer match" | "remarketing" | "similar" | "youtube" | "in-market" | "affinity" | "custom segment" | "combined" | "audience" | "life event" | "detailed demographics" | "other list";

function listKind(type: string, name: string): Kind {
  if (/youtube|yt /i.test(name)) return "youtube";
  if (type === "CRM_BASED") return "customer match";
  if (type === "SIMILAR" || type === "LOOKALIKE") return "similar";
  if (["RULE_BASED", "BASIC", "LOGICAL", "EXTERNAL_REMARKETING"].includes(type)) return "remarketing";
  return "other list";
}

function interestKind(taxonomy: string): Kind {
  if (taxonomy === "IN_MARKET") return "in-market";
  if (taxonomy === "AFFINITY") return "affinity";
  if (taxonomy === "LIFE_EVENT") return "life event";
  if (taxonomy === "DETAILED_DEMOGRAPHIC") return "detailed demographics";
  return "affinity";
}

/** Whether audiences only observe (bid only) under this targeting setting: Google's default is observation */
function observes(setting: unknown) {
  const r = (o(setting).targetRestrictions ?? []) as { targetingDimension?: string; bidOnly?: boolean }[];
  const a = r.find((x) => x.targetingDimension === "AUDIENCE");
  return a ? a.bidOnly !== false : true;
}

/** The account's setup, read live, as a compact block for the audit and the facts its plan is checked against */
export async function googleSetupSnapshot(account: string): Promise<GoogleSnapshot> {
  const unread: string[] = [];
  // One part, with a simpler query to fall back on when Google refuses a field (display names on older API versions)
  const safe = (part: string, q: string, alt?: string) =>
    googleQuery(account, q).catch((e) => (alt ? googleQuery(account, alt) : Promise.reject(e))).catch((e) => {
      unread.push(`${part} (${e instanceof Error ? e.message.slice(0, 120) : "refused"})`);
      return [] as Row[];
    });
  const LIVE = "campaign.status = 'ENABLED'";
  const AUD = "('USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'AUDIENCE', 'CUSTOM_AFFINITY', 'CUSTOM_INTENT')";
  const CAMP_CRIT = `SELECT campaign.id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.display_name, campaign_criterion.bid_modifier, campaign_criterion.user_list.user_list, campaign_criterion.user_interest.user_interest_category, campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.end_hour FROM campaign_criterion WHERE ${LIVE} AND campaign_criterion.status != 'REMOVED' AND campaign_criterion.type IN ('USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'AUDIENCE', 'CUSTOM_AFFINITY', 'CUSTOM_INTENT', 'LOCATION', 'PROXIMITY', 'LANGUAGE', 'AD_SCHEDULE')`;
  const GROUP_CRIT = `SELECT campaign.id, ad_group.id, ad_group.name, ad_group.targeting_setting.target_restrictions, ad_group_criterion.type, ad_group_criterion.negative, ad_group_criterion.display_name, ad_group_criterion.user_list.user_list, ad_group_criterion.user_interest.user_interest_category FROM ad_group_criterion WHERE ${LIVE} AND ad_group.status = 'ENABLED' AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.type IN ${AUD}`;
  const noName = (q: string) => q.replace(/, (campaign|ad_group)_criterion.display_name/, "");
  const [camps, campCrit, groupCrit, lists, convs, conv30, customer, tracking, campAssets, custAssets, sharedSets, campShared, custNeg, campNegKw, portfolios, assetGroups, signals, audiences, autoApply] = await Promise.all([
    safe("campaigns", `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas, campaign.targeting_setting.target_restrictions, campaign.geo_target_type_setting.positive_geo_target_type, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE ${LIVE}`),
    safe("campaign targeting", CAMP_CRIT, noName(CAMP_CRIT)),
    safe("ad group audiences", GROUP_CRIT, noName(GROUP_CRIT)),
    safe("audience lists", "SELECT user_list.resource_name, user_list.name, user_list.type, user_list.membership_status, user_list.size_for_search, user_list.size_for_display, user_list.match_rate_percentage, user_list.eligible_for_search, user_list.membership_life_span, user_list.crm_based_user_list.upload_key_type FROM user_list WHERE user_list.membership_status = 'OPEN'"),
    safe("conversion actions", "SELECT conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric, conversion_action.counting_type, conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value, conversion_action.attribution_model_settings.attribution_model, conversion_action.click_through_lookback_window_days FROM conversion_action WHERE conversion_action.status = 'ENABLED'"),
    safe("conversions by action", "SELECT segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE segments.date DURING LAST_30_DAYS"),
    safe("account settings", "SELECT customer.auto_tagging_enabled, customer.currency_code, customer.time_zone FROM customer"),
    safe("enhanced conversions", "SELECT customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled, customer.conversion_tracking_setting.accepted_customer_data_terms, customer.conversion_tracking_setting.conversion_tracking_status FROM customer"),
    safe("campaign assets", `SELECT campaign.id, campaign_asset.field_type, campaign_asset.source, asset.name, asset.sitelink_asset.link_text, asset.callout_asset.callout_text, asset.structured_snippet_asset.header FROM campaign_asset WHERE ${LIVE} AND campaign_asset.status = 'ENABLED'`),
    safe("account assets", "SELECT customer_asset.field_type, customer_asset.source, asset.name, asset.sitelink_asset.link_text, asset.callout_asset.callout_text, asset.structured_snippet_asset.header FROM customer_asset WHERE customer_asset.status = 'ENABLED'"),
    safe("shared lists", "SELECT shared_set.resource_name, shared_set.name, shared_set.type, shared_set.member_count FROM shared_set WHERE shared_set.status = 'ENABLED'"),
    safe("lists on campaigns", `SELECT campaign.id, shared_set.resource_name FROM campaign_shared_set WHERE ${LIVE} AND campaign_shared_set.status = 'ENABLED'`),
    safe("account exclusions", "SELECT customer_negative_criterion.type FROM customer_negative_criterion"),
    safe("campaign negatives", `SELECT campaign.id FROM campaign_criterion WHERE ${LIVE} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED'`),
    safe("portfolio bidding", "SELECT bidding_strategy.resource_name, bidding_strategy.name, bidding_strategy.type, bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.target_roas.target_roas, bidding_strategy.maximize_conversions.target_cpa_micros, bidding_strategy.maximize_conversion_value.target_roas FROM bidding_strategy WHERE bidding_strategy.status = 'ENABLED'"),
    safe("asset groups", `SELECT campaign.id, asset_group.resource_name, asset_group.name, asset_group.status, asset_group.ad_strength FROM asset_group WHERE ${LIVE} AND asset_group.status != 'REMOVED'`),
    safe("audience signals", `SELECT asset_group.resource_name, asset_group_signal.audience.audience, asset_group_signal.search_theme.text FROM asset_group_signal`),
    safe("audiences", "SELECT audience.resource_name, audience.name, audience.dimensions FROM audience"),
    safe("auto-apply", "SELECT recommendation_subscription.type, recommendation_subscription.status FROM recommendation_subscription"),
  ]);

  // ─── Lists and interests, by resource name ───
  const listBy = new Map<string, { name: string; type: string; kind: Kind }>();
  for (const r of lists) {
    const u = o(r.userList);
    const name = String(u.name ?? "");
    listBy.set(String(u.resourceName), { name, type: String(u.type ?? ""), kind: listKind(String(u.type ?? ""), name) });
  }
  const interestIds = [...new Set([...campCrit, ...groupCrit].map((r) => String(o(o(r.campaignCriterion ?? r.adGroupCriterion).userInterest).userInterestCategory ?? "")).filter(Boolean))].slice(0, 100);
  const interests = interestIds.length
    ? await safe("interest kinds", `SELECT user_interest.resource_name, user_interest.taxonomy_type FROM user_interest WHERE user_interest.resource_name IN (${interestIds.map((x) => `'${x.replace(/'/g, "")}'`).join(", ")})`)
    : [];
  const taxonomy = new Map(interests.map((r) => [String(o(r.userInterest).resourceName), String(o(r.userInterest).taxonomyType ?? "")]));
  const kindOf = (c: Obj): Kind => {
    const type = String(c.type ?? "");
    if (type === "USER_LIST") return listBy.get(String(o(c.userList).userList ?? ""))?.kind ?? "other list";
    if (type === "USER_INTEREST") return interestKind(taxonomy.get(String(o(c.userInterest).userInterestCategory ?? "")) ?? "");
    if (type === "COMBINED_AUDIENCE") return "combined";
    if (type === "AUDIENCE") return "audience";
    return "custom segment";
  };
  const nameOf = (c: Obj) => String(c.displayName || listBy.get(String(o(c.userList).userList ?? ""))?.name || "?");

  // ─── Campaigns ───
  const campaigns = camps.map((r) => {
    const c = o(r.campaign);
    return {
      id: String(c.id),
      name: String(c.name),
      type: String(c.advertisingChannelType ?? ""),
      bidding: String(c.biddingStrategyType ?? ""),
      portfolio: String(c.biddingStrategy ?? ""),
      targetCpa: micros(o(c.targetCpa).targetCpaMicros ?? o(c.maximizeConversions).targetCpaMicros),
      targetRoas: o(c.targetRoas).targetRoas ?? o(c.maximizeConversionValue).targetRoas ?? null,
      observes: observes(c.targetingSetting),
      geoType: String(o(c.geoTargetTypeSetting).positiveGeoTargetType ?? ""),
      searchPartners: Boolean(o(c.networkSettings).targetSearchNetwork),
      display: Boolean(o(c.networkSettings).targetContentNetwork),
      budget: micros(o(r.campaignBudget).amountMicros),
      sharedBudget: Boolean(o(r.campaignBudget).explicitlyShared),
    };
  });
  const campName = new Map(campaigns.map((c) => [c.id, c.name]));

  // Audiences per campaign: at campaign level, on its ad groups, and in its asset groups' signals
  type Aud = { kind: Kind; name: string; level: string; negative: boolean; observe: boolean };
  const auds = new Map<string, Aud[]>();
  const push = (cid: string, a: Aud) => auds.set(cid, [...(auds.get(cid) ?? []), a]);
  const campObserves = new Map(campaigns.map((c) => [c.id, c.observes]));
  const place = new Map<string, { locations: string[]; excluded: string[]; radius: string[]; languages: string[]; schedule: string[] }>();
  const placeOf = (cid: string) => {
    const p = place.get(cid) ?? { locations: [], excluded: [], radius: [], languages: [], schedule: [] };
    place.set(cid, p);
    return p;
  };
  for (const r of campCrit) {
    const cid = String(o(r.campaign).id);
    const c = o(r.campaignCriterion);
    const type = String(c.type ?? "");
    if (type === "LOCATION") (c.negative ? placeOf(cid).excluded : placeOf(cid).locations).push(String(c.displayName ?? "?"));
    else if (type === "PROXIMITY") placeOf(cid).radius.push(`${o(c.proximity).radius ?? "?"} ${words(o(c.proximity).radiusUnits) || "mi"}${c.displayName ? ` around ${c.displayName}` : ""}`);
    else if (type === "LANGUAGE") placeOf(cid).languages.push(String(c.displayName ?? "?"));
    else if (type === "AD_SCHEDULE") {
      const s = o(c.adSchedule);
      placeOf(cid).schedule.push(`${words(s.dayOfWeek).slice(0, 3)} ${s.startHour ?? 0}-${s.endHour ?? 24}`);
    } else push(cid, { kind: kindOf(c), name: nameOf(c), level: "campaign", negative: Boolean(c.negative), observe: campObserves.get(cid) ?? true });
  }
  const groupsWithAud = new Map<string, Set<string>>();
  for (const r of groupCrit) {
    const cid = String(o(r.campaign).id);
    const c = o(r.adGroupCriterion);
    const g = String(o(r.adGroup).name ?? "?");
    groupsWithAud.set(cid, (groupsWithAud.get(cid) ?? new Set()).add(g));
    push(cid, { kind: kindOf(c), name: nameOf(c), level: `ad group ${g}`, negative: Boolean(c.negative), observe: observes(o(r.adGroup).targetingSetting) });
  }
  // Performance Max: asset groups and their signals (an audience signal names lists inside its dimensions)
  const audienceBy = new Map(audiences.map((r) => [String(o(r.audience).resourceName), { name: String(o(r.audience).name ?? "?"), dims: JSON.stringify(o(r.audience).dimensions ?? []) }]));
  const groupBy = new Map(assetGroups.map((r) => [String(o(r.assetGroup).resourceName), { cid: String(o(r.campaign).id), name: String(o(r.assetGroup).name ?? "?"), strength: words(o(r.assetGroup).adStrength), status: words(o(r.assetGroup).status), signals: [] as string[], themes: 0 }]));
  for (const r of signals) {
    const g = groupBy.get(String(o(r.assetGroup).resourceName));
    if (!g) continue;
    const sig = o(r.assetGroupSignal);
    const theme = o(sig.searchTheme).text;
    if (theme) {
      g.themes++;
      continue;
    }
    const a = audienceBy.get(String(o(sig.audience).audience ?? ""));
    if (!a) continue;
    // Which kinds of lists the signal uses, from the list resource names in its dimensions
    const used = [...a.dims.matchAll(/customers\/\d+\/userLists\/\d+/g)].map((m) => listBy.get(m[0])?.kind).filter((x): x is Kind => Boolean(x));
    const kinds = [...new Set(used)];
    g.signals.push(`"${a.name}"${kinds.length ? ` (${kinds.join(", ")})` : ""}`);
    for (const kind of kinds.length ? kinds : (["audience"] as Kind[])) push(g.cid, { kind, name: a.name, level: `asset group ${g.name} signal`, negative: false, observe: true });
  }

  // ─── Assets ───
  type AssetCount = Map<string, string[]>;
  const assetLine = (rows: Row[], key: "campaignAsset" | "customerAsset") => {
    const m: AssetCount = new Map();
    for (const r of rows) {
      const a = o(r[key]);
      const field = String(a.fieldType ?? "");
      const as = o(r.asset);
      const label = String(o(as.sitelinkAsset).linkText ?? o(as.calloutAsset).calloutText ?? o(as.structuredSnippetAsset).header ?? as.name ?? "");
      m.set(field, [...(m.get(field) ?? []), `${label}${a.source === "AUTOMATICALLY_CREATED" ? " (auto)" : ""}`]);
    }
    return m;
  };
  const acctAssets = assetLine(custAssets, "customerAsset");
  const campAssetBy = new Map<string, AssetCount>();
  for (const r of campAssets) {
    const cid = String(o(r.campaign).id);
    campAssetBy.set(cid, mergeCount(campAssetBy.get(cid), assetLine([r], "campaignAsset")));
  }
  const FIELDS: [string, string][] = [
    ["SITELINK", "sitelinks"],
    ["CALLOUT", "callouts"],
    ["STRUCTURED_SNIPPET", "structured snippets"],
    ["AD_IMAGE", "images"],
    ["BUSINESS_LOGO", "logo"],
    ["BUSINESS_NAME", "business name"],
    ["LEAD_FORM", "lead form"],
    ["CALL", "call"],
    ["PRICE", "price"],
    ["PROMOTION", "promotion"],
    ["LOCATION", "location"],
  ];
  const describeAssets = (m: AssetCount | undefined) =>
    FIELDS.filter(([f]) => m?.get(f)?.length)
      .map(([f, label]) => {
        const items = m!.get(f)!;
        const named = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET"].includes(f) ? `: ${items.slice(0, 6).map((x) => `"${x}"`).join(", ")}${items.length > 6 ? ", …" : ""}` : "";
        return `${items.length} ${label}${named}`;
      })
      .join("; ");
  // Assets that serve on a campaign: its own, or the account's when it has none of that kind
  const serving = (cid: string, field: string) => campAssetBy.get(cid)?.get(field)?.length || acctAssets.get(field)?.length || 0;

  // ─── Negatives ───
  const sets = new Map(sharedSets.map((r) => [String(o(r.sharedSet).resourceName), { name: String(o(r.sharedSet).name ?? "?"), type: String(o(r.sharedSet).type ?? ""), members: num(o(r.sharedSet).memberCount) }]));
  const setsOn = new Map<string, string[]>();
  for (const r of campShared) {
    const s = sets.get(String(o(r.sharedSet).resourceName));
    if (s) setsOn.set(String(o(r.campaign).id), [...(setsOn.get(String(o(r.campaign).id)) ?? []), String(o(r.sharedSet).resourceName)]);
  }
  const negCount = new Map<string, number>();
  for (const r of campNegKw) negCount.set(String(o(r.campaign).id), (negCount.get(String(o(r.campaign).id)) ?? 0) + 1);
  const acctNeg = new Map<string, number>();
  for (const r of custNeg) acctNeg.set(words(o(r.customerNegativeCriterion).type), (acctNeg.get(words(o(r.customerNegativeCriterion).type)) ?? 0) + 1);

  // ─── Conversions ───
  const fired = new Map<string, number>();
  for (const r of conv30) fired.set(String(o(r.segments).conversionActionName ?? ""), (fired.get(String(o(r.segments).conversionActionName ?? "")) ?? 0) + num(o(r.metrics).allConversions));
  const cust = o(customer[0]?.customer);
  const ct = o(o(tracking[0]?.customer).conversionTrackingSetting);
  const ecLeads = tracking.length ? Boolean(ct.enhancedConversionsForLeadsEnabled) : null;
  const portfolio = new Map(portfolios.map((r) => [String(o(r.biddingStrategy).resourceName), o(r.biddingStrategy)]));

  // ─── Facts, for the plan check ───
  const all = campaigns.map((c) => c.name);
  const audienceTypes = ["SEARCH", "PERFORMANCE_MAX", "DISPLAY", "VIDEO", "DEMAND_GEN", "SHOPPING", "DISCOVERY"];
  const forAud = campaigns.filter((c) => audienceTypes.includes(c.type)).map((c) => c.name);
  const search = campaigns.filter((c) => c.type === "SEARCH");
  const hasKind = (kinds: Kind[]) => campaigns.filter((c) => (auds.get(c.id) ?? []).some((a) => !a.negative && kinds.includes(a.kind))).map((c) => c.name);
  const howAttached = (kinds: Kind[]) => {
    const on = campaigns.flatMap((c) => (auds.get(c.id) ?? []).filter((a) => !a.negative && kinds.includes(a.kind)).map((a) => ({ c: c.id, observe: a.observe })));
    const obs = new Set(on.filter((x) => x.observe).map((x) => x.c)).size;
    const tgt = new Set(on.filter((x) => !x.observe).map((x) => x.c)).size;
    return on.length ? `observation on ${obs}, targeting on ${tgt}` : undefined;
  };
  const ok = (part: string) => !unread.some((u) => u.startsWith(part));
  const facts: SetupFact[] = [];
  const fact = (f: SetupFact, ...parts: string[]) => {
    if (parts.every(ok)) facts.push(f);
  };
  fact({ key: "customer_match", label: "Customer match list", unit: "campaigns", of: forAud, on: hasKind(["customer match"]), detail: howAttached(["customer match"]) }, "campaign targeting", "ad group audiences", "audience lists");
  fact({ key: "remarketing", label: "Remarketing (website visitors) list", unit: "campaigns", of: forAud, on: hasKind(["remarketing"]), detail: howAttached(["remarketing"]) }, "campaign targeting", "ad group audiences", "audience lists");
  fact({ key: "in_market", label: "In-market audiences", unit: "campaigns", of: forAud, on: hasKind(["in-market"]) }, "campaign targeting", "ad group audiences", "interest kinds");
  fact({ key: "affinity", label: "Affinity audiences", unit: "campaigns", of: forAud, on: hasKind(["affinity"]) }, "campaign targeting", "ad group audiences", "interest kinds");
  fact({ key: "custom_segments", label: "Custom segments", unit: "campaigns", of: forAud, on: hasKind(["custom segment"]) }, "campaign targeting", "ad group audiences");
  const assetFact = (key: string, label: string, field: string, min: number) =>
    fact({ key, label: `${label} (${min}+)`, unit: "Search campaigns", of: search.map((c) => c.name), on: search.filter((c) => serving(c.id, field) >= min).map((c) => c.name) }, "campaign assets", "account assets");
  assetFact("sitelinks", "Sitelinks", "SITELINK", 4);
  assetFact("callouts", "Callouts", "CALLOUT", 4);
  assetFact("snippets", "Structured snippets", "STRUCTURED_SNIPPET", 1);
  assetFact("images", "Image assets", "AD_IMAGE", 1);
  assetFact("lead_form", "Lead form asset", "LEAD_FORM", 1);
  fact({ key: "negative_list", label: "Negative keyword list", unit: "Search campaigns", of: search.map((c) => c.name), on: search.filter((c) => (setsOn.get(c.id) ?? []).some((s) => sets.get(s)?.type === "NEGATIVE_KEYWORDS")).map((c) => c.name) }, "shared lists", "lists on campaigns");
  if (customer.length) fact({ key: "auto_tagging", label: "Auto-tagging", of: ["the account"], on: cust.autoTaggingEnabled ? ["the account"] : [] });
  if (ecLeads) fact({ key: "enhanced_conversions", label: "Enhanced conversions for leads", of: ["the account"], on: ["the account"] });
  fact({ key: "presence", label: 'Location option "Presence" (people in the area)', unit: "campaigns", of: all, on: campaigns.filter((c) => c.geoType === "PRESENCE").map((c) => c.name) }, "campaigns");

  // ─── The block ───
  const L: string[] = [];
  L.push("SETUP SNAPSHOT (what's already in place: check here before recommending any setup change)");
  L.push(`Account: auto-tagging ${customer.length ? (cust.autoTaggingEnabled ? "on" : "OFF") : "?"}; enhanced conversions for leads ${ecLeads == null ? "?" : ecLeads ? "on" : "off"}; customer data terms ${tracking.length ? (ct.acceptedCustomerDataTerms ? "accepted" : "not accepted") : "?"}; conversion tracking ${tracking.length ? words(ct.conversionTrackingStatus) || "?" : "?"}`);
  L.push(`\nCAMPAIGNS (enabled: ${campaigns.length}): bidding, targeting and settings`);
  for (const c of campaigns) {
    const p = place.get(c.id);
    const pf = c.portfolio ? portfolio.get(c.portfolio) : null;
    const target = pf ? ` portfolio "${pf.name}"` : `${c.targetCpa ? ` target CPA $${c.targetCpa}` : ""}${c.targetRoas ? ` target ROAS ${c.targetRoas}` : ""}`;
    const loc = p ? [p.locations.length ? `${p.locations.length} locations (${p.locations.slice(0, 4).join(", ")}${p.locations.length > 4 ? ", …" : ""})` : "", p.radius.length ? `radius ${p.radius.slice(0, 3).join(", ")}` : "", p.excluded.length ? `${p.excluded.length} excluded` : ""].filter(Boolean).join(", ") : "";
    L.push(
      `- ${c.name} [${words(c.type)}] ${words(c.bidding)}${target}${c.budget ? `, $${c.budget}/day${c.sharedBudget ? " shared" : ""}` : ""} · locations: ${loc || "none set (everywhere)"}${c.geoType ? `, ${c.geoType === "PRESENCE" ? "presence" : "presence or interest"}` : ""} · languages: ${p?.languages.join(", ") || "all"} · schedule: ${p?.schedule.length ? p.schedule.slice(0, 7).join(", ") : "all day"}${c.type === "SEARCH" ? ` · search partners ${c.searchPartners ? "on" : "off"}, display ${c.display ? "on" : "off"}` : ""}`,
    );
  }
  L.push("\nAUDIENCES ATTACHED (per enabled campaign; observation = bid only, targeting = narrows reach)");
  for (const c of campaigns) {
    const list = auds.get(c.id) ?? [];
    if (!list.length) {
      L.push(`- ${c.name}: none`);
      continue;
    }
    const byLevel = new Map<string, Aud[]>();
    for (const a of list) byLevel.set(a.level, [...(byLevel.get(a.level) ?? []), a]);
    const parts = [...byLevel].slice(0, 6).map(([level, as]) => `${level} (${as[0].observe ? "observation" : "targeting"}): ${as.slice(0, 8).map((a) => `${a.negative ? "excluded " : ""}${a.kind} "${a.name}"`).join(", ")}${as.length > 8 ? ", …" : ""}`);
    L.push(`- ${c.name}: ${parts.join(" | ")}${byLevel.size > 6 ? ` | +${byLevel.size - 6} more` : ""}`);
  }
  L.push("\nCOVERAGE (where it's in place out of where it applies)");
  L.push(...coverageLines({ platform: "google", facts }));
  const listLines = [...listBy.values()];
  const listRow = (r: Row) => {
    const u = o(r.userList);
    const rate = u.matchRatePercentage != null && u.matchRatePercentage !== "" ? `, match rate ${u.matchRatePercentage}%` : "";
    return `"${u.name}" (search ${k(num(u.sizeForSearch))}, display ${k(num(u.sizeForDisplay))}${rate}${u.eligibleForSearch === false ? ", not eligible for Search" : ""}${u.membershipLifeSpan ? `, ${u.membershipLifeSpan}d` : ""})`;
  };
  L.push(`\nAUDIENCE LISTS IN THE ACCOUNT (open: ${listLines.length})`);
  for (const kind of ["customer match", "remarketing", "youtube", "similar", "other list"] as Kind[]) {
    const rows = lists.filter((r) => listKind(String(o(r.userList).type ?? ""), String(o(r.userList).name ?? "")) === kind);
    if (rows.length) L.push(`- ${kind}: ${rows.slice(0, 8).map(listRow).join("; ")}${rows.length > 8 ? `; +${rows.length - 8} more` : ""}`);
  }
  L.push(`\nCONVERSION ACTIONS (enabled: ${convs.length}; last 30 days' all conversions in brackets)`);
  for (const r of convs) {
    const c = o(r.conversionAction);
    const v = o(c.valueSettings);
    L.push(
      `- ${c.name} [${words(c.category)}, ${words(c.type)}, ${c.primaryForGoal ? "primary" : "secondary"}${c.includeInConversionsMetric ? ", in Conversions" : ""}, counts ${c.countingType === "ONE_PER_CLICK" ? "one" : "every"}, value ${v.defaultValue ? `$${v.defaultValue}${v.alwaysUseDefaultValue ? " always" : " default"}` : "none"}, ${words(o(c.attributionModelSettings).attributionModel).replace("google ads ", "") || "?"}${c.clickThroughLookbackWindowDays ? `, ${c.clickThroughLookbackWindowDays}d click` : ""}] (${Math.round((fired.get(String(c.name)) ?? 0) * 10) / 10})`,
    );
  }
  L.push("\nASSETS");
  L.push(`- Account level: ${describeAssets(acctAssets) || "none"}`);
  for (const c of campaigns) {
    const d = describeAssets(campAssetBy.get(c.id));
    if (d) L.push(`- ${c.name}: ${d}`);
  }
  L.push("\nNEGATIVES");
  const negLists = [...sets.values()].filter((s) => s.type === "NEGATIVE_KEYWORDS");
  L.push(`- Negative keyword lists: ${negLists.map((s) => `"${s.name}" (${s.members} keywords)`).join(", ") || "none"}`);
  for (const c of search) L.push(`- ${c.name}: ${(setsOn.get(c.id) ?? []).map((s) => `"${sets.get(s)?.name}"`).join(", ") || "no shared lists"}, ${negCount.get(c.id) ?? 0} campaign negatives`);
  if (acctNeg.size) L.push(`- Account-level exclusions: ${[...acctNeg].map(([t, n]) => `${n} ${t}`).join(", ")}`);
  const pmax = [...groupBy.values()];
  if (pmax.length) {
    L.push("\nPERFORMANCE MAX ASSET GROUPS");
    for (const g of pmax) L.push(`- ${campName.get(g.cid) ?? "?"} › ${g.name} [${g.status}, ad strength ${g.strength || "?"}]: signals ${g.signals.join(", ") || "none"}${g.themes ? `, ${g.themes} search themes` : ""}`);
  }
  if (autoApply.length) L.push(`\nAUTO-APPLIED RECOMMENDATIONS: ${autoApply.map((r) => `${words(o(r.recommendationSubscription).type)} (${words(o(r.recommendationSubscription).status)})`).join(", ")}`);
  else if (ok("auto-apply")) L.push("\nAUTO-APPLIED RECOMMENDATIONS: none subscribed");
  if (unread.length) L.push(`\nCOULDN'T READ (don't assume these are missing): ${unread.join("; ")}`);
  return { text: L.join("\n"), facts: { platform: "google", facts }, unread };
}

function mergeCount(a: Map<string, string[]> | undefined, b: Map<string, string[]>) {
  const out = new Map(a ?? []);
  for (const [k, v] of b) out.set(k, [...(out.get(k) ?? []), ...v]);
  return out;
}
