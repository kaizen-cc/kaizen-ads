"use server";

import { AGENCY_SYSTEM, AiUnavailable, askJson, clientContext, contextBlock, getAgent, SCRIPT_SCHEMA, type Script } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { readReferences, referencesBlock } from "@/lib/references";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type SavedScript = { content: Script; version: number; at: string; by: string | null };

/** The script saved on a video ticket, if one was written. */
export async function ticketScript(requestId: string): Promise<SavedScript | null> {
  await requireStaff();
  const supabase = await createClient();
  const { data } = await supabase.from("request_scripts").select("content, version, generated_at, profiles(full_name)").eq("request_id", requestId).maybeSingle();
  if (!data) return null;
  return { content: data.content as Script, version: data.version, at: data.generated_at, by: (data.profiles as unknown as { full_name: string } | null)?.full_name ?? null };
}

/** The Video script writer turns the ticket's brief into a shootable script. Rewriting replaces it and bumps the version. */
export async function writeScript(requestId: string, note?: string): Promise<{ ok: true; script: SavedScript } | { ok: false; error: string }> {
  const me = await requireStaff();
  const supabase = await createClient();
  const { data: r } = await supabase
    .from("board_requests")
    .select("id, client_id, title, format, angle_name, audience, brief, sizes, refs, new_count, variation_count")
    .eq("id", requestId)
    .maybeSingle();
  if (!r) return { ok: false, error: "Ticket not found." };
  if (r.format !== "video") return { ok: false, error: "Scripts are for video tickets." };
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const ctx = await clientContext(supabase, r.client_id);
  if (!ctx) return { ok: false, error: "You don't work on this client." };

  try {
    const [{ sources }, refs] = await Promise.all([getAgent("scripts"), readReferences(r.refs ?? [])]);
    const content = await askJson<Script>({
      agent: "scripts",
      label: `script ${ctx.name}`,
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
- beats: the timed beat sheet from 0s to the end (time like "0-3s"), with shot, onScreen text, voiceover or dialogue, sound or music note. Retention beats around 3s, 7s and 10s; CTA last.
- cta: the closing action, exactly as the brief's offer allows.
- filming: who's on camera, location, framing (9:16 with the 4:5 safe crop), B-roll and inserts to capture. If the footage must come from the client, say what they should shoot.
- testPlan: which hook to run first, what variations to cut from the same footage, when to refresh.
- watchouts: client-memory rules or policy risks that matter for this script. Empty if none.`,
    });
    const admin = createAdminClient();
    const { data: prev } = await admin.from("request_scripts").select("version").eq("request_id", r.id).maybeSingle();
    const version = (prev?.version ?? 0) + 1;
    const { error } = await admin
      .from("request_scripts")
      .upsert({ request_id: r.id, client_id: r.client_id, content, model: (await getAgent("scripts")).model, version, generated_by: me.id, generated_at: new Date().toISOString() });
    if (error) return { ok: false, error: error.message };
    return { ok: true, script: { content, version, at: new Date().toISOString(), by: me.fullName } };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable ? e.message : "Couldn't write the script." };
  }
}
