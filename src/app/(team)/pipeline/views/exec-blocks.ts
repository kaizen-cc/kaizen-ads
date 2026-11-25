// The Overview blocks' words and colors, and their sub-chips: plain data and pure functions, so the server pages that
// build the blocks (role-overview) and the client blocks (exec-home) share them. Never "use client": a server page
// can't call a function from a client file (Nov 23 2026: "Attempted to call itemChips() from the server").
import type { ExecCard, ExecTab } from "@/lib/exec-overview-core";
import type { TodayItem } from "@/lib/today";
import { asanaSummary } from "@/lib/asana-due";

export const BLURB: Record<ExecTab, string> = {
  needs: "Replies, promises, tasks and approvals on you",
  escalated: "Stuck 48 hours past a lead, and fires",
  accounts: "Email, social and creative off target, nothing moving (ad accounts are step-ins)",
  asana: "Every open Asana task that's yours",
  pulse: "The agency at a glance, nothing to do",
  system: "Kaizen OS itself: checks, fixes, feedback",
};

export type Tone = { accent: string; glow: string };
export const TONE: Record<ExecTab, Tone> = {
  needs: { accent: "#ff6b78", glow: "rgba(178,30,44,0.45)" },
  escalated: { accent: "#ff4d5e", glow: "rgba(200,16,46,0.5)" },
  accounts: { accent: "#f2b14c", glow: "rgba(224,150,40,0.4)" },
  asana: { accent: "#f37c86", glow: "rgba(240,106,106,0.38)" },
  pulse: { accent: "#9aa8ff", glow: "rgba(90,110,255,0.3)" },
  system: { accent: "#5be3a5", glow: "rgba(40,180,120,0.32)" },
};
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The sub-chips under a block's number: what it holds, in a few words */
export function chips(tab: ExecTab, cards: ExecCard[]): string[] {
  const count = (f: (c: ExecCard) => boolean) => cards.filter(f).length;
  if (tab === "needs")
    return [
      count((c) => c.kind === "owed") && n(count((c) => c.kind === "owed"), "reply", "replies"),
      count((c) => c.kind === "said") && n(count((c) => c.kind === "said"), "promise", "promises"),
      count((c) => c.kind === "asana" || c.kind === "mine" || c.kind === "taken") && n(count((c) => c.kind === "asana" || c.kind === "mine" || c.kind === "taken"), "task", "tasks"),
      count((c) => c.kind === "approval") && n(count((c) => c.kind === "approval"), "approval", "approvals"),
      count((c) => Boolean(c.emailDraft)) && n(count((c) => Boolean(c.emailDraft)), "email drafted", "emails drafted"),
    ].filter((x): x is string => Boolean(x));
  if (tab === "escalated")
    return [
      count((c) => c.kind === "team") && n(count((c) => c.kind === "team"), "team card", "team cards"),
      count((c) => c.kind === "stuck") && n(count((c) => c.kind === "stuck"), "client", "clients"),
      count((c) => c.severity === "fire") && n(count((c) => c.severity === "fire"), "fire", "fires"),
    ].filter((x): x is string => Boolean(x));
  if (tab === "accounts") {
    const by = new Map<string, number>();
    const lineOf = (c: ExecCard) => c.line ?? (/^(step:)?kpi:/.test(c.key) ? "meta" : /^(step:)?email-/.test(c.key) ? "email" : /^(step:)?social-/.test(c.key) ? "social" : /^(step:)?(allot-behind|fatigue):/.test(c.key) ? "creative" : null);
    for (const c of cards) {
      const l = lineOf(c);
      if (l) by.set(l, (by.get(l) ?? 0) + 1);
    }
    const L: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", email: "Email", social: "Social", creative: "Creative" };
    return [...by.entries()].map(([l, k]) => `${k} ${L[l] ?? l}`);
  }
  if (tab === "asana") {
    const setup = cards.find((c) => c.key === "asana:connect");
    if (setup) {
      const shown = cards.length - 1;
      return [setup.action.href ? "Connect Asana" : "Being set up", shown ? `${shown} from the shared view` : "nothing visible yet"];
    }
    // Beside the big number (due today): tomorrow and the rest of the week (src/lib/asana-due.ts)
    return asanaSummary(cards.filter((c) => c.kind === "asana")).chips;
  }
  if (tab === "pulse")
    return [count((c) => c.severity === "fire") && n(count((c) => c.severity === "fire"), "client on fire", "clients on fire"), count((c) => c.key.startsWith("pulse:team:")) && n(count((c) => c.key.startsWith("pulse:team:")), "lead", "leads"), "this week"].filter((x): x is string => Boolean(x));
  return [
    count((c) => c.key.startsWith("system:check:")) && n(count((c) => c.key.startsWith("system:check:")), "check failing", "checks failing"),
    count((c) => c.key.startsWith("system:fix:")) && n(count((c) => c.key.startsWith("system:fix:")), "fix to look at", "fixes to look at"),
    count((c) => c.key.startsWith("system:triage:")) && "feedback stuck",
  ].filter((x): x is string => Boolean(x));
}

/** Colors for everyone's other blocks */
export const BLOCK_TONE: Record<string, Tone> = {
  ...TONE,
  team: { accent: "#c49bff", glow: "rgba(150,90,255,0.34)" },
  work: { accent: "#6fb6ff", glow: "rgba(60,140,255,0.34)" },
  briefs: { accent: "#7fe0c8", glow: "rgba(40,190,160,0.3)" },
  panel: { accent: "#9aa8ff", glow: "rgba(90,110,255,0.28)" },
};

/** The sub-chips of a block of items: how urgent, how late, how many clients */
export function itemChips(id: string, cards: ExecCard[]): string[] {
  if (id in BLURB) return chips(id as ExecTab, cards);
  const now = Date.now();
  const crit = cards.filter((c) => c.severity === "critical" || c.severity === "fire").length;
  const late = cards.filter((c) => c.due && Date.parse(c.due) < now).length;
  const clients = new Set(cards.map((c) => c.client).filter(Boolean)).size;
  return [crit && `${crit} critical`, late && `${late} overdue`, clients > 1 && `${clients} clients`].filter((x): x is string => Boolean(x));
}


/**
 * The Asana block's header (owner, Nov 24 2026): the big number is what's due today (overdue included, said so), never
 * every open task; "N open in all" opens the whole list. Not connected: a word, not a count of what the shared view sees.
 */
export function asanaLabel(id: string, cards: ExecCard[]): { bigLabel?: string; count?: number; blurb?: string; allChip?: string } {
  if (id !== "asana") return {};
  const setup = cards.find((c) => c.key === "asana:connect");
  if (setup) return { bigLabel: setup.action.href ? "Connect" : "Soon" };
  const s = asanaSummary(cards.filter((c) => c.kind === "asana"));
  return { count: s.big, blurb: s.label, ...(s.big === 0 ? { bigLabel: "0" } : {}), ...(s.all ? { allChip: `${s.all} open in all` } : {}) };
}

/** A recap item as a block card (an exec's and a lead's own linked items carry their card already) */
export function itemCard(i: TodayItem): ExecCard {
  if (i.exec) return i.exec;
  const kind: ExecCard["kind"] = i.key.startsWith("lead:") ? "stuck" : /^owed/.test(i.key) ? "owed" : /^said/.test(i.key) ? "said" : i.key.startsWith("draft:") ? "draft" : i.key.startsWith("todo:") ? "todo" : "mine";
  // A saved recap from before an update can carry an item without its action: never let one item break the page
  const act = (i as Partial<TodayItem>).action;
  const href = act?.href ?? (i.clientSlug ? `/clients/${i.clientSlug}` : null);
  return {
    key: i.key,
    tab: i.topic as ExecTab,
    kind,
    client: i.client === "Team" ? null : i.client,
    clientId: i.clientId,
    clientSlug: i.clientSlug || null,
    title: i.title,
    detail: i.story,
    severity: i.tier === "critical" ? "critical" : i.tier === "high" ? "high" : "normal",
    due: i.due ?? null,
    action: { label: act?.label ?? "Open", href },
    // The email drafted for it (its main action) and the conversation behind it
    emailDraft: i.emailDraft ?? null,
    context: i.context ?? null,
    subs: i.subs ?? null,
    subsTitle: i.subsTitle ?? null,
    source: i.source ?? null,
    routine: i.routine ?? null,
  };
}

/**
 * The card an item sheet (?item=<key>) opens on (issue #153: a task clicked in the Overview's list opened nothing for
 * every role but an exec, and nothing for an item outside the blocks): the blocks' own card first, else the same item
 * anywhere on the person's day.
 */
export function sheetCardFor(key: string | null, blockCards: readonly ExecCard[], dayCards: readonly ExecCard[] = []): ExecCard | undefined {
  if (!key) return undefined;
  return blockCards.find((c) => c.key === key) ?? dayCards.find((c) => c.key === key);
}
