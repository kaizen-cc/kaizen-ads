// A client's monthly email allotment (owner, Nov 19 2026): campaigns (email and SMS sends) and flows (each flow
// request once, however many messages it has). The cap is the month's scope from the client's Scope of Work (onboarding
// months differ per client) or else their email package. "Used" counts everything in the production line: what was
// asked this cycle plus whatever is still moving from earlier ones, the same rule as creative. The database view
// client_email_allotment counts with the same rule as requestUnits here (public.email_request_units). Pure: the pages,
// the agents and the tests (tests/email-allotment.test.ts) agree.

export type EmailPool = "campaigns" | "flows";

/**
 * What one request counts toward, from its Asana name (and kind or Request Type when known). A batched task counts its
 * emails ("Email Campaign - December (5)" is 5 campaigns); a flow is one ("Email Flow - Welcome Series (3)" is 1)
 * unless the name counts flows ("(3 flows)" is 3). Not a request (an action item) or templates: null.
 */
export function requestUnits(name: string | null | undefined, kind?: string | null, type?: string | null): { pool: EmailPool; units: number } | null {
  const n = String(name ?? "");
  const t = String(type ?? "");
  const k = String(kind ?? "");
  const isFlow = /flow/i.test(t) || (!t && (k === "flow" || /\bflows?\b/i.test(n)));
  const isTemplate = /template/i.test(t) || (!t && /\btemplates?\b/i.test(n));
  const isRequest = Boolean(t) || /\b(email|sms|text)\s+(campaigns?|flows?|blasts?)\b|\bnewsletters?\b/i.test(n);
  if (!isRequest || isTemplate) return null;
  const m = isFlow ? n.match(/\((\d{1,2})\s*flows?\)/i) : n.match(/\((\d{1,2})(?:\s*(?:emails?|campaigns?|sends?|texts?|sms|messages?))?\)/i);
  return { pool: isFlow ? "flows" : "campaigns", units: Math.max(1, Math.min(50, m ? Number(m[1]) : 1)) };
}

/** The pool a new request draws on, by its kind in the request form */
export const poolOfKind = (kind: string): EmailPool => (/flow/.test(kind) ? "flows" : "campaigns");

/** How many units a new request counts: a flow is one, a campaign batch its sends */
export const unitsOfRequest = (kind: string, count: number) => (poolOfKind(kind) === "flows" ? 1 : Math.max(1, count));

export type EmailAllotment = {
  campaigns: number | null;
  flows: number | null;
  campaignsUsed: number;
  flowsUsed: number;
  campaignsProgress: number;
  flowsProgress: number;
  /** Where the cap comes from: this month of the client's SOW, a month set by hand, or their package (null: none set) */
  source: "sow" | "manual" | "package" | null;
  /** The SOW month's name ("Onboarding month 1") or the package's */
  label: string | null;
  packageKey: string | null;
  cycle: { start: string; end: string } | null;
};

export type EmailAllotmentRow = {
  client_id: string;
  campaigns_per_month: number | null;
  flows_per_month: number | null;
  cap_source: "sow" | "manual" | "package" | null;
  scope_label: string | null;
  package_key: string | null;
  package_label: string | null;
  campaigns_used: number;
  flows_used: number;
  campaigns_progress: number;
  flows_progress: number;
  period_start: string | null;
  period_end: string | null;
};

export const toEmailAllotment = (r: EmailAllotmentRow): EmailAllotment => ({
  campaigns: r.campaigns_per_month,
  flows: r.flows_per_month,
  campaignsUsed: Number(r.campaigns_used) || 0,
  flowsUsed: Number(r.flows_used) || 0,
  campaignsProgress: Number(r.campaigns_progress) || 0,
  flowsProgress: Number(r.flows_progress) || 0,
  source: r.cap_source,
  label: r.cap_source === "package" ? r.package_label : r.scope_label,
  packageKey: r.package_key,
  cycle: r.period_start && r.period_end ? { start: r.period_start, end: r.period_end } : null,
});

export type EmailPoolView = { key: EmailPool; label: string; cap: number; used: number; progress: number; left: number; over: number };

/** Each pool with a cap (a cap of 0 still shows when something was used against it) */
export function emailPools(a: EmailAllotment | null | undefined): EmailPoolView[] {
  if (!a) return [];
  const out: EmailPoolView[] = [];
  for (const [key, label, cap, used, progress] of [
    ["campaigns", "Campaigns", a.campaigns, a.campaignsUsed, a.campaignsProgress],
    ["flows", "Flows", a.flows, a.flowsUsed, a.flowsProgress],
  ] as const) {
    if (cap == null || (cap === 0 && used === 0)) continue;
    out.push({ key, label, cap, used, progress, left: Math.max(0, cap - used), over: Math.max(0, used - cap) });
  }
  return out;
}

/** "Campaigns 3/8 used · 2 in progress · Flows 0/1 used": per pool, never summed, the overage named */
export function emailAllotmentLine(a: EmailAllotment | null | undefined): string | null {
  const pools = emailPools(a);
  if (!pools.length) return null;
  return pools.map((p) => `${p.label} ${p.used}/${p.cap} used${p.over ? ` · ${p.over} over` : ""}${p.progress ? ` · ${p.progress} in progress` : ""}`).join(" · ");
}

/** How far through the cycle (0 to 1) */
export function emailCycleElapsed(cycle: { start: string; end: string } | null | undefined, now = new Date()) {
  if (!cycle) return now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const a = new Date(`${cycle.start}T00:00:00`).getTime();
  const b = new Date(`${cycle.end}T00:00:00`).getTime();
  return Math.max(0, Math.min(1, (now.getTime() - a) / Math.max(1, b - a)));
}

/** Behind pace, on pace, over, or none set: for the picker's groups. Score sorts the furthest behind first. */
export function emailPace(a: EmailAllotment | null | undefined, now = new Date()): { group: "behind" | "pace" | "over" | "none"; score: number } {
  const pools = emailPools(a);
  if (!pools.length) return { group: "none", score: 1e9 };
  const over = pools.filter((p) => p.over > 0);
  if (over.length) return { group: "over", score: 1e6 + Math.max(...over.map((p) => p.over / Math.max(1, p.cap))) };
  const elapsed = Math.max(0.05, emailCycleElapsed(a?.cycle, now));
  const ratio = Math.min(...pools.map((p) => p.used / Math.max(1, p.cap) / elapsed));
  return { group: ratio < 0.7 ? "behind" : "pace", score: ratio };
}

/** What a request would leave: "Uses 3 of 5 campaigns left" / "2 over the month's campaigns" */
export function requestFit(a: EmailAllotment | null | undefined, kind: string, count: number): { tone: "ok" | "warn" | "none"; text: string } {
  const pool = poolOfKind(kind);
  const p = emailPools(a).find((x) => x.key === pool);
  const units = unitsOfRequest(kind, count);
  const word = pool === "flows" ? (units === 1 ? "flow" : "flows") : units === 1 ? "campaign" : "campaigns";
  if (!p) return { tone: "none", text: `Counts as ${units} ${word}` };
  const after = p.cap - p.used - units;
  if (after >= 0) return { tone: "ok", text: `Counts as ${units} ${word} · ${after} of ${p.cap} left after this` };
  return { tone: "warn", text: `Counts as ${units} ${word} · ${-after} over this month's ${p.cap}` };
}

// ─── Scope of Work ───────────────────────────────────────────────────────────

export type SowMonth = { month: string; label: string; campaigns: number; flows: number; notes: string };
export type SowScope = { summary: string; email_in_scope: boolean; start: string; months: SowMonth[]; ongoing: { campaigns: number; flows: number } | null };

/** Names that look like a Scope of Work */
export const SOW_NAME = /\bsows?\b|scope\s*of\s*work|statement\s*of\s*work|\bscope\b.*\b(sprint|onboarding|month)/i;

/** A SOW's read, made safe: months as YYYY-MM-01, counts whole and in range, at most 24 months */
export function cleanScope(s: Partial<SowScope> | null | undefined): SowScope {
  const months = (Array.isArray(s?.months) ? s.months : [])
    .map((m) => ({
      month: /^\d{4}-\d{2}/.test(String(m?.month ?? "")) ? `${String(m.month).slice(0, 7)}-01` : "",
      label: String(m?.label ?? "").slice(0, 80),
      campaigns: Math.max(0, Math.min(60, Math.round(Number(m?.campaigns) || 0))),
      flows: Math.max(0, Math.min(20, Math.round(Number(m?.flows) || 0))),
      notes: String(m?.notes ?? "").slice(0, 400),
    }))
    .filter((m) => m.month)
    .slice(0, 24);
  const o = s?.ongoing;
  return {
    summary: String(s?.summary ?? "").slice(0, 1200),
    email_in_scope: Boolean(s?.email_in_scope),
    start: /^\d{4}-\d{2}/.test(String(s?.start ?? "")) ? `${String(s!.start).slice(0, 7)}-01` : (months[0]?.month ?? ""),
    months,
    ongoing: o && (Number(o.campaigns) > 0 || Number(o.flows) > 0) ? { campaigns: Math.max(0, Math.round(Number(o.campaigns) || 0)), flows: Math.max(0, Math.round(Number(o.flows) || 0)) } : null,
  };
}
