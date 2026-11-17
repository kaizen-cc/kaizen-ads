import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { audioDeleteAfter, audioDue, parseSafetyReview, SAFETY_SCHEMA, timedTranscript } from "@/lib/assistant/core";

// The safety review every call gets once it ends (people are told before their first call that calls are recorded
// and may be reviewed). A cheap model reads the timed transcript for genuinely concerning content only: threats,
// harassment, discrimination, taking client or company confidential data out, fraud or deceiving clients, or the
// person in real distress. A flagged call is a private notification to the executives (not the caller themselves),
// with the transcript, the audio and the moments to skip to. The caller is not told about the flag. Unflagged audio
// is deleted right after the review; flagged audio is kept about 90 days, then deleted by the cleanup.

export const AUDIO_BUCKET = "call-audio";

const SYSTEM = `You review a recorded voice call between one member of a marketing agency's team and the agency's AI assistant or agents, for the agency's executives. The team knows calls are recorded and may be reviewed.

Flag ONLY genuinely concerning content:
- threat: threats of violence or harm to anyone, or to damage the company or a client;
- harassment: harassing, demeaning or sexual remarks about a colleague or client;
- discrimination: discriminating against people for race, gender, religion, age, disability, orientation or similar;
- confidential_data: trying to take client or company confidential data out (sending it to a personal address, a competitor, copying client lists or logins away);
- fraud: fraud, faking numbers or invoices, misusing client money or ad accounts;
- deceiving_clients: planning to lie to or mislead a client (hiding results, fake reports, billing for work not done);
- distress: the person themselves in genuine distress (talk of self harm, crisis, feeling unsafe, overwhelming despair).

Do NOT flag: ordinary frustration, swearing, venting about a busy day or a hard client, jokes, criticism of work, disagreement, honest mistakes, or normal business talk about numbers and clients. When in doubt it is not flagged. For each moment give the second it starts (from the [m:ss] stamps) and a short neutral note. No speculation about the person beyond what was said.`;

/** Reviews one ended call (never throws). Returns whether it was flagged, or null when it couldn't run. */
export async function reviewCallSafety(admin: SupabaseClient, callId: string): Promise<boolean | null> {
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key, started_at, ended_at, safety_reviewed_at, audio_parts").eq("id", callId).maybeSingle();
  if (!call || !call.ended_at || call.safety_reviewed_at) return null;
  const { data: rows } = await admin.from("ai_role_chats").select("role, role_key, content, created_at").eq("call_id", callId).order("created_at").limit(400);
  const { data: who } = await admin.from("profiles").select("full_name").eq("id", call.profile_id as string).maybeSingle();
  const name = String(who?.full_name ?? "The caller").split(/\s+/)[0];
  const lines = (rows ?? []).map((r) => ({ who: r.role === "user" ? name : `AI (${String(r.role_key).replace(/_/g, " ")})`, text: String(r.content), at: String(r.created_at) }));
  const seconds = Math.max(0, Math.round((Date.parse(call.ended_at as string) - Date.parse(call.started_at as string)) / 1000));
  const now = new Date();
  let result = parseSafetyReview({ flagged: false });
  if (lines.some((l) => l.who === name)) {
    try {
      const out = await askJson<unknown>({
        agent: "coach",
        label: "call safety review",
        bare: true,
        noSample: true,
        override: { model: "haiku", effort: "low" },
        system: SYSTEM,
        schema: SAFETY_SCHEMA,
        maxTokens: 2500,
        prompt: `<call length_seconds="${seconds}">\n${timedTranscript(lines, call.started_at as string).slice(0, 60_000)}\n</call>`,
      });
      result = parseSafetyReview(out, seconds);
    } catch (e) {
      console.error("[call safety]", e instanceof Error ? e.message : e);
      return null;
    }
  }
  const deleteAfter = audioDeleteAfter(result.flagged, now);
  const { error } = await admin.from("call_safety_reviews").upsert(
    {
      call_id: callId,
      profile_id: call.profile_id,
      flagged: result.flagged,
      categories: result.categories,
      severity: result.severity,
      summary: result.summary || null,
      moments: result.moments,
      distress: result.distress,
      reviewed_at: now.toISOString(),
      audio_delete_after: Number(call.audio_parts ?? 0) > 0 ? deleteAfter.toISOString() : null,
    },
    { onConflict: "call_id" },
  );
  if (error) {
    console.error("[call safety] save", error.message);
    return null;
  }
  await admin.from("ai_role_calls").update({ safety_reviewed_at: now.toISOString() }).eq("id", callId);
  if (result.flagged) {
    // The executives only, never the caller (an exec's own flagged call goes to the other execs)
    const { data: execs } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
    const to = (execs ?? []).map((e) => e.id as string).filter((id) => id !== call.profile_id);
    if (to.length)
      await admin.from("notifications").upsert(
        to.map((id) => ({
          profile_id: id,
          kind: "safety",
          title: `A call needs a look: ${result.categories.map((c) => c.replace(/_/g, " ")).join(", ")}`,
          body: `${result.summary}${result.distress ? " The caller may need support." : ""}`.slice(0, 600),
          href: `/safety/${callId}`,
          key: `call-safety:${callId}`,
          priority: result.severity === "high" || result.distress ? "critical" : "normal",
          read_at: null,
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  } else await deleteCallAudio(admin, callId);
  return result.flagged;
}

/** Deletes every recorded part of a call's audio */
export async function deleteCallAudio(admin: SupabaseClient, callId: string): Promise<void> {
  const { data: files } = await admin.storage.from(AUDIO_BUCKET).list(callId, { limit: 100 });
  const paths = (files ?? []).map((f) => `${callId}/${f.name}`);
  if (paths.length) await admin.storage.from(AUDIO_BUCKET).remove(paths);
  await admin.from("call_safety_reviews").update({ audio_deleted_at: new Date().toISOString() }).eq("call_id", callId);
}

/**
 * The cron step: reviews ended calls that haven't been reviewed yet (a review that failed is tried again), deletes
 * audio past its keep date (flagged after about 90 days), and audio of calls never reviewed after two days.
 */
export async function sweepCallSafety(admin: SupabaseClient): Promise<{ reviewed: number; flagged: number; deleted: number }> {
  let reviewed = 0;
  let flagged = 0;
  let deleted = 0;
  const { data: todo } = await admin
    .from("ai_role_calls")
    .select("id")
    .is("safety_reviewed_at", null)
    .not("ended_at", "is", null)
    .lt("ended_at", new Date(Date.now() - 5 * 60_000).toISOString())
    .order("ended_at", { ascending: false })
    .limit(25);
  for (const c of todo ?? []) {
    const r = await reviewCallSafety(admin, c.id as string);
    if (r !== null) reviewed++;
    if (r) flagged++;
  }
  const { data: due } = await admin.from("call_safety_reviews").select("call_id, audio_delete_after, audio_deleted_at").is("audio_deleted_at", null).not("audio_delete_after", "is", null).lte("audio_delete_after", new Date().toISOString()).limit(100);
  for (const d of due ?? []) {
    if (!audioDue({ endedAt: null, deleteAfter: d.audio_delete_after as string, deletedAt: null })) continue;
    await deleteCallAudio(admin, d.call_id as string);
    deleted++;
  }
  // Audio of calls whose review never ran, two days on
  const { data: stale } = await admin
    .from("ai_role_calls")
    .select("id, ended_at")
    .is("safety_reviewed_at", null)
    .gt("audio_parts", 0)
    .lt("ended_at", new Date(Date.now() - 2 * 86_400_000).toISOString())
    .limit(50);
  for (const s of stale ?? []) {
    if (!audioDue({ endedAt: s.ended_at as string, deleteAfter: null, deletedAt: null })) continue;
    const { data: files } = await admin.storage.from(AUDIO_BUCKET).list(s.id as string, { limit: 100 });
    const paths = (files ?? []).map((f) => `${s.id}/${f.name}`);
    if (paths.length) await admin.storage.from(AUDIO_BUCKET).remove(paths);
    await admin.from("ai_role_calls").update({ audio_parts: 0 }).eq("id", s.id as string);
    deleted++;
  }
  return { reviewed, flagged, deleted };
}
