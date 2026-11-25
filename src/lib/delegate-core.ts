import { noDash } from "@/lib/direction-core";
import { roleLabel, ROLES, type TeamRole } from "@/lib/roles";

// Delegating an item on someone's Overview ("Brief ready", a launch promised on a call) to a teammate: who can be
// picked (by the delegator's role, the client's seat holders first), what the teammate's task says, and how the
// original item shows it. The writing reuses the send_to_teammate path (agent_asks plus a bell notice and Slack DM).

export type Candidate = { id: string; name: string; role: string };

/**
 * Who the picker offers (Transfer owner, Hand off, Reassign): every active teammate, execs and the owner included, never
 * the person picking (team feedback, Nov 25 2026: a head of email couldn't hand anything to the owner). By role, in the
 * team's own role order, then by name; the client's seat holders are marked.
 */
export function delegateCandidates(me: { id: string; role: string; isExec: boolean }, team: readonly Candidate[], clientSeatIds: readonly string[] = []): (Candidate & { onClient: boolean; roleLabel: string })[] {
  const seat = new Set(clientSeatIds);
  return team
    .filter((p) => p.id !== me.id)
    .map((p) => ({ ...p, onClient: seat.has(p.id), roleLabel: roleLabel(p.role as TeamRole) }))
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name));
}

/** A role's place in the team's own order (unknown roles last) */
export function roleRank(role: string): number {
  const i = ROLES.findIndex((r) => r.value === role);
  return i < 0 ? ROLES.length : i;
}

/** Whether this person may be picked by the delegator (the server checks it again) */
export const canDelegateTo = (me: { id: string; role: string; isExec: boolean }, person: Candidate, team: readonly Candidate[] = [person]) => delegateCandidates(me, team.length ? team : [person]).some((c) => c.id === person.id);

/** The reference that ties a task back to the item it came from */
export const itemRef = (kind: "promise" | "suggestion", id: string) => `${kind}:${id}`;

/** What the teammate's row and notice lead with, credited to the delegator: "Dana: Sierra Dreams BFCM close" */
export function delegatedTitle(from: string, title: string): string {
  return noDash(`${from}: ${title.replace(/^Brief ready:\s*/i, "Brief: ")}`).slice(0, 300);
}

export function delegatedDetail(o: { from: string; note?: string | null; why?: string | null }): string {
  const note = (o.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  return noDash(`Delegated by ${o.from}${note ? `: ${note}` : ""}${o.why ? ` (${o.why.replace(/\s+/g, " ").slice(0, 200)})` : ""}`);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const cleanDue = (d: unknown): string | null => (DAY.test(String(d ?? "")) ? String(d) : null);

export type Delegation = { askId: string; to: string; status: "open" | "done" | "dismissed" };

/**
 * The original item after delegating: it leaves the delegator's dashboard at once and stays with the new owner only
 * (creative team, Nov 20 2026: a delegated task kept resurfacing on the old owner's dashboard). The label is kept for
 * anywhere that still names who has it. Only if the teammate sets the task aside does it come back to the delegator.
 */
export function delegationState(ref: string | undefined, rows: readonly { source_ref: string | null; status: string; ownerName: string | null; id: string }[]): { hide: boolean; label: string | null } {
  if (!ref) return { hide: false, label: null };
  const mine = rows.filter((r) => r.source_ref === ref);
  const open = mine.find((r) => r.status === "open");
  if (open) return { hide: true, label: `Delegated to ${open.ownerName ?? "a teammate"}` };
  return { hide: mine.some((r) => r.status === "done"), label: null };
}
