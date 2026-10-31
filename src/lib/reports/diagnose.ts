import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { servicesOf, SERVICES, type ServiceSlug } from "@/lib/services";
import type { ReportMetrics } from "./metrics";

// What a report says about why the numbers are where they are, and when it's natural to mention another Kaizen
// service. Worked out from the data before the writer sees anything, so the writer explains, it doesn't guess.
//
// The weak link, in order:
// - creative: the click-through rate is under the industry's benchmark, or fell 20%+: we test new creative.
// - cost: cost per result is over target (or up 20%+). Why: ads wearing out (the fatigue watcher), new ads that were
//   tested and lost, or neither (the auction got pricier).
// - website: people click as well as before but fewer convert (conversion rate down 25%+, or under the benchmark):
//   the page is what needs work.
//
// The opportunity: at most one other service, only when the numbers make it the obvious next step, never in two reports
// in a row, never the same one twice in two months, and never pushed when the account itself is struggling (unless the
// service is the fix: a website upgrade when the site is the weak link, creative when the ads are).

export type Diagnosis = {
  weak: "creative" | "cost_fatigue" | "cost_testing" | "cost" | "website" | "none";
  healthy: boolean;
  ctr: { now: number | null; before: number | null; benchmark: number | null };
  cvr: { now: number | null; before: number | null; benchmark: number | null };
  cost: { now: number | null; before: number | null; target: number | null };
  fatigue: { tiring: number; tired: number };
  tests: { tried: number; beat: number };
  lines: string[];
};

export type Opportunity = { service: ServiceSlug; label: string; why: string; angle: string };

const pct = (a: number | null, b: number | null) => (a == null || b == null || !b ? null : (a - b) / b);
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function diagnose(admin: SupabaseClient, clientId: string, m: ReportMetrics): Promise<Diagnosis> {
  const [{ data: client }, { data: fatigue }] = await Promise.all([
    admin.from("clients").select("vertical_id, verticals(benchmarks)").eq("id", clientId).maybeSingle(),
    m.platform === "meta" ? admin.from("ad_fatigue").select("severity").eq("client_id", clientId).eq("state", "open") : Promise.resolve({ data: [] }),
  ]);
  const bench = ((client?.verticals as unknown as { benchmarks: { metric: string; good: number | null }[] } | null)?.benchmarks ?? []) as { metric: string; good: number | null }[];
  const benchOf = (k: string) => bench.find((b) => b.metric === k)?.good ?? null;

  // New ads tried in the period (Meta): their first spend inside it, enough to judge, against the period's cost
  let tried = 0;
  let beat = 0;
  if (m.platform === "meta" && m.main.costPerResult != null) {
    const { data: rows } = await admin
      .from("meta_ad_daily")
      .select("ad_id, date, metrics")
      .eq("client_id", clientId)
      .gte("date", new Date(Date.parse(`${m.main.start}T12:00:00Z`) - 21 * 86_400_000).toISOString().slice(0, 10))
      .lte("date", m.main.end)
      .limit(8000);
    const ads = new Map<string, { first: string; spend: number }>();
    for (const r of rows ?? []) {
      const spend = Number((r.metrics as { spend?: string }).spend) || 0;
      if (!spend) continue;
      const a = ads.get(r.ad_id) ?? { first: r.date, spend: 0 };
      if (r.date < a.first) a.first = r.date;
      a.spend += spend;
      ads.set(r.ad_id, a);
    }
    const fresh = [...ads.entries()].filter(([, a]) => a.first >= m.main.start && a.spend >= Math.max(30, (m.main.costPerResult ?? 0) * 1.5));
    tried = fresh.length;
    // Whether each new ad got its results cheaper than the period overall: from the report's own top ads where known
    const top = new Map(m.topAds.map((a) => [a.id, a]));
    beat = fresh.filter(([id]) => {
      const t = top.get(id);
      return t?.costPerResult != null && t.costPerResult <= (m.main.costPerResult ?? 0);
    }).length;
  }

  const ctrNow = m.main.ctr;
  const ctrBefore = m.compare.ctr;
  const cvrOf = (p: ReportMetrics["main"]) => (p.clicks ? r1((p.results / p.clicks) * 100) : null);
  const cvrNow = cvrOf(m.main);
  const cvrBefore = cvrOf(m.compare);
  const costNow = m.roasKpi ? m.main.roas : m.main.costPerResult;
  const costBefore = m.roasKpi ? m.compare.roas : m.compare.costPerResult;
  const target = m.target;
  const tiring = (fatigue ?? []).filter((f) => f.severity === "tiring").length;
  const tired = (fatigue ?? []).filter((f) => f.severity === "tired").length;

  const ctrLow = (ctrNow != null && benchOf("ctr") != null && ctrNow < benchOf("ctr")! * 0.85) || (pct(ctrNow, ctrBefore) ?? 0) <= -0.2;
  // Cost per result: worse than target, or 20% worse than before (for ROAS, lower is worse)
  const worse = (a: number | null, b: number | null) => (a == null || b == null ? false : m.roasKpi ? a < b * 0.85 : a > b * 1.15);
  const costHigh = worse(costNow, target) || (m.roasKpi ? (pct(costNow, costBefore) ?? 0) <= -0.2 : (pct(costNow, costBefore) ?? 0) >= 0.2);
  const cvrLow = (cvrNow != null && cvrBefore != null && cvrBefore > 0 && (pct(cvrNow, cvrBefore) ?? 0) <= -0.25 && m.main.clicks >= 50) || (cvrNow != null && benchOf("conversion_rate") != null && cvrNow < benchOf("conversion_rate")! * 0.7 && m.main.clicks >= 100);

  const weak: Diagnosis["weak"] = cvrLow && !ctrLow ? "website" : ctrLow ? "creative" : costHigh ? (tiring + tired >= 2 ? "cost_fatigue" : tried >= 2 && beat === 0 ? "cost_testing" : "cost") : "none";
  const healthy = !ctrLow && !costHigh && !cvrLow && m.main.results > 0;

  const money = (x: number | null) => (x == null ? "—" : m.roasKpi ? `${x}x` : `$${x.toFixed(2)}`);
  const lines = [
    `Click-through rate ${ctrNow ?? "—"}% (before ${ctrBefore ?? "—"}%${benchOf("ctr") != null ? `; industry benchmark ${benchOf("ctr")}%` : ""}).`,
    `Conversion rate from click to ${m.conversion.toLowerCase()} ${cvrNow ?? "—"}% (before ${cvrBefore ?? "—"}%${benchOf("conversion_rate") != null ? `; industry benchmark ${benchOf("conversion_rate")}%` : ""}).`,
    `${m.roasKpi ? "ROAS" : "Cost per result"} ${money(costNow)} (before ${money(costBefore)}${target != null ? `; target ${money(target)}` : ""}).`,
    ...(m.platform === "meta" ? [`Ads wearing out right now: ${tiring} tiring, ${tired} tired.`, `New ads tested in the period: ${tried}${tried ? `, ${beat} getting results cheaper than the account` : ""}.`] : []),
    {
      creative: "The weak link is the creative: people see the ads but click less than they should. Say so plainly, and that we're testing new creative (new hooks and angles) to lift it.",
      cost_fatigue: "The weak link is cost per result, and the cause is ads wearing out (the audience has seen them too often). Say so plainly, and that fresh versions of the best ads are coming in to replace the tired ones.",
      cost_testing: "The weak link is cost per result, and the cause is new ads we tested that didn't beat the ones already running. Say so plainly as part of testing (that's how the next winner is found), what we learned, and what we're testing next.",
      cost: "The weak link is cost per result, without the ads wearing out or tests losing: the auction got more expensive. Say so plainly, and the budget and targeting moves we're making.",
      website: "The weak link is after the click: people click as well as before, but fewer of them convert on the website. Say so plainly: the ads are doing their job, and the landing page is what's holding results back.",
      none: "Nothing is clearly weak: the account is healthy. Say what's working.",
    }[weak],
  ];
  return { weak, healthy, ctr: { now: ctrNow, before: ctrBefore, benchmark: benchOf("ctr") }, cvr: { now: cvrNow, before: cvrBefore, benchmark: benchOf("conversion_rate") }, cost: { now: costNow, before: costBefore, target }, fatigue: { tiring, tired }, tests: { tried, beat }, lines };
}

const DAY = 86_400_000;

/**
 * The one other service worth mentioning in this report, if any. The rules keep it rare and earned: not in two reports
 * in a row (monthly recaps have more room, weekly ones less), not the same service twice in two months, and only when the
 * numbers make it the natural next step.
 */
export async function opportunityFor(admin: SupabaseClient, r: { id: string; client_id: string; kind: string; platform: string; bundle_id?: string | null }, m: ReportMetrics, d: Diagnosis): Promise<Opportunity | null> {
  // A joint report (Meta and Google parts sent as one) raises at most one: the Meta part's
  if (r.bundle_id && r.platform === "google") {
    const { data: meta } = await admin.from("reports").select("id").eq("bundle_id", r.bundle_id).eq("platform", "meta").neq("id", r.id).limit(1);
    if (meta?.length) return null;
  }
  const [{ data: c }, { data: platforms }, { data: past }] = await Promise.all([
    admin.from("clients").select("industry, services, services_extra, services_removed, creative_package, meta_ad_account_id").eq("id", r.client_id).maybeSingle(),
    admin.from("kpi_targets").select("platform, conversion").eq("client_id", r.client_id).eq("active", true),
    admin.from("reports").select("id, created_at, metrics->opportunity").eq("client_id", r.client_id).neq("id", r.id).gte("created_at", new Date(Date.now() - 60 * DAY).toISOString()).neq("status", "skipped"),
  ]);
  if (!c) return null;
  // How often: a weekly report only if nothing was raised in the last 4 weeks; a monthly recap if not in the last 3
  const raised = ((past ?? []) as { created_at: string; opportunity: Opportunity | null }[]).filter((p) => p.opportunity);
  const quiet = r.kind === "monthly" ? 21 : 28;
  if (raised.some((p) => Date.now() - Date.parse(p.created_at) < quiet * DAY)) return null;
  const recently = new Set(raised.map((p) => p.opportunity!.service));

  const has = new Set<string>(servicesOf(c));
  for (const p of platforms ?? []) has.add(p.platform === "google" ? "google-ads" : "facebook-ads");
  if (c.meta_ad_account_id) has.add("facebook-ads");
  if (c.creative_package) has.add("creative");
  const off = (s: ServiceSlug) => !has.has(s) && !recently.has(s) && !(c.services_removed ?? []).includes(s);

  const commerce = c.industry === "ecommerce" || c.industry === "cpg" || m.roasKpi || /purchase/i.test(m.conversion);
  const hospitality = ["restaurant", "hospitality", "entertainment"].includes(c.industry ?? "");
  const leadGen = !commerce && !hospitality && /lead|application|booking|registration|contact|conversation/i.test(m.conversion);
  const label = (s: ServiceSlug) => SERVICES.find((x) => x.slug === s)!.label;
  const pick = (service: ServiceSlug, why: string, angle: string): Opportunity => ({ service, label: label(service), why, angle });

  // The service that fixes the weak link comes first, even when results are down
  if (d.weak === "website" && off("web-design")) return pick("web-design", `Clicks are holding but fewer convert on the site (conversion rate ${d.cvr.now}% vs ${d.cvr.before}% before).`, "The ads are bringing people in; a faster, clearer landing page is the quickest way to turn more of those clicks into results.");
  if ((d.weak === "creative" || d.weak === "cost_fatigue") && off("creative")) return pick("creative", d.weak === "creative" ? "Click-through rate is below where it should be." : "Ads are wearing out faster than they're replaced.", "More fresh creative each month keeps results steady instead of waiting for ads to tire.");

  // Growth ideas only when the account is doing well: there's something worth scaling
  if (!d.healthy) return null;
  if (has.has("facebook-ads") && off("google-ads")) return pick("google-ads", "Meta is converting well, and people who already want this are searching for it on Google.", "Google Ads would catch the people searching right now, and the two together retarget each other's visitors.");
  if (has.has("google-ads") && off("facebook-ads")) return pick("facebook-ads", "Google is converting well on the people already searching.", "Meta would reach the people not searching yet, and bring back visitors who didn't convert the first time.");
  if ((commerce || hospitality) && off("email-marketing")) return pick("email-marketing", commerce ? "New customers are coming in steadily from the ads." : "New guests are finding them through the ads.", commerce ? "Email turns those first orders into repeat orders, on customers they've already paid to get." : "Email brings guests back for the next visit, event or special without paying for the click again.");
  if (leadGen && off("crm")) return pick("crm", `${m.conversion} are coming in steadily.`, "A tighter follow-up (fast replies, reminders, nurturing) turns more of those leads into customers.");
  if (off("social-media") && (hospitality || commerce)) return pick("social-media", "The ads are working and people are looking them up.", "An active, consistent social presence makes the ads land better, since that's what people check before buying or booking.");
  return null;
}

/** The diagnosis and the opportunity, as the writer and the QA read them. */
export function diagnosisText(d: Diagnosis | undefined, o: Opportunity | null | undefined) {
  if (!d) return "";
  return [
    `<diagnosis>\n${d.lines.map((l) => `- ${l}`).join("\n")}\n</diagnosis>`,
    o
      ? `<opportunity service="${o.label}">\nWhy now: ${o.why}\nThe idea: ${o.angle}\n</opportunity>`
      : "<opportunity>none: don't suggest any other service in this report</opportunity>",
  ].join("\n\n");
}
