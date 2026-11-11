import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENCY_SYSTEM, askJson, clientContext, contextBlock, getAgent, SCRIPT_SCHEMA, type Script } from "@/lib/ai";
import { readReferences, referencesBlock } from "@/lib/references";

// The Video script writer: the ticket's brief into a shootable script, saved on the ticket (request_scripts). Used by
// "Write the script" on a video ticket and, in the background, the moment production starts. `db` reads the ticket
// and the client (the person's own client when they asked, the server's in the background); `admin` saves it.

export class ScriptError extends Error {}

export async function writeScriptFor(db: SupabaseClient, admin: SupabaseClient, requestId: string, by: string | null, note?: string): Promise<{ content: Script; version: number }> {
  const { data: r } = await db
    .from("board_requests")
    .select("id, client_id, title, format, angle_name, audience, brief, sizes, refs, new_count, variation_count")
    .eq("id", requestId)
    .maybeSingle();
  if (!r) throw new ScriptError("Ticket not found.");
  if (r.format !== "video") throw new ScriptError("Scripts are for video tickets.");
  const ctx = await clientContext(db, r.client_id);
  if (!ctx) throw new ScriptError("You don't work on this client.");

  const [{ sources }, refs] = await Promise.all([getAgent("scripts"), readReferences(r.refs ?? [])]);
  const content = await askJson<Script>({
    agent: "scripts",
    label: `script ${ctx.name}`,
    clientId: r.client_id,
    system: AGENCY_SYSTEM,
    schema: SCRIPT_SCHEMA,
    images: refs.images,
    prompt: `${contextBlock(ctx, undefined, sources)}
${referencesBlock(refs.reads)}

<video_ticket>
Title: ${r.title}
Angle: ${r.angle_name ?? "not set"}
Audience: ${r.audience ?? "not set"}
Sizes: ${(r.sizes ?? []).join(", ") || "9x16"}
Deliverables: ${r.new_count} net new, ${r.variation_count} variations
Brief:
${r.brief ?? "(no brief)"}
</video_ticket>
${note?.trim() ? `\n<change_requested>\n${note.trim()}\n</change_requested>\n` : ""}
Write the script for this video ticket. Fields:
- framework, style, why: which framework and video style you chose and why (one or two lines).
- hooks: exactly 3, each a different hook type; onScreen under 8 words, spoken one sentence.
- title, placement (e.g. "Reels / Stories 9:16"), objective, lengthSeconds.
- beats: the timed beat sheet from 0s to the end (time like "0-3s"), with shot, onScreen text, voiceover or dialogue, sound or music note. Retention beats around 3s, 7s and 10s; CTA last. When the brief has Beats, they are the agreed spine: keep their order, their names and their exact lines (quoted footage with its source timestamp), and add the shots, timing and sound around them. The brief's Must and Never hold.
- cta: the closing action, exactly as the brief's offer allows.
- filming: who's on camera, location, framing (9:16 with the 4:5 safe crop), B-roll and inserts to capture. If the footage must come from the client, say what they should shoot.
- testPlan: which hook to run first, what variations to cut from the same footage, when to refresh.
- watchouts: client-memory rules or policy risks that matter for this script. Empty if none.`,
  });
  const { data: prev } = await admin.from("request_scripts").select("version").eq("request_id", r.id).maybeSingle();
  const version = (prev?.version ?? 0) + 1;
  const { error } = await admin
    .from("request_scripts")
    .upsert({ request_id: r.id, client_id: r.client_id, content, model: (await getAgent("scripts")).model, version, generated_by: by, generated_at: new Date().toISOString() });
  if (error) throw new ScriptError(error.message);
  return { content, version };
}
