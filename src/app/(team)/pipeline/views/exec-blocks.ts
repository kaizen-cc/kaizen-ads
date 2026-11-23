// The Overview blocks' words and colors, and their sub-chips: plain data and pure functions, so the server pages that
// build the blocks (role-overview) and the client blocks (exec-home) share them. Never "use client": a server page
// can't call a function from a client file (Nov 23 2026: "Attempted to call itemChips() from the server").
import type { ExecCard, ExecTab } from "@/lib/exec-overview-core";

export const BLURB: Record<ExecTab, string> = {
  needs: "Replies, promises, tasks and approvals on you",
  escalated: "Stuck 48 hours past a lead, and fires",
  accounts: "Your lines, off target, nothing in motion",
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
    ].filter((x): x is string => Boolean(x));
  if (tab === "escalated")
    return [
      count((c) => c.kind === "team") && n(count((c) => c.kind === "team"), "team card", "team cards"),
      count((c) => c.kind === "stuck") && n(count((c) => c.kind === "stuck"), "client", "clients"),
      count((c) => c.severity === "fire") && n(count((c) => c.severity === "fire"), "fire", "fires"),
    ].filter((x): x is string => Boolean(x));
  if (tab === "accounts") {
    const by = new Map<string, number>();
    for (const c of cards) by.set(c.line ?? "other", (by.get(c.line ?? "other") ?? 0) + 1);
    const L: Record<string, string> = { meta: "Meta", google: "Google", tiktok: "TikTok", email: "Email", social: "Social", creative: "Creative" };
    return [...by.entries()].map(([l, k]) => `${k} ${L[l] ?? l}`);
  }
  if (tab === "asana") {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const week = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const day = (c: ExecCard) => (c.due ? c.due.slice(0, 10) : null);
    const late = count((c) => Boolean(day(c) && day(c)! < today));
    const now = count((c) => day(c) === today);
    const soon = count((c) => Boolean(day(c) && day(c)! > today && day(c)! <= week));
    return [late && `${late} overdue`, now && `${now} today`, soon && `${soon} this week`].filter((x): x is string => Boolean(x));
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

