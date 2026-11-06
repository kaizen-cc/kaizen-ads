"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Someone on the creative team read a client's Brand Bible: this version is reviewed for them (it leaves their list).
 * The Head of Creative's review also marks the Bible itself reviewed, as the button on the Bible does.
 */
export async function markBibleReviewed(clientId: string, version: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireStaff();
  const db = await createClient();
  const { error } = await db.from("brand_bible_reviews").upsert({ client_id: clientId, version, profile_id: me.id }, { onConflict: "client_id,version,profile_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: "Couldn't mark it reviewed. Try again." };
  if (me.role === "head_of_creative")
    await db.from("client_brand_bibles").update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: me.id }).eq("client_id", clientId).eq("version", version).neq("status", "building");
  // Its notice is done with too
  await db.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", me.id).eq("key", `bible-review:${clientId}:${version}`).is("read_at", null);
  revalidatePath("/next");
  return { ok: true };
}
