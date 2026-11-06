"use server";

import { requireStaff } from "@/lib/auth";
import { can } from "@/lib/chat-permissions";
import { findCopyLine } from "@/lib/copy-library";
import type { CopyKind } from "@/lib/copy-library-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The Copy library's buttons: star a line to keep it (shared with the team on that client), and Make variations.

const ID = /^[0-9a-f-]{36}$/i;

export async function starCopyLine(clientId: string, key: string, kind: CopyKind, text: string, on: boolean): Promise<{ ok: true } | { error: string }> {
  const me = await requireStaff();
  if (!ID.test(clientId) || !key || key.length > 80) return { error: "That line can't be found." };
  const db = await createClient();
  const { error } = on
    ? await db.from("copy_library_stars").upsert({ client_id: clientId, line_key: key, kind, text: text.slice(0, 4000), created_by: me.id }, { onConflict: "client_id,line_key", ignoreDuplicates: true })
    : await db.from("copy_library_stars").delete().eq("client_id", clientId).eq("line_key", key);
  return error ? { error: "Couldn't save the star. Try again." } : { ok: true };
}

export async function makeCopyVariations(clientId: string, key: string, n: number, note: string | null) {
  const me = await requireStaff();
  // Writing copy is the copywriter's, the heads', the buyers' and the executives' (src/lib/chat-permissions.ts)
  const allowed = can(me, "copy");
  if (!allowed.ok) return { error: allowed.reason } as const;
  if (!ID.test(clientId)) return { error: "That client can't be found." } as const;
  // The line as the person can see it (their own session decides whether they can see the client)
  const line = await findCopyLine(await createClient(), clientId, key);
  if (!line) return { error: "That line isn't in the library any more." } as const;
  try {
    const { writeVariations } = await import("@/lib/copy-variations");
    const out = await writeVariations(createAdminClient(), { clientId, line, n, note, by: me.id });
    if (!out.variations.length) return { error: "None of the variations fit Meta's limits. Try again, or ask for something shorter." } as const;
    return { ok: true, ...out } as const;
  } catch (e) {
    console.error("[copy library] variations", e instanceof Error ? e.message : e);
    return { error: e instanceof Error && e.name === "AiUnavailable" ? e.message : "The Copywriter couldn't write them just now. Try again." } as const;
  }
}
