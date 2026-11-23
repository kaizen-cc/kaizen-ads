import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLIENT_REPLY_ROLE, CLIENT_REPLY_WAIT, leadFor, LINE_OF_ROLE, nudgeDraft, nudgeKey, waitedOut, type Wait } from "@/lib/escalation-ladder-core";

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
  kind: "owed" | "said" | "ticket" | "brief" | "launch" | "fatigue" | "other";
  /** How long it waits before it climbs (48 hours unless the signal says otherwise) */
  wait?: Wait;
  /** Who it climbs to instead of the owner's lead (a client waiting on a reply: the Client Success Coordinator) */
  toRole?: string;
};

export type Nudge = { id: string; itemKey: string; ownerId: string; owner: string; client: string | null; what: string; draft: string; href: string | null; since: string; kind: string; status: string };

/** Climbs whatever has waited 48 hours: a nudge card for the owner's lead (one per item), and the lead hears in the app */
export async function climbLadder(admin: SupabaseClient, items: LadderItem[], now = new Date()): Promise<{ nudged: number }> {
  const due = items.filter((i) => waitedOut(i.since, i.wait, now));
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
    // A signal with its own rung (a client waiting on a reply: the Client Success Coordinator), else the owner's lead
    const rung = i.toRole ? (active.find((a) => a.role === i.toRole && a.id !== owner.id) ?? null) : null;
    const lead = rung ?? (i.toRole && !waitedOut(i.since, undefined, now) ? null : leadFor(owner.role, active, owner.id));
    if (!lead) continue;
    const hours = (now.getTime() - Date.parse(i.since)) / 3_600_000;
    const draft = nudgeDraft({ teammate: owner.name, what: i.what, client: i.client ?? null, hours, kind: rung ? "client_reply" : i.kind });
    const { data: row, error } = await admin
      .from("ladder_nudges")
      .insert({ key: nudgeKey(i.key), item_key: i.key, kind: i.kind, line: LINE_OF_ROLE[owner.role] ?? null, client_id: i.clientId, owner_id: owner.id, lead_id: lead.id, what: i.what.slice(0, 300), client_name: i.client ?? null, href: i.href ?? null, since: i.since, draft })
      .select("id")
      .single();
    if (error || !row) continue;
    nudged++;
    await admin
      .from("notifications")
      .upsert({ profile_id: lead.id, kind: "nudge", title: `${owner.name} is behind: ${i.what}`.slice(0, 300), body: `${rung ? `Unanswered for ${Math.round(hours)} hours.` : `Nothing done in ${Math.round(hours / 24)} days.`} A message to nudge them is drafted for you to send from your Slack.`, href: `/pipeline?nudge=${row.id}`, key: `nudge:${row.id}`, client_id: i.clientId, priority: "normal", read_at: null }, { onConflict: "profile_id,key" })
      .then(({ error: e }) => e && console.error("[ladder] notice", e.message));
  }
  return { nudged };
}

/** The item behind a nudge is taken care of: its card leaves the lead's Overview */
export async function resolveNudges(admin: SupabaseClient, itemKeys: string[]) {
  if (!itemKeys.length) return;
  // Sent nudges too: the lead's message went out, and now the item is done
  for (let i = 0; i < itemKeys.length; i += 200) await admin.from("ladder_nudges").update({ status: "resolved", resolved_at: new Date().toISOString() }).in("item_key", itemKeys.slice(i, i + 200)).in("status", ["open", "sent"]);
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
export async function runLadder(admin: SupabaseClient): Promise<{ nudged: number; resolved: number; up?: number; down?: number; fired?: number }> {
  const cutoff = H48();
  const reportCutoff = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const [owed, said, tickets, emails, briefs, launches, fatigue, reports] = await Promise.all([
    admin.from("owed_replies").select("id, target_id, from_name, from_team, client_id, asked_at, nudged_at, url, clients(name)").in("status", ["watching", "nudged", "escalated"]).limit(300),
    admin.from("message_promises").select("id, owner_id, what, client_id, notified_at, due_at, url, clients(name)").in("status", ["overdue", "escalated"]).limit(300),
    admin.from("board_requests").select("id, number, title, client_id, assignee_id, stage, stage_due_at, clients(name)").neq("stage", "launched").not("assignee_id", "is", null).lte("stage_due_at", new Date().toISOString()).limit(300),
    admin.from("email_board").select("id, number, title, client_id, assignee_id, stage_due_at, stage, clients(name)").not("assignee_id", "is", null).lte("stage_due_at", new Date().toISOString()).limit(300),
    admin.from("creative_suggestions").select("id, client_id, created_at, status, trigger_key, clients(name)").eq("status", "open").not("trigger_key", "is", null).lte("created_at", cutoff).limit(200),
    admin.from("board_requests").select("id, number, title, client_id, buyer_id, stage_due_at, clients(name)").eq("stage", "ready_for_launch").is("deleted_at", null).not("buyer_id", "is", null).lte("stage_due_at", new Date().toISOString()).limit(200),
    admin.from("ad_fatigue").select("client_id, ad_id, ad_name, first_flagged_at, request_numbers, clients(name)").eq("state", "open").lte("first_flagged_at", cutoff).limit(300),
    admin.from("reports").select("id, kind, platform, period_end, owner_id, client_id, clients!inner(name, archived_at)").in("status", ["draft", "submitted"]).is("hidden_at", null).is("clients.archived_at", null).not("owner_id", "is", null).lte("period_end", reportCutoff).limit(300),
  ]);
  const name = (r: { clients?: unknown }) => ((r.clients as { name?: string } | null)?.name ?? null);
  const items: LadderItem[] = [];
  for (const o of owed.data ?? []) {
    // A client waiting on a reply: the owner hears first, then after 12 business hours the Client Success Coordinator
    if (!o.from_team && o.client_id) items.push({ key: `owed:${o.id}`, kind: "owed", ownerId: o.target_id as string, clientId: o.client_id as string, client: name(o), what: `a reply to ${o.from_name}`, since: o.asked_at as string, href: (o.url as string | null) ?? null, wait: CLIENT_REPLY_WAIT, toRole: CLIENT_REPLY_ROLE });
    // A teammate's ask: the owner's lead, 48 hours after their first notice
    else if (o.nudged_at) items.push({ key: `owed:${o.id}`, kind: "owed", ownerId: o.target_id as string, clientId: (o.client_id as string | null) ?? null, client: name(o), what: `a reply to ${o.from_name}`, since: o.nudged_at as string, href: (o.url as string | null) ?? null });
  }
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
  // A launch ready and past its date: the buyer's, climbing to the head of the line, then the paid-ads exec
  if (!launches.error) for (const t of launches.data ?? []) items.push({ key: `launch:${t.id}`, kind: "launch", ownerId: t.buyer_id as string, clientId: (t.client_id as string | null) ?? null, client: name(t), what: `launching #${t.number} ${t.title}`, since: t.stage_due_at as string, href: `/board?t=${t.number}` });
  // An ad wearing out with no refresh asked for: the client's Meta buyer's
  const tired = fatigue.error ? [] : (fatigue.data ?? []).filter((f) => !((f.request_numbers as number[] | null) ?? []).length);
  if (tired.length) {
    const { data: buyers } = await admin.from("client_assignments").select("client_id, profile_id").eq("role", "meta_buyer").in("client_id", [...new Set(tired.map((f) => f.client_id as string))]);
    const buyerOf = new Map<string, string>();
    for (const b of buyers ?? []) if (!buyerOf.has(b.client_id as string)) buyerOf.set(b.client_id as string, b.profile_id as string);
    for (const f of tired) {
      const owner = buyerOf.get(f.client_id as string);
      if (owner) items.push({ key: `fatigue:${f.client_id}:${f.ad_id}`, kind: "fatigue", ownerId: owner, clientId: f.client_id as string, client: name(f), what: `refreshing a tired ad (${String(f.ad_name ?? "an ad").slice(0, 60)})`, since: f.first_flagged_at as string, href: `/pipeline?tab=ideas` });
    }
  }
  // A report not sent 3 days after its period: the Client Success Coordinator nudges whoever owns sending it
  if (!reports.error)
    for (const r of reports.data ?? [])
      items.push({ key: `report:${r.id}`, kind: "other", ownerId: r.owner_id as string, clientId: r.client_id as string, client: name(r), what: `the ${r.platform} ${r.kind} report (period ended ${r.period_end})`, since: `${r.period_end}T22:00:00Z`, href: `/reports/${r.id}`, wait: { hours: 0 }, toRole: "customer_success" });
  const { nudged } = await climbLadder(admin, items);
  // Taken care of: the item isn't open any more, so its nudge leaves the lead's Overview
  const open = new Set(items.map((i) => i.key));
  const { data: nudges } = await admin.from("ladder_nudges").select("item_key").in("status", ["open", "sent"]).limit(2000);
  const done = (nudges ?? []).map((n) => n.item_key as string).filter((k) => !open.has(k));
  await resolveNudges(admin, done);
  // Rung 3: 48 hours more with the lead and nothing moving reaches the execs (src/lib/exec-overview-core.ts)
  const climbed = await runRung3(admin).catch((e) => {
    console.error("[ladder] rung 3", e instanceof Error ? e.message : e);
    return { up: 0, down: 0 };
  });
  // Fires skip the ladder: every exec hears at once (once per client per day)
  const { fireSweep } = await import("@/lib/exec-focus/server");
  const fires = await fireSweep(admin).catch(() => ({ fired: 0 }));
  return { nudged, resolved: done.length, ...climbed, fired: fires.fired };
}

/**
 * The last touch on each item: a comment, a ticket moved on either board, someone marking it saved or done. Any of
 * these after an item reached the lead counts as movement and resets the clock to the execs.
 */
async function touches(admin: SupabaseClient, keys: string[]): Promise<Map<string, number>> {
  const at = new Map<string, number>();
  const bump = (k: string, iso: unknown) => {
    const t = Date.parse(String(iso ?? ""));
    if (Number.isFinite(t) && t > (at.get(k) ?? 0)) at.set(k, t);
  };
  const tickets = keys.filter((k) => k.startsWith("ticket:") || k.startsWith("launch:")).map((k) => k.split(":")[1]);
  const emails = keys.filter((k) => k.startsWith("email:")).map((k) => k.split(":")[1]);
  for (let i = 0; i < keys.length; i += 200) {
    const part = keys.slice(i, i + 200);
    const [{ data: cs }, { data: ds }] = await Promise.all([
      admin.from("item_comments").select("key, created_at").in("key", part).order("created_at", { ascending: false }).limit(1000),
      admin.from("daily_items").select("key, updated_at").in("key", part).in("status", ["saved", "done"]).limit(1000),
    ]);
    for (const c of cs ?? []) bump(c.key as string, c.created_at);
    for (const d of ds ?? []) bump(d.key as string, d.updated_at);
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  if (tickets.length) {
    const { data } = await admin.from("request_events").select("request_id, created_at").in("request_id", tickets.slice(0, 300)).gte("created_at", since).limit(2000);
    for (const e of data ?? []) {
      bump(`ticket:${e.request_id}`, e.created_at);
      bump(`launch:${e.request_id}`, e.created_at);
    }
  }
  if (emails.length) {
    const { data } = await admin.from("email_ticket_events").select("ticket_id, created_at").in("ticket_id", emails.slice(0, 300)).gte("created_at", since).limit(2000);
    for (const e of data ?? []) bump(`email:${e.ticket_id}`, e.created_at);
  }
  return at;
}

/**
 * Rung 3: an item at the lead's rung with nothing moving for 48 more hours (no touch, the lead's nudge not sent) reaches
 * the execs of its line; a touch brings it back down, and waiting on the client pauses it. An item an exec took over
 * stays with them.
 */
export async function runRung3(admin: SupabaseClient, now = new Date()): Promise<{ up: number; down: number }> {
  const { atRung3 } = await import("@/lib/exec-overview-core");
  const { data } = await admin.from("ladder_nudges").select("id, item_key, created_at, sent_at, moved_at, exec_at, taken_by").in("status", ["open", "sent"]).limit(2000);
  const rows = (data ?? []) as { id: string; item_key: string; created_at: string; sent_at: string | null; moved_at: string | null; exec_at: string | null; taken_by: string | null }[];
  if (!rows.length) return { up: 0, down: 0 };
  const { pausedKeys } = await import("@/lib/item-comments");
  const keys = [...new Set(rows.map((r) => r.item_key))];
  const [paused, touched] = await Promise.all([pausedKeys(admin, keys), touches(admin, keys)]);
  let up = 0;
  let down = 0;
  const iso = now.toISOString();
  for (const r of rows) {
    const t = touched.get(r.item_key);
    // Only a touch after it reached the lead is movement
    const moved = t && t > Date.parse(r.created_at) && t > Date.parse(r.moved_at ?? "1970-01-01") ? new Date(t).toISOString() : null;
    const movedAt = moved ?? r.moved_at;
    const exec = !r.taken_by && atRung3({ createdAt: r.created_at, sentAt: r.sent_at, movedAt }, paused.has(r.item_key), now);
    const patch: Record<string, string | null> = {};
    if (moved) patch.moved_at = moved;
    if (exec && !r.exec_at) patch.exec_at = iso;
    if (!exec && r.exec_at) patch.exec_at = null;
    if (!Object.keys(patch).length) continue;
    if ("exec_at" in patch) {
      if (patch.exec_at) up++;
      else down++;
    }
    await admin.from("ladder_nudges").update(patch).eq("id", r.id);
  }
  return { up, down };
}
