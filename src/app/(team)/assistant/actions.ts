"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { AUDIO_BUCKET } from "@/lib/agent-call/safety";
import { CALL_LIMIT_SECONDS, audioPartPath } from "@/lib/agent-call/core";
import { screenFileName } from "@/lib/agent-call/call-context";
import { FACT_TOPICS, STYLE_TOPICS } from "@/lib/assistant/core";
import type { CallNotes } from "@/lib/assistant/notes";
import { describeUploads, kindOf, type CallUpload } from "@/lib/assistant/uploads";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The assistant's own actions: its notes after a call, the call's recorded audio and the files uploaded on it, and
// the person's private memory ("What I know about you"), which is read and changed only through their own session
// (row-level security: only they can see or change it).

type Fail = { ok: false; error: string };

/** The call, when it's this person's and still open (or just ended, for the last audio part) */
async function myCall(callId: string, graceSeconds = 600) {
  const me = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(callId)) return null;
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key, started_at, ended_at, uploads, audio_parts, safety_reviewed_at").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return null;
  if (call.ended_at && Date.now() - Date.parse(call.ended_at as string) > graceSeconds * 1000) return null;
  if (Date.now() - Date.parse(call.started_at as string) > (CALL_LIMIT_SECONDS + graceSeconds) * 1000) return null;
  return { me, admin, call };
}

// ─── Notes after a call ─────────────────────────────────────────────────────

/** The notes the assistant took on a call (null while they're still being written) */
export async function assistantCallNotes(callId: string): Promise<{ ok: true; notes: CallNotes | null } | Fail> {
  const me = await requireStaff();
  const { data } = await createAdminClient().from("ai_role_calls").select("profile_id, notes").eq("id", callId).maybeSingle();
  if (!data || data.profile_id !== me.id) return { ok: false, error: "That call isn't yours." };
  return { ok: true, notes: (data.notes as CallNotes | null) ?? null };
}

// ─── Recorded audio ─────────────────────────────────────────────────────────

/**
 * Where the next part of the call's audio goes (both sides, recorded in parts so a dropped call keeps what came
 * before): a signed upload to the private call-audio bucket. The person was told before their first call.
 */
export async function audioUploadSlot(callId: string, index: number, startSeconds: number, mime?: string): Promise<{ ok: true; path: string; token: string } | Fail> {
  const got = await myCall(callId, 120);
  if (!got) return { ok: false, error: "This call has ended." };
  // Once the review has run, nothing more is kept
  if ((got.call as { safety_reviewed_at?: string | null }).safety_reviewed_at) return { ok: false, error: "This call has ended." };
  const i = Math.max(0, Math.min(60, Math.floor(index)));
  // Named by what the browser really recorded (Safari: audio/mp4), so it plays back as what it is
  const path = audioPartPath(callId, i, startSeconds, typeof mime === "string" ? mime.slice(0, 60) : null);
  const { data, error } = await got.admin.storage.from(AUDIO_BUCKET).createSignedUploadUrl(path, { upsert: true });
  if (error || !data) return { ok: false, error: "Couldn't save the audio." };
  if (Number(got.call.audio_parts ?? 0) < i + 1) await got.admin.from("ai_role_calls").update({ audio_parts: i + 1 }).eq("id", callId);
  return { ok: true, path: data.path, token: data.token };
}

// ─── Files uploaded on a call ───────────────────────────────────────────────

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_").slice(-100) || "file";

/** Signed uploads for files the assistant asked for (and the frames the browser took from each video) */
export async function callUploadSlots(callId: string, files: { name: string; mime: string; bytes: number; frames?: number }[]): Promise<{ ok: true; slots: { path: string; token: string; frames: { path: string; token: string }[] }[] } | Fail> {
  const got = await myCall(callId, 60);
  if (!got || got.call.ended_at) return { ok: false, error: "This call has ended." };
  if (!files.length || files.length > 20) return { ok: false, error: "Up to 20 files at a time." };
  if (files.some((f) => f.bytes > 500 * 1024 * 1024)) return { ok: false, error: "A file is over 500 MB." };
  const batch = crypto.randomUUID().slice(0, 8);
  const slots = [];
  for (const [i, f] of files.entries()) {
    const path = `${got.me.id}/call-${callId}/${batch}-${String(i).padStart(3, "0")}-${safeName(f.name)}`;
    const { data, error } = await got.admin.storage.from(AI_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Couldn't get the upload ready." };
    const frames = [];
    for (let k = 0; k < Math.min(3, f.frames ?? 0); k++) {
      const fp = `${path}.frame${k}.jpg`;
      const fr = await got.admin.storage.from(AI_BUCKET).createSignedUploadUrl(fp);
      if (fr.data) frames.push({ path: fr.data.path, token: fr.data.token });
    }
    slots.push({ path: data.path, token: data.token, frames });
  }
  return { ok: true, slots };
}

/**
 * The files are up: they're looked at (so the assistant can say what it got) and kept on the call. Creatives for a
 * client with a launch in progress (being asked about, or a plan waiting) are also staged with that launch's media,
 * where the launch reads its files from. A screenshot (a look on a phone) isn't described: the agent sees it itself.
 */
export async function callUploadsDone(
  callId: string,
  files: { path: string; name: string; mime: string; bytes: number; frames?: { path: string; ms: number }[] }[],
  purpose: "creatives" | "files" | "screen",
  client: string | null,
): Promise<{ ok: true; files: { name: string; about: string; path: string }[]; launch: string | null } | Fail> {
  const got = await myCall(callId, 60);
  if (!got) return { ok: false, error: "This call has ended." };
  const prefix = `${got.me.id}/call-${callId}/`;
  const mine = files.filter((f) => f.path.startsWith(prefix)).slice(0, 20);
  if (!mine.length) return { ok: false, error: "Nothing was uploaded." };
  const kindOfUpload: CallUpload["purpose"] = purpose === "creatives" ? "creatives" : purpose === "screen" ? "screen" : "files";
  const ups: CallUpload[] = mine.map((f) => ({
    path: f.path,
    name: String(f.name).slice(0, 200),
    mime: String(f.mime).slice(0, 100),
    bytes: Math.max(0, Number(f.bytes) || 0),
    kind: kindOf(f.name, f.mime),
    frames: (f.frames ?? []).filter((fr) => fr.path.startsWith(prefix)).slice(0, 3),
    purpose: kindOfUpload,
    client: client ? String(client).slice(0, 120) : null,
  }));
  const read = kindOfUpload === "screen" ? ups.map((u) => ({ ...u, about: "a screenshot of their screen" })) : await describeUploads(got.admin, ups);
  const launch = kindOfUpload === "creatives" && client ? await stageForLaunch(got.admin, got.me.id, client, read).catch(() => null) : null;
  const { data: now } = await got.admin.from("ai_role_calls").select("uploads").eq("id", callId).maybeSingle();
  await got.admin.from("ai_role_calls").update({ uploads: [...((now?.uploads ?? []) as CallUpload[]), ...read].slice(-40) }).eq("id", callId);
  return { ok: true, files: read.map((f) => ({ name: f.name, about: f.about ?? "", path: f.path })), launch };
}

/**
 * Creatives uploaded on a call for a client whose launch is in progress: copied into that launch's staging in the
 * ad-media bucket (launch/<run>/), next to the files the launch stages from Drive, and marked on each upload. The
 * client is found through the person's own session (only clients they can see). Returns the launch, or null.
 */
async function stageForLaunch(admin: ReturnType<typeof createAdminClient>, profileId: string, client: string, ups: CallUpload[]): Promise<string | null> {
  const db = await createClient();
  const name = client.replace(/[%_,()]/g, " ").trim();
  if (!name) return null;
  const exact = await db.from("clients").select("id").ilike("name", name).limit(1).maybeSingle();
  const row = exact.data ?? (await db.from("clients").select("id").ilike("name", `%${name}%`).limit(1).maybeSingle()).data;
  if (!row) return null;
  const { openRunFor } = await import("@/lib/launch-sheet/runs");
  const run = await openRunFor(admin, row.id as string, profileId);
  if (!run) return null;
  for (const u of ups) {
    if (u.kind !== "image" && u.kind !== "video") continue;
    const to = `launch/${run.id}/call-${u.path.split("/").pop() ?? safeName(u.name)}`;
    const { error } = await admin.storage.from(AI_BUCKET).copy(u.path, to, { destinationBucket: "ad-media" });
    if (!error) u.staged = { launch: run.id as string, path: to };
  }
  return run.id as string;
}

/** Where a screenshot of the shared screen goes: with the call's uploads, under the person's own folder */
export async function screenFrameSlot(callId: string): Promise<{ ok: true; path: string; token: string } | Fail> {
  const got = await myCall(callId, 60);
  if (!got || got.call.ended_at) return { ok: false, error: "This call has ended." };
  // Once the safety review has run, nothing more is kept
  if ((got.call as { safety_reviewed_at?: string | null }).safety_reviewed_at) return { ok: false, error: "This call has ended." };
  const path = `${got.me.id}/call-${callId}/${screenFileName(new Date())}`;
  const { data, error } = await got.admin.storage.from(AI_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: "Couldn't take the screenshot." };
  return { ok: true, path: data.path, token: data.token };
}

/** The screenshot is up: kept on the call (deleted with the call's audio, or kept with it when the call is flagged) */
export async function screenFrameSaved(callId: string, path: string, bytes: number): Promise<{ ok: true } | Fail> {
  const got = await myCall(callId, 60);
  if (!got) return { ok: false, error: "This call has ended." };
  if (!path.startsWith(`${got.me.id}/call-${callId}/screen-`)) return { ok: false, error: "That isn't this call's screenshot." };
  const at = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  const up: CallUpload = { path, name: `Your screen at ${at}`, mime: "image/jpeg", bytes: Math.max(0, Number(bytes) || 0), kind: "image", purpose: "screen", client: null, about: "a screenshot of their screen" };
  const { data: now } = await got.admin.from("ai_role_calls").select("uploads").eq("id", callId).maybeSingle();
  await got.admin.from("ai_role_calls").update({ uploads: [...((now?.uploads ?? []) as CallUpload[]), up].slice(-40) }).eq("id", callId);
  return { ok: true };
}

// ─── What I know about you ──────────────────────────────────────────────────

export type MemoryItem = { id: string; kind: "fact" | "style"; topic: string; body: string; onDate: string | null; followUpOn: string | null; updatedAt: string };

/** Changes one thing it knows (their own session: only they can) */
export async function updateMemory(id: string, patch: { body?: string; topic?: string; onDate?: string | null }): Promise<{ ok: true } | Fail> {
  await requireStaff();
  const db = await createClient();
  const body = patch.body == null ? undefined : String(patch.body).replace(/\s+/g, " ").trim().slice(0, 600);
  if (body !== undefined && body.length < 2) return { ok: false, error: "Write a few words, or delete it." };
  const topic = patch.topic && ([...FACT_TOPICS, ...STYLE_TOPICS] as readonly string[]).includes(patch.topic) ? patch.topic : undefined;
  const onDate = patch.onDate === undefined ? undefined : patch.onDate && /^\d{4}-\d{2}-\d{2}$/.test(patch.onDate) ? patch.onDate : null;
  const { data, error } = await db
    .from("assistant_memory")
    .update({ ...(body !== undefined ? { body } : {}), ...(topic ? { topic } : {}), ...(onDate !== undefined ? { on_date: onDate } : {}), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error || !data?.length) return { ok: false, error: "Couldn't save that." };
  revalidatePath("/assistant");
  return { ok: true };
}

/** Deletes one thing it knows, or everything (their own session) */
export async function deleteMemory(id: string | "all"): Promise<{ ok: true; deleted: number } | Fail> {
  const me = await requireStaff();
  const db = await createClient();
  const q = db.from("assistant_memory").delete();
  const { data, error } = await (id === "all" ? q.eq("profile_id", me.id) : q.eq("id", id)).select("id");
  if (error) return { ok: false, error: "Couldn't delete that." };
  revalidatePath("/assistant");
  return { ok: true, deleted: data?.length ?? 0 };
}

/** Adds something by hand */
export async function addMemory(input: { kind: "fact" | "style"; topic: string; body: string; onDate?: string | null }): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const db = await createClient();
  const body = String(input.body ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
  if (body.length < 2) return { ok: false, error: "Write a few words." };
  const kind = input.kind === "style" ? "style" : "fact";
  const topics: readonly string[] = kind === "fact" ? FACT_TOPICS : STYLE_TOPICS;
  const topic = topics.includes(input.topic) ? input.topic : "other";
  const on = input.onDate && /^\d{4}-\d{2}-\d{2}$/.test(input.onDate) ? input.onDate : null;
  const { error } = await db.from("assistant_memory").insert({ profile_id: me.id, kind, topic, body, on_date: on });
  if (error) return { ok: false, error: kind === "style" ? "That style is already set: edit it instead." : "Couldn't save that." };
  revalidatePath("/assistant");
  return { ok: true };
}
