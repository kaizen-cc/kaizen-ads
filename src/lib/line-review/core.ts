import { servicesOf, type ServiceSlug } from "@/lib/services";
import { LEARNING_RESET, isAutomated, isKaizenEmail, matchActor, normName, type Person } from "@/lib/account-watch/core";

// The weekly account review, the pure part (no database, no keys). Every Monday each line head (Meta + TikTok, Google,
// Email, Organic Social) gets one review per client per line the client buys: scope against what was delivered, budget
// pace, ad account change history (us or the client, and our changes made without the client's sign-off), open
// commitments, results against target with a confidence tag on every claim, health, and what to do today. Each review
// drafts one strict internal Slack message for the client's INTERNAL channel, posted as the head once they approve it.
//
// The rules that keep it safe live here, with tests (tests/line-review.test.ts):
//   - nothing about Kaizen's fees, retainer, invoices or Stripe goes to Slack (ad spend and budgets are fine)
//   - never tag or address a departed or inactive teammate; their items go to the current seat holder
//   - real Slack mentions only from profiles.slack_user_id, never a guessed handle
//   - never call a client cancelled or churned unless the OS says so (clients.status)
//   - Meta and Google conversions that claim the same orders are never added together
//   - archived and inactive clients get nothing; a removed service is skipped (the services gate)

export type ReviewLine = "meta" | "google" | "email" | "social";
export const REVIEW_LINES: readonly ReviewLine[] = ["meta", "google", "email", "social"];
export const REVIEW_LINE_LABEL: Record<ReviewLine, string> = { meta: "Meta + TikTok", google: "Google", email: "Email", social: "Organic Social" };
/** The head who runs each line's review */
export const LINE_HEAD: Record<ReviewLine, "head_of_meta" | "head_of_google" | "head_of_email" | "head_of_social"> = { meta: "head_of_meta", google: "head_of_google", email: "head_of_email", social: "head_of_social" };
export const HEAD_LINE: Record<string, ReviewLine> = { head_of_meta: "meta", head_of_google: "google", head_of_email: "email", head_of_social: "social" };
/** The services that make up each line (TikTok is the Meta team's) */
export const LINE_SERVICES: Record<ReviewLine, ServiceSlug[]> = { meta: ["facebook-ads", "tiktok-ads"], google: ["google-ads"], email: ["email-marketing"], social: ["social-media"] };
/** The seats that own a line's day-to-day work on a client */
export const LINE_SEATS: Record<ReviewLine, string[]> = { meta: ["meta_buyer", "tiktok_buyer"], google: ["google_buyer"], email: ["email_strategist", "email_designer", "email_builder"], social: ["social_manager", "social_creative"] };
/** The ad platforms each line reviews */
export const LINE_PLATFORMS: Record<ReviewLine, string[]> = { meta: ["meta", "tiktok"], google: ["google"], email: [], social: [] };

/** The owner's thresholds (Nov 20 2026) */
export const THRESHOLDS = { silentDays: 5, overBudget: 0.2, creativeStuckDays: 7 } as const;

export type Confidence = "certain" | "likely" | "guessing";
export const CONFIDENCE_WORD: Record<Confidence, string> = { certain: "certain", likely: "likely", guessing: "guessing" };

const LIVE_STATUSES = new Set(["active", "onboarding"]);
const DAY = 86_400_000;

// ─── Which reviews ──────────────────────────────────────────────────────────

export type ClientForReview = {
  status: string | null;
  archived_at?: string | null;
  services?: string[] | null;
  services_extra?: string[] | null;
  services_removed?: string[] | null;
  strategy_only?: string[] | null;
};

/**
 * The lines a client gets a review on: none when archived or not live (paused, offboarded); else each line whose
 * service they buy (the services gate: a removed service is skipped). A line sold as strategy only is still reviewed,
 * marked so (no deliveries are expected on it). An email-only client gets its email review like anyone (internal only).
 */
export function reviewLinesFor(c: ClientForReview): { line: ReviewLine; strategyOnly: boolean }[] {
  if (c.archived_at || !LIVE_STATUSES.has(String(c.status ?? ""))) return [];
  const bought = new Set<string>(servicesOf(c));
  const strategy = new Set(c.strategy_only ?? []);
  return REVIEW_LINES.filter((l) => LINE_SERVICES[l].some((s) => bought.has(s))).map((line) => {
    const mine = LINE_SERVICES[line].filter((s) => bought.has(s));
    return { line, strategyOnly: mine.length > 0 && mine.every((s) => strategy.has(s)) };
  });
}

/** The Monday (YYYY-MM-DD) of the week a New York day falls in */
export function weekStartOf(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day.slice(0, 10)}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.floor((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / DAY);

// ─── Money never reaches Slack ──────────────────────────────────────────────

/** Always about Kaizen's own money, amount or not */
const FEE_STRONG = /\b(retainers?|invoices?|invoiced|invoicing|stripe|mrr|arr|management fees?|agency fees?|our fees?|kaizen'?s fees?|monthly fee|setup fee|past[- ]due|unpaid|overdue (?:payment|balance|invoice)|collections?)\b/i;
/** About Kaizen's money only when an amount is next to it */
const FEE_WEAK = /\b(fees?|billed|billing|bills?|subscriptions?|paid us|pays us|owes? us|pricing|price|priced|tier price|charged?|charges|contract value|revenue to us|per month to us)\b/i;
/** Ad money: spend and budgets are fine in Slack */
const AD_MONEY = /\b(ad ?spend|spend|spent|spending|budgets?|cpa|cpc|cpm|cost per|roas|aov|revenue|sales|purchases?)\b/i;
const AMOUNT = /(?:[$€£]\s?\d)|(?:\b\d[\d,.]*\s?(?:k|usd|dollars|bucks)\b)/i;

/**
 * Lines of a message that talk about Kaizen's fees, retainer, invoices or Stripe. Ad spend and budgets are fine; a
 * Meta/Google ad account payment problem (the platform's billing) is fine when no fee word comes with an amount.
 */
export function moneyIssues(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    if (FEE_STRONG.test(line)) {
      out.push(line);
      continue;
    }
    if (AMOUNT.test(line) && FEE_WEAK.test(line)) {
      // "billing threshold" on an ad account with spend in the same line is the platform's billing, not ours
      if (/\b(ad account|payment method|billing threshold|meta billing|google billing)\b/i.test(line) && AD_MONEY.test(line)) continue;
      out.push(line);
    }
  }
  return out;
}

/** The message with every line about Kaizen's money taken out (used on every draft; a send re-checks and refuses) */
export function redactMoney(text: string): string {
  const bad = new Set(moneyIssues(text));
  return String(text ?? "")
    .split("\n")
    .filter((l) => !bad.has(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── People: real mentions, never someone who left ─────────────────────────

export type Teammate = { id: string; full_name: string; display_name?: string | null; is_active: boolean; slack_user_id?: string | null; role?: string | null; email?: string | null };

const SLACK_ID = /^[UW][A-Z0-9]{6,}$/;
export const firstName = (p: { full_name: string; display_name?: string | null }) => (p.display_name?.trim() || p.full_name.trim()).split(/\s+/)[0] ?? "";

/** A Slack mention for an active teammate with a real Slack id; their first name in plain text without one; null for anyone inactive */
export function mention(p: Teammate | null | undefined): string | null {
  if (!p || !p.is_active) return null;
  const id = (p.slack_user_id ?? "").trim();
  return SLACK_ID.test(id) ? `<@${id}>` : firstName(p);
}

/**
 * Who an item goes to: its owner while they're active; else the client's current seat holder on that line (active,
 * primary first); else nobody (the head picks it up). A departed teammate is never returned.
 */
export function routeTo<T extends Teammate>(owner: T | null | undefined, seatHolders: readonly T[]): T | null {
  if (owner?.is_active) return owner;
  return seatHolders.find((s) => s.is_active) ?? null;
}

/** Mentions in a message that point at nobody active: a departed teammate's Slack id, or an id that isn't on the team */
export function mentionIssues(text: string, team: readonly Teammate[]): string[] {
  const out: string[] = [];
  const byId = new Map(team.filter((t) => t.slack_user_id).map((t) => [String(t.slack_user_id).trim(), t]));
  for (const m of String(text ?? "").matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    const p = byId.get(m[1]);
    if (!p) out.push(`<@${m[1]}> isn't anyone on the team in Kaizen OS`);
    else if (!p.is_active) out.push(`${p.full_name} has left the team: their items go to the current seat holder`);
  }
  // "@Name" typed for someone who's left
  for (const p of team.filter((t) => !t.is_active)) {
    const first = normName(firstName(p));
    const full = normName(p.full_name);
    const said = normName(String(text ?? "").replace(/<@[^>]+>/g, ""));
    if ((full.length > 3 && said.includes(`@${full}`)) || (first.length > 2 && new RegExp(`(^|\\s)@${first}\\b`).test(said))) out.push(`${p.full_name} has left the team: don't address them`);
  }
  return [...new Set(out)];
}

// ─── Status: verified, never guessed ───────────────────────────────────────

const CHURN_WORDS = /\b(cancel(?:l)?ed|cancel(?:l)?ing|cancellation|churn(?:ed|ing)?|offboard(?:ed|ing)?|left us|lost (?:the|this) client|terminated|no longer a client|former client)\b/i;

/** A message calling the client cancelled or churned while the OS doesn't say so (only an offboarded client is) */
export function statusIssues(text: string, status: string | null | undefined): string[] {
  if (status === "offboarded") return [];
  const m = String(text ?? "").match(CHURN_WORDS);
  return m ? [`It says "${m[0]}", but Kaizen OS has this client as ${status ?? "unknown"}. Only say a client is cancelled or churned when the OS does.`] : [];
}

/** Everything that stops a message going to Slack */
export function slackIssues(text: string, ctx: { status: string | null | undefined; team: readonly Teammate[] }): string[] {
  return [...moneyIssues(text).map((l) => `Kaizen's fees, invoices or Stripe can't go to Slack: "${l.slice(0, 80)}"`), ...mentionIssues(text, ctx.team), ...statusIssues(text, ctx.status)];
}

// ─── Budget pace ────────────────────────────────────────────────────────────

export type BudgetPace = { budget: number; spent: number; expected: number; projected: number; pacePct: number; projectedPct: number; over: boolean; under: boolean };

/**
 * Month-to-date spend against the monthly budget on file: how far ahead or behind the straight line it is (pacePct,
 * +0.25 = 25% ahead) and where the month lands at this rate (projectedPct against the budget). Over when the month is on
 * course to beat the budget by more than 20% (or already has); under when on course for less than half.
 */
export function budgetPace(i: { spent: number; budget: number | null | undefined; day: number; daysInMonth: number }): BudgetPace | null {
  const budget = Number(i.budget ?? 0);
  if (!(budget > 0) || i.day < 1 || i.daysInMonth < 1) return null;
  const spent = Math.max(0, Number(i.spent) || 0);
  const expected = (budget * Math.min(i.day, i.daysInMonth)) / i.daysInMonth;
  const projected = (spent / Math.min(i.day, i.daysInMonth)) * i.daysInMonth;
  const projectedPct = projected / budget - 1;
  return {
    budget,
    spent,
    expected,
    projected,
    pacePct: expected > 0 ? spent / expected - 1 : 0,
    projectedPct,
    over: spent > budget * (1 + THRESHOLDS.overBudget) || projectedPct > THRESHOLDS.overBudget,
    under: i.day >= 7 && projected < budget * 0.5,
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.round(Math.abs(x) * 100)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// ─── Conversions: never counted twice ──────────────────────────────────────

const ORDERISH = /purchase|order|checkout|revenue|roas|sale|transaction|conversion_value|omni_purchase/i;
export const isOrderConversion = (conversion: string | null | undefined) => ORDERISH.test(String(conversion ?? ""));

export type PlatformResult = { platform: string; conversion: string | null; results: number };
export type ConversionTotal = { total: number | null; from: "store" | "platform" | "none"; confidence: Confidence; note: string };

/**
 * One number for orders across platforms. The store's count wins when connected (certain). With no store, two ad
 * platforms that both claim orders are never added together: each counts the same buyer, so the total is unknown and
 * the note says so (guessing). One platform alone is its own reporting (likely).
 */
export function combineConversions(rows: readonly PlatformResult[], store: { orders: number } | null): ConversionTotal {
  if (store) return { total: store.orders, from: "store", confidence: "certain", note: `${store.orders} orders in the store (its own count, not the ad platforms').` };
  const orders = rows.filter((r) => isOrderConversion(r.conversion) && r.results > 0);
  const platforms = [...new Set(orders.map((r) => r.platform))];
  if (platforms.length >= 2) {
    const each = platforms.map((p) => `${p === "meta" ? "Meta" : p === "google" ? "Google" : p === "tiktok" ? "TikTok" : p} ${Math.round(orders.filter((r) => r.platform === p).reduce((n, r) => n + r.results, 0))}`).join(", ");
    return { total: null, from: "none", confidence: "guessing", note: `${each}: not added together, since both claim the same orders. Connect the store for the real count.` };
  }
  if (platforms.length === 1) {
    const n = Math.round(orders.reduce((s, r) => s + r.results, 0));
    return { total: n, from: "platform", confidence: "likely", note: `${n} by the platform's own count (no store connected to check it).` };
  }
  return { total: null, from: "none", confidence: "guessing", note: "No order numbers on record." };
}

// ─── Change history: us or the client, and sign-off ────────────────────────

export type Change = { at: string; who: string | null; what: string; object: string | null; platform?: string };
export type Actor = "us" | "client" | "automated" | "unknown";

/** Who made a change: our team (an alias, name or our domain), the client (their contacts or domain), automation, or nobody known */
export function actorOf(who: string | null | undefined, ctx: { team: readonly Person[]; contactNames: ReadonlySet<string>; contactDomains: ReadonlySet<string>; clientName?: string | null }): Actor {
  const w = String(who ?? "").trim();
  if (!w || isAutomated(w)) return "automated";
  if (isKaizenEmail(w) || matchActor(w, ctx.team)) return "us";
  const n = normName(w);
  if (ctx.contactNames.has(n)) return "client";
  if (w.includes("@") && ctx.contactDomains.has(w.split("@")[1].toLowerCase())) return "client";
  if (ctx.clientName && normName(ctx.clientName) === n) return "client";
  return "unknown";
}

const PAUSE = /\bpaus(?:e|ed|ing)\b|status.{0,20}(?:paused|off|inactive)|turned off|\bdeleted?\b|\barchived?\b/i;
/** A pause, stop or delete */
export const isPauseChange = (what: string) => PAUSE.test(what);
/** A budget, bid or targeting move (sends it back into learning) */
export const isBudgetOrTargeting = (what: string) => LEARNING_RESET.test(what);

const NEEDS_SIGNOFF =
  /(?:approv\w*|sign[- ]?off|signs? off|check(?:ed)? with (?:them|the client|us)|run (?:it|them|changes|anything) by|(?:their|client'?s?) (?:ok|okay|go[- ]ahead)).{0,80}(?:budget|spend|targeting|audience|change|campaign)|(?:budget|spend|targeting|audience|changes?).{0,80}(?:approv\w*|sign[- ]?off|need (?:their|the client'?s?) (?:ok|okay|approval)|before (?:we|you) (?:change|move|touch))/i;
/** Whether a client note or recap says budget or targeting changes need the client's sign-off */
export const needsSignoff = (notes: readonly (string | null | undefined)[]) => notes.some((n) => NEEDS_SIGNOFF.test(String(n ?? "")));

const APPROVED = /\b(approved?|approve it|go ahead|go for it|sounds good|green ?light|yes,? (?:do|go|please)|ok(?:ay)? to (?:go|proceed|change|move|increase|raise|lower)|let'?s do it|fine by (?:me|us)|works for (?:me|us))\b/i;
/** A client message that reads as a yes */
export const soundsApproved = (text: string | null | undefined) => APPROVED.test(String(text ?? ""));

/**
 * Our budget or targeting changes made while the client's notes say those need their sign-off, with no yes from the
 * client in the three days before. Confidence "likely": the sign-off is read from notes and messages, not a form.
 */
export function unapprovedChanges<C extends Change & { actor: Actor }>(changes: readonly C[], i: { needsSignoff: boolean; clientMessages: readonly { at: string; text: string }[] }): C[] {
  if (!i.needsSignoff) return [];
  const yeses = i.clientMessages.filter((m) => soundsApproved(m.text)).map((m) => Date.parse(m.at));
  return changes.filter((c) => {
    if (c.actor !== "us" || !isBudgetOrTargeting(c.what)) return false;
    const at = Date.parse(c.at);
    return !yeses.some((y) => y <= at && at - y <= 3 * DAY);
  });
}

// ─── Health ─────────────────────────────────────────────────────────────────

/** Days since a real human update (null when none on record) */
export const silentDays = (lastAt: string | null | undefined, today: string) => (lastAt ? Math.max(0, daysBetween(lastAt, today)) : null);
/** Silent long enough to call out: 5 days, or nothing on record */
export const isSilent = (days: number | null) => days == null || days >= THRESHOLDS.silentDays;

/** A channel message counts as a human update when it's a person (not a bot, workflow or the app) */
export const isHumanAuthor = (author: string | null | undefined) => {
  const a = String(author ?? "").trim();
  return Boolean(a) && !/\b(bot|app|workflow|zapier|integration|kaizen os|slackbot|asana|google drive|loom|calendar)\b/i.test(a);
};

// ─── The review ────────────────────────────────────────────────────────────

export type ReviewItem = { text: string; confidence: Confidence; who?: string | null; due?: string | null };
export type Review = {
  v: 1;
  client: { id: string; name: string; slug: string; status: string };
  line: ReviewLine;
  strategyOnly: boolean;
  period: { from: string; to: string };
  owner: { id: string; name: string; slackMention: string | null } | null;
  scope: { services: string[]; tiers: string[]; delivered: ReviewItem[]; promised: ReviewItem[] };
  budget: (BudgetPace & { account: string; platform: string; confidence: Confidence })[];
  changes: { total: number; ours: number; client: number; unknown: number; clientPauses: ReviewItem[]; unapproved: ReviewItem[]; notable: ReviewItem[]; readable: boolean };
  commitments: ReviewItem[];
  results: ReviewItem[];
  conversions: ConversionTotal | null;
  health: { internalSilent: number | null; clientSilent: number | null; atRisk: string | null; blockers: string[]; hasInternalChannel: boolean };
  todos: string[];
  risk: number;
};

/**
 * How worried to be about this account this week (for the execs' rollup, worst first): retention risk first, then
 * silence, broken promises, unapproved changes, the client pausing things, budget and results.
 */
export function riskScore(r: Pick<Review, "health" | "commitments" | "changes" | "budget" | "results">): number {
  let s = 0;
  if (r.health.atRisk) s += 50;
  if (r.health.clientSilent == null || r.health.clientSilent >= THRESHOLDS.silentDays) s += 15 + Math.min(15, Math.max(0, (r.health.clientSilent ?? 14) - THRESHOLDS.silentDays));
  if (r.health.internalSilent == null || r.health.internalSilent >= THRESHOLDS.silentDays) s += 5;
  s += Math.min(25, r.commitments.length * 6);
  s += Math.min(20, r.changes.unapproved.length * 10);
  s += Math.min(15, r.changes.clientPauses.length * 8);
  if (r.budget.some((b) => b.over)) s += 12;
  if (r.results.some((x) => /\bbehind target|off target|critical|poor\b/i.test(x.text))) s += 10;
  s += Math.min(10, r.health.blockers.length * 5);
  return s;
}

/** What to do today: short, direct, most urgent first */
export function todosFor(r: Pick<Review, "health" | "commitments" | "changes" | "budget" | "results" | "scope" | "strategyOnly">): string[] {
  const out: string[] = [];
  if (r.health.atRisk) out.push("Retention risk: call the client this week and agree the next 30 days.");
  for (const c of r.changes.unapproved.slice(0, 2)) out.push(`Get the client's sign-off on ${c.text.replace(/^Us: /, "")}, or roll it back.`);
  for (const c of r.changes.clientPauses.slice(0, 2)) out.push(`The client ${c.text.replace(/^Client: /, "").replace(/^paused/, "paused")}: ask why and agree what happens next.`);
  for (const c of r.commitments.slice(0, 3)) out.push(`${c.who ? `${c.who}: ` : ""}close out "${c.text.slice(0, 90)}"${c.due ? ` (due ${c.due})` : ""}.`);
  for (const p of r.scope.promised.slice(0, 2)) out.push(`Deliver ${p.text.slice(0, 90)}${p.due ? ` (due ${p.due})` : ""}.`);
  if (r.health.clientSilent == null || r.health.clientSilent >= THRESHOLDS.silentDays) out.push(`Post a real update in the client channel today (${r.health.clientSilent == null ? "nothing on record" : `${r.health.clientSilent} days quiet`}).`);
  for (const b of r.budget.filter((x) => x.over)) out.push(`Bring ${b.platform === "google" ? "Google" : b.platform === "tiktok" ? "TikTok" : "Meta"} spend in line: on course for ${usd(b.projected)} against ${usd(b.budget)}.`);
  for (const b of r.health.blockers.slice(0, 2)) out.push(`Unblock onboarding: ${b}.`);
  if (!out.length) out.push(r.strategyOnly ? "Strategy only: confirm the plan is current and noted in the channel." : "On track: keep the cadence and note one win in the channel.");
  return [...new Set(out)].slice(0, 7);
}

const tag = (c: Confidence) => `_(${CONFIDENCE_WORD[c]})_`;

/**
 * The internal Slack message: direct and strict, for the client's internal channel only. Money lines about Kaizen's
 * fees are never written (and redacted if any slip in from the data); people are tagged only when active with a real
 * Slack id; the client's status is the OS's.
 */
export function composeMessage(r: Review): string {
  const L: string[] = [];
  const who = r.owner?.slackMention ? `${r.owner.slackMention} ` : "";
  L.push(`*Weekly ${REVIEW_LINE_LABEL[r.line]} review: ${r.client.name}* (${r.period.from} to ${r.period.to})${r.strategyOnly ? " · strategy only" : ""}${r.client.status === "onboarding" ? " · onboarding" : ""}`);
  if (r.health.atRisk) L.push(`:rotating_light: Retention risk: ${r.health.atRisk}`);
  // Scope vs delivered
  if (r.scope.delivered.length || r.scope.promised.length) {
    L.push("", "*Scope vs delivered*");
    for (const d of r.scope.delivered.slice(0, 5)) L.push(`• ${d.text} ${tag(d.confidence)}`);
    for (const p of r.scope.promised.slice(0, 4)) L.push(`• Promised, not done: ${p.text}${p.due ? ` (due ${p.due})` : ""} ${tag(p.confidence)}`);
  }
  if (r.budget.length) {
    L.push("", "*Budget pace*");
    for (const b of r.budget) L.push(`• ${b.platform === "google" ? "Google" : b.platform === "tiktok" ? "TikTok" : "Meta"}: ${usd(b.spent)} spent of ${usd(b.budget)} (${pct(b.pacePct)} vs pace), on course for ${usd(b.projected)} (${pct(b.projectedPct)})${b.over ? " :warning: over" : b.under ? " · well under" : ""} ${tag(b.confidence)}`);
  }
  if (r.changes.readable && (r.changes.total || r.changes.unapproved.length)) {
    L.push("", "*Changes in the account*", `• ${r.changes.ours} by us, ${r.changes.client} by the client${r.changes.unknown ? `, ${r.changes.unknown} by someone we don't recognize` : ""} ${tag("certain")}`);
    for (const c of r.changes.clientPauses.slice(0, 3)) L.push(`• ${c.text} ${tag(c.confidence)}`);
    for (const c of r.changes.unapproved.slice(0, 3)) L.push(`• Without client sign-off: ${c.text} ${tag(c.confidence)}`);
  }
  if (r.commitments.length) {
    L.push("", "*Open commitments*");
    for (const c of r.commitments.slice(0, 5)) L.push(`• ${c.who ? `${c.who}: ` : ""}${c.text}${c.due ? ` (due ${c.due})` : ""} ${tag(c.confidence)}`);
  }
  if (r.results.length || r.conversions) {
    L.push("", "*Results vs target*");
    for (const x of r.results.slice(0, 4)) L.push(`• ${x.text} ${tag(x.confidence)}`);
    if (r.conversions && r.conversions.from !== "platform") L.push(`• Orders: ${r.conversions.note} ${tag(r.conversions.confidence)}`);
  }
  L.push("", "*Health*");
  L.push(`• Client channel: ${r.health.clientSilent == null ? "no human update on record" : `last human update ${r.health.clientSilent} day${r.health.clientSilent === 1 ? "" : "s"} ago`}${isSilent(r.health.clientSilent) ? " :warning:" : ""}. Internal: ${r.health.internalSilent == null ? "nothing on record" : `${r.health.internalSilent} day${r.health.internalSilent === 1 ? "" : "s"} ago`}.`);
  for (const b of r.health.blockers.slice(0, 3)) L.push(`• Onboarding blocker: ${b}`);
  L.push("", `*Today${who ? ` ${who.trim()}` : ""}*`);
  r.todos.forEach((t, i) => L.push(`${i + 1}. ${t}`));
  return redactMoney(L.join("\n"));
}

export const usdFmt = usd;
export const pctFmt = pct;
