"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import * as act from "@/lib/account-watch/act";

// The Account watch page's buttons: pause a service until a day, end a pause, mark a flag handled, place a
// change-history name, ask for a creative sprint, and (execs) run the watch now. The rights are checked in
// src/lib/account-watch/act.ts, the same code the assistant's tools run.

type Result = act.ActResult;
const admin = () => (adminConfigured() ? createAdminClient() : null);
const done = (r: Result) => {
  if (r.ok) {
    revalidatePath("/watch");
    revalidatePath("/clients");
  }
  return r;
};

export async function pauseWatchedService(clientId: string, service: string, until: string, reason: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.pauseService(a, me, { clientId, service, until, reason })) : { ok: false, error: "Can't save here." };
}

export async function endWatchPause(id: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.endPause(a, me, id)) : { ok: false, error: "Can't save here." };
}

export async function resolveWatchFlag(id: string, note: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.resolveFlag(a, me, id, note)) : { ok: false, error: "Can't save here." };
}

export async function placeWatchActor(flagId: string, as: "team" | "client" | "partner", profileId?: string | null): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.placeActor(a, me, { flagId, as, profileId })) : { ok: false, error: "Can't save here." };
}

export async function requestWatchSprint(flagId: string): Promise<Result> {
  const me = await requireStaff();
  const a = admin();
  return a ? done(await act.requestSprint(a, me, flagId)) : { ok: false, error: "Can't save here." };
}

export async function runWatchNow(): Promise<Result> {
  const me = await requireStaff();
  if (!me.isExec) return { ok: false, error: "Only execs can run the watch by hand." };
  const a = admin();
  if (!a) return { ok: false, error: "Can't run here." };
  const r = await (await import("@/lib/account-watch/run")).runAccountWatch(a);
  return done({ ok: true, message: `${r.findings} found: ${r.opened} new, ${r.resolved} cleared.` });
}
