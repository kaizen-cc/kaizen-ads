"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import * as act from "@/lib/line-review/act";
import type { ReviewLine } from "@/lib/line-review/core";

// The weekly review cards' buttons. Rights and every Slack rule are checked in src/lib/line-review/act.ts, the same
// code the assistant's tools run.

const admin = () => (adminConfigured() ? createAdminClient() : null);
const done = (r: act.ActResult) => {
  if (r.ok) revalidatePath("/reviews");
  return r;
};

export async function saveReviewMessage(id: string, message: string): Promise<act.ActResult> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.editReview(a, me, id, message)) : { ok: false, error: "Can't save here." };
}

export async function approveAndSendReview(id: string, message: string): Promise<act.ActResult> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.sendReview(a, me, id, message)) : { ok: false, error: "Can't send here." };
}

export async function skipWeeklyReview(id: string, reason: string): Promise<act.ActResult> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.skipReview(a, me, id, reason)) : { ok: false, error: "Can't save here." };
}

/** Redraft one client's review now (its head or an exec), or every missing one this week (execs) */
export async function redraftReview(clientId: string | null, line: ReviewLine | null): Promise<act.ActResult> {
  const me = await requireStaff();
  const a = admin();
  if (!a) return { ok: false, error: "Can't run here." };
  if (me.viewAs) return { ok: false, error: `You're viewing as ${me.viewAs.label}: exit to make changes.` };
  const { runOneReview, runWeeklyReviews } = await import("@/lib/line-review/build");
  if (!clientId) {
    if (!me.isExec) return { ok: false, error: "Only execs draft every review at once." };
    const r = await runWeeklyReviews(a, { batch: 200 });
    return done({ ok: true, message: `${r.saved} review${r.saved === 1 ? "" : "s"} drafted for ${r.clients} client${r.clients === 1 ? "" : "s"}.` });
  }
  if (line && !act.runsLine(me, line)) return { ok: false, error: "That line's review is its head's (or an exec's)." };
  if (!line && !me.isExec) return { ok: false, error: "Pick your line's review." };
  const r = await runOneReview(a, clientId, line);
  return done(r.ok ? { ok: true, message: "Redrafted with the latest numbers." } : { ok: false, error: r.error });
}
