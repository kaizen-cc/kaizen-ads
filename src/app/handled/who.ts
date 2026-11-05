import "server-only";
import { readNoticeToken, type NoticeKind } from "@/lib/notice-links";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type Ref = { t: string } | { kind: NoticeKind; id: string };

/**
 * Who's acting: the person the email went to (the signed link), or whoever's signed in. Either way only someone the
 * item is on, or who was told about it, or an exec, may close it.
 */
export async function whoActs(ref: Ref): Promise<{ profileId: string; kind: NoticeKind; id: string } | null> {
  if (!adminConfigured()) return null;
  const admin = createAdminClient();
  let found: { profileId: string; kind: NoticeKind; id: string } | null = null;
  if ("t" in ref) {
    const t = readNoticeToken(ref.t);
    if (t) found = { profileId: t.profileId, kind: t.kind, id: t.id };
  } else if (["said", "owed"].includes(ref.kind) && /^[0-9a-f-]{36}$/.test(ref.id)) {
    const db = await createClient();
    const { data } = await db.auth.getClaims();
    const uid = data?.claims?.sub;
    if (uid) {
      const { data: me } = await admin.from("profiles").select("id").eq("auth_user_id", uid).eq("is_active", true).maybeSingle();
      if (me) found = { profileId: me.id as string, kind: ref.kind, id: ref.id };
    }
  }
  if (!found) return null;
  const { mayAct } = await import("@/lib/notice-resolve");
  return (await mayAct(admin, found.kind, found.id, found.profileId)) ? found : null;
}
