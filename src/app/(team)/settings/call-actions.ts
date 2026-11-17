"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { canTalkToAgent, canTrainAgent } from "@/lib/agent-access";
import { CALL_LIMIT_SECONDS, decide, greetingFor, isVoiceId, pendingOf, resumeModeFor, seedOf, statusOf, voiceFor, type Decision, type LearnedItem, type ResumeMode } from "@/lib/agent-call/core";
import { summarizeCall, sweepOpenCalls } from "@/lib/agent-call/server";
import { logTraining, snapshot } from "@/lib/agent-training";
import { aiEnabled } from "@/lib/ai";
import { requireStaff, type Staff } from "@/lib/auth";
import { elevenlabsConfigured, listVoices, realtimeSttToken } from "@/lib/elevenlabs";
import { createAdminClient } from "@/lib/supabase/admin";
import { chatWithAgent } from "./actions";

// Calling an agent by voice (Settings › AI agents › the agent): everyone on the team can call every agent and ask it
// things. Starting a call closes any call of theirs left open, works out how it follows the last one (a cut-off, a
// quick call back, later the same day, or a fresh start) for the greeting and the context, and hands the browser a
// single-use token for ElevenLabs' realtime speech to text. Hanging up closes it and logs what it cost. What a trainer
// (an exec, or the head of the agent's line) taught it waits as pending: at hang-up (or later, from their Overview or
// the agent's page) they keep or toss each item, and only kept ones are written. The turns themselves stream through
// /api/agent-call/turn and /api/agent-call/speak.

type Fail = { ok: false; error: string };
const NOT_YOURS: Fail = { ok: false, error: "Only an executive or the head of this agent's line can change what it knows." };

export type StartedCall = { ok: true; callId: string; greeting: string; sttToken: string | null; limitSeconds: number; startedAt: string; mode: ResumeMode; canTeach: boolean };

/** Pick up: the call's row, the greeting (kept in the chat as the agent's first line) and a speech to text token */
export async function startCall(roleKey: string): Promise<StartedCall | Fail> {
  const me = await requireStaff();
  if (!canTalkToAgent(me, roleKey)) return { ok: false, error: "That isn't one of the agents." };
  if (!aiEnabled()) return { ok: false, error: "AI isn't connected yet." };
  if (!elevenlabsConfigured()) return { ok: false, error: "Calls need ElevenLabs: an exec adds ELEVENLABS_API_KEY in Vercel." };
  const admin = createAdminClient();
  const { data: role } = await admin.from("ai_roles").select("*").eq("key", roleKey).maybeSingle();
  if (!role) return { ok: false, error: "Unknown agent." };
  // A call of theirs never hung up (a closed tab, a dropped line) is closed first; what it heard stays for review
  const swept = await sweepOpenCalls(admin, { profileId: me.id }).catch(() => ({ closed: [] as string[] }));
  for (const id of swept.closed) after(() => summarizeCall(admin, id));
  // How this call follows their last one with this agent
  const { data: prev } = await admin.from("ai_role_calls").select("id, started_at, ended_at, last_turn_at, turns, topic").eq("profile_id", me.id).eq("role_key", roleKey).order("started_at", { ascending: false }).limit(1).maybeSingle();
  const mode = prev ? resumeModeFor({ startedAt: prev.started_at as string, endedAt: (prev.ended_at as string | null) ?? null, lastTurnAt: (prev.last_turn_at as string | null) ?? null, turns: Number(prev.turns ?? 0) }) : "fresh";
  // ElevenLabs' realtime speech to text when it hands out a token; the browser's own listening otherwise
  const sttToken = await realtimeSttToken(CALL_LIMIT_SECONDS + 60).catch((e) => {
    console.error("[agent call] speech token", e instanceof Error ? e.message : e);
    return null;
  });
  const row = { role_key: roleKey, profile_id: me.id, voice_id: voiceFor(roleKey, (role as { voice_id?: string | null }).voice_id), stt: sttToken ? "scribe" : "browser" };
  let { data: call, error } = await admin
    .from("ai_role_calls")
    .insert({ ...row, resumed_from: mode === "fresh" ? null : (prev?.id ?? null), resume_mode: mode })
    .select("id, started_at")
    .single();
  // Before the review migration: a plain call
  if (error) ({ data: call, error } = await admin.from("ai_role_calls").insert(row).select("id, started_at").single());
  if (error || !call) return { ok: false, error: error?.message ?? "Couldn't start the call." };
  const greeting = greetingFor(me.fullName, role.label as string, mode, (prev?.topic as string | null) ?? null, seedOf(call.id as string));
  await admin.from("ai_role_chats").insert({ role_key: roleKey, role: "agent", content: greeting, attachments: [], changes: [], created_by: me.id, call_id: call.id });
  return { ok: true, callId: call.id as string, greeting, sttToken, limitSeconds: CALL_LIMIT_SECONDS, startedAt: call.started_at as string, mode, canTeach: canTrainAgent(me, roleKey) };
}

/** A new speech to text token mid-call (the first one is single use: a dropped connection needs another) */
export async function renewSttToken(callId: string): Promise<{ ok: true; token: string } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id, role_key, started_at, ended_at").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id || call.ended_at || !canTalkToAgent(me, call.role_key as string)) return { ok: false, error: "This call has ended." };
  const left = CALL_LIMIT_SECONDS - (Date.now() - new Date(call.started_at as string).getTime()) / 1000;
  if (left <= 0) return { ok: false, error: "This call has ended." };
  try {
    return { ok: true, token: await realtimeSttToken(left + 30) };
  } catch {
    return { ok: false, error: "Couldn't reconnect the listening." };
  }
}

export type EndedCall = { ok: true; seconds: number; learned: LearnedItem[]; canReview: boolean; skills: Record<string, string> };

/**
 * Hang up: the call is closed, its cost logged with the other AI runs (ElevenLabs characters and seconds listened),
 * a short summary written after it (for later calls today), and what it heard comes back for the review. Nothing
 * heard is written yet. Safe to call twice.
 */
export async function endCall(callId: string): Promise<EndedCall | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, role_key, profile_id, stt, started_at, ended_at, tts_characters, learned").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That call isn't yours." };
  const learned = (call.learned ?? []) as LearnedItem[];
  const endedAt = call.ended_at ? new Date(call.ended_at as string) : new Date();
  const seconds = Math.min(CALL_LIMIT_SECONDS + 60, Math.max(0, Math.round((endedAt.getTime() - new Date(call.started_at as string).getTime()) / 1000)));
  if (!call.ended_at) {
    const sttSeconds = call.stt === "scribe" ? seconds : 0;
    const pending = pendingOf(learned).length;
    const { error } = await admin
      .from("ai_role_calls")
      .update({ ended_at: endedAt.toISOString(), stt_seconds: sttSeconds, ...(pending ? {} : { reviewed_at: endedAt.toISOString() }) })
      .eq("id", callId);
    if (error) await admin.from("ai_role_calls").update({ ended_at: endedAt.toISOString(), stt_seconds: sttSeconds }).eq("id", callId);
    await admin.from("ai_runs").insert({
      agent_key: "coach",
      label: `agent call voice ${call.role_key}`,
      model: null,
      ms: seconds * 1000,
      input_tokens: 0,
      output_tokens: 0,
      characters: (call.tts_characters as number) ?? 0,
      audio_seconds: sttSeconds,
      ok: true,
      profile_id: me.id,
      actor: "person",
    });
    after(() => summarizeCall(admin, callId));
    revalidatePath("/settings");
  }
  const { data: skillRows } = await admin.from("ai_agents").select("key, label").eq("role_key", call.role_key as string);
  const skills = Object.fromEntries((skillRows ?? []).map((k) => [k.key as string, k.label as string]));
  return { ok: true, seconds, learned, canReview: canTrainAgent(me, call.role_key as string), skills };
}

export type ReviewedCall = { ok: true; learned: LearnedItem[]; kept: number; tossed: number; proposals: number };

/**
 * The review: keep or toss each thing a call heard, with a kept note's text as edited. Kept notes are written to their
 * skill as knowledge items (in the agent's history, so an exec can revert one); kept rewrites of the core or a skill's
 * instructions go to the agent's chat as proposed edits a person applies; tossed ones are kept on the call as tossed.
 * The same people who apply edits in the agent's chat may review: an exec, or the head of the agent's line (their own
 * calls; an exec anyone's). Every pending item needs a decision. Safe against a second review (it's claimed first).
 */
export async function reviewCallLearnings(callId: string, decisions: Record<string, Decision>): Promise<ReviewedCall | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, role_key, profile_id, learned, reviewed_at").eq("id", callId).maybeSingle();
  if (!call) return { ok: false, error: "That call isn't there any more." };
  const roleKey = call.role_key as string;
  if (!canTrainAgent(me, roleKey) || (call.profile_id !== me.id && !me.isExec)) return NOT_YOURS;
  const items = (call.learned ?? []) as LearnedItem[];
  const plan = decide(items, decisions);
  if (!plan.ok) return plan;
  // Claimed, so two tabs can't write the same notes twice
  const { data: claimed } = await admin.from("ai_role_calls").update({ reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("id", callId).is("reviewed_at", null).select("id");
  if (!claimed?.length) return { ok: false, error: "This call was already reviewed." };

  const next = plan.items.slice();
  const proposals: LearnedItem[] = [];
  for (const k of plan.keep) {
    const at = next.findIndex((x) => x.key === k.key);
    if (k.type === "rewrite") {
      proposals.push(k);
      continue;
    }
    if (!canTrainAgent(me, k.skill)) {
      next[at] = { ...k, status: "tossed" };
      continue;
    }
    const { data, error } = await admin.from("ai_knowledge").insert({ agent_key: k.skill, kind: k.kind ?? "knowledge", title: k.title, body: k.body, created_by: me.id }).select("id").single();
    if (error || !data) {
      console.error("[agent call] keep learning", error?.message);
      // Not written: back to pending, so it surfaces again
      next[at] = { ...k, status: "pending" };
      continue;
    }
    await logTraining(admin, { me, agentKey: k.skill, target: "item:new", record: `item:${data.id}`, before: null });
    next[at] = { ...k, id: data.id as string };
  }
  const stillPending = pendingOf(next).length > 0;
  await admin
    .from("ai_role_calls")
    .update({ learned: next, ...(stillPending ? { reviewed_at: null, reviewed_by: null } : {}) })
    .eq("id", callId);
  if (proposals.length) {
    const asked = `From our call, change how you work: ${proposals.map((p) => `${p.skill === "core" ? "in your core" : `in your ${p.skill} skill`}, ${p.body}`).join(" Also, ")}`;
    after(async () => {
      const r = await chatWithAgent(roleKey, asked);
      if (!r.ok) console.error("[agent call] proposals", r.error);
    });
  }
  revalidatePath("/settings");
  revalidatePath("/pipeline");
  return { ok: true, learned: next, kept: plan.keep.length, tossed: plan.tossed, proposals: proposals.length };
}

/** Undo one note a call saved (the item is turned off, as a revert does; Put back turns it on again) */
export async function undoLearning(callId: string, itemId: string, undo = true): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, learned").eq("id", callId).maybeSingle();
  if (!call || (call.profile_id !== me.id && !me.isExec)) return { ok: false, error: "That call isn't yours." };
  const learned = (call.learned ?? []) as LearnedItem[];
  const at = learned.findIndex((l) => l.id === itemId && l.type === "note" && statusOf(l) === "kept");
  if (at < 0) return { ok: false, error: "That isn't something this call saved." };
  const { data: item } = await admin.from("ai_knowledge").select("agent_key").eq("id", itemId).maybeSingle();
  if (!item) return { ok: false, error: "That item isn't there any more." };
  if (!canTrainAgent(me, item.agent_key as string)) return NOT_YOURS;
  const before = await snapshot(admin, `item:${itemId}`);
  const { error } = await admin.from("ai_knowledge").update({ active: !undo, updated_at: new Date().toISOString() }).eq("id", itemId);
  if (error) return { ok: false, error: error.message };
  await logTraining(admin, { me, agentKey: item.agent_key as string, target: `item:${itemId}`, record: `item:${itemId}`, before });
  learned[at] = { ...learned[at], undone: undo };
  await admin.from("ai_role_calls").update({ learned }).eq("id", callId);
  revalidatePath("/settings");
  return { ok: true };
}

export type CallVoice = { id: string; name: string; about: string; preview: string | null };

async function trainerOf(roleKey: string): Promise<Staff | null> {
  const me = await requireStaff();
  return canTrainAgent(me, roleKey) ? me : null;
}

/** The voices an agent can speak in (Kaizen's own ElevenLabs voices first) */
export async function callVoices(roleKey: string): Promise<{ ok: true; voices: CallVoice[] } | Fail> {
  if (!(await trainerOf(roleKey))) return NOT_YOURS;
  if (!elevenlabsConfigured()) return { ok: false, error: "ElevenLabs isn't connected." };
  try {
    const voices = await listVoices();
    return {
      ok: true,
      voices: voices.map((v) => ({
        id: v.id,
        name: v.name,
        about: [v.labels.gender, v.labels.accent, v.labels.age, v.labels.description ?? v.labels.descriptive].filter(Boolean).join(", "),
        preview: v.previewUrl,
      })),
    };
  } catch {
    return { ok: false, error: "Couldn't load the voices." };
  }
}

/** The voice an agent speaks in on calls (null goes back to its role's default) */
export async function setAgentVoice(roleKey: string, voiceId: string | null): Promise<{ ok: true } | Fail> {
  const me = await trainerOf(roleKey);
  if (!me) return NOT_YOURS;
  if (voiceId !== null && !isVoiceId(voiceId)) return { ok: false, error: "Pick a voice." };
  const { error } = await createAdminClient().from("ai_roles").update({ voice_id: voiceId, updated_by: me.id }).eq("key", roleKey);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}
