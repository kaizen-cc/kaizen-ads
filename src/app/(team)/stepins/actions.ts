"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import * as act from "@/lib/stepins/act";

// The step-in cards' buttons (executives only; the checks are in src/lib/stepins/act.ts, shared with the assistant).

type Result = { ok: true; message?: string } | { ok: false; error: string };
const admin = () => (adminConfigured() ? createAdminClient() : null);
const done = (r: Result) => {
  if (r.ok) {
    revalidatePath("/stepins");
    revalidatePath("/pipeline");
  }
  return r;
};

export async function commentOnStepin(id: string, body: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.commentStepin(a, me, id, body)) : { ok: false, error: "Can't save here." };
}

export async function assignStepin(id: string, handlerId: string | null, dueOn: string | null): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.assignStepin(a, me, id, { handlerId, dueOn })) : { ok: false, error: "Can't save here." };
}

export async function handleStepin(id: string, reason: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.closeStepin(a, me, id, reason)) : { ok: false, error: "Can't save here." };
}

export async function reopenStepin(id: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.reopenStepin(a, me, id)) : { ok: false, error: "Can't save here." };
}

export async function refreshStepins(): Promise<Result> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Step-ins are for the executives." };
  if (me.viewAs) return { ok: false, error: `You're viewing as ${me.viewAs.label}: exit to make changes.` };
  const a = admin();
  if (!a) return { ok: false, error: "Can't run here." };
  const r = await (await import("@/lib/stepins/run")).runStepins(a);
  return done({ ok: true, message: `${r.open} account${r.open === 1 ? "" : "s"} need an exec: ${r.opened} new, ${r.reopened} reopened, ${r.closed} recovered.` });
}
