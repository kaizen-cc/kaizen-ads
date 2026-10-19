import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { aggregate, pickType, type Day } from "@/lib/kpi/calc";
import { conversionFor, conversionLabel, type Conversion } from "@/lib/kpi/conversions";
import { accountSetup, metaConfigured, syncClientAds, type AccountSetup } from "@/lib/context/meta";
import type { Benchmark } from "@/lib/verticals";

// The account audit: one ad account (a KPI target) scrubbed the way a senior media buyer would, against its target,
// its own last 90 days, its live setup in Meta, the client's full context (Brand Bible, strategy, memory, calls), what
// wins in its sub-vertical (playbook, Hall of Fame), the researched benchmarks and the market. It explains why it's
// where it is and writes the plan: what the buyer changes, what to test, what creative to make, what to ask the client.

const DAY = 86_400_000;
const AREAS = ["creative", "audience", "offer", "funnel", "landing_page", "structure", "budget", "bidding", "tracking", "seasonality"] as const;
export type Area = (typeof AREAS)[number];

export type AuditResult = {
  verdict: { status: "off" | "at_risk" | "on_track" | "winning"; headline: string; summary: string };
  /** What I found: why the account is where it is */
  diagnosis: string;
  causes: { title: string; area: Area; severity: "high" | "medium" | "low"; confidence: "high" | "medium" | "low"; evidence: string[] }[];
  tracking: string[];
  /** What I'd do if I were you */
  actions: { title: string; area: Area; owner: "media_buyer" | "creative" | "client" | "strategist"; when: "now" | "this_week" | "next"; steps: string[]; why: string; impact: string; effort: "low" | "medium" | "high" }[];
  tests: { name: string; hypothesis: string; setup: string; metric: string; success: string; budget: string; duration: string }[];
  creative: { concept: string; angle: string; hook: string; format: string; why: string }[];
  budget: { call: string; moves: string[] };
  /** What I'd watch out for */
  watchouts?: { title: string; why: string }[];
  watch: string[];
  questions: string[];
  /** Lessons this audit added to the client page */
  learnings?: { kind: "avoid" | "prefer" | "note"; body: string; resurfaced: boolean }[];
};

/** One milestone of the audit, as it really happens. */
export type AuditStep = { key: string; label: string; status: "pending" | "running" | "done" | "skipped" | "failed"; detail: string | null; startedAt: string | null; finishedAt: string | null };

const S = { type: "string" } as const;
const list = (items: object) => ({ type: "array", items }) as const;
const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const;
const AREA = { type: "string", enum: [...AREAS] } as const;

const FOUND_SCHEMA = obj({
  verdict: obj({ status: { type: "string", enum: ["off", "at_risk", "on_track", "winning"] }, headline: S, summary: S }),
  diagnosis: S,
  causes: list(obj({ title: S, area: AREA, severity: { type: "string", enum: ["high", "medium", "low"] }, confidence: { type: "string", enum: ["high", "medium", "low"] }, evidence: list(S) })),
  tracking: list(S),
  learnings: list(obj({ kind: { type: "string", enum: ["avoid", "prefer", "note"] }, body: S, resurfaced: { type: "boolean" } })),
});
const PLAN_SCHEMA = obj({
  actions: list(
    obj({
      title: S,
      area: AREA,
      owner: { type: "string", enum: ["media_buyer", "creative", "client", "strategist"] },
      when: { type: "string", enum: ["now", "this_week", "next"] },
      steps: list(S),
      why: S,
      impact: S,
      effort: { type: "string", enum: ["low", "medium", "high"] },
    }),
  ),
  tests: list(obj({ name: S, hypothesis: S, setup: S, metric: S, success: S, budget: S, duration: S })),
  creative: list(obj({ concept: S, angle: S, hook: S, format: S, why: S })),
  budget: obj({ call: S, moves: list(S) }),
  watchouts: list(obj({ title: S, why: S })),
  watch: list(S),
  questions: list(S),
});

const BASE = `You are Kaizen Marketing's head of paid media, auditing one Meta ad account for the media buyer who runs it. This is a real audit of the account, not a creative brainstorm, and the buyer acts on it today. Speak to the buyer directly, in the first person ("I found", "I'd"), plain and specific.
Read everything given: the target and how far off it is, 90 days of numbers by campaign, ad set and ad, the funnel, the live setup (objectives, optimization events, budgets, bidding, learning phase, audiences, placements, attribution) and its splits, the tiring ads, the client page (Brand Bible, go-to-market strategy, intake, calls, memory, what's in production), the sub-vertical playbook and benchmarks, our Hall of Fame and the market.
Argue from this account's data, using Meta best practice as of today. Respect the client's rules (what they told us to avoid, claims never to make, special ad categories). If the data is too thin to judge something, say so instead of guessing. Refer to people by role, never by name. No em dashes.`;

const FOUND_SYSTEM = `${BASE}

This pass is "Here's what I found": why the account is where it is against its KPI target.
verdict: status (off: well outside target; at_risk: close or sliding; on_track; winning), a headline in one line ("Cost per purchase doubled when two winning ads tired and nothing replaced them"), and a 2 or 3 sentence summary.
diagnosis: 2 to 4 short paragraphs, first person, on why the metrics aren't hitting the KPI (or why they are). Separate cause from symptom. Use the numbers. Say what changed and when.
causes: the root causes, most important first: area, severity, how confident you are (low when the data is thin), and evidence lines with real numbers and the names of campaigns, ad sets or ads.
tracking: anything that looks like a tracking or attribution problem (results that don't add up, a pixel event missing, attribution windows mixed). Empty if none.
learnings: 2 to 4 lasting lessons about this account for the client page, so the team and every agent remember them next time: what keeps going wrong (kind avoid), what works for this account (kind prefer), or a fact to keep in mind (kind note). Each one sentence, written as a rule that will still be true in a month ("Prevention angles haven't converted for this account; keep budget on treatment-urgency creative"), never this week's numbers. Read the client memory you were given first: don't repeat a lesson that's already there. If a problem it already warns about has happened again, write it again with resurfaced true and say it came back ("Resurfaced: …").`;

const PLAN_SYSTEM = `${BASE}

This pass is "Here's what I'd do if I were you" and "what I'd watch out for", built on the findings you're given.
actions: 5 to 10 concrete moves, most important first, specific enough to do without asking: which campaign or ad set, what to change it to, what to turn off, how much budget to move. owner: media_buyer, creative (the creative team), client (only the client can fix it: offer, site, stock, tracking access) or strategist. when: now (today), this_week or next. steps as short imperative lines. why with the evidence. impact: what it should move and roughly how much. Never vague ("optimize targeting"): name the thing.
tests: 2 to 4 tests: hypothesis, setup in Meta, the metric, what success looks like with a number, a budget and duration that can read out at this account's spend.
creative: 2 to 4 creative directions only if creative is part of the problem, built from the playbook's proven angles, our Hall of Fame and the Brand Bible (never copy a competitor). Empty otherwise.
budget: the call on budget and pacing (hold, cut, scale, reallocate) and the specific moves.
watchouts: 3 to 6 things I'd watch out for in these results and in making these changes: what could mislead us (a small sample, a one-off spike, attribution lag, a promo ending), what the changes could break (resetting learning, starving a winner), and what to check before reading a result. Each with why.
watch: the 3 to 5 numbers to watch over the next 7 days, each with the line that says it's working.
questions: what to ask the client that would change the plan.`;

type Row = { date: string; ad_id: string; ad_name: string | null; adset_id: string | null; adset_name: string | null; campaign_id: string | null; campaign_name: string | null; metrics: Record<string, unknown> };
const n = (v: unknown) => Number(v) || 0;
const acts = (v: unknown) => Object.fromEntries(((v ?? []) as { action_type: string; value: string }[]).map((a) => [a.action_type, n(a.value)]));
const r2 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a: number, b: number) => (b ? r2((a / b) * 100) : null);

/** Everything worth knowing about a set of rows: the KPI plus the diagnostics around it. */
function stats(rows: Row[], conv: Conversion, type: string | null) {
  const days: Day[] = rows.map((r) => ({ date: r.date, spend: n(r.metrics.spend), actions: acts(r.metrics.actions), values: acts(r.metrics.action_values), linkClicks: n(r.metrics.inline_link_clicks) }));
  const agg = aggregate(days, conv, type);
  let impressions = 0;
  let clicks = 0;
  let plays = 0;
  let thru = 0;
  let freqW = 0;
  const funnel: Record<string, number> = {};
  for (const r of rows) {
    const imp = n(r.metrics.impressions);
    impressions += imp;
    clicks += n(r.metrics.inline_link_clicks);
    plays += n(((r.metrics.video_play_actions ?? []) as { value: string }[])[0]?.value);
    thru += n(((r.metrics.video_thruplay_watched_actions ?? []) as { value: string }[])[0]?.value);
    freqW += n(r.metrics.frequency) * imp;
    const a = acts(r.metrics.actions);
    for (const k of ["landing_page_view", "omni_add_to_cart", "add_to_cart", "omni_initiated_checkout", "initiate_checkout", "lead", "onsite_conversion.lead_grouped"]) if (a[k]) funnel[k] = (funnel[k] ?? 0) + a[k];
  }
  const lpv = funnel.landing_page_view ?? 0;
  return {
    spend: agg.spend,
    results: agg.results,
    value: agg.value,
    ctr: pct(clicks, impressions),
    cpm: impressions ? r2((agg.spend / impressions) * 1000) : null,
    cpc: clicks ? r2(agg.spend / clicks) : null,
    clickToResult: pct(agg.results, clicks),
    lpvRate: pct(lpv, clicks),
    hookRate: plays ? pct(plays, impressions) : null,
    holdRate: plays ? pct(thru, plays) : null,
    freq: impressions ? r2(freqW / impressions) : null,
    funnel: { linkClicks: clicks, landingPageViews: lpv, addToCart: funnel.omni_add_to_cart ?? funnel.add_to_cart ?? 0, checkout: funnel.omni_initiated_checkout ?? funnel.initiate_checkout ?? 0 },
  };
}
type Stats = ReturnType<typeof stats>;

function line(name: string, s: Stats, roas: boolean, extra = "") {
  const kpi = s.value == null ? "no results" : roas ? `${s.value}x ROAS` : `$${s.value} per result`;
  return `${name}: $${Math.round(s.spend)} spend, ${s.results} results, ${kpi}, CTR ${s.ctr ?? "?"}%, CPM $${s.cpm ?? "?"}, CPC $${s.cpc ?? "?"}, click→result ${s.clickToResult ?? "?"}%${s.hookRate != null ? `, hook ${s.hookRate}%, hold ${s.holdRate}%` : ""}${s.freq ? `, freq ~${s.freq}` : ""}${extra}`;
}

/** The account in numbers, written for the auditor. */
function digest(rows: Row[], conv: Conversion, type: string | null, today: string) {
  const roas = Boolean(conv.roas);
  const since = (d: number) => new Date(Date.parse(today) - d * DAY).toISOString().slice(0, 10);
  const inRange = (from: number, to: number) => rows.filter((r) => r.date > since(from) && r.date <= since(to));
  const last14 = inRange(14, 0);
  const prev14 = inRange(28, 14);
  const last30 = inRange(30, 0);
  const prev30 = inRange(60, 30);
  const last90 = inRange(90, 0);
  const out: string[] = [];
  out.push("ACCOUNT");
  out.push(line("Last 14 days", stats(last14, conv, type), roas));
  out.push(line("The 14 before", stats(prev14, conv, type), roas));
  out.push(line("Last 30 days", stats(last30, conv, type), roas));
  out.push(line("The 30 before", stats(prev30, conv, type), roas));
  out.push(line("Last 90 days", stats(last90, conv, type), roas));
  const f = stats(last30, conv, type).funnel;
  out.push(`Funnel, last 30 days: ${f.linkClicks} link clicks → ${f.landingPageViews} landing page views → ${f.addToCart} adds to cart → ${f.checkout} checkouts → ${stats(last30, conv, type).results} results`);

  // Week by week, to see when it turned
  out.push("\nWEEK BY WEEK (newest first)");
  for (let w = 0; w < 12; w++) {
    const wk = inRange((w + 1) * 7, w * 7);
    if (!wk.length) continue;
    out.push(line(`Week ending ${since(w * 7)}`, stats(wk, conv, type), roas));
  }

  const group = (rs: Row[], key: (r: Row) => string | null) => {
    const m = new Map<string, Row[]>();
    for (const r of rs) {
      const k = key(r);
      if (k) m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const total30 = stats(last30, conv, type).spend || 1;

  out.push("\nCAMPAIGNS, last 30 days vs the 30 before");
  const prevCamp = group(prev30, (r) => r.campaign_name);
  for (const [name, rs] of [...group(last30, (r) => r.campaign_name)].sort((a, b) => stats(b[1], conv, type).spend - stats(a[1], conv, type).spend).slice(0, 15)) {
    const s = stats(rs, conv, type);
    const p = prevCamp.get(name);
    out.push(line(name, s, roas, ` · ${Math.round((s.spend / total30) * 100)}% of spend${p ? ` · before: ${stats(p, conv, type).value ?? "no results"}` : " · new"}`));
  }

  out.push("\nAD SETS, last 30 days");
  for (const [name, rs] of [...group(last30, (r) => (r.adset_name ? `${r.campaign_name} › ${r.adset_name}` : null))].sort((a, b) => stats(b[1], conv, type).spend - stats(a[1], conv, type).spend).slice(0, 20)) {
    const s = stats(rs, conv, type);
    out.push(line(name, s, roas, ` · ${Math.round((s.spend / total30) * 100)}% of spend`));
  }

  // Ads: age, share, and whether they're carrying or dragging
  const firstSeen = new Map<string, string>();
  for (const r of rows) if (n(r.metrics.spend) > 0 && (!firstSeen.has(r.ad_id) || r.date < firstSeen.get(r.ad_id)!)) firstSeen.set(r.ad_id, r.date);
  const ads = [...group(last30, (r) => r.ad_id)].map(([id, rs]) => ({ id, name: rs[rs.length - 1].ad_name ?? id, s: stats(rs, conv, type), s14: stats(rs.filter((r) => r.date > since(14)), conv, type), age: Math.round((Date.parse(today) - Date.parse(firstSeen.get(id) ?? today)) / DAY) }));
  ads.sort((a, b) => b.s.spend - a.s.spend);
  const top3 = ads.slice(0, 3).reduce((x, a) => x + a.s.spend, 0);
  out.push(`\nADS, last 30 days: ${ads.filter((a) => a.s.spend > 0).length} ads spent; the top 3 took ${Math.round((top3 / total30) * 100)}% of spend; ${ads.filter((a) => a.age <= 30).length} launched in the last 30 days`);
  for (const a of ads.slice(0, 30)) out.push(line(`${a.name} (${a.age} days old)`, a.s, roas, ` · ${Math.round((a.s.spend / total30) * 100)}% of spend · last 14: ${a.s14.value ?? "no results"}`));
  const burners = ads.filter((a) => a.s.results === 0 && a.s.spend > 0).sort((a, b) => b.s.spend - a.s.spend).slice(0, 8);
  if (burners.length) out.push(`Spent with no results: ${burners.map((a) => `${a.name} $${Math.round(a.s.spend)}`).join("; ")}`);
  const fresh = ads.filter((a) => a.age <= 30);
  const old = ads.filter((a) => a.age > 30);
  if (fresh.length && old.length) out.push(line("New ads (≤30 days) together", stats(last30.filter((r) => fresh.some((a) => a.id === r.ad_id)), conv, type), roas) + " | " + line("Older ads together", stats(last30.filter((r) => old.some((a) => a.id === r.ad_id)), conv, type), roas));

  return { text: out.join("\n"), ads: ads.length, days: new Set(rows.map((r) => r.date)).size, last14: stats(last14, conv, type), prev14: stats(prev14, conv, type) };
}

function setupText(s: AccountSetup | null) {
  if (!s) return "Live setup: couldn't read it from Meta.";
  const camp = new Map(s.campaigns.map((c) => [c.id, c]));
  const brk = (rows: Record<string, unknown>[], key: (r: Record<string, unknown>) => string) =>
    rows
      .map((r) => ({ k: key(r), spend: n(r.spend), ctr: r.ctr, cpm: r.cpm }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 12)
      .map((r) => `${r.k} $${Math.round(r.spend)} (CTR ${n(r.ctr).toFixed(2)}%, CPM $${n(r.cpm).toFixed(2)})`)
      .join("; ");
  return `LIVE SETUP IN META${s.account ? ` (${s.account.name}, ${s.account.currency}, ${s.account.status}${s.account.spendCap ? `, spend cap ${s.account.spendCap}` : ""})` : ""}
Campaigns:
${s.campaigns.map((c) => `- ${c.name} [${c.status}] ${c.objective}${c.cbo ? `, campaign budget ${c.dailyBudget ? `$${c.dailyBudget}/day` : `$${c.lifetimeBudget} lifetime`}` : ", ad set budgets"}${c.bidStrategy ? `, ${c.bidStrategy}` : ""}${c.specialCategories.length ? `, special category ${c.specialCategories.join("/")}` : ""}, since ${c.created}`).join("\n") || "(none live)"}
Ad sets:
${
  s.adsets
    .map((a) => {
      const au = a.audience;
      return `- ${camp.get(a.campaignId)?.name ?? "?"} › ${a.name} [${a.status}] optimizes for ${a.optimization}${a.event ? ` (${a.event})` : ""}${a.dailyBudget ? `, $${a.dailyBudget}/day` : ""}${a.bidStrategy ? `, ${a.bidStrategy}${a.bidAmount ? ` $${a.bidAmount}` : ""}` : ""}${a.learning ? `, learning: ${a.learning}` : ""}${a.attribution ? `, attribution ${a.attribution}` : ""}${au ? ` · audience: ${au.ages} ${au.genders}, ${au.geo || "?"}${au.advantage ? ", Advantage+ audience" : ""}${au.custom.length ? `, custom: ${au.custom.join(", ")}` : ""}${au.excluded.length ? `, excluding: ${au.excluded.join(", ")}` : ""}${au.interests.length ? `, interests: ${au.interests.join(", ")}` : ""}, placements ${au.placements}` : ""}`;
    })
    .join("\n") || "(none live)"
}
Placements, last 30 days: ${brk(s.placements, (r) => `${r.publisher_platform}/${r.platform_position}`) || "?"}
Age and gender, last 30 days: ${brk(s.demo, (r) => `${r.gender} ${r.age}`) || "?"}
Countries, last 30 days: ${brk(s.countries, (r) => String(r.country)) || "?"}`;
}

const STEPS: { key: string; label: string; weight: number }[] = [
  { key: "numbers", label: "Reading 90 days of the ad account", weight: 6 },
  { key: "setup", label: "Checking the live setup in Meta", weight: 6 },
  { key: "client", label: "Reading the client page", weight: 4 },
  { key: "fatigue", label: "Checking for tiring ads", weight: 2 },
  { key: "vertical", label: "Comparing with the sub-vertical, our winners and the market", weight: 4 },
  { key: "found", label: "Working out why it's where it is", weight: 40 },
  { key: "plan", label: "Writing what I'd do and what to watch out for", weight: 38 },
];

/** Keeps the audit's steps and progress in step with what it's really doing, for the card to follow. */
function milestones(admin: SupabaseClient, id: string) {
  const steps: AuditStep[] = STEPS.map((s) => ({ key: s.key, label: s.label, status: "pending", detail: null, startedAt: null, finishedAt: null }));
  let partial = 0; // how far through the running step (0 to 1), for the long AI steps
  const pct = () => {
    const total = STEPS.reduce((t, s) => t + s.weight, 0);
    const done = steps.reduce((t, s, i) => t + (s.status === "done" || s.status === "skipped" ? STEPS[i].weight : s.status === "running" ? STEPS[i].weight * partial : 0), 0);
    return Math.max(2, Math.min(99, Math.round((done / total) * 100)));
  };
  const save = () => admin.from("account_audits").update({ steps, progress: pct(), step: steps.find((s) => s.status === "running")?.label ?? null }).eq("id", id);
  return {
    async start(key: string) {
      const s = steps.find((x) => x.key === key)!;
      s.status = "running";
      s.startedAt = new Date().toISOString();
      partial = 0;
      await save();
    },
    async finish(key: string, detail: string | null, status: AuditStep["status"] = "done") {
      const s = steps.find((x) => x.key === key)!;
      Object.assign(s, { status, detail, finishedAt: new Date().toISOString() });
      partial = 0;
      await save();
    },
    /** Progress inside a running AI step, from what it has written. */
    async inside(p: number) {
      partial = Math.max(partial, Math.min(0.95, p));
      await save();
    },
    async failRunning(message: string) {
      const s = steps.find((x) => x.status === "running");
      if (s) Object.assign(s, { status: "failed", detail: message, finishedAt: new Date().toISOString() });
      await admin.from("account_audits").update({ steps }).eq("id", id);
    },
  };
}

const n0 = (x: number) => Math.round(x).toLocaleString("en-US");
const ago = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = Math.round((Date.now() - Date.parse(iso)) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** Runs one audit (the row is created by the button); the card follows its steps. */
export async function runAudit(admin: SupabaseClient, id: string) {
  const { data: a } = await admin.from("account_audits").select("id, target_id, client_id").eq("id", id).single();
  if (!a) return;
  const m = milestones(admin, id);
  try {
    const { data: t } = await admin.from("kpi_targets").select("ad_account_id, conversion, custom_action, campaign_match, target, monthly_budget, budget_note, sheet").eq("id", a.target_id).single();
    if (!t?.ad_account_id) throw new Error("No ad account on this KPI");
    const conv = conversionFor(t.conversion);
    const account = String(t.ad_account_id).replace(/^act_/, "");

    // 1. The numbers
    await m.start("numbers");
    const since = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
    const readRows = async () => {
      const out: Row[] = [];
      for (let page = 0; page < 40; page++) {
        const { data } = await admin
          .from("meta_ad_daily")
          .select("date, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name, metrics")
          .eq("client_id", a.client_id)
          .eq("ad_account_id", account)
          .gte("date", since)
          .order("date")
          .range(page * 1000, page * 1000 + 999);
        out.push(...((data ?? []) as Row[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    };
    let rows = await readRows();
    // The scheduled Meta ads sync hasn't reached this account yet: pull its ads now rather than fail
    if (!rows.length && metaConfigured()) {
      await m.inside(0.1);
      await admin.from("account_audits").update({ step: "Pulling this account's ads from Meta for the first time (a minute or two)" }).eq("id", id);
      await syncClientAds(admin, a.client_id, account).catch((e) => {
        throw new Error(`Couldn't pull this account's ads from Meta: ${e instanceof Error ? e.message : e}`);
      });
      rows = await readRows();
    }
    const scoped = t.campaign_match ? rows.filter((r) => (r.campaign_name ?? "").toLowerCase().includes(String(t.campaign_match).toLowerCase())) : rows;
    if (!scoped.length)
      throw new Error(
        rows.length
          ? `No ads in campaigns containing "${t.campaign_match}" in the last 90 days. Check "Only campaigns containing" on this KPI.`
          : "Meta returned no ads for this account in the last 90 days. Check the ad account ID on this KPI and that it's shared with Kaizen's system user.",
      );
    const days: Day[] = scoped.map((r) => ({ date: r.date, spend: n(r.metrics.spend), actions: acts(r.metrics.actions), values: acts(r.metrics.action_values) }));
    const type = pickType(days, conv, t.custom_action);
    const today = scoped[scoped.length - 1].date;
    const d = digest(scoped, conv, type, today);
    const spend90 = scoped.reduce((x, r) => x + n(r.metrics.spend), 0);
    await m.finish("numbers", `${d.days} days · ${new Set(scoped.map((r) => r.campaign_id)).size} campaigns · ${new Set(scoped.map((r) => r.adset_id)).size} ad sets · ${d.ads} ads · $${n0(spend90)} spent`);

    // 2. The live setup
    await m.start("setup");
    const setup = metaConfigured() ? await accountSetup(account).catch(() => null) : null;
    if (setup) {
      const learning = setup.adsets.filter((x) => x.learning && x.learning !== "SUCCESS").length;
      await m.finish("setup", `${setup.campaigns.length} campaigns and ${setup.adsets.length} ad sets live or paused${learning ? ` · ${learning} still learning` : ""} · placements, age, gender and country splits`);
    } else await m.finish("setup", "Couldn't read the live setup from Meta; working from the numbers", "skipped");

    // 3. The client page
    await m.start("client");
    const [ctx, { data: client }, { data: bible }, { data: gtm }, { count: intakes }, { count: calls }, { count: memory }, { data: briefing }, { count: open }] = await Promise.all([
      clientContext(admin, a.client_id),
      admin.from("clients").select("name, industry, industry_detail, vertical_id").eq("id", a.client_id).single(),
      admin.from("client_brand_bibles").select("status, version").eq("client_id", a.client_id).maybeSingle(),
      admin.from("client_gtm_strategies").select("status, version").eq("client_id", a.client_id).maybeSingle(),
      admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", a.client_id).not("summary", "is", null),
      admin.from("call_mentions").select("id", { count: "exact", head: true }).eq("client_id", a.client_id),
      admin.from("client_memory").select("id", { count: "exact", head: true }).eq("client_id", a.client_id).eq("status", "active"),
      admin.from("client_briefings").select("generated_at").eq("client_id", a.client_id).maybeSingle(),
      admin.from("board_requests").select("id", { count: "exact", head: true }).eq("client_id", a.client_id).neq("stage", "launched"),
    ]);
    if (!ctx || !client) throw new Error("Client not found");
    const read = [
      bible ? `Brand Bible ${bible.version ?? ""} (${bible.status})`.replace("  ", " ") : "no Brand Bible yet",
      gtm?.status && gtm.status !== "waiting" ? `go-to-market strategy ${gtm.version ?? ""} (${gtm.status})`.replace("  ", " ") : "no go-to-market strategy yet",
      intakes ? "intake form" : "no intake form",
      `${calls ?? 0} call ${calls === 1 ? "note" : "notes"}`,
      `${memory ?? 0} client memory ${memory === 1 ? "rule" : "rules"}`,
      briefing?.generated_at ? `briefing from ${ago(briefing.generated_at)}` : "no briefing yet",
      `${open ?? 0} requests in progress`,
    ];
    await m.finish("client", read.join(" · "));

    // 4. Tiring ads
    await m.start("fatigue");
    const { data: fatigue } = await admin.from("ad_fatigue").select("ad_name, severity, signals").eq("client_id", a.client_id).in("state", ["open", "refreshing"]).limit(15);
    await m.finish("fatigue", fatigue?.length ? `${fatigue.length} ${fatigue.length === 1 ? "ad" : "ads"} flagged as tiring` : "No ads flagged as tiring");

    // 5. The sub-vertical
    await m.start("vertical");
    const [{ playbookBlock }, { marketBlock }, { industryWinners, winnersBlock }] = await Promise.all([import("@/lib/playbooks"), import("@/lib/market"), import("@/lib/industry")]);
    const [playbook, market, winners, { data: sub }, { data: fame }] = await Promise.all([
      playbookBlock(admin, a.client_id).catch(() => ""),
      marketBlock(admin, a.client_id, client.industry ?? null, 8).catch(() => ""),
      client.industry && client.industry !== "other" ? industryWinners(admin, client.industry, a.client_id, 8).catch(() => []) : Promise.resolve([]),
      client.vertical_id ? admin.from("verticals").select("name, benchmarks").eq("id", client.vertical_id).maybeSingle() : Promise.resolve({ data: null }),
      client.vertical_id
        ? admin.from("hall_of_fame").select("creative, value, target, roas, conversion, days_live, client_id").eq("vertical_id", client.vertical_id).gt("expires_at", new Date().toISOString()).order("beat_by", { ascending: false }).limit(10)
        : Promise.resolve({ data: [] }),
    ]);
    const benchmarks = (sub?.benchmarks ?? []) as Benchmark[];
    const bm = benchmarks.map((b) => `${b.metric}: good ${b.good ?? "?"}${b.unit}, great ${b.great ?? "?"}${b.unit} (${b.source} ${b.year})`).join("; ");
    const marketCount = (market.match(/\n- /g) ?? []).length;
    await m.finish(
      "vertical",
      [
        sub?.name ? `${sub.name}` : "not placed in a sub-vertical yet",
        playbook ? "playbook" : "no playbook yet",
        benchmarks.length ? `${benchmarks.length} benchmarks` : "no benchmarks yet",
        `${fame?.length ?? 0} Hall of Fame ads`,
        `${winners.length} winners from similar clients`,
        market ? `${marketCount || "some"} market ads` : "no market ads matched",
      ].join(" · "),
    );

    const label = conversionLabel(t.conversion, t.custom_action);
    const target = t.target == null ? null : Number(t.target);
    const roas = Boolean(conv.roas);
    const gap = target && d.last14.value != null ? Math.round(((roas ? (target - d.last14.value) / target : (d.last14.value - target) / target) || 0) * 100) : null;
    const context = `${contextBlock(ctx)}

<target>
${client.name}: ${label}. Target: ${target == null ? "not set" : roas ? `${target}x ROAS` : `$${target} per result`}. Last 14 days: ${d.last14.value == null ? "no results" : roas ? `${d.last14.value}x` : `$${d.last14.value}`} (${gap == null ? "?" : gap > 0 ? `${gap}% worse than target` : `${-gap}% better than target`}); the 14 days before: ${d.prev14.value ?? "no results"}.
Monthly budget: ${t.monthly_budget ? `$${t.monthly_budget}` : "not set"}${t.budget_note ? ` (${t.budget_note})` : ""}.${t.campaign_match ? ` Only campaigns containing "${t.campaign_match}" count toward this KPI.` : ""} Results are counted as Meta's "${type ?? "?"}".
</target>

<account_numbers>
${d.text}
</account_numbers>
${t.sheet ? `
<team_notes source="the Account Overview sheet the buyers keep">
${Object.entries(t.sheet as Record<string, string>).filter(([k, v]) => v && !["name", "platform", "syncedAt"].includes(k)).map(([k, v]) => `${k}: ${v}`).join("\n")}
</team_notes>
` : ""}

<live_setup>
${setupText(setup)}
</live_setup>

<ads_tiring source="our fatigue watcher">
${(fatigue ?? []).map((f) => `- ${f.ad_name}: ${f.severity}, ${JSON.stringify(f.signals).slice(0, 300)}`).join("\n") || "(none flagged)"}
</ads_tiring>

<benchmarks sub_vertical="${sub?.name ?? "not placed"}">
${bm || "(not researched yet)"}
</benchmarks>
${playbook ? `\n${playbook}\n` : ""}
<our_hall_of_fame_in_this_sub_vertical>
${(fame ?? []).map((f) => `- ${f.client_id === a.client_id ? "THIS CLIENT: " : ""}"${(f.creative as { headline?: string } | null)?.headline ?? ""}" ${(((f.creative as { text?: string } | null)?.text ?? "") as string).slice(0, 160)} · ${f.roas ? `${f.value}x vs ${f.target}x` : `$${f.value} vs $${f.target}`} over ${f.days_live} days`).join("\n") || "(none yet)"}
</our_hall_of_fame_in_this_sub_vertical>

${winners.length ? winnersBlock(client.industry, client.industry_detail, winners) : ""}
${market ? `\n${market}\n` : ""}
Today is ${new Date().toISOString().slice(0, 10)}.`;

    // 6. What I found
    await m.start("found");
    let last = 0;
    const found = await askJson<Pick<AuditResult, "verdict" | "diagnosis" | "causes" | "tracking"> & { learnings: { kind: "avoid" | "prefer" | "note"; body: string; resurfaced: boolean }[] }>({
      agent: "auditor",
      label: `audit ${client.name} · findings`,
      system: FOUND_SYSTEM,
      schema: FOUND_SCHEMA,
      maxTokens: 32000,
      onText: (so) => {
        if (Date.now() - last < 4000) return;
        last = Date.now();
        void m.inside(so.length / 6000);
      },
      prompt: `${context}\n\nAudit ${client.name}'s account: here's what you found.`,
    });
    await m.finish("found", found.verdict.headline);
    // The learning loop: what this audit taught us goes into client memory, which every agent reads from now on
    const lessons = (found.learnings ?? []).filter((l) => l.body.trim());
    if (lessons.length) {
      const { data: run } = await admin.from("account_audits").select("created_by").eq("id", id).single();
      const { data: saved } = await admin.from("client_memory").insert(
        lessons.map((l) => ({
          client_id: a.client_id,
          kind: l.kind,
          source: "audit",
          created_by: run?.created_by ?? null,
          body: `${l.resurfaced && !/^resurfaced/i.test(l.body) ? "Resurfaced: " : ""}${l.body}`.replace(/\s*—\s*/g, ", ").slice(0, 1000),
        })),
      ).select("id, kind");
      // What worked here may help truly similar clients (same sub-vertical, then a strict check); never what to avoid
      const works = (saved ?? []).filter((x) => x.kind === "prefer").map((x) => x.id as string);
      if (works.length) {
        const { shareLessons } = await import("@/lib/lesson-sharing");
        await shareLessons(admin, works);
      }
    }

    // 7. What I'd do, and what to watch out for
    await m.start("plan");
    last = 0;
    const plan = await askJson<Omit<AuditResult, "verdict" | "diagnosis" | "causes" | "tracking">>({
      agent: "auditor",
      label: `audit ${client.name} · plan`,
      system: PLAN_SYSTEM,
      schema: PLAN_SCHEMA,
      maxTokens: 32000,
      onText: (so) => {
        if (Date.now() - last < 4000) return;
        last = Date.now();
        void m.inside(so.length / 9000);
      },
      prompt: `${context}

<what_you_found>
${JSON.stringify(found)}
</what_you_found>

Now write what you'd do if you were the buyer, and what you'd watch out for.`,
    });
    await m.finish("plan", `${plan.actions.length} actions · ${plan.tests.length} tests · ${plan.watchouts?.length ?? 0} things to watch out for`);

    const clean = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(/\s*—\s*/g, ", "));
    await admin
      .from("account_audits")
      .update({
        status: "ready",
        step: null,
        progress: 100,
        result: clean({ ...found, ...plan, learnings: lessons }),
        inputs: { days: d.days, ads: d.ads, campaigns: setup?.campaigns.length ?? null, adsets: setup?.adsets.length ?? null, fatigue: fatigue?.length ?? 0, hallOfFame: fame?.length ?? 0, playbook: Boolean(playbook), market: Boolean(market), benchmarks: Boolean(bm), liveSetup: Boolean(setup) },
        finished_at: new Date().toISOString(),
      })
      .eq("id", id);
    // The plan becomes a sprint the system follows with the buyer
    const { openSprint } = await import("@/lib/sprints");
    await openSprint(admin, id).catch((e) => console.error("[audit] couldn't open the sprint:", e instanceof Error ? e.message : e));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await m.failRunning(message);
    await admin.from("account_audits").update({ status: "failed", error: message, finished_at: new Date().toISOString() }).eq("id", id);
  }
}
