import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recapKeysOf, stableKeyOf } from "@/lib/today-counts";
import { cleanComment, commentAudience, ENDED_SAY, readPause, type ThreadState } from "@/lib/item-comments-core";

// Comments on every Overview and Today item (the server side; rules in ./item-comments-core.ts). Read with the person's
// own session (RLS: the clients they can see), written with the server's rights after that check. A new comment tells
// the people the item reaches in the app (the bell), never by Slack DM. A "waiting on client" mark pauses the item's
// reminders and escalations (pausedKeys) until the client writes, sends an asset, or the due date passes.

export type ItemComment = { id: string; body: string; kind: "comment" | "waiting" | "resumed"; at: string; author: string | null; authorId: string | null };
export type ItemThread = { key: string; clientId: string | null; title: string | null; waiting: boolean; waitingSince: string | null; waitingBy: string | null; comments: ItemComment[] };

type Me = { id: string; fullName: string };

/** One item's thread, as the person may read it */
export async function loadThread(db: SupabaseClient, rawKey: string): Promise<ItemThread> {
  const key = stableKeyOf(rawKey);
  const [{ data: t }, { data: cs }] = await Promise.all([
    db.from("item_threads").select("key, client_id, title, waiting_on_client, waiting_since, waiting_by, waiter:profiles!item_threads_waiting_by_fkey(full_name)").eq("key", key).maybeSingle(),
    db.from("item_comments").select("id, body, kind, created_at, author_id, author:profiles!item_comments_author_id_fkey(full_name)").eq("key", key).order("created_at").limit(200),
  ]);
  return {
    key,
    clientId: (t?.client_id as string | null) ?? null,
    title: (t?.title as string | null) ?? null,
    waiting: Boolean(t?.waiting_on_client),
    waitingSince: (t?.waiting_since as string | null) ?? null,
    waitingBy: ((t?.waiter as unknown as { full_name: string } | null) ?? null)?.full_name ?? null,
    comments: ((cs ?? []) as unknown as { id: string; body: string; kind: ItemComment["kind"]; created_at: string; author_id: string | null; author: { full_name: string } | null }[]).map((c) => ({ id: c.id, body: c.body, kind: c.kind, at: c.created_at, authorId: c.author_id, author: c.author?.full_name ?? null })),
  };
}

/** How many comments, and whether it's waiting on the client, for many items at once (the list view's badges) */
export async function threadBadges(db: SupabaseClient, rawKeys: string[]): Promise<Record<string, { comments: number; waiting: boolean }>> {
  const keys = [...new Set(rawKeys.map(stableKeyOf))];
  if (!keys.length) return {};
  const { data } = await db.from("item_threads").select("key, comments, waiting_on_client").in("key", keys.slice(0, 300));
  const by = new Map((data ?? []).map((t) => [t.key as string, { comments: Number(t.comments ?? 0), waiting: Boolean(t.waiting_on_client) }]));
  return Object.fromEntries(rawKeys.map((k) => [k, by.get(stableKeyOf(k)) ?? { comments: 0, waiting: false }]));
}

/**
 * Adds a comment (and/or sets or clears "waiting on client") as this person. The caller has checked they can see the
 * client. Everyone the item reached and everyone who commented before hears it in the app.
 */
export async function addComment(admin: SupabaseClient, me: Me, input: { key: string; clientId: string | null; title?: string | null; body?: string; waiting?: boolean | null; dueAt?: string | null; href?: string | null }) {
  const key = stableKeyOf(input.key);
  const body = cleanComment(input.body);
  const now = new Date().toISOString();
  const { data: cur } = await admin.from("item_threads").select("waiting_on_client, comments").eq("key", key).maybeSingle();
  const rows: { key: string; client_id: string | null; author_id: string; body: string; kind: ItemComment["kind"] }[] = [];
  if (body) rows.push({ key, client_id: input.clientId, author_id: me.id, body, kind: "comment" });
  const setWaiting = input.waiting === true && !cur?.waiting_on_client;
  const clearWaiting = input.waiting === false && Boolean(cur?.waiting_on_client);
  if (setWaiting) rows.push({ key, client_id: input.clientId, author_id: me.id, body: "Waiting on the client: reminders and escalations paused until they reply, send something new, or it's due.", kind: "waiting" });
  if (clearWaiting) rows.push({ key, client_id: input.clientId, author_id: me.id, body: "Not waiting on the client any more: reminders are on again.", kind: "resumed" });
  if (!rows.length) return { ok: false as const, error: "Write a comment first." };
  const { error } = await admin.from("item_comments").insert(rows);
  if (error) return { ok: false as const, error: "It didn't save. Try again." };
  await admin.from("item_threads").upsert(
    {
      key,
      client_id: input.clientId,
      ...(input.title ? { title: input.title.slice(0, 300) } : {}),
      comments: Number(cur?.comments ?? 0) + (body ? 1 : 0),
      ...(body ? { last_comment_at: now } : {}),
      ...(setWaiting ? { waiting_on_client: true, waiting_since: now, waiting_by: me.id, due_at: input.dueAt ?? null } : {}),
      ...(clearWaiting ? { waiting_on_client: false, waiting_since: null, waiting_by: null, due_at: null } : {}),
      updated_at: now,
    },
    { onConflict: "key" },
  );
  await tellThread(admin, me, { key, clientId: input.clientId, title: input.title ?? null, href: input.href ?? null, what: body ? body : setWaiting ? "marked it waiting on the client" : "took the waiting-on-client mark off" });
  if (setWaiting || clearWaiting) {
    const { reviewsChanged } = await import("@/lib/item-state");
    await reviewsChanged();
  }
  return { ok: true as const };
}

/** The people this item reached (it was on their day), and who commented on it before, hear in the app */
async function tellThread(admin: SupabaseClient, me: Me, o: { key: string; clientId: string | null; title: string | null; href: string | null; what: string }) {
  const recap = recapKeysOf(o.key);
  const [{ data: reached }, { data: before }] = await Promise.all([
    admin.from("daily_items").select("profile_id").in("key", [...new Set([...recap, o.key])]).limit(200),
    admin.from("item_comments").select("author_id").eq("key", o.key).limit(200),
  ]);
  // The person a message or promise is on hears too, whether or not it was on their day yet
  const owners = await ownersOf(admin, o.key);
  const to = commentAudience({ author: me.id, reached: (reached ?? []).map((r) => r.profile_id as string), commenters: (before ?? []).map((r) => r.author_id as string), owners });
  if (!to.length) return;
  const title = `${me.fullName} on ${o.title ?? "an item on your day"}`.slice(0, 300);
  await admin
    .from("notifications")
    .upsert(
      to.map((id) => ({ profile_id: id, kind: "comment", title, body: o.what.slice(0, 1000), href: o.href ?? `/pipeline?comments=${encodeURIComponent(o.key)}`, key: `comment:${o.key}`.slice(0, 200), priority: "normal", read_at: null, actor_id: me.id })),
      { onConflict: "profile_id,key" },
    )
    .then(({ error }) => error && console.error("[comments] notice", error.message));
}

/** Whose a message or promise is (the person it waits on, who said yes) */
async function ownersOf(admin: SupabaseClient, key: string): Promise<string[]> {
  const [kind, id] = key.split(":");
  if (!id) return [];
  if (kind === "owed") {
    const { data } = await admin.from("owed_replies").select("target_id").eq("id", id).maybeSingle();
    return data?.target_id ? [data.target_id as string] : [];
  }
  // A reminder, checklist or task one person sent another: both ends
  if (kind === "ask") {
    const { data } = await admin.from("agent_asks").select("owner_id, asked_by").eq("id", id).maybeSingle();
    return [data?.owner_id as string | undefined, data?.asked_by as string | undefined].filter((x): x is string => Boolean(x));
  }
  if (kind === "said") {
    const { data } = await admin.from("message_promises").select("owner_id").eq("id", id).maybeSingle();
    return data?.owner_id ? [data.owner_id as string] : [];
  }
  return [];
}

/**
 * The stable keys whose reminders and escalations are paused right now (waiting on the client, nothing new since).
 * A pause that something ended (the client wrote, sent an asset, the due date passed) is taken off here, with a note in
 * its thread, so the next reminder goes out as normal. Pass keys to look only at those.
 */
export async function pausedKeys(admin: SupabaseClient, only?: string[]): Promise<Set<string>> {
  let q = admin.from("item_threads").select("key, client_id, waiting_on_client, waiting_since, due_at").eq("waiting_on_client", true).limit(500);
  if (only) {
    const ks = [...new Set(only.map(stableKeyOf))];
    if (!ks.length) return new Set();
    q = q.in("key", ks.slice(0, 300));
  }
  const { data: threads, error } = await q;
  if (error || !threads?.length) return new Set();
  const clients = [...new Set(threads.map((t) => t.client_id as string | null).filter((c): c is string => Boolean(c)))];
  const oldest = threads.reduce((m, t) => (t.waiting_since && (t.waiting_since as string) < m ? (t.waiting_since as string) : m), new Date().toISOString());
  const [{ data: msgs }, { data: assets }] = clients.length
    ? await Promise.all([
        admin.from("owed_replies").select("client_id, asked_at").in("client_id", clients).eq("from_team", false).gt("asked_at", oldest).limit(1000),
        admin.from("client_assets").select("client_id, created_at").in("client_id", clients).gt("created_at", oldest).limit(1000),
      ])
    : [{ data: [] }, { data: [] }];
  const latest = (rows: { client_id: string; at: string }[]) => {
    const m = new Map<string, string>();
    for (const r of rows) if (!m.has(r.client_id) || r.at > m.get(r.client_id)!) m.set(r.client_id, r.at);
    return m;
  };
  const msgAt = latest((msgs ?? []).map((r) => ({ client_id: r.client_id as string, at: r.asked_at as string })));
  const assetAt = latest((assets ?? []).map((r) => ({ client_id: r.client_id as string, at: r.created_at as string })));
  const paused = new Set<string>();
  for (const t of threads) {
    const c = t.client_id as string | null;
    const read = readPause(t as ThreadState, { lastClientMessageAt: c ? msgAt.get(c) : null, lastAssetAt: c ? assetAt.get(c) : null });
    if (read.paused) paused.add(t.key as string);
    else if (read.ended) {
      const now = new Date().toISOString();
      await admin.from("item_threads").update({ waiting_on_client: false, waiting_since: null, waiting_by: null, due_at: null, updated_at: now }).eq("key", t.key);
      await admin.from("item_comments").insert({ key: t.key, client_id: c, author_id: null, body: ENDED_SAY[read.ended], kind: "resumed" });
    }
  }
  return paused;
}

/** Whether one item is paused (waiting on the client, nothing new since) */
export async function isPaused(admin: SupabaseClient, key: string): Promise<boolean> {
  return (await pausedKeys(admin, [key])).has(stableKeyOf(key));
}
