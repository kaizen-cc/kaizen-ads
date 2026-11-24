// The done-check on demand (owner, Nov 24 2026, from an exec's call): "check if my waiting replies, promises and tasks
// are done", "sweep my comms", "is X done yet" runs the same check right then, through the assistant (chat and calls)
// and Kaizen AI. The pure rules: whose items, which ones first, how many, and how the answer reads. Tested in
// tests/done-check-now.test.ts.

export type Scope = "mine" | "team";
export type NowItem = { key: string; kind: string; ownerId: string | null; ownerRole: string | null; client: string; title: string; since: string };

/** How many items one ask checks (each is a small model call or a source read); the rest wait for the next ask or the hourly pass */
export const NOW_CAP = 15;

/**
 * Whether an item is in this ask: the asker's own, or (team, for an exec or a lead) anyone's under them; a named client
 * or item narrows it. A tracking item with no owner belongs to the Tracking Specialist.
 */
export function inScope(i: NowItem, me: { id: string; role: string; isExec: boolean; isLead: boolean }, o: { scope: Scope; client?: string | null; about?: string | null; leadOf?: Record<string, string | null> }): boolean {
  const own = i.ownerId === me.id || (i.ownerId == null && me.role === "tracking_specialist" && (i.kind === "notrack" || i.kind === "dog"));
  let mine = own;
  if (!mine && o.scope === "team") {
    if (me.isExec) mine = true;
    else if (me.isLead || me.role.startsWith("head_of_")) mine = Boolean(i.ownerRole && o.leadOf?.[i.ownerRole] === me.role);
  }
  if (!mine) return false;
  if (o.client && !norm(i.client).includes(norm(o.client))) return false;
  if (o.about && !words(o.about).every((w) => norm(`${i.title} ${i.client}`).includes(w))) return false;
  return true;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "a", "an", "is", "it", "done", "yet", "for", "on", "of", "to", "my", "and", "with", "about"]);
const words = (s: string) => norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 4);

/** The order they're checked in, inside the cap: the oldest open first (the longest it's been waiting) */
export function pickForNow<T extends NowItem>(items: readonly T[], cap = NOW_CAP): { now: T[]; later: number } {
  const sorted = [...items].sort((a, b) => a.since.localeCompare(b.since));
  return { now: sorted.slice(0, cap), later: Math.max(0, sorted.length - cap) };
}

export type NowResult = { key: string; kind: string; client: string; title: string; state: "done" | "moving" | "nothing"; quote: string; source: string | null; link: string | null; at: string | null };

const SOURCE: Record<string, string> = { slack_internal: "internal Slack", slack_external: "the client's Slack", gmail: "email", call: "call notes", slack: "Slack", thread: "the thread" };

/** The answer, grouped: closed (with the quote, where it was said and a Reopen key), moving (latest sign), nothing */
export function summarize(results: readonly NowResult[], later: number) {
  const line = (r: NowResult) => ({ key: r.key, client: r.client, what: r.title, quote: r.quote || null, where: r.source ? (SOURCE[r.source] ?? r.source) : null, said: r.at ? r.at.slice(0, 10) : null, link: r.link });
  return {
    closed: results.filter((r) => r.state === "done").map((r) => ({ ...line(r), reopen: r.key })),
    moving: results.filter((r) => r.state === "moving").map(line),
    nothing_found: results.filter((r) => r.state === "nothing").map(line),
    still_to_check: later,
    note: later ? `Checked ${results.length}; ${later} more wait for the next ask or the hourly pass.` : `Checked ${results.length}.`,
  };
}
