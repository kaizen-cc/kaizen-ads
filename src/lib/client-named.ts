import type { SupabaseClient } from "@supabase/supabase-js";
import { pickClientByName } from "@/lib/client-name-match";

// The client a tool was asked for, by name: the one shared resolver for the assistant's, the agents' (calls and their
// chats) and Kaizen AI's tools. Reads the clients this person's session can see (RLS), so nobody reaches a client
// they can't open. The name matches ignoring spaces, punctuation and case before any loose word match
// (src/lib/client-name-match.ts); two equally close clients are asked about, never guessed.

export type NamedRow = { id: string; name: string; slug: string };

export class ClientNameError extends Error {
  constructor(
    message: string,
    readonly choices: string[] = [],
  ) {
    super(message);
  }
}

/** The visible client named, or a ClientNameError saying none matched or which ones to choose between */
export async function clientNamed(db: SupabaseClient, name: unknown): Promise<NamedRow> {
  const asked = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!asked) throw new ClientNameError("Which client?");
  const { data } = await db.from("clients").select("id, name, slug").is("archived_at", null).order("name").limit(2000);
  const rows = (data ?? []) as NamedRow[];
  const bySlug = rows.find((c) => c.slug === asked.toLowerCase());
  if (bySlug) return bySlug;
  const { hit, close } = pickClientByName(asked, rows);
  if (hit) return hit;
  if (close.length) throw new ClientNameError(`"${asked}" could be ${close.map((c) => c.name).join(" or ")}. Ask which one they mean.`, close.map((c) => c.name));
  throw new ClientNameError(`No client called "${asked}" that you can see.`);
}

/** The same, null instead of an error when no name was given */
export async function clientNamedOrNull(db: SupabaseClient, name: unknown): Promise<NamedRow | null> {
  return String(name ?? "").trim() ? clientNamed(db, name) : null;
}
