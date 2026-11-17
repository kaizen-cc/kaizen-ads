"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { canTrainAgent } from "@/lib/agent-access";
import { CALL_LIMIT_SECONDS, greetingFor, isVoiceId, voiceFor, type LearnedItem } from "@/lib/agent-call/core";
import { logTraining, snapshot } from "@/lib/agent-training";
import { aiEnabled } from "@/lib/ai";
import { requireStaff, type Staff } from "@/lib/auth";
import { elevenlabsConfigured, listVoices, realtimeSttToken } from "@/lib/elevenlabs";
import { createAdminClient } from "@/lib/supabase/admin";
import { chatWithAgent } from "./actions";

// Calling an agent by voice (Settings › AI agents › the agent): anyone who can talk to the agent in its chat (an exec,
// or the head of its line) can call it. Starting a call opens its row and hands the browser a single-use token for
// ElevenLabs' realtime speech to text; hanging up closes it, logs what it cost and shows what it learned, each with
// Undo. The turns themselves stream through /api/agent-call/turn and /api/agent-call/speak.

type Fail = { ok: false; error: string };
const NOT_YOURS: Fail = { ok: false, error: "Only an executive or the head of this agent's line can call it." };

async function caller(roleKey: string): Promise<Staff | null> {
  const me = await requireStaff();
  return canTrainAgent(me, roleKey) ? me : null;
}

export type StartedCall = { ok: true; callId: string; greeting: string; sttToken: string | null; limitSeconds: number; startedAt: string };

/** Pick up: the call's row, the greeting (kept in the chat as the agent's first line) and a speech to text token */
export async function startCall(roleKey: string): Promise<StartedCall | Fail> {
  const me = await caller(roleKey);
  if (!me) return NOT_YOURS;
  if (!aiEnabled()) return { ok: false, error: "AI isn't connected yet." };
  if (!elevenlabsConfigured()) return { ok: false, error: "Calls need ElevenLabs: an exec adds ELEVENLABS_API_KEY in Vercel." };
  const admin = createAdminClient();
  const { data: role } = await admin.from("ai_roles").select("*").eq("key", roleKey).maybeSingle();
  if (!role) return { ok: false, error: "Unknown agent." };
  // ElevenLabs' realtime speech to text when it hands out a token; the browser's own listening otherwise
  const sttToken = await realtimeSttToken(CALL_LIMIT_SECONDS + 60).catch((e) => {
    console.error("[agent call] speech token", e instanceof Error ? e.message : e);
    return null;
  });
  const { data: call, error } = await admin
    .from("ai_role_calls")
    .insert({ role_key: roleKey, profile_id: me.id, voice_id: voiceFor(roleKey, (role as { voice_id?: string | null }).voice_id), stt: sttToken ? "scribe" : "browser" })
    .select("id, started_at")
    .single();
  if (error || !call) return { ok: false, error: error?.message ?? "Couldn't start the call." };
  const greeting = greetingFor(me.fullName, role.label as string);
  await admin.from("ai_role_chats").insert({ role_key: roleKey, role: "agent", content: greeting, attachments: [], changes: [], created_by: me.id, call_id: call.id });
  return { ok: true, callId: call.id as string, greeting, sttToken, limitSeconds: CALL_LIMIT_SECONDS, startedAt: call.started_at as string };
}

/** A new speech to text token mid-call (the first one is single use: a dropped connection needs another) */
export async function renewSttToken(callId: string): Promise<{ ok: true; token: string } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("profile_id, role_key, started_at, ended_at").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id || call.ended_at || !canTrainAgent(me, call.role_key as string)) return { ok: false, error: "This call has ended." };
  const left = CALL_LIMIT_SECONDS - (Date.now() - new Date(call.started_at as string).getTime()) / 1000;
  if (left <= 0) return { ok: false, error: "This call has ended." };
  try {
    return { ok: true, token: await realtimeSttToken(left + 30) };
  } catch {
    return { ok: false, error: "Couldn't reconnect the listening." };
  }
}

export type EndedCall = { ok: true; seconds: number; learned: LearnedItem[]; proposals: number };

/**
 * Hang up: the call is closed, its cost logged with the other AI runs (ElevenLabs characters and seconds listened),
 * and what it learned comes back for the summary. Changes to its core or a skill's instructions go to its chat as
 * proposed edits (written after the call, so hanging up is instant). Safe to call twice.
 */
export async function endCall(callId: string): Promise<EndedCall | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, role_key, profile_id, stt, started_at, ended_at, tts_characters, learned").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That call isn't yours." };
  const learned = (call.learned ?? []) as LearnedItem[];
  const proposals = learned.filter((l) => l.type === "rewrite");
  const endedAt = call.ended_at ? new Date(call.ended_at as string) : new Date();
  const seconds = Math.min(CALL_LIMIT_SECONDS + 60, Math.max(0, Math.round((endedAt.getTime() - new Date(call.started_at as string).getTime()) / 1000)));
  if (!call.ended_at) {
    const sttSeconds = call.stt === "scribe" ? seconds : 0;
    await admin.from("ai_role_calls").update({ ended_at: endedAt.toISOString(), stt_seconds: sttSeconds }).eq("id", callId);
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
    if (proposals.length && canTrainAgent(me, call.role_key as string)) {
      const roleKey = call.role_key as string;
      const asked = `From our call just now, change how you work: ${proposals.map((p) => `${p.skill === "core" ? "in your core" : `in your ${p.skill} skill`}, ${p.body}`).join(" Also, ")}`;
      after(async () => {
        const r = await chatWithAgent(roleKey, asked);
        if (!r.ok) console.error("[agent call] proposals", r.error);
      });
    }
    revalidatePath("/settings");
  }
  return { ok: true, seconds, learned, proposals: proposals.length };
}

/** Undo one thing the call saved (the item is turned off, as a revert does; Put back turns it on again) */
export async function undoLearning(callId: string, itemId: string, undo = true): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, learned").eq("id", callId).maybeSingle();
  if (!call || call.profile_id !== me.id) return { ok: false, error: "That call isn't yours." };
  const learned = (call.learned ?? []) as LearnedItem[];
  const at = learned.findIndex((l) => l.id === itemId && l.type === "note");
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

/** The voices an agent can speak in (Kaizen's own ElevenLabs voices first) */
export async function callVoices(roleKey: string): Promise<{ ok: true; voices: CallVoice[] } | Fail> {
  if (!(await caller(roleKey))) return NOT_YOURS;
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
  const me = await caller(roleKey);
  if (!me) return NOT_YOURS;
  if (voiceId !== null && !isVoiceId(voiceId)) return { ok: false, error: "Pick a voice." };
  const { error } = await createAdminClient().from("ai_roles").update({ voice_id: voiceId, updated_by: me.id }).eq("key", roleKey);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}
