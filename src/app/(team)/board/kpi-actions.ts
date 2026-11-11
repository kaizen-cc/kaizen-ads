"use server";

import { after } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { BOARD_KPIS_TAG } from "@/lib/board-kpis-cache";
import { isExecOrLead, requireStaff } from "@/lib/auth";
import { aiEnabled } from "@/lib/ai";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Execs and leads: set a client's allotment aside for one billing cycle (a delay on our side, billing dates out of
 * step), with why. It drops into "Dismissed" on the Creative KPIs and that cycle is never flagged as "nothing made".
 */
export async function dismissAllotment(clientId: string, periodStart: string, reason: string): Promise<Result> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can dismiss an allotment." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return { ok: false, error: "That billing cycle isn't known." };
  if (!reason.trim()) return { ok: false, error: "Say why, so the team knows." };
  const { error } = await createAdminClient()
    .from("allotment_dismissals")
    .upsert({ client_id: clientId, period_start: periodStart, reason: reason.trim().slice(0, 300), dismissed_by: me.id, dismissed_at: new Date().toISOString() });
  if (error) return { ok: false, error: "Couldn't save it. Try again." };
  revalidateTag(BOARD_KPIS_TAG, "max");
  revalidatePath("/board");
  return { ok: true };
}

/** Execs and leads: count the client's allotment again for this cycle */
export async function restoreAllotment(clientId: string, periodStart: string): Promise<Result> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can change this." };
  const { error } = await createAdminClient().from("allotment_dismissals").delete().eq("client_id", clientId).eq("period_start", periodStart);
  if (error) return { ok: false, error: "Couldn't save it. Try again." };
  revalidateTag(BOARD_KPIS_TAG, "max");
  revalidatePath("/board");
  return { ok: true };
}

/** Execs and leads: read new feedback and sort it into errors now, instead of waiting for the hourly run */
export async function checkErrorsNow(): Promise<Result> {
  const me = await requireStaff();
  if (!isExecOrLead(me)) return { ok: false, error: "Only execs and leads can start this." };
  if (!adminConfigured() || !aiEnabled()) return { ok: false, error: "The AI isn't connected here." };
  const admin = createAdminClient();
  after(async () => {
    const { keepCreativeErrors } = await import("@/lib/creative-errors");
    await keepCreativeErrors(admin).catch((e) => console.error("[creative errors]", e instanceof Error ? e.message : e));
    revalidateTag(BOARD_KPIS_TAG, "max");
    revalidatePath("/board");
  });
  return { ok: true };
}
