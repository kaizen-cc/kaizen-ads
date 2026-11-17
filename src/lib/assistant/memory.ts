import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { cleanMemory, FACT_TOPICS, ownMemory, STYLE_TOPICS, type MemoryNote, type MemoryRow } from "./core";

// The assistant's memory of one person: facts they told it (a birthday, family, a trip, what they like) and how they
// like to talk (brief or chatty, humor, numbers first or story first). Private to that person: read here only for
// that person's own calls, never for anyone else, never shared with the other agents. It only learns from what the
// person says on their calls with it, never from their email, Slack or anything else.

const COLUMNS = "id, profile_id, kind, topic, body, on_date, follow_up_on, followed_up_at";

/** This person's memory (only theirs, whatever client reads it) */
export async function loadMemory(admin: SupabaseClient, profileId: string): Promise<MemoryRow[]> {
  const { data, error } = await admin.from("assistant_memory").select(COLUMNS).eq("profile_id", profileId).order("updated_at", { ascending: false }).limit(80);
  if (error) return [];
  return ownMemory((data ?? []) as MemoryRow[], profileId);
}

/** Saves notes to this person's memory: facts added, a style trait replaced (one per trait) */
export async function saveNotes(admin: SupabaseClient, profileId: string, notes: readonly MemoryNote[], callId: string | null): Promise<number> {
  let saved = 0;
  for (const n of notes) {
    const row = { profile_id: profileId, kind: n.kind, topic: n.topic, body: n.body, on_date: n.on_date, follow_up_on: n.follow_up_on, call_id: callId, updated_at: new Date().toISOString() };
    if (n.kind === "style") {
      // One row per trait: its words replaced when it's already kept
      const { data: had } = await admin.from("assistant_memory").update({ body: n.body, call_id: callId, updated_at: row.updated_at }).eq("profile_id", profileId).eq("kind", "style").eq("topic", n.topic).select("id");
      if (had?.length) {
        saved++;
        continue;
      }
    }
    const { error } = await admin.from("assistant_memory").insert(row);
    if (error) console.error("[assistant memory] save", error.message);
    else saved++;
  }
  return saved;
}

/** A follow-up the greeting asked about: asked once */
export async function markFollowedUp(admin: SupabaseClient, profileId: string, id: string) {
  await admin.from("assistant_memory").update({ followed_up_at: new Date().toISOString() }).eq("id", id).eq("profile_id", profileId);
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["notes"],
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "topic", "body", "on_date", "follow_up_on"],
        properties: {
          kind: { type: "string", enum: ["fact", "style"] },
          topic: { type: "string", enum: [...new Set([...FACT_TOPICS, ...STYLE_TOPICS])] },
          body: { type: "string", description: "One short sentence in the second person about them ('Your daughter Mia starts school in September')" },
          on_date: { type: "string", description: "YYYY-MM-DD when a date matters (a birthday: any year with the right month and day), else empty" },
          follow_up_on: { type: "string", description: "YYYY-MM-DD to ask how it went (the day after a trip or event ends), else empty" },
        },
      },
    },
  },
};

const SYSTEM = `You keep a friendly work assistant's private memory of one person, from what THEY said on a call with it. Pick out:
- facts they shared about themselves that a good colleague would remember: their birthday, family (names, ages, milestones), trips and events coming up, hobbies, food and work preferences (how they like updates, when they're busiest);
- about their work life, from what they said: what they enjoy about the job (topic likes), what eats their time or what they want help with (needs), what they're working toward (goals), the clients they find challenging or want to watch closely, by name with why (focus), how their day runs and when they want a rundown (routine), and what they use you for, including things they keep asking for (uses). Update a note when it changes (a new focus client, a goal reached).
- how they like to talk (style): brief or chatty, humor or straight, numbers first or the story first, fast or relaxed. Only when it's clear from how they talked.
Never keep: client data or numbers (that lives elsewhere; only which clients they find hard or want to watch, and why, in their words), passwords or numbers, health, religion, politics, money troubles, other people's private details beyond a name and relation, or anything they asked you to forget. Nothing they didn't say themselves. Most calls give nothing new: then return an empty list. At most six notes, none repeating what's already known.`;

/**
 * After an assistant call: what the person shared and how they talk, read with a cheap model from their own lines only
 * (never the assistant's, never their email or Slack), checked, and saved to their private memory.
 */
export async function learnFromCall(admin: SupabaseClient, callId: string): Promise<number> {
  const { data: call } = await admin.from("ai_role_calls").select("id, profile_id, role_key").eq("id", callId).maybeSingle();
  if (!call || call.role_key !== "assistant") return 0;
  const profileId = call.profile_id as string;
  const { data: rows } = await admin.from("ai_role_chats").select("content").eq("call_id", callId).eq("role", "user").eq("created_by", profileId).order("created_at").limit(80);
  const said = (rows ?? []).map((r) => String(r.content)).join("\n");
  if (said.split(/\s+/).length < 8) return 0;
  const known = await loadMemory(admin, profileId);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  try {
    const out = await askJson<unknown>({
      agent: "coach",
      label: "assistant memory",
      bare: true,
      noSample: true,
      override: { model: "haiku", effort: "low" },
      system: SYSTEM,
      schema: SCHEMA,
      maxTokens: 2000,
      prompt: `Today is ${today}.\n\n<already_known>\n${known.map((m) => `${m.kind}/${m.topic}: ${m.body}`).join("\n") || "(nothing yet)"}\n</already_known>\n\n<what_they_said>\n${said.slice(0, 20_000)}\n</what_they_said>`,
    });
    const notes = cleanMemory(out, known);
    return notes.length ? await saveNotes(admin, profileId, notes, callId) : 0;
  } catch (e) {
    console.error("[assistant memory]", e instanceof Error ? e.message : e);
    return 0;
  }
}
