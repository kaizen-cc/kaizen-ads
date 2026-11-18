import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { SERVICES } from "@/lib/services";
import { normName } from "./core";
import { notify } from "./run";

// What people do with a watch flag, shared by the Account watch page and the assistant's tools. Each checks the
// person's rights itself and writes with the server's (the tables are read-only to sessions).

export type ActResult = { ok: true; message: string } | { ok: false; error: string };
const decider = (me: Staff) => me.isExec || me.isLead;

/** Leads and execs: a service intentionally paused until a day (a seasonal business), with the reason */
export async function pauseService(admin: SupabaseClient, me: Staff, i: { clientId: string; service: string; until: string; reason: string }): Promise<ActResult> {
  if (!decider(me)) return { ok: false, error: "Only leads and execs can mark a service paused." };
  if (!SERVICES.some((s) => s.slug === i.service)) return { ok: false, error: "Unknown service." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.until) || i.until < new Date().toISOString().slice(0, 10)) return { ok: false, error: "Pick a day from today on." };
  const reason = i.reason.trim().slice(0, 500);
  if (reason.length < 3) return { ok: false, error: "Say why it's paused (the client asked, off season...)." };
  await admin.from("watch_pauses").update({ cleared_at: new Date().toISOString(), cleared_by: me.id }).eq("client_id", i.clientId).eq("service", i.service).is("cleared_at", null);
  const { error } = await admin.from("watch_pauses").insert({ client_id: i.clientId, service: i.service, until: i.until, reason, set_by: me.id });
  if (error) return { ok: false, error: error.message };
  await closeFlags(admin, { client_id: i.clientId, line: i.service, kind: "idle" }, `Paused until ${i.until}: ${reason}`, me.id);
  return { ok: true, message: `Paused until ${i.until}. The watch leaves it alone until then.` };
}

/** Leads and execs: end a pause early (the watch checks the line again on its next run) */
export async function endPause(admin: SupabaseClient, me: Staff, id: string): Promise<ActResult> {
  if (!decider(me)) return { ok: false, error: "Only leads and execs can change a pause." };
  const { error } = await admin.from("watch_pauses").update({ cleared_at: new Date().toISOString(), cleared_by: me.id }).eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true, message: "Pause ended." };
}

/** Mark a flag handled with a note. Billed-but-idle and people flags are a lead's or exec's to close. */
export async function resolveFlag(admin: SupabaseClient, me: Staff, id: string, note: string): Promise<ActResult> {
  const { data: f } = await admin.from("watch_flags").select("id, kind").eq("id", id).is("resolved_at", null).maybeSingle();
  if (!f) return { ok: false, error: "That flag is already closed." };
  if ((f.kind === "idle" || f.kind === "unrecognized") && !decider(me)) return { ok: false, error: "A lead or exec closes this one (or set a pause)." };
  await closeFlags(admin, { id }, `Handled by ${me.fullName}${note.trim() ? `: ${note.trim().slice(0, 300)}` : ""}`, me.id);
  return { ok: true, message: "Marked handled." };
}

/**
 * Leads and execs: who a change-history name is. A team member: it becomes an alias on their profile (shown as them from
 * then on). The client's own person, or an outside partner or tool: remembered, never flagged again.
 */
export async function placeActor(admin: SupabaseClient, me: Staff, i: { flagId: string; as: "team" | "client" | "partner"; profileId?: string | null }): Promise<ActResult> {
  if (!decider(me)) return { ok: false, error: "Only leads and execs can place a name." };
  const { data: f } = await admin.from("watch_flags").select("id, client_id, detail").eq("id", i.flagId).maybeSingle();
  const who = String((f?.detail as { who?: string } | null)?.who ?? "").trim();
  if (!f || !who) return { ok: false, error: "That flag isn't a change-history name." };
  if (i.as === "team") {
    if (!i.profileId) return { ok: false, error: "Pick the team member." };
    const { data: p } = await admin.from("profiles").select("full_name, platform_aliases").eq("id", i.profileId).maybeSingle();
    if (!p) return { ok: false, error: "Team member not found." };
    await admin.from("profiles").update({ platform_aliases: [...new Set([...((p.platform_aliases as string[] | null) ?? []), who])] }).eq("id", i.profileId);
    await closeAllNamed(admin, who, `${who} is ${p.full_name} (set by ${me.fullName})`, me.id);
    return { ok: true, message: `${who} now shows as ${p.full_name}.` };
  }
  await admin.from("watch_actors").upsert({ name_key: normName(who), name: who, status: i.as, client_id: i.as === "client" ? f.client_id : null, decided_by: me.id, decided_at: new Date().toISOString() });
  if (i.as === "partner") await closeAllNamed(admin, who, `${who} is an outside partner or tool (set by ${me.fullName})`, me.id);
  else await closeFlags(admin, { id: f.id }, `${who} is the client's own person (set by ${me.fullName})`, me.id);
  return { ok: true, message: i.as === "client" ? `${who} is remembered as the client's own person.` : `${who} is remembered as an outside partner or tool.` };
}

/** The buyer or the head of creative: ask the creative team for a two-creative sprint on an account beating its KPI */
export async function requestSprint(admin: SupabaseClient, me: Staff, flagId: string): Promise<ActResult> {
  const { data: f } = await admin.from("watch_flags").select("id, client_id, title, clients(name, slug)").eq("id", flagId).is("resolved_at", null).maybeSingle();
  if (!f) return { ok: false, error: "That suggestion is already closed." };
  const c = f.clients as unknown as { name: string; slug: string };
  const [{ data: heads }, { data: seats }] = await Promise.all([
    admin.from("profiles").select("id").eq("is_active", true).eq("role", "head_of_creative"),
    admin.from("client_assignments").select("profile_id").eq("client_id", f.client_id).in("role", ["graphic_designer", "video_editor"]),
  ]);
  const to = [...new Set([...(heads ?? []).map((h) => h.id as string), ...(seats ?? []).map((s) => s.profile_id as string)])].filter((id) => id !== me.id);
  await notify(admin, to, {
    key: `watch:${f.id}:sprint`,
    title: `${c.name}: creative sprint asked for (two extra creatives)`,
    body: `${me.fullName} asked for two extra creatives this cycle: ${f.title.toLowerCase()}. Brief them while it's winning.`,
    href: `/requests/new?client=${encodeURIComponent(c.slug)}`,
    clientId: f.client_id as string,
    kind: "client",
    critical: false,
  });
  await closeFlags(admin, { id: f.id }, `Sprint asked for by ${me.fullName}`, me.id);
  return { ok: true, message: "The creative team has it." };
}

async function closeFlags(admin: SupabaseClient, where: { id?: string; client_id?: string; line?: string; kind?: string }, resolution: string, by: string) {
  let q = admin.from("watch_flags").update({ resolved_at: new Date().toISOString(), resolution, resolved_by: by }).is("resolved_at", null);
  for (const [k, v] of Object.entries(where)) if (v) q = q.eq(k, v);
  const { data } = await q.select("id");
  for (const f of data ?? []) await admin.from("notifications").update({ cleared_at: new Date().toISOString() }).like("key", `watch:${f.id}%`).is("cleared_at", null);
}

async function closeAllNamed(admin: SupabaseClient, who: string, resolution: string, by: string) {
  const { data } = await admin.from("watch_flags").select("id, detail").eq("kind", "unrecognized").is("resolved_at", null);
  for (const f of data ?? []) if (normName((f.detail as { who?: string } | null)?.who) === normName(who)) await closeFlags(admin, { id: f.id as string }, resolution, by);
}
