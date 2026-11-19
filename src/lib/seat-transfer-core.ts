import { SLOTS, canHold, seatOffered } from "./roles";

// Moving someone's accounts to someone else (a teammate leaving, changing team, out for a while): every client seat
// they hold, all at once or a chosen few. Each seat follows its own line: a Meta buyer seat goes to someone who can
// buy Meta, an email designer seat to someone who designs email. Pure, so the assistant's tools, the Handoffs page,
// the server actions and the tests share one rule.

/** The line a seat belongs to (who leads it) */
export type SeatLine = "meta" | "google" | "creative" | "email" | "social";

const SEAT_LINE: Record<string, SeatLine> = {
  meta_buyer: "meta",
  tiktok_buyer: "meta",
  google_buyer: "google",
  graphic_designer: "creative",
  video_editor: "creative",
  email_strategist: "email",
  email_designer: "email",
  email_builder: "email",
  social_manager: "social",
  social_creative: "social",
};

/** The line each head leads */
const HEAD_LINE: Record<string, SeatLine> = {
  head_of_meta: "meta",
  head_of_google: "google",
  head_of_creative: "creative",
  head_of_email: "email",
  head_of_social: "social",
};

export const seatLine = (slot: string): SeatLine | null => SEAT_LINE[slot] ?? null;
export const seatLabel = (slot: string) => SLOTS.find((s) => s.value === slot)?.label ?? slot.replace(/_/g, " ");

export type Mover = { role: string | null | undefined; isExec?: boolean | null };

/** Whether this person may move this seat: executives every seat, a head only their own line's seats */
export function mayTransferSeat(me: Mover, slot: string): boolean {
  if (!SEAT_LINE[slot]) return false;
  if (me.isExec) return true;
  const line = HEAD_LINE[String(me.role ?? "")];
  return Boolean(line && SEAT_LINE[slot] === line);
}

/** Whether this person may move any seats at all (shows the Handoffs page and the assistant's tools) */
export const mayTransferAny = (me: Mover) => Boolean(me.isExec) || Boolean(HEAD_LINE[String(me.role ?? "")]);

/** The lines this person moves seats on (every line for an executive) */
export const linesFor = (me: Mover): SeatLine[] => (me.isExec ? ["meta", "google", "creative", "email", "social"] : HEAD_LINE[String(me.role ?? "")] ? [HEAD_LINE[String(me.role ?? "")]] : []);

export type Person = { id: string; full_name: string; role: string; also_buys?: boolean | null; also_social?: boolean | null; also_designs_email?: boolean | null; teams?: readonly string[] | null };

/** Whether this person can sit in this seat (their role or badges) */
export function canTake(slot: string, p: Person): boolean {
  const s = SLOTS.find((x) => x.value === slot);
  return Boolean(s && canHold(s, p));
}

/** A seat someone holds on a client */
export type HeldSeat = { clientId: string; client: string; services: readonly string[]; role: string; primary: boolean };

/** One move in a plan: the seat, who has it, who gets it (null: nobody fits yet, pick someone) and why not */
export type PlannedMove = HeldSeat & { toId: string | null; to: string | null; why: string | null };

/**
 * The moves for handing someone's seats over. `to` is who takes them; `byLine` names someone for a line `to` can't
 * cover ("the Google seats to Ana"). A seat nobody named can hold is still planned, without a person, so it's picked
 * on the page. Seats the mover may not move are left out, as are seats the client no longer buys.
 */
export function planMoves(me: Mover, fromId: string, seats: readonly HeldSeat[], people: readonly Person[], to: string | null, byLine: Partial<Record<SeatLine, string>> = {}): PlannedMove[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  return seats
    .filter((s) => mayTransferSeat(me, s.role) && seatOffered(s.role, s.services))
    .map((s) => {
      const line = seatLine(s.role);
      const picks = [line ? byLine[line] : undefined, to].filter((x): x is string => Boolean(x));
      const fit = picks.map((id) => byId.get(id)).find((p) => p && p.id !== fromId && canTake(s.role, p)) ?? null;
      const named = picks.map((id) => byId.get(id)).find(Boolean) ?? null;
      const why = fit ? null : named ? `${named.full_name} can't hold the ${seatLabel(s.role)} seat: pick who takes it` : `Pick who takes the ${seatLabel(s.role)} seat`;
      return { ...s, toId: fit?.id ?? null, to: fit?.full_name ?? null, why };
    })
    .sort((a, b) => a.client.localeCompare(b.client) || a.role.localeCompare(b.role));
}

/** A name matched against the team: one person, several (ask which), or nobody */
export function matchPerson<P extends { full_name: string }>(people: readonly P[], name: string): { one: P } | { many: P[] } | { none: true } {
  const q = name.trim().toLowerCase().replace(/[’']s?$/, "");
  if (!q) return { none: true };
  const exact = people.filter((p) => p.full_name.toLowerCase() === q);
  if (exact.length === 1) return { one: exact[0] };
  const words = q.split(/\s+/);
  const hits = people.filter((p) => {
    const n = p.full_name.toLowerCase();
    return words.every((w) => n.split(/\s+/).some((part) => part.startsWith(w)));
  });
  if (hits.length === 1) return { one: hits[0] };
  if (hits.length > 1) return { many: hits };
  return { none: true };
}
