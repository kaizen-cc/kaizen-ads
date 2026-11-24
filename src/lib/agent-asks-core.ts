// Tasks and reminders asked of a person through an assistant (agent_asks), the pure rules (tests/agent-asks-core.test.ts).

/** A title compared loosely: letters and digits only, lowercase, its start (a re-save rewords the end) */
const stem = (t: string) =>
  String(t ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 30);

/** How close in time two saves must be to be the same ask said twice */
export const SAME_ASK_WINDOW_MS = 10 * 60_000;

type AskLike = { owner_id: string; asked_by: string | null; title: string; created_at: string };

/** The same asker, the same owner, a near-identical title, within a few minutes: one ask saved twice (owner, Nov 24 2026) */
export function sameAsk(a: AskLike, b: AskLike): boolean {
  if (a.owner_id !== b.owner_id || (a.asked_by ?? "") !== (b.asked_by ?? "")) return false;
  if (Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at)) > SAME_ASK_WINDOW_MS) return false;
  const x = stem(a.title);
  return x.length >= 8 && x === stem(b.title);
}

/** One of each ask saved more than once: the first saved stands for the rest */
export function dedupeAsks<T extends AskLike>(rows: readonly T[]): T[] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const out: T[] = [];
  for (const r of sorted) if (!out.some((k) => sameAsk(k, r))) out.push(r);
  return out;
}

/** A reminder's checklist after one line closed: nothing open left, the reminder itself is done (the parent auto-completes) */
export function lineClosed(items: { text: string; done: boolean }[]): { items: { text: string; done: boolean }[]; close: boolean } {
  return { items, close: items.length > 0 && items.every((i) => i.done) };
}

/** Where it was asked: a call opens its notes, a chat (or anything else) the assistant */
export function askSource(a: { call_id: string | null; role_key: string | null }): { label: string; href: string } {
  if (a.call_id) return { label: "From a call", href: `/assistant?call=${a.call_id}` };
  return { label: "From a chat", href: "/assistant" };
}
