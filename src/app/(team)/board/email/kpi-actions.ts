"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { BOARD_KPIS_TAG } from "@/lib/board-kpis-cache";
import { requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

/** Who reads and acts on the Email Board's KPI tabs: the execs and the Head of Email */
const leadsEmail = (me: { isExec: boolean; role: string }) => me.isExec || me.role === "head_of_email";

/**
 * Execs and the Head of Email: set a client's sending cycle aside (a pause on their side, billing dates out of step),
 * with why. It drops into "Dismissed" on the Email design KPIs and that cycle is never flagged as "nothing sent".
 */
export async function dismissCadence(clientId: string, periodStart: string, reason: string): Promise<Result> {
  const me = await requireStaff();
  if (!leadsEmail(me)) return { ok: false, error: "Only execs and the Head of Email can dismiss a client's cycle." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return { ok: false, error: "That cycle isn't known." };
  if (!reason.trim()) return { ok: false, error: "Say why, so the team knows." };
  const { error } = await createAdminClient()
    .from("email_cadence_dismissals")
    .upsert({ client_id: clientId, period_start: periodStart, reason: reason.trim().slice(0, 300), dismissed_by: me.id, dismissed_at: new Date().toISOString() });
  if (error) return { ok: false, error: "Couldn't save it. Try again." };
  revalidateTag(BOARD_KPIS_TAG, "max");
  revalidatePath("/board/email");
  return { ok: true };
}

/** Execs and the Head of Email: count the client's cycle again */
export async function restoreCadence(clientId: string, periodStart: string): Promise<Result> {
  const me = await requireStaff();
  if (!leadsEmail(me)) return { ok: false, error: "Only execs and the Head of Email can change this." };
  const { error } = await createAdminClient().from("email_cadence_dismissals").delete().eq("client_id", clientId).eq("period_start", periodStart);
  if (error) return { ok: false, error: "Couldn't save it. Try again." };
  revalidateTag(BOARD_KPIS_TAG, "max");
  revalidatePath("/board/email");
  return { ok: true };
}
