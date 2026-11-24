import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { safetyAlertKey } from "./safety-alert";
import { audioDeleteAfter, audioDue, parseSafetyReview, SAFETY_CATEGORIES, SAFETY_SCHEMA, safetyAlerts, timedTranscript, type SafetyResult } from "@/lib/assistant/core";

// The safety review every call gets once it ends (people are told before their first call that calls are recorded
// and may be reviewed). A cheap model reads the timed transcript for genuinely concerning content only: threats,
// harassment, discrimination, taking client or company confidential data out, fraud or deceiving clients, or the
// person in real distress. A flagged call is a private notification to the executives (not the caller themselves),
// with the transcript, the audio and the moments to skip to. The caller is not told about the flag. Unflagged audio
// is deleted right after the review; flagged audio is kept about 90 days, then deleted by the cleanup. Screenshots of
// the person's screen taken on the call ("take a look") follow the audio: deleted with it, kept with it when flagged.

export const AUDIO_BUCKET = "call-audio";

const SYSTEM = `You review a recorded voice call between one member of a marketing agency's team and the agency's AI assistant or agents, for the agency's executives. The team knows calls are recorded and may be reviewed. The bar is high: a flag goes to management about a real person, so a false one does harm. When in doubt it is not flagged.

The transcript is speech-to-text from an open microphone. It picks up whatever is around the person (other people in the room, their own conversations with someone else, a TV, a show, a video, music) and it garbles, repeats and cuts words. For every moment you flag, say who said it (speaker): the_person (the team member, in their own words), someone_else_or_media (another voice, a show, a quote, something read out), the_ai (the assistant or an agent), or unclear. Only what the person themselves said counts against them.

Flag ONLY:
- threat: the person threatening violence or harm to someone, or to damage the company or a client, in earnest;
- harassment: the person making harassing, demeaning or sexual remarks about a colleague or client;
- discrimination: the person discriminating against people for race, gender, religion, age, disability, orientation or similar;
- confidential_data: the person trying to take client or company confidential data out (to a personal address, a competitor, copying client lists or logins away);
- fraud: the person faking numbers or invoices, misusing client money or ad accounts;
- deceiving_clients: an explicit plan by the person to lie to a client or falsify something for them (made-up numbers, a faked report, billing for work not done, hiding a problem with their own account so they're misled about it);
- distress: an explicit crisis cue from the person about themselves: self-harm, harming others, saying they're unsafe or in crisis;
- assistant_reliability: the AI itself stating something unsourced or wrong as fact (a made-up date, a thread status it didn't check). This is about the AI, never the person: speaker the_ai, severity low.

NEVER flag:
- distress for work stress or venting ("I'm not gonna eat", "busy month", "I don't wanna do this"), tiredness or a late-night call, long pauses, garbled, fragmented or repeated speech (usually the microphone, the transcriber, or the AI hearing itself or the room), personal conversations with someone else, or a TV or stream in the background;
- anything the system or the AI says or reads out, or the person discussing, asking about or dismissing an alert (an alert titled "A call needs a look: distress" read back is the system talking, never a flag);
- deceiving_clients for normal copy choices (leaving lead times or hours out of an email), choosing which wins a case study or pitch leads with while every number stays true, asking about an offer or a product, correcting a budget, or the AI's own unsourced claims (that's assistant_reliability);
- ordinary frustration, swearing, jokes, sarcasm, criticism of work, disagreement, honest mistakes, or normal business talk about numbers and clients.

Severity: high only for an earnest threat, harassment or discrimination, or an explicit crisis cue; medium for a clear, explicit case of the other categories; low for anything you're not sure the person meant or said. For each moment give the second it starts (from the [m:ss] stamps), the speaker, and a short neutral note. No speculation about the person beyond what was said.`;

const VERIFY_SYSTEM = `A first reviewer flagged moments in a recorded call between a team member and the company's AI assistant, to alert the executives. You check it before anyone is told. Read the moments in context and answer: is each one clearly the team member themselves (not someone else in the room, a TV, a show, a quote, the AI, or the system reading out an alert), meant in earnest, and an explicit case of its category (an earnest threat; harassment; discrimination; taking confidential data; fraud; an explicit plan to lie to or falsify for a client; an explicit crisis cue such as self-harm or saying they're unsafe)? Work stress, venting, tiredness, garbled speech, normal copy or case-study choices and the AI's own mistakes are not. confirmed: true only if at least one moment clearly is. Then give the categories that hold and their severity, and a one-line reason.`;

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["confirmed", "categories", "severity", "reason"],
  properties: {
    confirmed: { type: "boolean" },
    categories: { type: "array", items: { type: "string", enum: [...SAFETY_CATEGORIES] } },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string" },
  },
};

/** Bumped when the review's rules change; flags from an older rule are re-scored by the sweep (recalibrateFlags) */
export const SAFETY_RULE_VERSION = 3;

type Line = { who: string; text: string; at: string };

/**
 * The review of one call's transcript: the first read, then, before anything can alert the executives (medium or
 * high), a second check of those moments in context. Not confirmed: kept as low, logged only.
 */
async function assess(lines: Line[], startedAt: string, seconds: number, name: string): Promise<SafetyResult> {
  if (!lines.some((l) => l.who === name)) return parseSafetyReview({ flagged: false });
  const transcript = timedTranscript(lines, startedAt);
  const out = await askJson<unknown>({
    agent: "coach",
    label: "call safety review",
    bare: true,
    noSample: true,
    override: { model: "haiku", effort: "low" },
    system: SYSTEM,
    schema: SAFETY_SCHEMA,
    maxTokens: 2500,
    prompt: `<call length_seconds="${seconds}" person="${name}">\n${transcript.slice(0, 60_000)}\n</call>`,
  });
  const first = parseSafetyReview(out, seconds);
  if (!safetyAlerts(first)) return first;
  const check = await askJson<{ confirmed: boolean; categories: string[]; severity: "low" | "medium" | "high"; reason: string }>({
    agent: "coach",
    label: "call safety check",
    bare: true,
    noSample: true,
    system: VERIFY_SYSTEM,
    schema: VERIFY_SCHEMA,
    maxTokens: 800,
    prompt: `<flagged>\n${first.moments.map((m) => `[${Math.floor(m.at_seconds / 60)}:${String(m.at_seconds % 60).padStart(2, "0")}] ${m.category} (${m.speaker ?? "unclear"}): ${m.note}`).join("\n")}\n</flagged>\n\n<call person="${name}">\n${transcript.slice(0, 60_000)}\n</call>`,
  });
  if (!check.confirmed) return { ...first, severity: "low", summary: `${first.summary} (Second check: not confirmed. ${String(check.reason ?? "").slice(0, 200)})`.slice(0, 600) };
  const kept = first.categories.filter((c) => check.categories.includes(c));
  const severity = check.severity === "high" || check.severity === "medium" ? check.severity : "low";
  return kept.length ? { ...first, categories: kept, severity, moments: first.moments.filter((m) => kept.includes(m.category)), distress: kept.includes("distress") } : { ...first, severity: "low" };
}

async function callLines(admin: SupabaseClient, call: { id: string; profile_id: string | null }) {
  const { data: rows } = await admin.from("ai_role_chats").select("role, role_key, content, created_at").eq("call_id", call.id).order("created_at").limit(400);
  const { data: who } = await admin.from("profiles").select("full_name").eq("id", call.profile_id as string).maybeSingle();
  const name = String(who?.full_name ?? "The caller").split(/\s+/)[0];
  return { name, lines: (rows ?? []).map((r) => ({ who: r.role === "user" ? name : `AI (${String(r.role_key).replace(/_/g, " ")})`, text: String(r.content), at: String(r.created_at) })) };
}

/** Reviews one ended call (never throws). Returns whether it was flagged, or null when it couldn't run. */
export async function reviewCallSafety(admin: SupabaseClient, callId: string): Promise<boolean | null> {
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key, started_at, ended_at, safety_reviewed_at, audio_parts, uploads").eq("id", callId).maybeSingle();
  if (!call || !call.ended_at || call.safety_reviewed_at) return null;
  const shots = screenshotsOf(call.uploads).length;
  const { name, lines } = await callLines(admin, call as { id: string; profile_id: string | null });
  const seconds = Math.max(0, Math.round((Date.parse(call.ended_at as string) - Date.parse(call.started_at as string)) / 1000));
  const now = new Date();
  let result: SafetyResult;
  try {
    result = await assess(lines, call.started_at as string, seconds, name);
  } catch (e) {
    console.error("[call safety]", e instanceof Error ? e.message : e);
    return null;
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
      rule_version: SAFETY_RULE_VERSION,
      reviewed_at: now.toISOString(),
      audio_delete_after: Number(call.audio_parts ?? 0) > 0 || shots > 0 ? deleteAfter.toISOString() : null,
    },
    { onConflict: "call_id" },
  );
  if (error) {
    console.error("[call safety] save", error.message);
    return null;
  }
  await admin.from("ai_role_calls").update({ safety_reviewed_at: now.toISOString() }).eq("id", callId);
  // Only medium or high, confirmed by the second check, reaches the executives; low is logged (Settings › Calls & usage)
  if (safetyAlerts(result)) {
    // The executives only, never the caller (an exec's own flagged call goes to the other execs)
    const { data: execs } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true);
    const to = (execs ?? []).map((e) => e.id as string).filter((id) => id !== call.profile_id);
    if (to.length)
      await admin.from("notifications").upsert(
        to.map((id) => ({
          profile_id: id,
          kind: "safety",
          title: `A call needs a look: ${result.categories.filter((c) => c !== "assistant_reliability").map((c) => c.replace(/_/g, " ")).join(", ")}`,
          body: `${result.summary}${result.distress ? " The caller may need support." : ""}`.slice(0, 600),
          href: `/safety/${callId}`,
          key: safetyAlertKey(callId),
          priority: result.severity === "high" || result.distress ? "critical" : "normal",
          read_at: null,
        })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
  } else if (!result.flagged) await deleteCallAudio(admin, callId);
  return result.flagged;
}

type Upload = { path?: string; purpose?: string };
/** The screenshots kept on a call (looks at the person's screen) */
const screenshotsOf = (uploads: unknown): Upload[] => (Array.isArray(uploads) ? (uploads as Upload[]).filter((u) => u?.purpose === "screen" && typeof u.path === "string") : []);

/** Deletes a call's screenshots (the files, and their place on the call) */
export async function deleteCallScreenshots(admin: SupabaseClient, callId: string): Promise<void> {
  const { data } = await admin.from("ai_role_calls").select("uploads").eq("id", callId).maybeSingle();
  const all = (Array.isArray(data?.uploads) ? data.uploads : []) as Upload[];
  const shots = screenshotsOf(all);
  if (!shots.length) return;
  await admin.storage.from(AI_BUCKET).remove(shots.map((u) => u.path as string));
  await admin.from("ai_role_calls").update({ uploads: all.filter((u) => u?.purpose !== "screen") }).eq("id", callId);
}

/** Deletes every recorded part of a call's audio, and its screenshots */
export async function deleteCallAudio(admin: SupabaseClient, callId: string): Promise<void> {
  const { data: files } = await admin.storage.from(AUDIO_BUCKET).list(callId, { limit: 100 });
  const paths = (files ?? []).map((f) => `${callId}/${f.name}`);
  if (paths.length) await admin.storage.from(AUDIO_BUCKET).remove(paths);
  await deleteCallScreenshots(admin, callId).catch((e) => console.error("[call safety] screenshots", e instanceof Error ? e.message : e));
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
  await recalibrateFlags(admin).catch((e) => console.error("[call safety] recalibrate", e instanceof Error ? e.message : e));
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
    await deleteCallScreenshots(admin, s.id as string).catch(() => undefined);
    await admin.from("ai_role_calls").update({ audio_parts: 0 }).eq("id", s.id as string);
    deleted++;
  }
  return { reviewed, flagged, deleted };
}

/**
 * Every flag from an older rule (any date, resolved or not), reviewed again under the current one, a few per run, with
 * the audio left exactly as it was (its retention isn't changed) and nobody alerted again. One that no longer qualifies
 * is cleared ("Cleared by recalibration"), and one that's now low is logged only; either way its open alert is
 * cleared for every executive. What it was before is kept on the review (recalibrated).
 */
export async function recalibrateFlags(admin: SupabaseClient, max = 5): Promise<{ rescored: number; cleared: number; logged: number }> {
  const { data } = await admin
    .from("call_safety_reviews")
    .select("call_id, flagged, categories, severity, summary, resolved_at, resolution")
    .eq("flagged", true)
    .lt("rule_version", SAFETY_RULE_VERSION)
    .order("reviewed_at", { ascending: false })
    .limit(max);
  let rescored = 0;
  let cleared = 0;
  let logged = 0;
  for (const r of data ?? []) {
    const callId = r.call_id as string;
    const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, started_at, ended_at").eq("id", callId).maybeSingle();
    let result: SafetyResult | null = null;
    if (call?.ended_at) {
      const { name, lines } = await callLines(admin, call as { id: string; profile_id: string | null });
      const seconds = Math.max(0, Math.round((Date.parse(call.ended_at as string) - Date.parse(call.started_at as string)) / 1000));
      result = await assess(lines, call.started_at as string, seconds, name).catch(() => null);
    }
    if (!result) {
      // Couldn't run: marked as seen by this rule so it isn't retried forever; the old flag stands
      await admin.from("call_safety_reviews").update({ rule_version: SAFETY_RULE_VERSION }).eq("call_id", callId);
      continue;
    }
    rescored++;
    const now = new Date().toISOString();
    const before = { flagged: r.flagged, categories: r.categories, severity: r.severity, summary: r.summary, at: now };
    const alerts = safetyAlerts(result);
    const note = !result.flagged ? "Cleared by recalibration: under the stricter rules this call has nothing to flag." : !alerts ? "Cleared by recalibration: now low, logged only (no alert)." : null;
    await admin
      .from("call_safety_reviews")
      .update({
        flagged: result.flagged,
        categories: result.categories,
        severity: result.severity,
        summary: result.summary || null,
        moments: result.moments,
        distress: result.distress,
        rule_version: SAFETY_RULE_VERSION,
        recalibrated: before,
        ...(note ? { resolved_at: r.resolved_at ?? now, resolution: [r.resolution, note].filter(Boolean).join(" ").slice(0, 1000) } : {}),
      })
      .eq("call_id", callId);
    if (!note) continue;
    if (result.flagged) logged++;
    else cleared++;
    const key = safetyAlertKey(callId);
    await admin.from("notifications").update({ read_at: now }).eq("key", key).is("read_at", null);
    await admin.from("notifications").update({ cleared_at: now }).eq("key", key).is("cleared_at", null);
  }
  return { rescored, cleared, logged };
}
