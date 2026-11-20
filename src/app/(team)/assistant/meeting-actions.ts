"use server";

import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CallSlots } from "@/lib/agent-call/core";

// The slot card's taps: Book (the confirm step's button, which is the person's yes: it books on their own calendar as
// them and sends the invites) and More times (the next batch). Only the person the times were found for.

type Fail = { ok: false; error: string };

export async function bookSlot(proposalId: string, start: string, title?: string | null): Promise<{ ok: true; slots: CallSlots; already: boolean } | Fail> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Scheduling isn't available while viewing as someone else." };
  const { bookProposal } = await import("@/lib/assistant/calendar-server");
  const r = await bookProposal(createAdminClient(), { id: me.id, email: me.email, fullName: me.fullName }, proposalId, start, { title: title ?? null, via: "card" });
  if (!r.ok) return { ok: false, error: r.for_the_admin ? `${r.error} ${r.for_the_admin}` : r.error };
  return { ok: true, slots: r.slots, already: r.already };
}

export async function moreSlots(proposalId: string): Promise<{ ok: true; slots: CallSlots } | Fail> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Scheduling isn't available while viewing as someone else." };
  const { moreTimes } = await import("@/lib/assistant/calendar-server");
  const r = await moreTimes(createAdminClient(), { id: me.id, email: me.email, fullName: me.fullName }, proposalId);
  if (!r.ok) return { ok: false, error: r.for_the_admin ? `${r.error} ${r.for_the_admin}` : r.error };
  return { ok: true, slots: r.slots };
}
