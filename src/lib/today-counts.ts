import type { Tier, TodayItem, TopicKey } from "@/lib/today";
import { subsLeft, type ExecCard, type SubItem, type SubsTitle } from "@/lib/exec-overview-core";
import { dueByToday } from "@/lib/asana-due";

// How the daily recap is counted, in one place for every screen that shows its numbers (the recap itself, the "Your
// day" card on the Overview and the theme cards under it). Everything about one client in a topic is one look: three
// unanswered messages from the same client are one row, counted once. Items without a client (a teammate's message)
// gather as one "Team" row. A client's row is as urgent as its most urgent item. Pure: no database, no server-only.

export const TIER_ORDER: Tier[] = ["critical", "high", "normal"];
export const TOPIC_KEYS: TopicKey[] = ["fire", "mine", "radar", "promises", "onboarding", "accounts", "email", "social", "work", "briefs", "ads", "allotments", "elsewhere", "needs", "escalated", "pulse", "system", "team", "asana"];
/** An exec's day plays in its tabs' order, whatever is most critical: Needs me, Escalated, Accounts, Pulse, System */
export const EXEC_TOPICS: TopicKey[] = ["needs", "escalated", "accounts", "asana", "pulse", "system"];
/** An exec's tabs that count items, one card each, like their Overview block (the rest count client rows) */
export const ITEM_TOPICS: TopicKey[] = ["needs", "escalated", "system"];
/** Everyone's blocks, in the order their Overview and recap show them (owner, Nov 23 2026) */
export const BLOCK_ORDER: TopicKey[] = ["needs", "escalated", "team", "work", "accounts", "briefs", "asana", "pulse", "system"];
const execRank = (t: TopicKey) => (BLOCK_ORDER.includes(t) ? BLOCK_ORDER.indexOf(t) : 99);
/** Topics only a block day has: their presence means the blocks' order applies */
const EXEC_ONLY: TopicKey[] = ["needs", "escalated", "pulse", "system", "asana", "team"];
/** An exec's "Everything else": outside their focus, shown last and left out of every total */
export const QUIET_TOPIC: TopicKey = "elsewhere";
const RANK: Record<Tier, number> = { critical: 2, high: 1, normal: 0 };

type Countable = Pick<TodayItem, "client" | "tier" | "score" | "topic"> & { due?: string | null };

/** Everything in a topic about one client, gathered: one row to review, counted once. */
export type Bucket<T extends Countable = TodayItem> = { key: string; client: string; items: T[]; tier: Tier };

/** The client a recap item belongs to, by name: some items (promises from calls, replies) carry no client id, and the same client must still be one row. */
export function bucketKey(i: Pick<TodayItem, "client">): string {
  return (i.client ?? "").trim().toLowerCase().replace(/\s+/g, " ") || "team";
}

/** A list's items gathered by client, most urgent client first, each client's items most urgent first. */
export function bucketsOf<T extends Countable>(list: T[]): Bucket<T>[] {
  const sorted = [...list].sort((a, b) => b.score - a.score);
  const m = new Map<string, T[]>();
  for (const i of sorted) {
    const k = bucketKey(i);
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return [...m.entries()].map(([key, items]) => ({ key, client: items[0].client, items, tier: items.reduce<Tier>((t, i) => (RANK[i.tier] > RANK[t] ? i.tier : t), "normal") }));
}

/** The topics in a list, most critical first (its most urgent item decides), each with its items and clients. */
export function topicGroups<T extends Countable>(items: T[]): { topic: TopicKey; items: T[]; buckets: Bucket<T>[] }[] {
  const m = new Map<TopicKey, T[]>();
  for (const i of items) m.set(i.topic, [...(m.get(i.topic) ?? []), i]);
  const rank = [...m.keys()].some((t) => EXEC_ONLY.includes(t)) ? execRank : () => 0;
  return [...m.entries()]
    .map(([topic, list]) => {
      const sorted = [...list].sort((a, b) => b.score - a.score);
      return { topic, items: sorted, buckets: bucketsOf(sorted) };
    })
    .sort((a, b) => Number(a.topic === QUIET_TOPIC) - Number(b.topic === QUIET_TOPIC) || rank(a.topic) - rank(b.topic) || b.items[0].score - a.items[0].score);
}

export type Looks = {
  /** Every client row in every topic (the sum of the per-topic counts) */
  total: number;
  /** Client rows by how urgent they are (a row is as urgent as its most urgent item) */
  byTier: Record<Tier, number>;
  /** Client rows per topic, and how many of them are critical */
  byTopic: Record<TopicKey, { n: number; critical: number }>;
};

/** The recap's numbers: client rows, per topic and by urgency. */
export function countLooks(items: Countable[]): Looks {
  const byTier: Record<Tier, number> = { critical: 0, high: 0, normal: 0 };
  const byTopic = Object.fromEntries(TOPIC_KEYS.map((k) => [k, { n: 0, critical: 0 }])) as Looks["byTopic"];
  let total = 0;
  // An Asana task counts once it's due today or overdue; the rest of someone's Asana isn't today's to-do (src/lib/asana-due.ts)
  items = items.filter((i) => i.topic !== "asana" || dueByToday(i.due));
  for (const g of topicGroups(items)) {
    for (const b of g.buckets) {
      // Everything else has its own count, never in the totals; so does an exec's Pulse (read only, never a to-do)
      if (g.topic === QUIET_TOPIC || g.topic === "pulse") {
        byTopic[g.topic].n++;
        continue;
      }
      // An exec's tabs count items, one card each, the same number their Overview block shows (owner, Nov 25 2026:
      // the hero said 2, the recap 1 and the list 5); every other topic counts client rows
      const each = ITEM_TOPICS.includes(g.topic) ? b.items : [b];
      for (const x of each) {
        total++;
        byTier[x.tier]++;
        byTopic[g.topic].n++;
        if (x.tier === "critical") byTopic[g.topic].critical++;
      }
    }
  }
  return { total, byTier, byTopic };
}

/**
 * Still open for this person: not done, not set aside, and not put off until tomorrow (Later). One rule for every
 * list and count, so a Later leaves them all at once (owner, Nov 25 2026). A "saved" item from an earlier day is back
 * and open again.
 */
export const isOpenMark = (m: string | null | undefined) => m !== "done" && m !== "dismissed" && m !== "snoozed";

/** A client row's open items, the one count its row, its overview and its pill all show. */
export function openOf<T extends { key: string }>(items: T[], marks: Record<string, string | undefined>): T[] {
  return items.filter((i) => isOpenMark(marks[i.key]));
}

/**
 * The big number on a client's row: one open item shows its own number ("7 business days past when it was due");
 * several show how many are open, the most pressing one's number under it, so the number always matches the count.
 */
export function rowStat(open: Pick<TodayItem, "stat">[], lead: Pick<TodayItem, "stat">): { value: string; label: string } {
  if (open.length <= 1) return (open[0] ?? lead).stat;
  const top = open[0].stat;
  return { value: String(open.length), label: `open · top: ${top.value} ${top.label}`.trim() };
}

const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What a topic's recap screen says, in one line, for n client rows. */
export function lookHeadline(topic: TopicKey, n: number): string {
  switch (topic) {
    case "fire":
      return `${n} ${s(n, "client is", "clients are")} on fire`;
    case "elsewhere":
      return `${n} ${s(n, "client", "clients")} outside your focus, when you want them`;
    case "mine":
      return `${n} ${s(n, "thing is", "things are")} on you today`;
    case "radar":
      return `${n} ${s(n, "thing is", "things are")} coming to your board soon`;
    case "promises":
      return `${n} ${s(n, "thing is", "things are")} waiting on us: promised, said yes to, or not answered`;
    case "onboarding":
      return `${n} new ${s(n, "client needs", "clients need")} you`;
    case "accounts":
      return `${n} ${s(n, "client has", "clients have")} accounts off or near target`;
    case "email":
      return `${n} email ${s(n, "client needs", "clients need")} a look: the account, its plan, its report or an idea`;
    case "social":
      return `${n} social ${s(n, "client needs", "clients need")} a look: results, posting or a report`;
    case "work":
      return `${n} ${s(n, "client has", "clients have")} work stuck or running late`;
    case "briefs":
      return `${n} ${s(n, "client has", "clients have")} brief ideas, when you have a moment`;
    case "ads":
      return `${n} ${s(n, "client has", "clients have")} ads ready for a refresh`;
    case "allotments":
      return `${n} ${s(n, "client is", "clients are")} behind on creative`;
    case "needs":
      return `${n} ${s(n, "thing needs", "things need")} you`;
    case "escalated":
      return `${n} stuck past a lead, or on fire`;
    case "pulse":
      return "The agency at a glance";
    case "system":
      return `${n} ${s(n, "thing", "things")} in Kaizen OS itself`;
    case "team":
      return `${n} ${s(n, "teammate's item has", "teammates' items have")} sat 48 hours with nothing moving`;
    case "asana":
      return `${n} Asana ${s(n, "task is", "tasks are")} due today`;
  }
}

/** The same number, short, for a chip on the Overview: reads the same as the recap's headline. */
export function lookChip(topic: TopicKey, n: number): string {
  switch (topic) {
    case "fire":
      return `${n} on fire`;
    case "elsewhere":
      return `${n} everything else`;
    case "mine":
      return `${n} on you today`;
    case "radar":
      return `${n} on your radar`;
    case "promises":
      return `${n} waiting on us`;
    case "onboarding":
      return `${n} new ${s(n, "client needs", "clients need")} you`;
    case "accounts":
      return `${n} ${s(n, "client", "clients")} with accounts off or near target`;
    case "email":
      return `${n} email ${s(n, "client", "clients")} to look at`;
    case "social":
      return `${n} social ${s(n, "client", "clients")} to look at`;
    case "work":
      return `${n} ${s(n, "client", "clients")} with work stuck or late`;
    case "briefs":
      return `${n} ${s(n, "client", "clients")} with brief ideas`;
    case "ads":
      return `${n} ${s(n, "client", "clients")} with ads ready for a refresh`;
    case "allotments":
      return `${n} ${s(n, "client", "clients")} behind on creative`;
    case "needs":
      return `${n} ${s(n, "needs", "need")} you`;
    case "escalated":
      return `${n} escalated`;
    case "pulse":
      return "pulse";
    case "system":
      return `${n} system`;
    case "team":
      return `${n} stuck on your team`;
    case "asana":
      return `${n} due in Asana`;
  }
}

// One item, two places: the recap keys an item by what it is for this person (`owed:` a message waiting on you,
// `owed-lead:` one waiting on someone you lead), the Overview's Done and Dismiss by the thing itself (`owed:<id>`).
// These map one to the other, so a mark made in either place is read by both.
const HIDE_AS: Record<string, string> = { owed: "owed", owed2: "owed", "owed-lead": "owed", said: "said", said2: "said", "said-lead": "said", promise: "call", callp: "call", attention: "alert" };
const RECAP_AS: Record<string, string[]> = { owed: ["owed", "owed2", "owed-lead"], said: ["said", "said2", "said-lead"], call: ["promise", "callp"], alert: ["attention"] };

/** The Overview key (hidden_items) for a recap item, when the Overview has that item with its own Done and Dismiss. */
export function hideKeyOf(recapKey: string): string | null {
  const [kind, id] = recapKey.split(":");
  return HIDE_AS[kind] && id ? `${HIDE_AS[kind]}:${id}` : null;
}

/** Every recap key (daily_items) one item can have, from either side's key. */
export function recapKeysOf(key: string): string[] {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  const fromHide = RECAP_AS[kind];
  if (fromHide) return fromHide.map((k) => `${k}:${id}`);
  const hide = hideKeyOf(key);
  return hide ? recapKeysOf(hide) : [key];
}

/**
 * A saved review brought up to date with what this person has done since it was built, in either place: done or set
 * aside in the recap (daily_items) or cleared off the Overview (hidden_items) leaves it; saved for later shows saved.
 * Counts are redone when anything changed.
 */
export function applyMarks<T extends { items: (Countable & { key: string; state: TodayItem["state"] })[]; looks?: Looks | null }>(t: T, marks: Map<string, string>, hidden: Set<string>): T {
  let changed = false;
  const items = t.items.flatMap((i) => {
    const m = marks.get(i.key);
    const h = hideKeyOf(i.key);
    // Snoozed to a later day: gone until then, back on its own (src/lib/item-state.ts snoozeItem)
    if (m === "done" || m === "dismissed" || m === "snoozed" || (h && hidden.has(h))) {
      changed = true;
      return [];
    }
    const state = m === "saved" ? "saved" : i.state === "saved" ? "seen" : i.state;
    if (state !== i.state) changed = true;
    // A group card's own items closed since it was saved: what's left, counted again (src/lib/exec-overview-core.ts)
    let it = state === i.state ? i : { ...i, state };
    type Group = { title: string; detail?: string; story?: string; stat?: { value: string; label: string }; subs?: SubItem[] | null; subsTitle?: SubsTitle | null; exec?: ExecCard };
    const g = it as unknown as Group;
    if (g.subs?.length) {
      const closed = { has: (k: string) => ["done", "dismissed"].includes(marks.get(k) ?? "") };
      const next = subsLeft(g, closed);
      if (!next) {
        changed = true;
        return [];
      }
      if (next !== g) {
        changed = true;
        it = { ...it, ...next, ...(g.exec ? { exec: subsLeft(g.exec, closed) ?? g.exec } : {}) } as typeof it;
      }
    }
    return [it];
  });
  return changed ? { ...t, items, looks: countLooks(items) } : t;
}

/** A snapshot saved before the counts were kept on it: worked out from its items. */
export function withLooks<T extends { items: Countable[]; looks?: Looks | null }>(t: T): T & { looks: Looks } {
  return t.looks && t.looks.byTopic && t.looks.byTier ? (t as T & { looks: Looks }) : { ...t, looks: countLooks(t.items ?? []) };
}

/**
 * One key per thing, whoever sees it: a message waiting on you (`owed:`) and the same message on a lead's day
 * (`owed-lead:`) are one item. Comments, delegations and anything else shared between people key on this.
 */
export function stableKeyOf(key: string): string {
  return hideKeyOf(recapKeysOf(key)[0]) ?? key;
}
