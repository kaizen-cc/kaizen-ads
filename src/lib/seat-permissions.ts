import { slotService } from "./roles";

// Who may assign which seat on a client. Executives and leaders (the Heads of Meta, Creative and Google) assign any
// seat. The Head of Email and the Head of Organic Social assign only their own team's seats, and only on clients that
// buy their service. Pure (no server code) so the server action, the pages and the tests share one rule; the database
// enforces the same thing (supabase/migrations/20261117110000_heads_assign_seats.sql).

/** The seats each channel head hands out */
export const HEAD_SEATS = {
  head_of_email: ["email_strategist", "email_designer", "email_builder"],
  head_of_social: ["social_manager", "social_creative"],
} as const;

type Head = keyof typeof HEAD_SEATS;
const isHead = (role: string | null | undefined): role is Head => role === "head_of_email" || role === "head_of_social";

/** Someone, as the signed-in staff member (Staff fits) */
export type SeatWho = { role: string | null | undefined; isExec?: boolean | null; isLead?: boolean | null };

/** Whether the person may assign this seat on a client with these services */
export function mayAssignSeat(me: SeatWho, slot: string, services: readonly string[]): boolean {
  if (me.isExec || me.isLead) return true;
  if (!isHead(me.role)) return false;
  if (!(HEAD_SEATS[me.role] as readonly string[]).includes(slot)) return false;
  const need = slotService(slot);
  return need != null && services.includes(need);
}

/** Whether the person may assign at least one seat (anywhere): shows the seat pickers at all */
export const mayAssignAnySeat = (me: SeatWho) => Boolean(me.isExec || me.isLead) || isHead(me.role);
