// One item, one person (owner, Nov 23 2026; tested in tests/item-owners.test.ts). Every Overview item has a single
// owner. A transfer (kept in item_owners) wins; then the person the item's source names (who owes the reply, who said
// yes, the account's buyer, the ticket's assignee); then the client's seat on the item's line; then the client's first
// seat. Everyone else sees it only as their own linked escalation item (the lead's, then the exec's), never the item.

/** The seat (client_assignments.role) that owns a line's work on a client */
export const SEAT_OF_LINE: Record<string, string> = { meta: "meta_buyer", google: "google_buyer", tiktok: "tiktok_buyer", email: "email_strategist", social: "social_manager", creative: "graphic_designer" };
/** A client's first seat, when nothing says whose an item is */
export const PRIMARY_SEATS = ["meta_buyer", "google_buyer", "email_strategist", "social_manager", "tiktok_buyer"] as const;
/** Items a role owns outright, whatever the client */
export const ROLE_OF_PREFIX: Record<string, string> = { "allot-behind": "head_of_creative", intake: "onboarding_specialist", onboarding: "onboarding_specialist" };

const prefix = (key: string) => key.split(":")[0];

/** The line an item is about, from its key or topic (null: no line of its own) */
export function lineOfItem(i: { key: string; topic: string; title?: string }): string | null {
  const p = prefix(i.key);
  if (p.startsWith("email-") || i.topic === "email") return "email";
  if (p.startsWith("social-") || i.topic === "social") return "social";
  if (p === "brief" || p === "fatigue" || i.topic === "ads" || i.topic === "briefs") return "meta";
  if (p === "kpi" || i.topic === "accounts") return / Google/.test(i.title ?? "") ? "google" : / TikTok/.test(i.title ?? "") ? "tiktok" : "meta";
  if (i.topic === "allotments" || i.topic === "work") return "creative";
  return null;
}

export type OwnerContext = {
  /** Transfers: stable key → new owner */
  overrides: ReadonlyMap<string, string>;
  /** The person the item's own source names: stable key → owner */
  named: ReadonlyMap<string, string>;
  /** client → seat role → person */
  seats: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** role → the active person in it (the first, when several) */
  roleHolder: ReadonlyMap<string, string>;
};

/**
 * The one owner of an item, or null when nothing names one (it stays where its source put it). `me` owns their own
 * tickets and tasks (the "mine:" items) unless they were transferred.
 */
export function ownerOf(i: { key: string; stable: string; topic: string; title?: string; clientId?: string | null }, me: string, ctx: OwnerContext): string | null {
  const o = ctx.overrides.get(i.stable);
  if (o) return o;
  if (i.key.startsWith("mine:") || i.topic === "mine") return me;
  const n = ctx.named.get(i.stable);
  if (n) return n;
  const role = ROLE_OF_PREFIX[prefix(i.key)];
  if (role && ctx.roleHolder.get(role)) return ctx.roleHolder.get(role)!;
  const seats = i.clientId ? ctx.seats.get(i.clientId) : undefined;
  if (!seats) return null;
  const line = lineOfItem(i);
  const seat = line ? seats.get(SEAT_OF_LINE[line]) : undefined;
  if (seat) return seat;
  for (const r of PRIMARY_SEATS) if (seats.get(r)) return seats.get(r)!;
  return null;
}

/** The ladder's key for an item (its tickets are "ticket:<id>" and "email:<id>"; the recap's are "mine:ticket:<id>", "email-ticket:<id>") */
export function ladderKeyOf(stable: string): string {
  if (stable.startsWith("mine:ticket:")) return `ticket:${stable.slice("mine:ticket:".length)}`;
  if (stable.startsWith("email-ticket:")) return `email:${stable.slice("email-ticket:".length)}`;
  return stable;
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The lead's own item, linked to the owner's (rung 2): "Acme is in the red, and Mel hasn't acted in 48h". Never the
 * owner's item itself.
 */
export function leadItemTitle(o: { client: string | null; what: string; owner: string; hours: number; kind?: string | null }): string {
  const h = o.hours >= 72 ? `${Math.floor(o.hours / 24)} days` : `${Math.max(48, Math.round(o.hours))}h`;
  if (o.kind === "kpi") return `${o.client ?? "An account"} is in the red, and ${first(o.owner)} hasn't acted in ${h}`;
  return `${o.client ? `${o.client}: ` : ""}${cap(o.what)}, and ${first(o.owner)} hasn't acted in ${h}`;
}
