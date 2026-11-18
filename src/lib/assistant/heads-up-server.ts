import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { firstNameOf } from "@/lib/agent-call/core";
import { safeAppPath } from "./core";
import { DEFAULT_PREFS, SETTLE_MS, afterRing, cleanPrefs, decideHeadsUp, headsUpChat, headsUpLine, isActive, type HeadsUpItem, type Presence, type RingPrefs } from "./ring-core";

// The assistant calls you about urgent items, on the server. Triggers queue each urgent thing once per person
// (assistant_heads_up_items: a critical notification, a client's change of direction, an exec's ask due today). The
// open app's heartbeat (every few seconds while a tab is in view) says they're there and picks up what's waiting:
// a ring when ring-core decides so (one at a time, a burst as one heads-up), else the heads-up goes to their assistant
// chat as unread. The cron's pass does the same for people who aren't in the app. Bell and email are unchanged.

export type HeadsUpView = { id: string; line: string; chat: string; href: string | null; items: { title: string; href: string | null }[]; status: "ringing" | "answered" | "chat"; at: string };

type Row = { id: string; profile_id: string; items: HeadsUpItem[]; line: string; href: string | null; status: "ringing" | "answered" | "chat"; outcome: string | null; rang_at: string | null; created_at: string };
const COLS = "id, profile_id, items, line, href, status, outcome, rang_at, created_at";

/** How a heads-up in the chat reads, by what became of its ring */
const chatWhy = (outcome: string | null): "declined" | "missed" | "away" | "quiet" => (outcome === "declined" ? "declined" : outcome === "missed" ? "missed" : outcome === "quiet" ? "quiet" : "away");

function view(r: Row, firstName: string): HeadsUpView {
  const items = (r.items ?? []).map((i) => ({ title: i.title, href: safeAppPath(i.href) }));
  return { id: r.id, line: r.line, chat: headsUpChat(firstName, r.items ?? [], chatWhy(r.outcome)), href: safeAppPath(r.href), items, status: r.status, at: r.created_at };
}

export async function ringPrefs(admin: SupabaseClient, profileId: string): Promise<RingPrefs> {
  const { data, error } = await admin.from("assistant_ring_prefs").select("mode, quiet_start, quiet_end, tz").eq("profile_id", profileId).maybeSingle();
  if (error || !data) return DEFAULT_PREFS;
  return cleanPrefs({ mode: data.mode, quietStart: data.quiet_start, quietEnd: data.quiet_end, tz: data.tz });
}

async function firstNameFor(admin: SupabaseClient, profileId: string): Promise<string> {
  const { data } = await admin.from("profiles").select("full_name, display_name").eq("id", profileId).maybeSingle();
  return firstNameOf(((data?.display_name as string | null) || (data?.full_name as string | null)) ?? "");
}

/**
 * What's waiting for one person, decided now: a ring (returned, for the app that asked), the chat, or a moment more.
 * `presence` null: they aren't in the app. A ring left unanswered by a tab that went away is moved to the chat.
 */
export async function deliverHeadsUps(admin: SupabaseClient, profileId: string, presence: Presence | null, now = Date.now()): Promise<HeadsUpView | null> {
  const { data: pending } = await admin.from("assistant_heads_up_items").select("id, title, body, href, created_at").eq("profile_id", profileId).is("heads_up_id", null).order("created_at", { ascending: true }).limit(20);
  const { data: recent } = await admin.from("assistant_heads_ups").select(COLS).eq("profile_id", profileId).not("rang_at", "is", null).order("rang_at", { ascending: false }).limit(3);
  const rows = (recent ?? []) as Row[];
  // A ring nobody answered or declined (the tab closed mid-ring): it's a miss, into the chat
  for (const r of rows.filter((x) => x.status === "ringing" && now - Date.parse(x.rang_at!) > 30_000)) {
    await admin.from("assistant_heads_ups").update({ status: "chat", outcome: "missed", ended_at: new Date(now).toISOString() }).eq("id", r.id).eq("status", "ringing");
    r.status = "chat";
  }
  const items = (pending ?? []) as { id: string; title: string; body: string | null; href: string | null; created_at: string }[];
  if (!items.length) return null;
  const prefs = await ringPrefs(admin, profileId);
  const decision = decideHeadsUp({ prefs, presence, now, oldestAt: items[0].created_at, newestAt: items.at(-1)!.created_at, lastRingAt: rows[0]?.rang_at ?? null, ringing: rows.some((r) => r.status === "ringing") });
  if (decision.action === "wait") return null;
  const first = await firstNameFor(admin, profileId);
  const list: HeadsUpItem[] = items.map((i) => ({ title: i.title, body: i.body, href: i.href, at: i.created_at }));
  const at = new Date(now).toISOString();
  const ring = decision.action === "ring";
  const { data: made, error } = await admin
    .from("assistant_heads_ups")
    .insert({ profile_id: profileId, items: list, line: headsUpLine(first, list), href: list.find((i) => i.href)?.href ?? null, status: ring ? "ringing" : "chat", outcome: ring ? null : decision.why, rang_at: ring ? at : null, ended_at: ring ? null : at })
    .select(COLS)
    .single();
  if (error || !made) return null;
  // Claimed once: another tab beating at the same moment doesn't make a second heads-up of the same items
  const { data: claimed } = await admin.from("assistant_heads_up_items").update({ heads_up_id: made.id }).in("id", items.map((i) => i.id)).is("heads_up_id", null).select("id");
  if (!(claimed ?? []).length) {
    await admin.from("assistant_heads_ups").delete().eq("id", made.id);
    return null;
  }
  return ring ? view(made as Row, first) : null;
}

/** The open app says it's there; what's waiting is decided; a ring comes back, with what's unread in the chat */
export async function beat(admin: SupabaseClient, profileId: string, input: { visible: boolean; inCall: boolean; path: string | null }): Promise<{ ring: HeadsUpView | null; unread: HeadsUpView[] }> {
  const at = new Date().toISOString();
  const presence: Presence = { lastSeen: at, visible: input.visible, inCall: input.inCall };
  await admin.from("staff_presence").upsert({ profile_id: profileId, last_seen: at, visible: input.visible, in_call: input.inCall, path: input.path?.slice(0, 300) ?? null });
  const ring = await deliverHeadsUps(admin, profileId, isActive(presence, Date.now()) ? presence : null).catch((e) => {
    console.error("[heads-up] deliver", e instanceof Error ? e.message : e);
    return null;
  });
  return { ring, unread: await unreadHeadsUps(admin, profileId) };
}

/** Answered, declined, or ten seconds went by: an answered one opens the call; the others wait in the chat, unread */
export async function endRing(admin: SupabaseClient, profileId: string, id: string, outcome: "answered" | "declined" | "missed"): Promise<HeadsUpView | null> {
  const status = afterRing(outcome);
  const { data } = await admin
    .from("assistant_heads_ups")
    .update({ status, outcome, ended_at: new Date().toISOString(), ...(status === "answered" ? { read_at: new Date().toISOString() } : {}) })
    .eq("id", id)
    .eq("profile_id", profileId)
    .eq("status", "ringing")
    .select(COLS)
    .maybeSingle();
  if (!data) return null;
  return view(data as Row, await firstNameFor(admin, profileId));
}

/** A heads-up this person answered (the call opens with its line) */
export async function headsUpFor(admin: SupabaseClient, profileId: string, id: string): Promise<HeadsUpView | null> {
  const { data } = await admin.from("assistant_heads_ups").select(COLS).eq("id", id).eq("profile_id", profileId).maybeSingle();
  return data ? view(data as Row, await firstNameFor(admin, profileId)) : null;
}

/** What's waiting in their assistant chat, unread, oldest first */
export async function unreadHeadsUps(admin: SupabaseClient, profileId: string): Promise<HeadsUpView[]> {
  const { data, error } = await admin.from("assistant_heads_ups").select(COLS).eq("profile_id", profileId).eq("status", "chat").is("read_at", null).order("created_at", { ascending: true }).limit(10);
  if (error || !data?.length) return [];
  const first = await firstNameFor(admin, profileId);
  return (data as Row[]).map((r) => view(r, first));
}

/** Seen in the chat */
export async function markHeadsUpsRead(admin: SupabaseClient, profileId: string, ids: string[]) {
  if (!ids.length) return;
  await admin.from("assistant_heads_ups").update({ read_at: new Date().toISOString() }).eq("profile_id", profileId).in("id", ids.slice(0, 20)).is("read_at", null);
}

/** "Later": the heads-up they were just called about stays at the top of their list until it's done */
export async function keepForLater(admin: SupabaseClient, profileId: string): Promise<HeadsUpView | null> {
  const since = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { data } = await admin.from("assistant_heads_ups").select(COLS).eq("profile_id", profileId).gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  await admin.from("assistant_heads_ups").update({ later: true }).eq("id", data.id);
  return view(data as Row, await firstNameFor(admin, profileId));
}

/** Heads-ups kept for later, for the top of their list (their own session reads them) */
export async function laterHeadsUps(db: SupabaseClient, profileId: string): Promise<{ id: string; items: HeadsUpItem[]; href: string | null; at: string }[]> {
  const { data, error } = await db.from("assistant_heads_ups").select("id, items, href, created_at").eq("profile_id", profileId).eq("later", true).is("done_at", null).order("created_at", { ascending: false }).limit(5);
  if (error) return [];
  return ((data ?? []) as { id: string; items: HeadsUpItem[]; href: string | null; created_at: string }[]).map((r) => ({ id: r.id, items: r.items ?? [], href: r.href, at: r.created_at }));
}

/** The cron's pass: people not in the app get what's waiting in their chat; rings left hanging become misses */
export async function sweepHeadsUps(admin: SupabaseClient, now = Date.now()): Promise<{ people: number; posted: number }> {
  const { data } = await admin
    .from("assistant_heads_up_items")
    .select("profile_id")
    .is("heads_up_id", null)
    .lte("created_at", new Date(now - SETTLE_MS).toISOString())
    .limit(500);
  const people = [...new Set((data ?? []).map((r) => r.profile_id as string))];
  let posted = 0;
  for (const id of people) {
    const { data: p } = await admin.from("staff_presence").select("last_seen, visible, in_call").eq("profile_id", id).maybeSingle();
    const presence: Presence | null = p ? { lastSeen: p.last_seen as string, visible: Boolean(p.visible), inCall: Boolean(p.in_call) } : null;
    // In the app: their own heartbeat rings them; only people away are handled here
    if (isActive(presence, now)) continue;
    await deliverHeadsUps(admin, id, null, now).catch(() => null);
    posted++;
  }
  await admin.from("assistant_heads_ups").update({ status: "chat", outcome: "missed", ended_at: new Date(now).toISOString() }).eq("status", "ringing").lt("rang_at", new Date(now - 60_000).toISOString());
  return { people: people.length, posted };
}
