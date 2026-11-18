import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { firstNameOf } from "@/lib/agent-call/core";
import type { CallNotes } from "@/lib/assistant/notes";
import { createClient } from "@/lib/supabase/server";
import { cleanPrefs } from "@/lib/assistant/ring-core";
import type { MemoryItem } from "./actions";
import { AssistantHome, type PastCall } from "./assistant-home";

export const metadata: Metadata = { title: "Your assistant" };

// Your assistant: call it, pick its voice and color, read the notes from your calls with it (and download their
// transcripts), and see what it knows about you (view, edit,
// delete one thing or everything). Read with the person's own session: their memory is theirs alone (row-level
// security), never an exec's to read.

export default async function AssistantPage() {
  const me = await requireStaff();
  const db = await createClient();
  const [{ data: memory }, { data: calls }, { data: look }, { data: named }, { data: ring }] = await Promise.all([
    db.from("assistant_memory").select("id, kind, topic, body, on_date, follow_up_on, updated_at, profile_id").eq("profile_id", me.id).order("updated_at", { ascending: false }).limit(200),
    db.from("ai_role_calls").select("id, started_at, ended_at, topic, notes, turns").eq("profile_id", me.id).eq("role_key", "assistant").not("ended_at", "is", null).order("started_at", { ascending: false }).limit(12),
    // Their assistant's voice (its color comes with the layout; read on its own: before its migration this just comes back empty)
    db.from("profiles").select("assistant_voice").eq("id", me.id).maybeSingle(),
    // The name they gave it (read on its own, so the page loads before its migration)
    db.from("profiles").select("assistant_name").eq("id", me.id).maybeSingle(),
    // When something's urgent: ring or chat only, and quiet hours (empty before its migration: the defaults)
    db.from("assistant_ring_prefs").select("mode, quiet_start, quiet_end, tz").eq("profile_id", me.id).maybeSingle(),
  ]);
  const ringPrefs = cleanPrefs(ring ? { mode: ring.mode, quietStart: ring.quiet_start, quietEnd: ring.quiet_end, tz: ring.tz } : null);
  const items: MemoryItem[] = (memory ?? [])
    .filter((m) => m.profile_id === me.id)
    .map((m) => ({ id: m.id as string, kind: m.kind as "fact" | "style", topic: m.topic as string, body: m.body as string, onDate: (m.on_date as string | null) ?? null, followUpOn: (m.follow_up_on as string | null) ?? null, updatedAt: m.updated_at as string }));
  const past: PastCall[] = (calls ?? [])
    .filter((c) => Number(c.turns ?? 0) > 0)
    .map((c) => ({ id: c.id as string, startedAt: c.started_at as string, seconds: Math.max(0, Math.round((Date.parse(c.ended_at as string) - Date.parse(c.started_at as string)) / 1000)), topic: (c.topic as string | null) ?? null, notes: (c.notes as CallNotes | null) ?? null }));
  return <AssistantHome name={firstNameOf(me.fullName)} memory={items} calls={past} voice={(look?.assistant_voice as string | null | undefined) ?? null} assistantName={(named?.assistant_name as string | null | undefined) ?? null} ringPrefs={ringPrefs} />;
}
