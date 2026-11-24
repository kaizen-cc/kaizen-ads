// Dedupe against reality (owner, Nov 24 2026, a hard rule for every automated item generator in the OS): before any
// run creates an item, a follow-up or a recap line, it checks whether the thing is already done or in motion anywhere
// the OS can see. Done: don't create it (mention it as closed if useful). In motion: link the existing item and say
// who's on it; never a duplicate, never a chase. The pure matching rules, tested in tests/reality-check.test.ts.

export type RealityState = "new" | "in_motion" | "done";
export type Existing = { source: "item" | "asana" | "call" | "promise" | "done_check" | "board"; id: string; title: string; clientId: string | null; ownerId: string | null; owner: string | null; open: boolean; href: string | null; at: string | null };
export type Candidate = { title: string; clientId: string | null; ownerId?: string | null; sourceRef?: string | null };

const STOP = new Set(
  "a an the and or of to for in on at by with from into about this that these those it its is are was be been our their your his her my we they you i me him them up out over new send sent get make made do done set setup set-up please can could would will need needs needed should by asap today tomorrow call email slack client clients kaizen re fwd".split(" "),
);

/** The words that carry what a piece of work is (lowercase, no stop words, light plural folding) */
export function keyWords(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/[^a-z0-9$% ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
    ),
  ];
}

/** How alike two descriptions of work are: the share of the shorter one's key words the other has (0..1) */
export function likeness(a: string, b: string): number {
  const x = keyWords(a);
  const y = new Set(keyWords(b));
  if (!x.length || !y.size) return 0;
  const shorter = x.length <= y.size ? x : [...y];
  const other = x.length <= y.size ? y : new Set(x);
  const hit = shorter.filter((w) => other.has(w)).length;
  return hit / shorter.length;
}

/** Same work: the same client (or both without one) and most of the key words in common */
export const SAME_WORK = 0.6;
export function sameWork(c: Candidate, e: Existing): boolean {
  if (c.sourceRef && e.id && c.sourceRef === e.id) return true;
  if ((c.clientId ?? null) !== (e.clientId ?? null) && c.clientId && e.clientId) return false;
  return likeness(c.title, e.title) >= SAME_WORK;
}

/**
 * Where a candidate stands against everything found: an open match means it's in motion (link it, name who's on it);
 * a closed match means it's done; otherwise it's new. An open match wins over a closed one (it came back).
 */
export function decide(c: Candidate, found: readonly Existing[]): { state: RealityState; match: Existing | null } {
  const same = found.filter((e) => sameWork(c, e));
  const open = same.filter((e) => e.open).sort((a, b) => likeness(c.title, b.title) - likeness(c.title, a.title))[0];
  if (open) return { state: "in_motion", match: open };
  const closed = same.filter((e) => !e.open).sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
  if (closed) return { state: "done", match: closed };
  return { state: "new", match: null };
}

/** One line for a recap or a report: what happened to a candidate that wasn't created */
export function realityLine(d: { state: RealityState; match: Existing | null }): string | null {
  if (d.state === "new" || !d.match) return null;
  const who = d.match.owner ? ` (${d.match.owner} is on it)` : "";
  return d.state === "done" ? `Already done: ${d.match.title}` : `Already in motion${who}: ${d.match.title}`;
}


// The floating sweep's stricter test (owner, Nov 24 2026, after its first run matched "Tin Lizzy's: 2 follow-ups from
// your call" to a teammate's different follow-ups): only the words that say what the work is count, never the client's
// name or filler; a summary of a checklist never matches anything; both sides need at least 3 such words.
const FILLER = new Set("follow ups up call calls recap update updates week hey hi hello just wanted ask asking checking check quick note thanks thank please here your our item items task tasks landing page tracking setup".split(" "));
const SUMMARY = /\b\d+\s+follow-?ups?\s+from\b|\bfollow-?ups?\s+from\s+(your|the)\s+call\b/i;

/** The words that say what the work is, without the client's name or filler */
export function workWords(title: string, client: string | null | undefined): string[] {
  const own = new Set(keyWords(String(client ?? "")));
  return keyWords(title).filter((w) => !own.has(w) && !FILLER.has(w));
}

/** How alike two pieces of work are on their work words alone (0 when either is a checklist summary or too thin) */
export function strictLikeness(a: string, b: string, client: string | null | undefined): number {
  if (SUMMARY.test(a) || SUMMARY.test(b)) return 0;
  const x = workWords(a, client);
  const y = new Set(workWords(b, client));
  if (x.length < 3 || y.size < 3) return 0;
  const [short, long] = x.length <= y.size ? [x, y] : [[...y], new Set(x)];
  return short.filter((w) => long.has(w)).length / short.length;
}
export const STRICT_SAME = 0.75;
