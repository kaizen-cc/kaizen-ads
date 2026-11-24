// Needs me narrowed down (owner's exec call, Nov 24 2026: "a long replies list needs filters"): by what kind of thing it
// is, by client, by where it was said, by line. Only the choices that have items show. Pure: tests/item-filters.test.ts.

export type FilterCard = { key: string; kind: string; client: string | null; line?: string | null; action: { href: string | null }; source?: { href?: string | null } | null };

export const KIND_LABEL = { reply: "Replies", promise: "Promises", approval: "Approvals", task: "Tasks", email: "Emails to send" } as const;
export type KindFilter = keyof typeof KIND_LABEL;

/** What kind of thing an item is, for the filter */
export function kindOf(c: FilterCard): KindFilter {
  if (/^(owed2?|owed-lead):/.test(c.key) || c.kind === "owed") return "reply";
  if (/^(said2?|said-lead|callp|promise):/.test(c.key) || c.kind === "said") return "promise";
  if (c.kind === "approval" || c.key.startsWith("approve:")) return "approval";
  if (c.kind === "draft" || c.key.startsWith("draft:")) return "email";
  return "task";
}

/** Where it was said: Slack, email, a call, Kaizen OS */
export function placeOf(c: FilterCard): "Slack" | "Email" | "Call" | "Kaizen OS" {
  const h = `${c.action.href ?? ""} ${c.source?.href ?? ""}`;
  if (/slack\.com/.test(h)) return "Slack";
  if (/mail\.google|gmail/.test(h) || c.key.startsWith("draft:")) return "Email";
  if (/call=|\/calls?\//.test(h)) return "Call";
  return "Kaizen OS";
}

export type Filters = { kind?: string | null; client?: string | null; place?: string | null; line?: string | null };

/** The choices to offer (only ones with items, each with its count) */
export function filterChoices(cards: readonly FilterCard[]) {
  const count = <K extends string>(xs: K[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<K, number>())].sort((a, b) => b[1] - a[1]);
  return {
    kinds: count(cards.map(kindOf)),
    clients: count(cards.map((c) => c.client).filter((c): c is string => Boolean(c))),
    places: count(cards.map(placeOf)),
    lines: count(cards.map((c) => c.line).filter((l): l is string => Boolean(l))),
  };
}

/** The cards that match every filter set */
export function applyFilters<T extends FilterCard>(cards: readonly T[], f: Filters): T[] {
  return cards.filter((c) => (!f.kind || kindOf(c) === f.kind) && (!f.client || c.client === f.client) && (!f.place || placeOf(c) === f.place) && (!f.line || c.line === f.line));
}
