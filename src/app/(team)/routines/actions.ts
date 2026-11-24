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

/** Sends a drafted message from the nightly agent, as you, in the client's internal channel; the item closes as sent */
export async function sendItemDraft(id: string, text: string): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (!adminConfigured()) return { ok: false, error: "Not available here." };
  const admin = createAdminClient();
  const { data: it } = await admin.from("agent_asks").select("owner_id, draft, detail").eq("id", id).maybeSingle();
  const d = it?.draft as { kind?: string; channelId?: string | null } | null;
  if (!it || it.owner_id !== me.id || !d) return { ok: false, error: "That draft isn't yours." };
  if (d.kind !== "slack" || !d.channelId) return { ok: false, error: "This one goes from Gmail or to a teammate: copy the draft and send it yourself." };
  const body = text.trim();
  if (!body) return { ok: false, error: "Write the message first." };
  const { postAsUser } = await import("@/lib/slack-user");
  const sent = await postAsUser(me.id, { channel: d.channelId, text: body.slice(0, 3900) });
  if (!sent.ok) return { ok: false, error: sent.error };
  const now = new Date().toISOString();
  await admin.from("agent_asks").update({ status: "done", done_at: now, draft: { ...(it.draft as object), text: body, sentAt: now }, detail: `${String(it.detail ?? "").trim()}\nSent by ${me.fullName.split(" ")[0]} from Kaizen OS`.trim().slice(0, 4000) }).eq("id", id);
  revalidatePath("/routines");
  return { ok: true };
}

/** Releases a task the nightly agent staged: it goes to the teammate it was staged for (or you), live on their Overview */
export async function releaseStaged(id: string, to?: string | null): Promise<Result> {
  const me = await requireStaff();
  if (me.viewAs) return { ok: false, error: "Not while viewing as someone." };
  if (!adminConfigured()) return { ok: false, error: "Not available here." };
  const admin = createAdminClient();
  const { data: it } = await admin.from("agent_asks").select("owner_id, status, staged_for, detail").eq("id", id).maybeSingle();
  if (!it || it.owner_id !== me.id || it.status !== "staged") return { ok: false, error: "That isn't a task waiting for your release." };
  const owner = to || (it.staged_for as string | null) || me.id;
  const { error } = await admin.from("agent_asks").update({ status: "open", owner_id: owner, asked_by: me.id, released_at: new Date().toISOString(), detail: String(it.detail ?? "").replace(/^STAGED: [^\n]*\n?/, "") }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/routines");
  return { ok: true };
}

/** Drops a staged task (not needed) */
export async function dropStaged(id: string): Promise<Result> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Not available here." };
  const { error } = await createAdminClient().from("agent_asks").update({ status: "dismissed", done_at: new Date().toISOString() }).eq("id", id).eq("owner_id", me.id).eq("status", "staged");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/routines");
  return { ok: true };
}
