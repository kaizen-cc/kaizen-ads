// The email audit's plain parts, kept apart from the network and the database so they can be tested: what the audit
// reads (a digest of the Klaviyo account and the score's checks), the findings the numbers prove on their own, the shape
// the AI writes into, and the rule for when an account audits itself. The audit mirrors the ads audit: it reads, says
// why the account is where it is, and writes the plan the email team ticks off.

import { emailBand, type EmailCheck, type EmailScore } from "@/lib/email-score";
import type { ClientKlaviyo } from "@/lib/klaviyo/store";

export const EMAIL_AREAS = ["deliverability", "flows", "campaigns", "segmentation", "list_health", "offers", "subject_lines", "design", "tracking", "cadence"] as const;
export type EmailArea = (typeof EMAIL_AREAS)[number];
export const AREA_LABEL: Record<EmailArea, string> = {
  deliverability: "Deliverability",
  flows: "Flows",
  campaigns: "Campaigns",
  segmentation: "Segmentation",
  list_health: "List health",
  offers: "Offers",
  subject_lines: "Subject lines",
  design: "Design",
  tracking: "Tracking",
  cadence: "Cadence",
};

/** The people an action can belong to: the three email seats, or the client */
export const EMAIL_OWNERS = ["email_strategist", "email_designer", "email_builder", "client"] as const;
export type EmailOwner = (typeof EMAIL_OWNERS)[number];
export const OWNER_LABEL: Record<EmailOwner, string> = { email_strategist: "Email strategist", email_designer: "Email designer", email_builder: "Email builder", client: "Client" };

export type EmailAction = { title: string; area: EmailArea; owner: EmailOwner; when: "now" | "this_week" | "next"; steps: string[]; why: string; impact: string; effort: "low" | "medium" | "high" };

export type EmailAuditResult = {
  verdict: { status: "red" | "watch" | "good"; headline: string; summary: string };
  /** What I found: why the account is where it is */
  diagnosis: string;
  causes: { title: string; area: EmailArea; severity: "high" | "medium" | "low"; evidence: string[] }[];
  actions: EmailAction[];
  tests: { name: string; hypothesis: string; setup: string; metric: string; success: string }[];
  watch: string[];
  questions: string[];
};

const S = { type: "string" } as const;
const list = (items: object) => ({ type: "array", items }) as const;
const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as const;
const enumOf = (v: readonly string[]) => ({ type: "string", enum: [...v] }) as const;

export const EMAIL_AUDIT_SCHEMA = obj({
  verdict: obj({ status: enumOf(["red", "watch", "good"]), headline: S, summary: S }),
  diagnosis: S,
  causes: list(obj({ title: S, area: enumOf(EMAIL_AREAS), severity: enumOf(["high", "medium", "low"]), evidence: list(S) })),
  actions: list(obj({ title: S, area: enumOf(EMAIL_AREAS), owner: enumOf(EMAIL_OWNERS), when: enumOf(["now", "this_week", "next"]), steps: list(S), why: S, impact: S, effort: enumOf(["low", "medium", "high"]) })),
  tests: list(obj({ name: S, hypothesis: S, setup: S, metric: S, success: S })),
  watch: list(S),
  questions: list(S),
});

export const EMAIL_AUDIT_SYSTEM = `You are Kaizen Marketing's Email Strategist, auditing one client's Klaviyo account for the email strategist who holds it. This is a real audit and the team acts on it today. Speak to the strategist directly, in the first person ("I found", "I'd"), plain and specific.
Read everything given: the email score and its eight checks (the month's revenue pace against its target first) (each value against its bar and the points it costs), the last 30 days against the 30 before, campaigns with subject lines and results, flows and which key flows are missing, list and segment health, deliverability signals, and the client page (Brand Bible, memory, calls) when it is given.
Argue from this account's numbers. Every cause and action names the check or the campaign or flow it rests on, with the value against its bar. Order by money and risk: deliverability first when it is under its bar (it caps everything), then the flows that earn while nobody works, then campaign cadence, offers, segmentation and subject lines. Never recommend sending harder to a list that is bouncing, complaining or unsubscribing: a smaller, warmer segment first. Segments: when a <segments> block is given, recommend which lists and segments to send to and which to leave out, by name, from its numbers. Say who to INCLUDE and who to EXCLUDE on the next sends (engaged 30, 60 or 90 days when deliverability is under its bar, with the unengaged left out; zero-time purchasers targeted with a first-purchase offer while recent buyers are excluded; an overused or underperforming segment rested or trimmed). Put them in the segmentation actions with the segment names and the number each rests on, and treat the similar-clients patterns only as ideas to test, never as proof. If audiences are not recorded yet, say segment advice waits for the next full read. A check with nothing to measure is not a failure: say what is missing to measure it. If the data is too thin to judge something, say so instead of guessing, and do not invent a benchmark that is not in what you were given.
Nothing here sends, edits or schedules in Klaviyo: every action is made by the email team in Klaviyo and ticked off in Kaizen OS. Refer to people by role, never by name. No em dashes.

verdict: status (red: the score is under 60; watch: 60 to 79; good: 80 or more), a headline in one line, and a 2 or 3 sentence summary.
diagnosis: 2 to 4 short paragraphs on why the score is where it is. Separate cause from symptom; say what changed and when.
causes: the root causes, most important first, each with real numbers as evidence.
actions: 4 to 9 moves, most important first. owner is the email strategist, the email designer (copy, subject lines, layout), the email builder (building in Klaviyo) or the client (approvals, offers, data). Each has numbered steps a person can follow, why, the expected impact on a named check, and the effort.
tests: up to 3 tests worth running (subject line, offer, send time, segment), each with a hypothesis, setup, the metric and what counts as a win.
watch: what to keep an eye on next week. questions: what to ask the client.`;

type Money = (x: number) => string;
export const moneyFor = (currency: string | null | undefined): Money => (x) => `${!currency || currency === "USD" ? "$" : `${currency} `}${Math.round(x).toLocaleString("en-US")}`;

const pct = (x: number | null, d = 1) => (x == null ? "n/a" : `${(x * 100).toFixed(d)}%`);

/** One check as a line: "Campaign click rate: 0.6% against a 1.0% bar, costing 4.4 of 11 points" */
export function checkLine(c: EmailCheck): string {
  const bar = c.unit === "pct" ? pct(c.bar) : c.unit === "money" ? `$${c.bar.toFixed(2)}` : String(c.bar);
  if (c.value == null) return `${c.label}: nothing to measure (bar ${bar}, ${c.weight} points, left out of the score)`;
  const value = c.unit === "pct" ? pct(c.value, c.bar < 0.02 ? 2 : 1) : c.unit === "money" ? `$${c.value.toFixed(3)}` : String(Math.round(c.value));
  return `${c.label}: ${value} against a ${bar} bar${c.met ? ", met" : `, costing ${(c.weight - c.points).toFixed(1)} of ${c.weight} points`}`;
}

export type RuleFinding = { title: string; area: EmailArea; severity: "high" | "medium" | "low"; evidence: string[] };

const CHECK_AREA: Record<EmailCheck["key"], EmailArea> = {
  pace: "campaigns",
  allotment: "cadence",
  attributed: "flows",
  rpr: "campaigns",
  deliverability: "deliverability",
  campaignOpen: "subject_lines",
  campaignClick: "design",
  flowOpen: "flows",
  flowClick: "flows",
};

/**
 * What the numbers prove on their own, before any AI: each check under its bar, worst first, and each critical key flow
 * that is missing or not live. The AI builds on these.
 */
export function ruleFindings(score: EmailScore, flows: { label: string; state: "live" | "present" | "missing"; critical?: boolean }[] = []): RuleFinding[] {
  const out: RuleFinding[] = score.weighingDown.map((c) => {
    const lost = c.weight - c.points;
    return { title: `${c.label} is under its bar`, area: CHECK_AREA[c.key], severity: lost >= 8 ? "high" : lost >= 4 ? "medium" : "low", evidence: [checkLine(c)] };
  });
  for (const f of flows) if (f.critical && f.state !== "live") out.push({ title: `${f.label} ${f.state === "missing" ? "is missing" : "is built but not live"}`, area: "flows", severity: "high", evidence: [`Key flow: ${f.label} is ${f.state === "missing" ? "not in the account" : "present but not live"}`] });
  return out;
}

const sentOn = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");

function shiftDay(day: string, n: number) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * What the audit reads: the score and its checks, the 30 days against the 30 before, deliverability, every recent
 * campaign, flows, the key flows, lists and the account's own health findings. Plain text.
 */
export function auditDigest(client: string, score: EmailScore, k: ClientKlaviyo, today: string): string {
  const money = moneyFor(k.currency);
  const n = k.now;
  const b = k.before;
  const lines: string[] = [];
  lines.push(`<email_source>The numbers are from ${k.providerName}.${k.revenueMeasured ? "" : ` ${k.providerName} reports no revenue for this client: revenue, orders and the checks built on them are not measured (never quote them as zero, never add an action about them beyond connecting revenue).`}${k.flowsKnown ? "" : ` ${k.providerName}'s API doesn't list automations: flows are not measured here, so never say a key flow is missing; ask the email team to check the account for them.`}</email_source>`);
  lines.push(`<email_score client="${client}" date="${today}">`);
  lines.push(`Score ${score.score} of 100 (${score.band === "good" ? "green, from 80" : score.band === "watch" ? "yellow, from 60" : "red, under 60"}).`);
  for (const c of score.checks) lines.push(`- ${checkLine(c)}`);
  if (score.unmeasured.length) lines.push(`Not measured: ${score.unmeasured.join(", ")} (left out, the rest scaled up).`);
  lines.push("</email_score>");
  lines.push(`<last_30_days_vs_the_30_before currency="${k.currency ?? "USD"}">`);
  if (k.revenueMeasured) {
    lines.push(`Attributed revenue ${money(n.revenue)} (before ${money(b.revenue)}): campaigns ${money(n.campaignRevenue)}, flows ${money(n.flowRevenue)}, SMS ${money(n.smsRevenue)}.`);
    lines.push(`Share of the store's revenue ${pct(n.share)}; revenue per recipient ${n.revenuePerRecipient == null ? "n/a" : `$${n.revenuePerRecipient.toFixed(3)}`}.`);
  } else lines.push("Revenue: not measured by this source.");
  lines.push(`Campaigns sent ${n.campaignsSent} (before ${b.campaignsSent}), ${n.cadence.toFixed(1)} a week. Open ${pct(n.openRate)} (before ${pct(b.openRate)}); click ${pct(n.clickRate, 2)} (before ${pct(b.clickRate, 2)}).`);
  lines.push(`Unsubscribe ${pct(n.unsubscribeRate, 2)}; spam ${pct(n.spamRate, 3)}; bounce ${pct(n.bounceRate, 2)}. List growth ${n.listGrowth == null ? "n/a" : `${n.listGrowth >= 0 ? "+" : ""}${n.listGrowth}`} profiles.`);
  if (n.estimated) lines.push("Revenue is estimated: the daily rows were missing, so it is added up from campaigns and the flows' own totals.");
  lines.push("</last_30_days_vs_the_30_before>");
  lines.push("<key_flows>");
  for (const f of k.keyFlows) lines.push(`- ${f.label}: ${f.state}${f.flows.length ? ` (${f.flows.map((x) => `${x.name} ${x.status ?? "?"} ${money(x.revenue30)}/30d`).join("; ")})` : ""}`);
  lines.push("</key_flows>");
  lines.push('<flows note="by revenue, 30 days">');
  for (const f of k.flows.slice(0, 15)) lines.push(`- ${f.name} [${f.status ?? "?"}, ${f.trigger ?? "no trigger"}]: ${money(f.revenue30)}, ${f.recipients30} recipients, open ${pct(f.openRate30)}, click ${pct(f.clickRate30, 2)}`);
  lines.push("</flows>");
  const from = shiftDay(today, -89);
  const recent = k.campaigns.filter((c) => c.sendTime && c.sendTime.slice(0, 10) >= from && c.recipients > 0).slice(0, 40);
  lines.push('<campaigns note="last 90 days, newest first">');
  for (const c of recent) lines.push(`- ${sentOn(c.sendTime)} ${c.channel} "${c.subject ?? c.name}": ${c.recipients} recipients, open ${pct(c.openRate)}, click ${pct(c.clickRate, 2)}, ${money(c.revenue)}, unsub ${c.unsubscribes}, spam ${c.spamComplaints}, bounced ${c.bounced}`);
  lines.push("</campaigns>");
  lines.push("<lists>");
  for (const a of k.audiences.filter((x) => x.profiles != null).slice(0, 12)) lines.push(`- ${a.kind} "${a.name}": ${a.profiles} profiles${a.growth ? `, ${a.growth.change >= 0 ? "+" : ""}${a.growth.change} since ${a.growth.since}` : ""}`);
  lines.push("</lists>");
  if (k.health.length) {
    lines.push('<health_findings note="the account\'s own checks">');
    for (const h of k.health) lines.push(`- ${h.tone === "bad" ? "RED" : h.tone === "warn" ? "AMBER" : "GREEN"} ${h.title}: ${h.detail}${h.action ? ` Do: ${h.action}` : ""}`);
    lines.push("</health_findings>");
  }
  if (k.warning) lines.push(`Data note: ${k.warning}`);
  return lines.join("\n");
}

// ─── Auto audits ───────────────────────────────────────────────────────────

export const REFRESH_DAYS = 3;
export const RED_BELOW = 60;

export type LastAudit = { status: "running" | "ready" | "failed"; createdAt: string; touched: boolean } | null;

/**
 * Whether an account in the red should audit itself now. The same rules as the ads audits: red with no audit yet; red
 * and the last one is three days old with nobody having started on it (no action ticked, no sprint move begun); never
 * while one is running (unless it timed out after 15 minutes) and not within six hours of a failed one.
 */
export function needsAutoAudit(score: number | null, last: LastAudit, now = Date.now()): boolean {
  if (score == null || score >= RED_BELOW) return false;
  if (!last) return true;
  const at = Date.parse(last.createdAt);
  if (last.status === "running") return now - at >= 15 * 60_000;
  if (last.status === "failed") return now - at >= 6 * 3_600_000;
  return at <= now - REFRESH_DAYS * 86_400_000 && !last.touched;
}

/** The band an audit's score belongs to (kept in step with the score itself) */
export const bandOfScore = emailBand;
