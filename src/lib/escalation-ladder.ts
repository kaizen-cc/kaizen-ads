import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasClimbed, leadFor, LINE_OF_ROLE, nudgeDraft, nudgeKey } from "@/lib/escalation-ladder-core";

// The one escalation ladder every line routes through (rules in ./escalation-ladder-core.ts): owed replies, things
// said yes to, creative stuck past its turnaround, briefs waiting on an approval. The owner hears first (each source
// keeps its own first notice); after 48 hours with nothing done, the owner's lead gets a card: a Slack message drafted
// to nudge the teammate, sent as the lead from their own Slack (ladder_nudges). Items waiting on the client don't climb.

export type LadderItem = {
  /** The item's stable key (owed:<id>, said:<id>, ticket:<id>, brief:<id>) */
  key: string;
  ownerId: string;
  clientId: string | null;
  client?: string | null;
  /** What it is, short, for the lead's card and the drafted message */
  what: string;
  /** Since when nothing has been done (the first notice, the due date, the turnaround) */
  since: string;
  href?: string | null;
  kind: "owed" | "said" | "ticket" | "brief" | "other";
};

export type Nudge = { id: string; itemKey: string; ownerId: string; owner: string; client: string | null; what: string; draft: string; href: string | null; since: string; kind: string; status: string };

/** Climbs whatever has waited 48 hours: a nudge card for the owner's lead (one per item), and the lead hears in the app */
export async function climbLadder(admin: SupabaseClient, items: LadderItem[], now = new Date()): Promise<{ nudged: number }> {
  const due = items.filter((i) => hasClimbed(i.since, now));
  if (!due.length) return { nudged: 0 };
  const { pausedKeys } = await import("@/lib/item-comments");
  const [paused, { data: people }, { data: have }] = await Promise.all([
    pausedKeys(admin, due.map((i) => i.key)),
    admin.from("profiles").select("id, full_name, role").eq("is_active", true),
    admin.from("ladder_nudges").select("key").in("key", due.map((i) => nudgeKey(i.key))),
  ]);
  const active = ((people ?? []) as { id: string; full_name: string; role: string }[]).map((p) => ({ id: p.id, role: String(p.role), name: p.full_name }));
  const byId = new Map(active.map((p) => [p.id, p]));
  const done = new Set((have ?? []).map((h) => h.key as string));
  let nudged = 0;
  for (const i of due) {
    if (paused.has(i.key) || done.has(nudgeKey(i.key))) continue;
    const owner = byId.get(i.ownerId);
    if (!owner) continue;
    const lead = leadFor(owner.role, active, owner.id);
    if (!lead) continue;
    const hours = (now.getTime() - Date.parse(i.since)) / 3_600_000;
    const draft = nudgeDraft({ teammate: owner.name, what: i.what, client: i.client ?? null, hours });
    const { data: row, error } = await admin
      .from("ladder_nudges")
      .insert({ key: nudgeKey(i.key), item_key: i.key, kind: i.kind, line: LINE_OF_ROLE[owner.role] ?? null, client_id: i.clientId, owner_id: owner.id, lead_id: lead.id, what: i.what.slice(0, 300), client_name: i.client ?? null, href: i.href ?? null, since: i.since, draft })
      .select("id")
      .single();
    if (error || !row) continue;
    nudged++;
    await admin
      .from("notifications")
      .upsert({ profile_id: lead.id, kind: "nudge", title: `${owner.name} is behind: ${i.what}`.slice(0, 300), body: `Nothing done in ${Math.round(hours / 24)} days. A message to nudge them is drafted for you to send from your Slack.`, href: `/pipeline?nudge=${row.id}`, key: `nudge:${row.id}`, client_id: i.clientId, priority: "normal", read_at: null }, { onConflict: "profile_id,key" })
      .then(({ error: e }) => e && console.error("[ladder] notice", e.message));
  }
  return { nudged };
}

/** The item behind a nudge is taken care of: its card leaves the lead's Overview */
export async function resolveNudges(admin: SupabaseClient, itemKeys: string[]) {
  if (!itemKeys.length) return;
  await admin.from("ladder_nudges").update({ status: "resolved", resolved_at: new Date().toISOString() }).in("item_key", itemKeys).eq("status", "open");
}

/** The lead's open nudges, newest first (their own session reads them: RLS keeps them to the lead) */
export async function loadNudges(db: SupabaseClient, leadId: string): Promise<Nudge[]> {
  const { data, error } = await db.from("ladder_nudges").select("id, item_key, owner_id, client_name, what, draft, href, since, kind, status, owner:profiles!ladder_nudges_owner_id_fkey(full_name)").eq("lead_id", leadId).eq("status", "open").order("created_at", { ascending: false }).limit(30);
  if (error) return [];
  return ((data ?? []) as unknown as { id: string; item_key: string; owner_id: string; client_name: string | null; what: string; draft: string; href: string | null; since: string; kind: string; status: string; owner: { full_name: string } | null }[]).map((r) => ({ id: r.id, itemKey: r.item_key, ownerId: r.owner_id, owner: r.owner?.full_name ?? "Teammate", client: r.client_name, what: r.what, draft: r.draft, href: r.href, since: r.since, kind: r.kind, status: r.status }));
}

/** Sends the nudge as the lead, from their own Slack, in a DM to the teammate */
export async function sendNudge(admin: SupabaseClient, leadId: string, id: string, text: string): Promise<{ ok: true } | { ok: false; error: string; needsConnect?: boolean }> {
  const { data: n } = await admin.from("ladder_nudges").select("id, lead_id, owner_id, status").eq("id", id).maybeSingle();
  if (!n || n.lead_id !== leadId) return { ok: false, error: "That nudge isn't yours to send." };
  if (n.status !== "open") return { ok: false, error: "It's already been handled." };
  const body = text.trim().slice(0, 3000);
  if (!body) return { ok: false, error: "Write the message first." };
  const slackId = await slackIdOf(admin, n.owner_id as string);
  if (!slackId) return { ok: false, error: "Your teammate isn't found in Slack (no Slack account matches their work email)." };
  const { postAsUser } = await import("@/lib/slack-user");
  const sent = await postAsUser(leadId, { channel: slackId, text: body });
  if (!sent.ok) return sent;
  await admin.from("ladder_nudges").update({ status: "sent", sent_at: new Date().toISOString(), draft: body }).eq("id", id);
  await admin.from("notifications").update({ read_at: new Date().toISOString() }).eq("profile_id", leadId).eq("key", `nudge:${id}`).is("read_at", null);
  return { ok: true };
}

export async function dismissNudge(admin: SupabaseClient, leadId: string, id: string) {
  await admin.from("ladder_nudges").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", id).eq("lead_id", leadId).eq("status", "open");
}

async function slackIdOf(admin: SupabaseClient, profileId: string): Promise<string | null> {
  const { data: t } = await admin.from("slack_user_tokens").select("slack_user_id").eq("profile_id", profileId).maybeSingle();
  if (t?.slack_user_id) return String(t.slack_user_id);
  const { data: p } = await admin.from("profiles").select("email, slack_user_id").eq("id", profileId).maybeSingle();
  if (p?.slack_user_id) return String(p.slack_user_id);
  if (!p?.email) return null;
  const { findSlackUser } = await import("@/lib/profile-slack");
  const found = await findSlackUser(String(p.email)).catch(() => null);
  if (found?.id) await admin.from("profiles").update({ slack_user_id: found.id }).eq("id", profileId);
  return found?.id ?? null;
}

const H48 = () => new Date(Date.now() - 48 * 3_600_000).toISOString();

/**
 * One run of the ladder over every line's sources: messages owed a reply and things said yes to (after their first
 * notice), creative and email board tickets past their turnaround, and briefs drafted for a buyer to approve. Then the
 * nudges whose item is taken care of leave the leads' Overviews. Run with the owed-replies step (hourly).
 */
export async function runLadder(admin: SupabaseClient): Promise<{ nudged: number; resolved: number }> {
  const cutoff = H48();
  const [owed, said, tickets, emails, briefs] = await Promise.all([
    admin.from("owed_replies").select("id, target_id, from_name, client_id, nudged_at, url, clients(name)").in("status", ["nudged", "escalated"]).not("nudged_at", "is", null).limit(300),
    admin.from("message_promises").select("id, owner_id, what, client_id, notified_at, due_at, url, clients(name)").in("status", ["overdue", "escalated"]).limit(300),
    admin.from("board_requests").select("id, number, title, client_id, assignee_id, stage, stage_due_at, clients(name)").neq("stage", "launched").not("assignee_id", "is", null).lte("stage_due_at", new Date().toISOString()).limit(300),
    admin.from("email_board").select("id, number, title, client_id, assignee_id, stage_due_at, stage, clients(name)").not("assignee_id", "is", null).lte("stage_due_at", new Date().toISOString()).limit(300),
    admin.from("creative_suggestions").select("id, client_id, created_at, status, trigger_key, clients(name)").eq("status", "open").not("trigger_key", "is", null).lte("created_at", cutoff).limit(200),
  ]);
  const name = (r: { clients?: unknown }) => ((r.clients as { name?: string } | null)?.name ?? null);
  const items: LadderItem[] = [];
  for (const o of owed.data ?? []) items.push({ key: `owed:${o.id}`, kind: "owed", ownerId: o.target_id as string, clientId: (o.client_id as string | null) ?? null, client: name(o), what: `a reply to ${o.from_name}`, since: o.nudged_at as string, href: (o.url as string | null) ?? null });
  for (const p of said.data ?? []) items.push({ key: `said:${p.id}`, kind: "said", ownerId: p.owner_id as string, clientId: (p.client_id as string | null) ?? null, client: name(p), what: String(p.what), since: ((p.notified_at ?? p.due_at) as string), href: (p.url as string | null) ?? null });
  // Waiting on the client (with them for review, ready to send to them) or done isn't on the maker
  const onUs = (stage: unknown) => !/client_review|ready_for_client|ready_for_launch|launched|sent|scheduled|done|approved/.test(String(stage ?? ""));
  for (const t of (tickets.data ?? []).filter((x) => onUs(x.stage))) items.push({ key: `ticket:${t.id}`, kind: "ticket", ownerId: t.assignee_id as string, clientId: (t.client_id as string | null) ?? null, client: name(t), what: `#${t.number} ${t.title}`, since: t.stage_due_at as string, href: `/board?t=${t.number}` });
  // The email board (when it isn't there yet, nothing to climb)
  if (!emails.error) for (const t of emails.data ?? []) if (onUs(t.stage)) items.push({ key: `email:${t.id}`, kind: "ticket", ownerId: t.assignee_id as string, clientId: (t.client_id as string | null) ?? null, client: name(t), what: `Email #${t.number} ${t.title}`, since: t.stage_due_at as string, href: `/board/email?t=${t.number}` });
  // A drafted brief waits on the client's Meta buyer to approve it
  const briefRows = briefs.error ? [] : (briefs.data ?? []);
  if (briefRows.length) {
    const { data: buyers } = await admin.from("client_assignments").select("client_id, profile_id").eq("role", "meta_buyer").in("client_id", [...new Set(briefRows.map((b) => b.client_id as string))]);
    const buyerOf = new Map<string, string>();
    for (const b of buyers ?? []) if (!buyerOf.has(b.client_id as string)) buyerOf.set(b.client_id as string, b.profile_id as string);
    for (const b of briefRows) {
      const owner = buyerOf.get(b.client_id as string);
      if (owner) items.push({ key: `brief:${b.id}`, kind: "brief", ownerId: owner, clientId: b.client_id as string, client: name(b), what: "approving a drafted brief", since: b.created_at as string, href: `/requests/new?approve=${b.id}` });
    }
  }
  const { nudged } = await climbLadder(admin, items);
  // Taken care of: the item isn't open any more, so its nudge leaves the lead's Overview
  const open = new Set(items.map((i) => i.key));
  const { data: nudges } = await admin.from("ladder_nudges").select("item_key").eq("status", "open").limit(500);
  const done = (nudges ?? []).map((n) => n.item_key as string).filter((k) => !open.has(k));
  await resolveNudges(admin, done);
  return { nudged, resolved: done.length };
}
