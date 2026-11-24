"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { mayUseRoutines, routineOf, validTime, type RoutineKind } from "@/lib/routines-core";

type Result = { ok: true } | { ok: false; error: string };

/** Turn one of your routines on or off, or change its times (saved as you change it) */
export async function saveRoutine(kind: string, patch: { enabled?: boolean; times?: string[] }): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (!mayUseRoutines(me)) return { ok: false, error: "Routines are for the executives and leads." };
  const def = routineOf(kind);
  if (!def) return { ok: false, error: "That isn't a routine." };
  const times = patch.times ? [...new Set(patch.times.map((t) => t.trim()).filter(validTime))].sort().slice(0, 8) : undefined;
  if (patch.times && !times?.length && def.times.length) return { ok: false, error: "Give at least one time, like 08:45." };
  const db = await createClient();
  const { data: cur } = await db.from("routines").select("enabled, times").eq("profile_id", me.id).eq("kind", kind).maybeSingle();
  const { error } = await db.from("routines").upsert({ profile_id: me.id, kind, enabled: patch.enabled ?? Boolean(cur?.enabled), times: times ?? (cur?.times as string[] | undefined) ?? def.times, days: def.days, updated_at: new Date().toISOString() });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/routines");
  return { ok: true };
}

/** Run one of your routines right now (in the background): its report lands on this page and in the bell */
export async function runRoutineNow(kind: string): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (!mayUseRoutines(me)) return { ok: false, error: "Routines are for the executives and leads." };
  if (!routineOf(kind) || !adminConfigured()) return { ok: false, error: "That isn't a routine." };
  after(async () => {
    const { runRoutine } = await import("@/lib/routines");
    await runRoutine(createAdminClient(), me.id, kind as RoutineKind).catch(() => null);
  });
  return { ok: true };
}
