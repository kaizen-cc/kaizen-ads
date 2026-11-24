// Exec focus: each exec hears about the lines they own plus anything personal to them, and every exec hears when a
// client is on fire. The pure part (no database, no keys): the lines, which line a notification belongs to, and whether
// an exec keeps it. The database applies the same rules before a notification is stored
// (supabase/migrations/20261120170000_exec_focus.sql); keep the two in step.

import type { ServiceSlug } from "@/lib/services";

export const FOCUS_LINES = ["meta", "google", "tiktok", "email", "social", "creative", "creative_performance", "web", "crm", "finance"] as const;
export type FocusLine = (typeof FOCUS_LINES)[number];

export const FOCUS_LABEL: Record<FocusLine, string> = {
  meta: "Meta ads",
  google: "Google ads",
  tiktok: "TikTok ads",
  email: "Email",
  social: "Organic social",
  creative: "Creative for ads",
  creative_performance: "Creative underperforming or fatigued",
  web: "Web",
  crm: "CRM",
  finance: "Billing and finance",
};

export const isFocusLine = (x: unknown): x is FocusLine => typeof x === "string" && (FOCUS_LINES as readonly string[]).includes(x);

/** Only real lines, once each, in the standard order */
export const cleanFocus = (xs: readonly unknown[] | null | undefined): FocusLine[] => FOCUS_LINES.filter((l) => (xs ?? []).includes(l));

/** The line a service (as Kaizen Track names it) belongs to */
export const SERVICE_FOCUS: Record<ServiceSlug, FocusLine> = {
  "facebook-ads": "meta",
  "google-ads": "google",
  "tiktok-ads": "tiktok",
  creative: "creative",
  "email-marketing": "email",
  "social-media": "social",
  "web-design": "web",
  crm: "crm",
};

/** A line from anything that names one: a focus line, a service slug, an ad platform or a watch line */
export function lineOf(x: string | null | undefined): FocusLine | null {
  const v = String(x ?? "").trim().toLowerCase();
  if (!v) return null;
  if (isFocusLine(v)) return v;
  if (v in SERVICE_FOCUS) return SERVICE_FOCUS[v as ServiceSlug];
  if (v === "facebook" || v === "instagram") return "meta";
  if (v === "klaviyo" || v === "brevo" || v === "sms") return "email";
  return null;
}

/** The lines a client buys, from its services */
export const clientLines = (services: readonly string[] | null | undefined): FocusLine[] => cleanFocus((services ?? []).map((s) => lineOf(s)));

// ─── Classifying a notification ──────────────────────────────────────────────

/** Notifications about one person's own work: what's on them, what they owe, what they asked for or must decide */
export const PERSONAL_PREFIXES = [
  "assign", "buyer", "asana", "handoff", "ev", "owed", "owed2", "said", "said2", "agent-ask", "review-todo", "task-ready",
  "feedback-reply", "feedback-review", "feedback-fixed", "feedback-digest", "feedback-urgent", "ai-share", "ai-project",
  "recap", "assistant-report", "call-safety", "agent-heads", "drift", "bible-change", "bible-change-decided",
  "contradiction", "contradictions", "connector-ask", "connector-ready", "connector-declined", "saved-used", "lab-called",
  "lab-note", "dashboard-question", "launch-signoff", "mention", "ask", "call-prep",
] as const;
export const PERSONAL_KINDS = ["assigned", "handoff", "agent", "assistant", "feedback", "recap", "mention", "ask", "safety"] as const;

/** Escalations about someone else's client conversation: matched by the client's lines when no line is set */
export const CLIENT_SCOPED_PREFIXES = ["owed-lead", "said-lead", "said-moving"] as const;

/** Key prefixes that name their line outright (the rest are looked up: an ad account's platform, a watch flag's line) */
export const PREFIX_LINE: Record<string, FocusLine> = {
  "email-audit": "email",
  "email-sprint": "email",
  asana_email: "email",
  "social-audit": "social",
  "social-sprint": "social",
  "ai-review": "creative",
  "copy-rebut": "creative",
  "copy-force": "creative",
  "client-auto": "creative",
  "client-wait": "creative",
  "site-issues": "web",
  "package-gap": "creative",
  "package-risk": "creative",
};
/** Kinds that name their line outright */
export const KIND_LINE: Record<string, FocusLine> = {
  fatigue: "creative_performance",
  email_sprint: "email",
  email_audit: "email",
  social_sprint: "social",
  social_audit: "social",
  website: "web",
};

export const prefixOf = (key: string | null | undefined) => String(key ?? "").split(":")[0];

export type NoticeShape = { kind: string; key: string; line?: string | null; fire?: boolean | null; clientLines?: readonly string[] | null };

/** The line a notification belongs to: the one its writer set, else read from its key or kind (null when it has none) */
export function classifyNotice(n: Pick<NoticeShape, "kind" | "key" | "line">): FocusLine | null {
  const set = lineOf(n.line);
  if (set) return set;
  const p = prefixOf(n.key);
  if (PREFIX_LINE[p]) return PREFIX_LINE[p];
  if (KIND_LINE[n.kind]) return KIND_LINE[n.kind];
  // An ad account's connection, a business audit per platform ("ba:<audit>:<platform>")
  if (p === "connection" && /meta/.test(n.key)) return "meta";
  if (p === "ba") return lineOf(n.key.split(":")[2]);
  return null;
}

/** About this person's own work, whatever line it's on */
export function isPersonal(n: Pick<NoticeShape, "kind" | "key">): boolean {
  const p = prefixOf(n.key);
  if ((CLIENT_SCOPED_PREFIXES as readonly string[]).includes(p)) return false;
  return (PERSONAL_PREFIXES as readonly string[]).includes(p) || (PERSONAL_KINDS as readonly string[]).includes(n.kind);
}

/**
 * Whether a line matches a focus. "creative" (creative for ads) covers its performance too; "creative_performance"
 * covers only underperforming or fatigued creative, never production.
 */
export function lineInFocus(line: FocusLine | null, focus: readonly FocusLine[]): boolean {
  if (!line) return false;
  if (focus.includes(line)) return true;
  return line === "creative_performance" && focus.includes("creative");
}

export type Keep = { keep: boolean; why: "fire" | "personal" | "focus" | "client" | "unset" | "outside" };

/**
 * Whether an exec keeps a notification: a client on fire, something personal to them, or a line in their focus (a
 * client-scoped escalation with no line matches by the client's lines). An exec with no focus set keeps everything.
 */
export function execKeeps(n: NoticeShape, focus: readonly FocusLine[]): Keep {
  if (n.fire) return { keep: true, why: "fire" };
  if (!focus.length) return { keep: true, why: "unset" };
  if (isPersonal(n)) return { keep: true, why: "personal" };
  const line = classifyNotice(n);
  if (line) return lineInFocus(line, focus) ? { keep: true, why: "focus" } : { keep: false, why: "outside" };
  if ((CLIENT_SCOPED_PREFIXES as readonly string[]).includes(prefixOf(n.key)) && (n.clientLines ?? []).some((l) => lineInFocus(lineOf(l), focus))) return { keep: true, why: "client" };
  return { keep: false, why: "outside" };
}

// ─── The recap and Overview ──────────────────────────────────────────────────

/** The line a recap item is about, from its topic and key (the same lines the notifications use) */
export function itemLine(i: { topic: string; key: string; title?: string }): FocusLine | null {
  const p = prefixOf(i.key);
  if (i.topic === "email") return "email";
  if (i.topic === "social") return "social";
  if (i.topic === "ads" || p === "fatigue") return "creative_performance";
  // Briefs, allotments and work running late are creative production
  if (i.topic === "briefs" || i.topic === "allotments" || i.topic === "work") return "creative";
  if (i.topic === "accounts" || p === "kpi") {
    const t = i.title ?? "";
    return /Google/.test(t) ? "google" : /TikTok/.test(t) ? "tiktok" : "meta";
  }
  return null;
}

/** Recap items that are always this person's own: their tickets and tasks, what they owe or said yes to */
const OWN_PREFIXES = new Set(["mine", "owed", "owed2", "said", "said2", "callp", "recap"]);

type Item = { topic: string; key: string; title?: string; clientId?: string | null };
export type ItemContext = { onFire?: ReadonlySet<string>; clientLines?: ReadonlyMap<string, readonly FocusLine[]> };

/**
 * For an exec: whether a recap item stays on their day (their focus lines, anything on them, a client on fire) or goes
 * to the quiet "Everything else". An item with no line of its own (a promise or message waiting on us, a new client)
 * stays when the client buys a line in their focus.
 */
export function itemInFocus(i: Item, focus: readonly FocusLine[], ctx: ItemContext = {}): boolean {
  if (!focus.length) return true;
  if (i.topic === "mine" || OWN_PREFIXES.has(prefixOf(i.key))) return true;
  if (i.clientId && ctx.onFire?.has(i.clientId)) return true;
  const line = itemLine(i);
  if (line) return lineInFocus(line, focus);
  const lines = i.clientId ? (ctx.clientLines?.get(i.clientId) ?? []) : [];
  return lines.some((l) => lineInFocus(l, focus));
}

/** An exec's day split into what's theirs (first, counted) and everything else (quiet, uncounted) */
export function splitForExec<T extends Item>(items: readonly T[], focus: readonly FocusLine[], ctx: ItemContext = {}): { mine: T[]; elsewhere: T[] } {
  const mine: T[] = [];
  const elsewhere: T[] = [];
  for (const i of items) (itemInFocus(i, focus, ctx) ? mine : elsewhere).push(i);
  return { mine, elsewhere };
}
