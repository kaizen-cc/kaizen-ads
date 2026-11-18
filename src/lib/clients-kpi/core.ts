import { checkText } from "@/lib/email-score-calc";
import { socialCheckText, type SocialCheck } from "@/lib/social-score";
import type { EmailCheck } from "@/lib/email-score";
import { conversionValue } from "@/lib/kpi/conversion-value";
import { kpiValue, money } from "@/lib/kpi/format";
import type { Status } from "@/lib/kpi/calc";

// The KPI row on the Clients list: one compact metric per service line that has a KPI, coloured by the same status
// the KPI boards use, a cross-line criticality score to order the list for a meeting, and the top reasons behind each
// number (from what's already stored: the score's checks, the latest audit, the synced days). Pure, so the list, the
// assistant and the tests all say the same thing. Nothing here calls an AI or the network.

export type KpiLine = "meta" | "google" | "tiktok" | "email" | "social";
export const KPI_LINES: readonly KpiLine[] = ["meta", "google", "tiktok", "email", "social"];
export const LINE_LABEL: Record<KpiLine, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", email: "Email", social: "Social" };

/** The service tab each line belongs to (a tab narrows sorting to that line's KPI only) */
export const LINE_OF_SERVICE: Record<string, KpiLine | undefined> = { "facebook-ads": "meta", "google-ads": "google", "tiktok-ads": "tiktok", "email-marketing": "email", "social-media": "social" };

export type Tone = "good" | "watch" | "bad" | "none";
export type Reason = { text: string; tone: "down" | "up" | "info" };

/** One line's KPI on a client, ready to show */
export type LineKpi = {
  line: KpiLine;
  /** "CPA", "ROAS", "Email", "Social" */
  label: string;
  /** "$42 / $35", "2.1x / 3.0x", "72", or a neutral note when there is nothing to judge */
  shown: string;
  tone: Tone;
  /** 0 (worst) to 100 (best); null when this line can't be judged (no target, not spending, not read yet) */
  health: number | null;
  /** The last 14 days' spend on an ad line (the money at stake), null elsewhere */
  spend: number | null;
  /** Up to three reasons, plain and short, down reasons first when the line is down */
  reasons: Reason[];
  /** The KPI card (or sheet) this number lives on */
  href: string;
};

export const GOOD_FROM = 80;
export const WATCH_FROM = 60;

/** Green at 80 and over, yellow from 60, red under 60: the email and social score bands, used for every line */
export const toneOf = (health: number | null): Tone => (health == null ? "none" : health >= GOOD_FROM ? "good" : health >= WATCH_FROM ? "watch" : "bad");

// How an ad account's 14 day deviation from target (positive = worse) maps to a 0 to 100 health, in line with the KPI
// bands: 20% under target or better is 100, on target 80, 15% over 60 (where "off target" starts), then falling away
const DEVIATION_POINTS: readonly (readonly [number, number])[] = [
  [-0.2, 100],
  [0, 80],
  [0.15, 60],
  [0.5, 15],
  [1, 0],
];

/** An ad KPI's health from how much worse than target it is (null when there's no deviation to read) */
export function adHealth(deviation: number | null | undefined): number | null {
  if (deviation == null || !Number.isFinite(deviation)) return null;
  const pts = DEVIATION_POINTS;
  if (deviation <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x0, y0] = pts[i - 1];
    if (deviation <= x1) return Math.round(y0 + ((deviation - x0) / (x1 - x0)) * (y1 - y0));
  }
  return 0;
}

/** Judged ad status to a health: spending with no results is as bad as it gets; idle and unset aren't judged */
export function adHealthFor(status: Status, deviation: number | null): number | null {
  if (status === "idle" || status === "setup" || status === "unset") return null;
  if (deviation == null) return status === "off" ? 5 : null;
  const h = adHealth(deviation);
  // The status and the number agree (they come from the same bands); keep the status the boards show the winner at the edges
  if (h == null) return null;
  if (status === "off") return Math.min(h, WATCH_FROM - 1);
  if (status === "close") return Math.min(Math.max(h, WATCH_FROM), GOOD_FROM - 1);
  return Math.max(h, GOOD_FROM);
}

/** The cost KPI's short name from its conversion ("CPA", "CPL", "CPC"), or ROAS */
export function costLabel(conversion: string | null | undefined, roas: boolean): string {
  if (roas) return "ROAS";
  const c = String(conversion ?? "");
  if (/lead|application/.test(c)) return "CPL";
  if (/click/.test(c)) return "CPC";
  if (/engagement|landing_page/.test(c)) return "CPR";
  return "CPA";
}

// ─── Criticality ────────────────────────────────────────────────────────────

/** How bad a line is, 0 (nothing to fix) to 100: nothing until it's under the green band, then the distance below it */
export const severity = (health: number | null): number => (health == null ? 0 : Math.max(0, Math.min(100, ((GOOD_FROM - health) / GOOD_FROM) * 100)));

export type CriticalityInput = {
  /** Only these lines count (a service tab asks for one line); omit for all */
  only?: KpiLine | null;
  /** Someone said this client is probably leaving (a recent risk note in their memory) */
  atRisk?: boolean;
};

/**
 * The client's criticality across lines: the worst line's severity, plus 30% of the rest (two lines off is worse than
 * one), lifted by retention risk (a recent "they may cancel" note adds 30%) and by the money on the line (up to 20%
 * at $50k spent in 14 days). Null when none of the lines can be judged, so those clients sort last.
 */
export function criticality(lines: readonly LineKpi[], opts: CriticalityInput = {}): number | null {
  const judged = lines.filter((l) => l.health != null && (!opts.only || l.line === opts.only));
  if (!judged.length) return null;
  const sev = judged.map((l) => severity(l.health)).sort((a, b) => b - a);
  const base = sev[0] + 0.3 * sev.slice(1).reduce((s, x) => s + x, 0);
  const spend = judged.reduce((s, l) => s + (l.spend ?? 0), 0);
  const weight = 1 + (opts.atRisk && sev[0] > 0 ? 0.3 : 0) + Math.min(0.2, (spend / 50_000) * 0.2);
  return Math.round(base * weight * 10) / 10;
}

/** A client's overall health (the mean of its judged lines), for "best performing first"; null when nothing is judged */
export function overallHealth(lines: readonly LineKpi[], only?: KpiLine | null): number | null {
  const judged = lines.filter((l) => l.health != null && (!only || l.line === only));
  return judged.length ? judged.reduce((s, l) => s + (l.health as number), 0) / judged.length : null;
}

/** At or above this a client is critical: a line far off target, or two lines slipping with the account at risk */
export const CRITICAL_FROM = 50;

export type KpiClient = { id: string; name: string; kpis?: LineKpi[]; atRisk?: boolean };
export type KpiSort = "critical" | "best" | "name";
export const KPI_SORTS: readonly { key: KpiSort; label: string }[] = [
  { key: "critical", label: "Most critical first" },
  { key: "best", label: "Best performing first" },
  { key: "name", label: "Name" },
];
export const asKpiSort = (v: string | null | undefined): KpiSort | null => (v === "critical" || v === "best" || v === "name" ? v : null);

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });

/**
 * The list in a meeting's order. critical: the most critical first; best: the healthiest first; name: A to Z. Clients
 * with no KPI data are always last (by name). `only`: the line a service tab is on, so the sort looks at that line's
 * KPI alone.
 */
export function sortClients<T extends KpiClient>(cards: readonly T[], sort: KpiSort, only?: KpiLine | null): T[] {
  if (sort === "name") return [...cards].sort(byName);
  const keyed = cards.map((c) => ({ c, v: sort === "critical" ? criticality(c.kpis ?? [], { only, atRisk: c.atRisk }) : overallHealth(c.kpis ?? [], only) }));
  return keyed
    .sort((a, b) => {
      if (a.v == null && b.v == null) return byName(a.c, b.c);
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      return b.v - a.v || byName(a.c, b.c);
    })
    .map((x) => x.c);
}

export type KpiSummary = { offTarget: number; critical: number; lines: KpiLine[]; judged: number };

/** "N clients off target across M lines: K critical", counted over what's on screen (a tab counts its line alone) */
export function summarize(cards: readonly KpiClient[], only?: KpiLine | null): KpiSummary {
  const lines = new Set<KpiLine>();
  let offTarget = 0;
  let critical = 0;
  let judged = 0;
  for (const c of cards) {
    const ks = (c.kpis ?? []).filter((l) => !only || l.line === only);
    if (ks.some((l) => l.health != null)) judged++;
    const bad = ks.filter((l) => l.tone === "bad");
    if (bad.length) {
      offTarget++;
      for (const l of bad) lines.add(l.line);
    }
    const crit = criticality(c.kpis ?? [], { only, atRisk: c.atRisk });
    if (crit != null && crit >= CRITICAL_FROM) critical++;
  }
  return { offTarget, critical, lines: KPI_LINES.filter((l) => lines.has(l)), judged };
}

/** The summary as one line for the top of the list ("12 clients off target across 3 lines: 5 critical") */
export function summaryText(s: KpiSummary): string {
  if (!s.judged) return "No KPI numbers read yet";
  if (!s.offTarget) return `All ${s.judged} clients with a KPI are on target`;
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? "" : "s"}`;
  return `${n(s.offTarget, "client")} off target across ${n(s.lines.length, "line")}${s.critical ? `: ${s.critical} critical` : ""}`;
}

/** Whether a client passes the summary's filter: off target on a line, or critical */
export function passesKpiFilter(c: KpiClient, kind: "off" | "critical", only?: KpiLine | null): boolean {
  if (kind === "off") return (c.kpis ?? []).some((l) => l.tone === "bad" && (!only || l.line === only));
  const v = criticality(c.kpis ?? [], { only, atRisk: c.atRisk });
  return v != null && v >= CRITICAL_FROM;
}

// ─── Reasons ────────────────────────────────────────────────────────────────

const pctWord = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The email score's checks as reasons: what weighs it down (worst first), or when it's healthy, what carries it */
export function emailReasons(s: { band: string; checks: readonly EmailCheck[]; weighingDown: readonly EmailCheck[] }, currency: string | null = "USD", n = 3): Reason[] {
  const down = s.weighingDown.slice(0, n).map((c): Reason => ({ tone: "down", text: `${c.label} ${checkText(c.unit, c.value, currency, c.bar)} against a ${checkText(c.unit, c.bar, currency)} bar` }));
  if (down.length && s.band !== "good") return down;
  return upReasons(s.checks, (c) => `${c.label} ${checkText(c.unit, c.value, currency)}, over its ${checkText(c.unit, c.bar, currency)} bar`, n, down);
}

/** The social score's checks as reasons, the same way */
export function socialReasons(s: { band: string; checks: readonly SocialCheck[]; weighingDown: readonly (SocialCheck & { platform?: string })[] }, n = 3): Reason[] {
  const down = s.weighingDown.slice(0, n).map((c): Reason => ({ tone: "down", text: `${c.platform ? `${cap(c.platform)} ` : ""}${c.platform ? c.label.toLowerCase() : c.label} ${socialCheckText(c.unit, c.value)} against a ${socialCheckText(c.unit, c.bar)} bar` }));
  if (down.length && s.band !== "good") return down;
  return upReasons(s.checks, (c) => `${c.label} ${socialCheckText(c.unit, c.value)}, over its ${socialCheckText(c.unit, c.bar)} bar`, n, down);
}

function upReasons<C extends { value: number | null; met: boolean; weight: number }>(checks: readonly C[], say: (c: C) => string, n: number, fallback: Reason[]): Reason[] {
  const best = checks
    .filter((c) => c.met && c.value != null)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((c): Reason => ({ tone: "up", text: say(c) }));
  // A green score that still has a drag: the best bits first, then the one thing to watch
  return [...best, ...fallback].slice(0, n);
}

/** A day of an ad account's numbers (campaigns of the KPI summed), for the data-driven reasons */
export type DayNumbers = { date: string; campaign: string; spend: number; impressions: number; linkClicks: number; results: number };

export type AdSignals = {
  /** Snapshot-level facts (free: already stored with the KPI) */
  status: Status;
  deviation: number | null;
  trend: "improving" | "steady" | "slipping" | null;
  vsMonth: number | null;
  budget: { status?: string; pace?: number } | null;
  roas: boolean;
  /** The latest ready audit's headline for this account, when there is one */
  audit: { headline: string; status: string } | null;
  /** Ads the fatigue watcher has open on this client (Meta) */
  tiredAds: number;
  /** The synced days, last 28 days of the KPI's campaigns (empty when not read) */
  days: readonly DayNumbers[];
  today: string;
};

const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Win = { spend: number; impressions: number; linkClicks: number; results: number };
const sumWin = (days: readonly DayNumbers[]): Win => days.reduce((a, d) => ({ spend: a.spend + d.spend, impressions: a.impressions + d.impressions, linkClicks: a.linkClicks + d.linkClicks, results: a.results + d.results }), { spend: 0, impressions: 0, linkClicks: 0, results: 0 });
const change = (now: number | null, before: number | null) => (now == null || before == null || !before ? null : (now - before) / before);

/**
 * Simple, data driven reasons from the synced days: the last 14 complete days against the 14 before. CPM up, link CTR
 * down, cost per result up, spend moved onto a weak campaign. Each only when it's big enough to mean something.
 */
export function dataReasons(days: readonly DayNumbers[], today: string, roas = false): Reason[] {
  if (!days.length) return [];
  const to = shiftDay(today, -1);
  const mid = shiftDay(to, -14);
  const from = shiftDay(mid, -14);
  const now = days.filter((d) => d.date > mid && d.date <= to);
  const before = days.filter((d) => d.date > from && d.date <= mid);
  const a = sumWin(now);
  const b = sumWin(before);
  if (a.spend <= 0) return [];
  const out: Reason[] = [];
  const cpm = change(a.impressions ? (a.spend / a.impressions) * 1000 : null, b.impressions ? (b.spend / b.impressions) * 1000 : null);
  if (cpm != null && cpm >= 0.15) out.push({ tone: "down", text: `CPM up ${pctWord(cpm)} (auctions got pricier)` });
  const ctr = change(a.impressions ? a.linkClicks / a.impressions : null, b.impressions ? b.linkClicks / b.impressions : null);
  if (ctr != null && ctr <= -0.15) out.push({ tone: "down", text: `Click-through down ${pctWord(ctr)} (the ads pull fewer clicks)` });
  const cpr = change(a.results ? a.spend / a.results : null, b.results ? b.spend / b.results : null);
  if (!roas && cpr != null && cpr >= 0.15) out.push({ tone: "down", text: `Cost per result up ${pctWord(cpr)} on the 14 days before` });
  if (!roas && cpr != null && cpr <= -0.15) out.push({ tone: "up", text: `Cost per result down ${pctWord(cpr)} on the 14 days before` });
  if (!roas && a.results === 0) out.push({ tone: "down", text: `${money(Math.round(a.spend))} spent in 14 days with no results` });
  // Spend on a weak campaign: one that takes a third of the money at 1.5x the account's cost per result (or none)
  const by = new Map<string, Win>();
  for (const d of now) {
    const w = by.get(d.campaign) ?? { spend: 0, impressions: 0, linkClicks: 0, results: 0 };
    by.set(d.campaign, { spend: w.spend + d.spend, impressions: w.impressions + d.impressions, linkClicks: w.linkClicks + d.linkClicks, results: w.results + d.results });
  }
  const avg = a.results ? a.spend / a.results : null;
  if (!roas && avg != null) {
    const weak = [...by.entries()]
      .filter(([, w]) => w.spend / a.spend >= 0.3 && (w.results === 0 || w.spend / w.results >= avg * 1.5))
      .sort((x, y) => y[1].spend - x[1].spend)[0];
    if (weak) out.push({ tone: "down", text: `${Math.round((weak[1].spend / a.spend) * 100)}% of spend is on "${weak[0]}", ${weak[1].results ? `at ${money(Math.round(weak[1].spend / weak[1].results))} a result` : "with no results"}` });
  }
  return out;
}

/**
 * The top three reasons for an ad KPI, from what's stored: the latest audit's headline first (the agent already worked
 * it out), then the data-driven ones, then the snapshot's own flags. When it's on target the same sources say why it's
 * going well. Never calls an AI.
 */
export function adReasons(s: AdSignals, n = 3): Reason[] {
  const judgedDown = s.status === "off" || s.status === "close";
  const judgedUp = s.status === "good" || s.status === "excellent";
  const out: Reason[] = [];
  const data = dataReasons(s.days, s.today, s.roas);
  if (judgedDown) {
    if (s.audit && (s.audit.status === "off" || s.audit.status === "at_risk")) out.push({ tone: "down", text: `Audit: ${s.audit.headline}` });
    out.push(...data.filter((r) => r.tone === "down"));
    if (s.tiredAds > 0) out.push({ tone: "down", text: `${s.tiredAds} ${s.tiredAds === 1 ? "ad is" : "ads are"} wearing out (frequency up, click-through down)` });
    if (s.trend === "slipping") out.push({ tone: "down", text: "The last 3 days are worse than the 14 day average" });
    if (s.vsMonth != null && s.vsMonth >= 0.1) out.push({ tone: "down", text: `${s.roas ? "ROAS" : "Cost per result"} ${s.roas ? "down" : "up"} ${pctWord(s.vsMonth)} on last month` });
    if (s.budget?.status === "under" && s.budget.pace != null) out.push({ tone: "down", text: `Spend is pacing ${pctWord(1 - s.budget.pace)} under budget` });
    if (s.budget?.status === "over" && s.budget.pace != null) out.push({ tone: "down", text: `Spend is pacing ${pctWord(s.budget.pace - 1)} over budget` });
    if (!out.length && s.deviation != null) out.push({ tone: "info", text: `${pctWord(s.deviation)} ${s.roas ? "under" : "over"} target over the last 14 days; no single cause stands out yet` });
  } else if (judgedUp) {
    if (s.audit && (s.audit.status === "winning" || s.audit.status === "on_track")) out.push({ tone: "up", text: `Audit: ${s.audit.headline}` });
    if (s.deviation != null && s.deviation < 0) out.push({ tone: "up", text: `${pctWord(s.deviation)} ${s.roas ? "above" : "under"} target over the last 14 days` });
    out.push(...data.filter((r) => r.tone === "up"));
    if (s.trend === "improving") out.push({ tone: "up", text: "The last 3 days are better than the 14 day average" });
    if (s.vsMonth != null && s.vsMonth <= -0.1) out.push({ tone: "up", text: `${s.roas ? "ROAS" : "Cost per result"} ${s.roas ? "up" : "down"} ${pctWord(s.vsMonth)} on last month` });
  }
  return dedupe(out).slice(0, n);
}

const dedupe = (rs: Reason[]) => rs.filter((r, i) => rs.findIndex((x) => x.text === r.text) === i);

// ─── The ad chip ────────────────────────────────────────────────────────────

export type AdChipInput = {
  line: "meta" | "google" | "tiktok";
  conversion: string;
  roas: boolean;
  target: number | null;
  status: Status;
  deviation: number | null;
  /** The last 14 days: spend, results and value (cost per result, or ROAS on a ROAS KPI) */
  d14: { spend: number; results: number; value: number | null; revenue?: number } | null;
  href: string;
  reasons: Reason[];
};

/**
 * One ad account's chip, the board's own numbers and status: the 14 day value against the target, coloured by the
 * status the board shows. A Google ROAS KPI whose conversion value isn't real (a default of 1 per conversion) is never
 * shown as a ROAS: it says so and isn't judged.
 */
export function adChip(i: AdChipInput): LineKpi {
  const label = costLabel(i.conversion, i.roas);
  const spend = i.d14 ? i.d14.spend : null;
  const base = { line: i.line, label, spend, href: i.href };
  if (i.status === "idle") return { ...base, shown: `${label} · not spending`, tone: "none", health: null, reasons: i.reasons };
  if (i.status === "setup") return { ...base, shown: `${label} · setting up`, tone: "none", health: null, reasons: i.reasons };
  if (i.status === "unset" || !(i.target != null && i.target > 0)) return { ...base, shown: `${label} · no target`, tone: "none", health: null, reasons: i.reasons };
  if (i.line === "google" && i.roas && i.d14) {
    const gv = conversionValue({ spend: i.d14.spend, conversions: i.d14.results, value: i.d14.revenue });
    if (!gv.tracked) return { ...base, shown: `${label} · value not tracked`, tone: "none", health: null, reasons: [{ tone: "info", text: "Conversion value isn't tracked (a tracking fix), so there is no real ROAS to judge" }] };
  }
  const health = adHealthFor(i.status, i.deviation);
  const v = i.d14?.value ?? null;
  return { ...base, shown: `${kpiValue(v, i.roas)} / ${kpiValue(i.target, i.roas)}`, tone: toneOf(health), health, reasons: i.reasons };
}

/** Of several accounts on one platform, the one to show: the worst judged, else the first */
export function worstChip(chips: readonly LineKpi[]): LineKpi | null {
  if (!chips.length) return null;
  return [...chips].sort((a, b) => (a.health ?? 101) - (b.health ?? 101))[0];
}

/** A line's chip for an email or social score: the number, its band's colour, the checks as reasons */
export function scoreChip(i: { line: "email" | "social"; score: number | null; band: "good" | "watch" | "bad" | null; reasons: Reason[]; href: string; note: string }): LineKpi {
  const label = LINE_LABEL[i.line];
  const base = { line: i.line, label, spend: null, href: i.href };
  if (i.score == null || i.band == null) return { ...base, shown: i.note, tone: "none", health: null, reasons: i.reasons };
  return { ...base, shown: String(Math.round(i.score)), tone: i.band, health: i.score, reasons: i.reasons };
}

/**
 * The lines this person sees KPIs for, the boards' own rule: executives and leads every line; the email and social
 * teams their own line; a Meta or Google buyer their own platform (and TikTok, read only, with the ad side)
 */
export function allowedKpiLines(me: { isExec?: boolean | null; isLead?: boolean | null }, channel: "email" | "social" | null, adsPlatform: "meta" | "google" | null): KpiLine[] {
  if (me.isExec || me.isLead) return [...KPI_LINES];
  if (channel) return [channel];
  if (adsPlatform) return [adsPlatform];
  return ["meta", "google", "tiktok"];
}

/**
 * The top reasons across a client's lines, for a meeting line or the assistant: the worst line's first reason, then the
 * next line's, and so on (so no single line crowds the rest out), then the lines' second reasons. "up" reads the best
 * lines the same way. Each is said with its line ("Meta: Cost per result up 24%...").
 */
export function topReasons(kpis: readonly LineKpi[], n = 3, dir: "down" | "up" = "down"): string[] {
  const judged = kpis.filter((k) => k.health != null && k.reasons.length);
  const order = [...judged].sort((a, b) => (dir === "down" ? (a.health as number) - (b.health as number) : (b.health as number) - (a.health as number)));
  const want = (r: Reason) => (dir === "down" ? r.tone !== "up" : r.tone !== "down");
  const out: string[] = [];
  for (let round = 0; out.length < n && round < 3; round++) {
    for (const k of order) {
      const r = k.reasons.filter(want)[round];
      if (r && out.length < n) out.push(`${LINE_LABEL[k.line]}: ${r.text}`);
    }
  }
  return out;
}
