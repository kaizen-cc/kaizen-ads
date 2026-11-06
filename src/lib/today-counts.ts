import type { Tier, TodayItem, TopicKey } from "@/lib/today";

// How the daily recap is counted, in one place for every screen that shows its numbers (the recap itself, the "Your
// day" card on the Overview and the theme cards under it). Everything about one client in a topic is one look: three
// unanswered messages from the same client are one row, counted once. Items without a client (a teammate's message)
// gather as one "Team" row. A client's row is as urgent as its most urgent item. Pure: no database, no server-only.

export const TIER_ORDER: Tier[] = ["critical", "high", "normal"];
export const TOPIC_KEYS: TopicKey[] = ["mine", "promises", "onboarding", "accounts", "work", "briefs", "ads", "allotments"];
const RANK: Record<Tier, number> = { critical: 2, high: 1, normal: 0 };

type Countable = Pick<TodayItem, "client" | "tier" | "score" | "topic">;

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
  return [...m.entries()]
    .map(([topic, list]) => {
      const sorted = [...list].sort((a, b) => b.score - a.score);
      return { topic, items: sorted, buckets: bucketsOf(sorted) };
    })
    .sort((a, b) => b.items[0].score - a.items[0].score);
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
  for (const g of topicGroups(items)) {
    for (const b of g.buckets) {
      total++;
      byTier[b.tier]++;
      byTopic[g.topic].n++;
      if (b.tier === "critical") byTopic[g.topic].critical++;
    }
  }
  return { total, byTier, byTopic };
}

/** Still open for this person: not done and not set aside (saved for later is still open). */
export const isOpenMark = (m: string | null | undefined) => m !== "done" && m !== "dismissed";

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
    case "mine":
      return `${n} ${s(n, "thing is", "things are")} on you today`;
    case "promises":
      return `${n} ${s(n, "thing is", "things are")} waiting on us: promised, said yes to, or not answered`;
    case "onboarding":
      return `${n} new ${s(n, "client needs", "clients need")} you`;
    case "accounts":
      return `${n} ${s(n, "client has", "clients have")} accounts off or near target`;
    case "work":
      return `${n} ${s(n, "client has", "clients have")} work stuck or running late`;
    case "briefs":
      return `${n} ${s(n, "client has", "clients have")} brief ideas, when you have a moment`;
    case "ads":
      return `${n} ${s(n, "client has", "clients have")} ads ready for a refresh`;
    case "allotments":
      return `${n} ${s(n, "client is", "clients are")} behind on creative`;
  }
}

/** The same number, short, for a chip on the Overview: reads the same as the recap's headline. */
export function lookChip(topic: TopicKey, n: number): string {
  switch (topic) {
    case "mine":
      return `${n} on you today`;
    case "promises":
      return `${n} waiting on us`;
    case "onboarding":
      return `${n} new ${s(n, "client needs", "clients need")} you`;
    case "accounts":
      return `${n} ${s(n, "client", "clients")} with accounts off or near target`;
    case "work":
      return `${n} ${s(n, "client", "clients")} with work stuck or late`;
    case "briefs":
      return `${n} ${s(n, "client", "clients")} with brief ideas`;
    case "ads":
      return `${n} ${s(n, "client", "clients")} with ads ready for a refresh`;
    case "allotments":
      return `${n} ${s(n, "client", "clients")} behind on creative`;
  }
}

// One item, two places: the recap keys an item by what it is for this person (`owed:` a message waiting on you,
// `owed-lead:` one waiting on someone you lead), the Overview's Done and Dismiss by the thing itself (`owed:<id>`).
// These map one to the other, so a mark made in either place is read by both.
const HIDE_AS: Record<string, string> = { owed: "owed", owed2: "owed", "owed-lead": "owed", said: "said", said2: "said", "said-lead": "said", promise: "call", attention: "alert" };
const RECAP_AS: Record<string, string[]> = { owed: ["owed", "owed2", "owed-lead"], said: ["said", "said2", "said-lead"], call: ["promise"], alert: ["attention"] };

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
    if (m === "done" || m === "dismissed" || (h && hidden.has(h))) {
      changed = true;
      return [];
    }
    const state = m === "saved" ? "saved" : i.state === "saved" ? "seen" : i.state;
    if (state !== i.state) changed = true;
    return [state === i.state ? i : { ...i, state }];
  });
  return changed ? { ...t, items, looks: countLooks(items) } : t;
}

/** A snapshot saved before the counts were kept on it: worked out from its items. */
export function withLooks<T extends { items: Countable[]; looks?: Looks | null }>(t: T): T & { looks: Looks } {
  return t.looks && t.looks.byTopic && t.looks.byTier ? (t as T & { looks: Looks }) : { ...t, looks: countLooks(t.items ?? []) };
}
