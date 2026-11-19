// A client's monthly email allotment, as Kaizen sells it (owner's pricing deck and SOWs, Nov 19 2026). Four pools,
// each a range paced against its top: campaign emails, SMS messages, flows (each flow request counts once, building or
// optimizing) and the emails across flows. The month's cap comes from, first that applies: a month set by hand, the
// client's own Scope of Work month, the 3-Month Initial Setup by its start date (M1 Foundation, M2 Expansion, M3
// Ongoing), then the ongoing tier (Basic, Silver, Gold). "Used" counts everything in the production line: what was asked
// this cycle plus whatever is still moving from earlier ones, the same rule as creative. The database view
// client_email_allotment counts with the same rule as requestUnits here (public.email_request_units). Pure: the pages,
// the agents and the tests (tests/email-allotment.test.ts) agree.

export type EmailPool = "campaigns" | "sms" | "flows" | "flowEmails";
export type Units = Record<EmailPool, number>;
const none = (): Units => ({ campaigns: 0, sms: 0, flows: 0, flowEmails: 0 });

/**
 * What one request counts, from its Asana name (and kind or Request Type when known). A batch counts its sends
 * ("Email Campaign - December (5)" is 5 campaigns), an SMS batch its texts, a flow is one flow with its emails ("Email
 * Flow - Welcome Series (3)" is 1 flow, 3 flow emails), "(3 flows)" three flows. Not a request (an action item) or
 * templates: null.
 */
export function requestUnits(name: string | null | undefined, kind?: string | null, type?: string | null): Units | null {
  const n = String(name ?? "");
  const t = String(type ?? "");
  const k = String(kind ?? "");
  const isFlow = /flow/i.test(t) || (!t && (k === "flow" || /\bflows?\b/i.test(n)));
  const isSms = /sms|text/i.test(t) || (!t && /\b(sms|texts?)\b/i.test(n));
  const isTemplate = /template/i.test(t) || (!t && /\btemplates?\b/i.test(n));
  const isRequest = Boolean(t) || /\b(email|sms|text)\s+(campaigns?|flows?|blasts?)\b|\bnewsletters?\b/i.test(n);
  if (!isRequest || isTemplate) return null;
  const flowsNamed = n.match(/\((\d{1,2})\s*flows?\)/i);
  const counted = n.match(/\((\d{1,2})(?:\s*(?:emails?|campaigns?|sends?|texts?|sms|messages?))?\)/i);
  const u = none();
  if (isFlow) {
    u.flows = Math.max(1, Math.min(20, flowsNamed ? Number(flowsNamed[1]) : 1));
    u.flowEmails = flowsNamed ? 0 : Math.min(50, counted ? Number(counted[1]) : 0);
  } else if (isSms) u.sms = Math.max(1, Math.min(50, counted ? Number(counted[1]) : 1));
  else u.campaigns = Math.max(1, Math.min(50, counted ? Number(counted[1]) : 1));
  return u;
}

/** What a new request from the form counts: a campaign batch its sends, texts their texts, a flow one flow and its messages */
export function unitsOfRequest(kind: string, count: number): Units {
  const u = none();
  const c = Math.max(1, count);
  if (kind === "flow" || kind === "sms_flow") {
    u.flows = 1;
    u.flowEmails = c;
  } else if (kind === "sms") u.sms = c;
  else u.campaigns = c;
  return u;
}

/** One pool: its range (min to max, paced against max), used this cycle (done and in motion), in motion, done this cycle */
export type PoolCap = { min: number | null; max: number | null; used: number; progress: number; done: number };

export type EmailAllotment = {
  campaigns: PoolCap;
  sms: PoolCap;
  flows: PoolCap;
  flowEmails: PoolCap;
  /** Where the cap comes from: a month set by hand, this month of the client's SOW, the setup month, or their tier (null: none set) */
  source: "manual" | "sow" | "setup" | "package" | "strategy" | null;
  /** The month's name ("Setup month 2: Expansion", the SOW's "Month 1") or the tier's ("Basic") */
  label: string | null;
  /** The setup month's deliverables, in words */
  notes: string | null;
  packageKey: string | null;
  cycle: { start: string; end: string } | null;
};

export type EmailAllotmentRow = {
  client_id: string;
  campaigns_min: number | null;
  campaigns_per_month: number | null;
  sms_min: number | null;
  sms_per_month: number | null;
  flows_per_month: number | null;
  flow_emails_min: number | null;
  flow_emails_per_month: number | null;
  cap_source: EmailAllotment["source"];
  scope_label: string | null;
  scope_notes: string | null;
  package_key: string | null;
  package_label: string | null;
  campaigns_used: number;
  sms_used: number;
  flows_used: number;
  flow_emails_used: number;
  campaigns_progress: number;
  sms_progress: number;
  flows_progress: number;
  flow_emails_progress: number;
  period_start: string | null;
  period_end: string | null;
  campaigns_done?: number;
  sms_done?: number;
  flows_done?: number;
  flow_emails_done?: number;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const cap = (min: unknown, max: unknown, used: unknown, progress: unknown, done: unknown): PoolCap => ({ min: num(min), max: num(max), used: Number(used) || 0, progress: Number(progress) || 0, done: Number(done) || 0 });

export const toEmailAllotment = (r: EmailAllotmentRow): EmailAllotment => ({
  campaigns: cap(r.campaigns_min, r.campaigns_per_month, r.campaigns_used, r.campaigns_progress, r.campaigns_done),
  sms: cap(r.sms_min, r.sms_per_month, r.sms_used, r.sms_progress, r.sms_done),
  flows: cap(null, r.flows_per_month, r.flows_used, r.flows_progress, r.flows_done),
  flowEmails: cap(r.flow_emails_min, r.flow_emails_per_month, r.flow_emails_used, r.flow_emails_progress, r.flow_emails_done),
  source: r.cap_source,
  label: r.cap_source === "package" ? r.package_label : r.scope_label,
  notes: r.scope_notes ?? null,
  packageKey: r.package_key,
  cycle: r.period_start && r.period_end ? { start: r.period_start, end: r.period_end } : null,
});

export const POOL_LABEL: Record<EmailPool, string> = { campaigns: "Campaigns", sms: "SMS", flows: "Flows", flowEmails: "Flow emails" };

/** One pool as shown: "3-5" for a range, paced against its top (cap); a pool with no cap shows only what was asked */
export type EmailPoolView = { key: EmailPool; label: string; cap: number | null; min: number | null; range: string | null; used: number; progress: number; done: number; left: number; over: number };

/** Each pool that has a cap, or has work asked against it (a cap of 0 shows once something is asked) */
export function emailPools(a: EmailAllotment | null | undefined): EmailPoolView[] {
  if (!a) return [];
  const out: EmailPoolView[] = [];
  for (const key of ["campaigns", "sms", "flows", "flowEmails"] as const) {
    const p = a[key];
    const max = p.max;
    if ((max == null || max === 0) && p.used === 0) continue;
    if (max == null && !a.source) continue;
    const range = max == null ? null : p.min != null && p.min < max ? `${p.min}-${max}` : String(max);
    out.push({ key, label: POOL_LABEL[key], cap: max, min: p.min, range, used: p.used, progress: p.progress, done: p.done, left: max == null ? 0 : Math.max(0, max - p.used), over: max == null ? 0 : Math.max(0, p.used - max) });
  }
  return out;
}

/** "Campaigns 3/3-5 used · 2 in progress · 1 done · SMS 0/2 used · Flows 2 asked": per pool, never summed, the overage named */
export function emailAllotmentLine(a: EmailAllotment | null | undefined): string | null {
  const pools = emailPools(a);
  if (!pools.length) return null;
  return pools.map((p) => `${p.label} ${p.range == null ? `${p.used} asked` : `${p.used}/${p.range} used`}${p.over ? ` · ${p.over} over` : ""}${p.progress ? ` · ${p.progress} in progress` : ""}${p.done ? ` · ${p.done} done` : ""}`).join(" · ");
}

/** How far through the cycle (0 to 1) */
export function emailCycleElapsed(cycle: { start: string; end: string } | null | undefined, now = new Date()) {
  if (!cycle) return now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const a = new Date(`${cycle.start}T00:00:00`).getTime();
  const b = new Date(`${cycle.end}T00:00:00`).getTime();
  return Math.max(0, Math.min(1, (now.getTime() - a) / Math.max(1, b - a)));
}

/** Behind pace, on pace, over, or none set, against each pool's top: for the picker's groups. Score sorts the furthest behind first. */
export function emailPace(a: EmailAllotment | null | undefined, now = new Date()): { group: "behind" | "pace" | "over" | "none"; score: number } {
  const pools = emailPools(a).filter((p): p is EmailPoolView & { cap: number } => p.cap != null && p.cap > 0);
  if (!pools.length) return { group: "none", score: 1e9 };
  const over = pools.filter((p) => p.over > 0);
  if (over.length) return { group: "over", score: 1e6 + Math.max(...over.map((p) => p.over / Math.max(1, p.cap))) };
  const elapsed = Math.max(0.05, emailCycleElapsed(a?.cycle, now));
  const ratio = Math.min(...pools.map((p) => p.used / Math.max(1, p.cap) / elapsed));
  return { group: ratio < 0.7 ? "behind" : "pace", score: ratio };
}

const WORD: Record<EmailPool, [string, string]> = { campaigns: ["campaign", "campaigns"], sms: ["text", "texts"], flows: ["flow", "flows"], flowEmails: ["flow email", "flow emails"] };
const say = (key: EmailPool, n: number) => `${n} ${WORD[key][n === 1 ? 0 : 1]}`;

/** What a request would leave: "Counts as 3 campaigns · 2 of 5 left after this" / "1 over this month's 5" */
export function requestFit(a: EmailAllotment | null | undefined, kind: string, count: number): { tone: "ok" | "warn" | "none"; text: string } {
  const u = unitsOfRequest(kind, count);
  const keys = (Object.keys(u) as EmailPool[]).filter((k) => u[k] > 0);
  const counts = keys.map((k) => say(k, u[k])).join(" and ");
  const pools = emailPools(a);
  const notes: string[] = [];
  let warn = false;
  for (const k of keys) {
    const p = pools.find((x) => x.key === k);
    if (!p || p.cap == null) continue;
    const after = p.cap - p.used - u[k];
    if (after >= 0) notes.push(`${after} of ${p.range} ${WORD[k][1]} left after this`);
    else {
      warn = true;
      notes.push(`${-after} over this month's ${p.range} ${WORD[k][1]}`);
    }
  }
  if (!notes.length) return { tone: "none", text: `Counts as ${counts}` };
  return { tone: warn ? "warn" : "ok", text: `Counts as ${counts} · ${notes.join(" · ")}` };
}

// ─── Scope of Work ───────────────────────────────────────────────────────────

export type SowMonth = { month: string; label: string; campaigns: number; campaigns_min: number; sms: number; sms_min: number; flows: number; flow_emails: number; flow_emails_min: number; notes: string };
export type SowScope = { summary: string; email_in_scope: boolean; start: string; setup: "three_month" | "sprint" | "none"; ongoing_tier: string; months: SowMonth[] };

/** Names that look like a Scope of Work */
export const SOW_NAME = /\bsows?\b|scope\s*of\s*work|statement\s*of\s*work|\bscope\b.*\b(sprint|onboarding|month)/i;

const whole = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

/** A SOW's read, made safe: months as YYYY-MM-01, counts whole and in range (a min never above its max), at most 24 months */
export function cleanScope(s: Partial<SowScope> | null | undefined): SowScope {
  const months = (Array.isArray(s?.months) ? s.months : [])
    .map((m) => {
      const campaigns = whole(m?.campaigns, 60);
      const sms = whole(m?.sms, 40);
      const flowEmails = whole(m?.flow_emails, 60);
      return {
        month: /^\d{4}-\d{2}/.test(String(m?.month ?? "")) ? `${String(m.month).slice(0, 7)}-01` : "",
        label: String(m?.label ?? "").slice(0, 80),
        campaigns,
        campaigns_min: Math.min(campaigns, whole(m?.campaigns_min ?? campaigns, 60)),
        sms,
        sms_min: Math.min(sms, whole(m?.sms_min ?? sms, 40)),
        flows: whole(m?.flows, 20),
        flow_emails: flowEmails,
        flow_emails_min: Math.min(flowEmails, whole(m?.flow_emails_min ?? flowEmails, 60)),
        notes: String(m?.notes ?? "").slice(0, 400),
      };
    })
    .filter((m) => m.month)
    .slice(0, 24);
  const tier = String(s?.ongoing_tier ?? "").toLowerCase();
  return {
    summary: String(s?.summary ?? "").slice(0, 1200),
    email_in_scope: Boolean(s?.email_in_scope),
    start: /^\d{4}-\d{2}/.test(String(s?.start ?? "")) ? `${String(s!.start).slice(0, 7)}-01` : (months[0]?.month ?? ""),
    setup: s?.setup === "three_month" || s?.setup === "sprint" ? s.setup : "none",
    ongoing_tier: ["basic", "silver", "gold"].includes(tier) ? tier : "",
    months,
  };
}
