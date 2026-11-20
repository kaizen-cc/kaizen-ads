import { noDash } from "@/lib/direction-core";

// Delegating an item on someone's Overview ("Brief ready", a launch promised on a call) to a teammate: who can be
// picked (by the delegator's role, the client's seat holders first), what the teammate's task says, and how the
// original item shows it. The writing reuses the send_to_teammate path (agent_asks plus a bell notice and Slack DM).

export type Candidate = { id: string; name: string; role: string };

/** The roles a person's work is naturally handed to; an exec can pick anyone */
const DOWN: Record<string, readonly string[]> = {
  head_of_creative: ["lead_graphic_designer", "lead_video_editor", "graphic_designer", "video_editor", "copywriter"],
  lead_graphic_designer: ["graphic_designer", "video_editor", "copywriter"],
  lead_video_editor: ["video_editor", "graphic_designer", "copywriter"],
  head_of_meta: ["media_buyer", "tiktok_buyer", "google_buyer", "copywriter"],
  head_of_google: ["google_buyer", "media_buyer"],
  head_of_email: ["email_strategist", "email_designer", "email_builder", "copywriter"],
  head_of_social: ["social_media_manager", "graphic_designer", "video_editor"],
  media_buyer: ["media_buyer", "tiktok_buyer", "google_buyer", "head_of_meta"],
  google_buyer: ["google_buyer", "media_buyer", "head_of_google"],
};

/**
 * Who the picker offers: the roles under the delegator's own (a head of creative offers designers and video editors),
 * everyone for an exec, never the delegator. People holding a seat on the client come first.
 */
export function delegateCandidates(me: { id: string; role: string; isExec: boolean }, team: readonly Candidate[], clientSeatIds: readonly string[] = []): (Candidate & { onClient: boolean })[] {
  const allowed = me.isExec ? null : new Set(DOWN[me.role] ?? ["graphic_designer", "video_editor", "copywriter", "media_buyer", "google_buyer"]);
  const seat = new Set(clientSeatIds);
  return team
    .filter((p) => p.id !== me.id && (!allowed || allowed.has(p.role)))
    .map((p) => ({ ...p, onClient: seat.has(p.id) }))
    .sort((a, b) => Number(b.onClient) - Number(a.onClient) || a.name.localeCompare(b.name));
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
