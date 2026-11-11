"use server";

import { AiUnavailable, type Script } from "@/lib/ai";
import { requireStaff } from "@/lib/auth";
import { ScriptError, writeScriptFor } from "@/lib/script-writer";
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
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { content, version } = await writeScriptFor(await createClient(), createAdminClient(), requestId, me.id, note);
    return { ok: true, script: { content, version, at: new Date().toISOString(), by: me.fullName } };
  } catch (e) {
    return { ok: false, error: e instanceof AiUnavailable || e instanceof ScriptError ? e.message : "Couldn't write the script." };
  }
}
