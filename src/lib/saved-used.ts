import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { propagateUse, suggestionIdeaKeys, uniqueKeys, type IdeaKey } from "@/lib/saved-references";

// An idea was briefed (a request sent, an Asana task made, a saved reference added to a ticket): every person's save of
// that idea for that client is marked used (when, by whom, where), so it leaves their "Things you've saved", and each
// other person who had saved it is told once on the bell ("An idea you saved for <client> is in motion").

const quote = (v: string) => `"${v.replace(/["\\]/g, "")}"`;

export type UsedBy = { id: string; name: string };

/**
 * Mark the ideas a brief was built on as used, for everyone. Pass what's known: the saved rows it used (savedIds), the
 * ideas themselves (keys), and the suggested brief it came from (suggestionId: its own id and what it was built on).
 */
export async function markIdeasUsed(
  db: SupabaseClient,
  o: { clientId?: string | null; savedIds?: string[]; keys?: IdeaKey[]; suggestionId?: string | null; requestId?: string | null; href?: string | null; title?: string | null; by: UsedBy },
) {
  let clientId = o.clientId ?? null;
  let keys: IdeaKey[] = [...(o.keys ?? [])];
  const ids = (o.savedIds ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 40);
  if (ids.length) {
    const { data } = await db.from("client_saved_references").select("client_id, source, ref_id").in("id", ids);
    for (const r of data ?? []) {
      clientId ??= r.client_id as string;
      keys.push({ source: r.source as IdeaKey["source"], refId: r.ref_id as string });
    }
  }
  if (o.suggestionId && /^[0-9a-f-]{36}$/i.test(o.suggestionId)) {
    const [{ data: s }, { data: promises }] = await Promise.all([
      db.from("creative_suggestions").select("client_id, source").eq("id", o.suggestionId).maybeSingle(),
      db.from("call_commitments").select("id").eq("suggestion_id", o.suggestionId).limit(5),
    ]);
    if (s) {
      clientId ??= s.client_id as string;
      keys.push(...suggestionIdeaKeys(o.suggestionId, s.source as Record<string, unknown> | null));
    }
    for (const p of promises ?? []) keys.push({ source: "promise", refId: p.id as string });
  }
  keys = uniqueKeys(keys).slice(0, 20);
  if (!clientId || !keys.length) return { marked: 0, notified: 0 };

  const { data: rows } = await db
    .from("client_saved_references")
    .select("id, source, ref_id, saved_by, used_at, title")
    .eq("client_id", clientId)
    .or(keys.map((k) => `and(source.eq.${k.source},ref_id.eq.${quote(k.refId)})`).join(","));
  const list = (rows ?? []).map((r) => ({ id: r.id as string, savedBy: (r.saved_by as string | null) ?? null, usedAt: (r.used_at as string | null) ?? null, title: (r.title as string | null) ?? null }));
  const { mark, notify } = propagateUse(list, o.by.id);
  if (!mark.length) return { marked: 0, notified: 0 };
  await db
    .from("client_saved_references")
    .update({ used_at: new Date().toISOString(), used_request_id: o.requestId && /^[0-9a-f-]{36}$/i.test(o.requestId) ? o.requestId : null, used_by: o.by.id, used_href: o.href?.slice(0, 1000) ?? null })
    .in("id", mark)
    .is("used_at", null);
  if (notify.length) {
    const { data: c } = await db.from("clients").select("name").eq("id", clientId).maybeSingle();
    const client = (c?.name as string | undefined) ?? "a client";
    const first = o.by.name.trim().split(/\s+/)[0] || o.by.name;
    await db.from("notifications").upsert(
      notify.map((n) => {
        const title = o.title ?? list.find((r) => r.id === n.rowId)?.title ?? "an idea";
        return {
          profile_id: n.profileId,
          kind: "ticket",
          title: `An idea you saved for ${client} is in motion: ${title}, by ${first}`.slice(0, 300),
          body: `${o.by.name} briefed it, so it's out of your saved list. Open it to see where it's at.`,
          href: o.href ?? null,
          client_id: clientId,
          key: `saved-used:${n.rowId}`,
          priority: "normal",
          actor_id: o.by.id,
        };
      }),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  }
  return { marked: mark.length, notified: notify.length };
}
