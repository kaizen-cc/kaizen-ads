import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";

// The same promise comes up in more than one place: two calls about it, both note-takers on the same call, a Slack
// thread after. Each client's open promises (calls, Slack, email) are sorted into groups, one per piece of work, with
// what every conversation added. A group is briefed once (from all of it), chased once, and when any part of it is
// moving (a ticket, a task, the thread) all of it is.

type Admin = SupabaseClient;
const CALL_OPEN = ["open", "briefed"];
const MSG_OPEN = ["open", "overdue", "escalated"];
const MAKE = ["creative", "copy", "offer"];

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

type Item = { ref: string; table: "call" | "msg"; id: string; group: string | null; what: string; why: string | null; kind: string | null; where: string; at: string; due: string | null; status: string; suggestion: string | null };

async function openItems(admin: Admin, clientId: string): Promise<Item[]> {
  const [{ data: calls }, { data: msgs }] = await Promise.all([
    admin.from("call_commitments").select("id, group_id, what, why, kind, due_at, status, suggestion_id, client_calls(title, occurred_at)").eq("client_id", clientId).in("status", CALL_OPEN),
    admin.from("message_promises").select("id, group_id, what, ask, asked_by, kind, said_at, due_at, status, source, channel_name").eq("client_id", clientId).in("status", MSG_OPEN),
  ]);
  return [
    ...(calls ?? []).map((c) => {
      const call = c.client_calls as unknown as { title: string; occurred_at: string } | null;
      return { ref: "", table: "call" as const, id: c.id as string, group: (c.group_id as string | null) ?? null, what: c.what as string, why: (c.why as string | null) ?? null, kind: c.kind as string, where: `the call "${call?.title ?? "a call"}"`, at: call?.occurred_at ?? (c.due_at as string), due: c.due_at as string, status: c.status as string, suggestion: (c.suggestion_id as string | null) ?? null };
    }),
    ...(msgs ?? []).map((m) => ({ ref: "", table: "msg" as const, id: m.id as string, group: (m.group_id as string | null) ?? null, what: String(m.what ?? ""), why: m.ask ? `${m.asked_by ?? "They"} asked: ${m.ask}` : null, kind: (m.kind as string | null) ?? null, where: m.source === "gmail" ? "an email" : `Slack #${m.channel_name}`, at: m.said_at as string, due: (m.due_at as string | null) ?? null, status: m.status as string, suggestion: null })),
  ]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((x, i) => ({ ...x, ref: String(i + 1) }));
}

const SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: { members: { type: "array", items: { type: "integer" } }, title: { type: "string" }, context: { type: "string" } },
        required: ["members", "title", "context"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

/**
 * Clients with a promise not in a group yet (new from a call or a message) are sorted again, all their open promises
 * together, so a new mention joins what it's about. Existing groups keep their id when they keep their members.
 */
export async function groupPromises(admin: Admin, opts: { clientId?: string; max?: number } = {}) {
  let clients: string[];
  if (opts.clientId) clients = [opts.clientId];
  else {
    const [{ data: a }, { data: b }] = await Promise.all([
      admin.from("call_commitments").select("client_id").is("group_id", null).in("status", CALL_OPEN).limit(300),
      admin.from("message_promises").select("client_id").is("group_id", null).in("status", MSG_OPEN).not("client_id", "is", null).limit(300),
    ]);
    clients = [...new Set([...(a ?? []), ...(b ?? [])].map((r) => r.client_id as string))].slice(0, opts.max ?? 12);
  }
  let grouped = 0;
  let merged = 0;
  for (const clientId of clients) {
    try {
      const r = await groupClient(admin, clientId);
      grouped += r.groups;
      merged += r.merged;
    } catch (e) {
      console.error("[promises] grouping failed:", e instanceof Error ? e.message : e);
    }
  }
  return { clients: clients.length, groups: grouped, merged };
}

async function groupClient(admin: Admin, clientId: string) {
  const items = await openItems(admin, clientId);
  if (!items.length) return { groups: 0, merged: 0 };
  const byRef = new Map(items.map((x) => [Number(x.ref), x]));
  let out: { groups: { members: number[]; title: string; context: string }[] };
  if (items.length === 1) out = { groups: [{ members: [1], title: items[0].what, context: items[0].why ?? "" }] };
  else
    out = await askJson({
      agent: "calls",
      label: "group promises",
      bare: true,
      maxTokens: 6000,
      system:
        "You sort the promises Kaizen (a paid ads and creative agency) made to one client into groups, one per piece of work. Promises are the same when they'd be done by the same work: the same deliverables (\"3 videos and 10 images\" said on two calls), the same change (\"point the campaigns to the new landing page\" and \"redirect Google to the new landing page with call tracking\"), the same test. The same call is often read twice (two note-takers), so near-identical lines from calls with the same name on the same day are always the same. Related but separate work stays apart (making the creative vs launching it; a Meta test vs a Google change). Put every promise in exactly one group. title: the promise in one line covering everything said about it (keep the numbers and specifics). context: two to four short sentences on what each conversation added (deadlines, details, conditions, who asked), naming where it came from (the call, Slack, email) and when; leave it empty for a group of one with nothing to add.",
      schema: SCHEMA,
      prompt: items.map((x) => `${x.ref}. ${x.what}${x.why ? ` (${x.why.slice(0, 300)})` : ""} [${x.where}, ${day(x.at)}${x.kind ? `, ${x.kind}` : ""}]`).join("\n"),
    });

  // Every promise exactly once; anything the answer left out stands alone
  const seen = new Set<number>();
  const groups = out.groups
    .map((g) => ({ ...g, members: g.members.filter((n) => byRef.has(n) && !seen.has(n) && (seen.add(n), true)) }))
    .filter((g) => g.members.length);
  for (const x of items) if (!seen.has(Number(x.ref))) groups.push({ members: [Number(x.ref)], title: x.what, context: "" });

  const taken = new Set<string>();
  const now = new Date().toISOString();
  let merged = 0;
  for (const g of groups) {
    const members = g.members.map((n) => byRef.get(n)!);
    // Keep the id most of its members already had, so cards and notices don't change under people
    const counts = new Map<string, number>();
    for (const m of members) if (m.group && !taken.has(m.group)) counts.set(m.group, (counts.get(m.group) ?? 0) + 1);
    let id = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const row = { client_id: clientId, title: g.title.slice(0, 300) || members[0].what, context: g.context.slice(0, 1500) || null, updated_at: now };
    if (id) await admin.from("promise_groups").update(row).eq("id", id);
    else {
      const { data, error } = await admin.from("promise_groups").insert(row).select("id").single();
      if (error || !data) throw new Error(error?.message ?? "Couldn't save a group");
      id = data.id as string;
    }
    taken.add(id);
    const calls = members.filter((m) => m.table === "call").map((m) => m.id);
    const msgs = members.filter((m) => m.table === "msg").map((m) => m.id);
    if (calls.length) await admin.from("call_commitments").update({ group_id: id }).in("id", calls);
    if (msgs.length) await admin.from("message_promises").update({ group_id: id }).in("id", msgs);
    if (members.length > 1 && (await mergeBrief(admin, clientId, id, members))) merged++;
  }
  await admin.from("clients").update({ promises_grouped_at: now }).eq("id", clientId);
  await settleGroups(admin, clientId);
  return { groups: groups.length, merged };
}

/**
 * A group with more than one brief (each written from one call): one brief from everything said, the others
 * expired. Only when a brief was already wanted (one of them was briefed) and the members changed since.
 */
async function mergeBrief(admin: Admin, clientId: string, groupId: string, members: Item[]) {
  const calls = members.filter((m) => m.table === "call");
  const briefed = calls.filter((m) => m.status === "briefed" && m.suggestion);
  if (!briefed.length) return false;
  const key = members.map((m) => m.id).sort().join(",");
  const { data: g } = await admin.from("promise_groups").select("title, context, briefed_members").eq("id", groupId).single();
  if (!g) return false;
  const old = [...new Set(briefed.map((m) => m.suggestion!))];
  if (g.briefed_members === key || (old.length === 1 && calls.length === briefed.length && members.length === calls.length && g.briefed_members)) return false;
  // Only one brief and nothing new to fold in: link the rest to it rather than writing again
  if (old.length === 1 && members.every((m) => m.table === "call") && !g.context) {
    await admin.from("call_commitments").update({ status: "briefed", suggestion_id: old[0] }).in("id", calls.map((m) => m.id));
    await admin.from("promise_groups").update({ briefed_members: key }).eq("id", groupId);
    return false;
  }
  const primary = [...calls].sort((a, b) => a.at.localeCompare(b.at))[0];
  const { data: c } = await admin.from("call_commitments").select("id, kind, call_id, client_calls(title, occurred_at)").eq("id", primary.id).single();
  if (!c) return false;
  const { data: mention } = await admin.from("call_mentions").select("summary").eq("call_id", c.call_id).eq("client_id", clientId).maybeSingle();
  const call = c.client_calls as unknown as { title: string; occurred_at: string };
  const where = members.map((m) => `${m.where} (${day(m.at)}): ${m.what}`).join("\n");
  const { suggestFromCall } = await import("@/lib/suggestions");
  const id = await suggestFromCall(
    admin,
    clientId,
    { id: c.id as string, what: g.title as string, why: `${g.context ?? ""}\nSaid in ${members.length} places:\n${where}`.trim(), kind: MAKE.includes(String(c.kind)) ? String(c.kind) : "creative" },
    { ...call, summary: (mention?.summary as { summary?: string; clientSaid?: string[]; decisions?: string[] } | null) ?? null },
  );
  if (typeof id !== "string") return false;
  await admin.from("call_commitments").update({ status: "briefed", suggestion_id: id }).in("id", calls.map((m) => m.id));
  await admin.from("creative_suggestions").update({ status: "expired" }).in("id", old).eq("status", "open");
  await admin.from("promise_groups").update({ briefed_members: key }).eq("id", groupId);
  return true;
}

/**
 * When one part of a group is moving (a ticket covers a call promise, a Slack promise shows it sent), the rest of the
 * group is too: its briefs come off Home and nobody is chased for it again.
 */
export async function settleGroups(admin: Admin, clientId?: string) {
  let q1 = admin.from("call_commitments").select("id, group_id, status, request_numbers, asana_gids, suggestion_id").not("group_id", "is", null);
  let q2 = admin.from("message_promises").select("id, group_id, status, evidence, request_numbers").not("group_id", "is", null);
  if (clientId) {
    q1 = q1.eq("client_id", clientId);
    q2 = q2.eq("client_id", clientId);
  } else {
    // Only recent groups: anything open is under a month old
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
    q1 = q1.gte("created_at", since);
    q2 = q2.gte("created_at", since);
  }
  const [{ data: calls }, { data: msgs }] = await Promise.all([q1.limit(1000), q2.limit(1000)]);
  const moving = new Map<string, { tickets: number[]; asana: string[]; evidence: string }>();
  for (const c of calls ?? []) if (c.status === "in_motion") moving.set(c.group_id as string, { tickets: (c.request_numbers as number[]) ?? [], asana: (c.asana_gids as string[]) ?? [], evidence: (c.request_numbers as number[])?.length ? `In production as ${(c.request_numbers as number[]).map((n) => `#${n}`).join(", ")}` : "In motion from another conversation about it" });
  for (const m of msgs ?? []) if (["in_motion", "done"].includes(m.status as string) && !moving.has(m.group_id as string)) moving.set(m.group_id as string, { tickets: (m.request_numbers as number[]) ?? [], asana: [], evidence: (m.evidence as string | null) ?? "Moving from another conversation about it" });
  if (!moving.size) return 0;
  const now = new Date().toISOString();
  let settled = 0;
  for (const c of calls ?? []) {
    const m = moving.get(c.group_id as string);
    if (!m || !CALL_OPEN.includes(c.status as string)) continue;
    await admin.from("call_commitments").update({ status: "in_motion", request_numbers: m.tickets, asana_gids: m.asana, checked_at: now }).eq("id", c.id);
    if (c.suggestion_id) await admin.from("creative_suggestions").update({ status: "expired" }).eq("id", c.suggestion_id).eq("status", "open");
    settled++;
  }
  for (const p of msgs ?? []) {
    const m = moving.get(p.group_id as string);
    if (!m || !MSG_OPEN.includes(p.status as string)) continue;
    await admin.from("message_promises").update({ status: "in_motion", evidence: m.evidence.slice(0, 300), request_numbers: m.tickets, closed_at: now, checked_at: now }).eq("id", p.id);
    await admin.from("notifications").update({ cleared_at: now }).in("key", [`said:${p.id}`, `said2:${p.id}`, `said-lead:${p.id}`]).is("read_at", null).is("cleared_at", null);
    settled++;
  }
  return settled;
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type PromiseSource = { label: string; at: string; url: string | null };
export type PromiseGroup = { id: string; title: string; context: string | null; sources: PromiseSource[] };

/** Each group's title, context and every place it was said (calls, Slack, email), for the cards. */
export async function loadGroups(db: SupabaseClient, ids: string[]): Promise<Map<string, PromiseGroup>> {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return new Map();
  const [{ data: groups }, { data: calls }, { data: msgs }] = await Promise.all([
    db.from("promise_groups").select("id, title, context").in("id", want),
    db.from("call_commitments").select("group_id, client_calls(title, occurred_at, url)").in("group_id", want),
    db.from("message_promises").select("group_id, source, channel_name, said_at, url").in("group_id", want).neq("status", "not_promise"),
  ]);
  const out = new Map<string, PromiseGroup>();
  for (const g of groups ?? []) out.set(g.id as string, { id: g.id as string, title: g.title as string, context: (g.context as string | null) ?? null, sources: [] });
  const seen = new Set<string>();
  for (const c of calls ?? []) {
    const call = c.client_calls as unknown as { title: string; occurred_at: string; url: string | null } | null;
    const g = out.get(c.group_id as string);
    // Both note-takers on one call: the call once
    const k = `${c.group_id}|${call?.title}|${call?.occurred_at?.slice(0, 10)}`;
    if (!g || !call || seen.has(k)) continue;
    seen.add(k);
    g.sources.push({ label: `Call: ${call.title}`, at: call.occurred_at, url: call.url ?? null });
  }
  for (const m of msgs ?? []) out.get(m.group_id as string)?.sources.push({ label: m.source === "gmail" ? "Email" : `Slack #${m.channel_name}`, at: m.said_at as string, url: (m.url as string | null) ?? null });
  for (const g of out.values()) g.sources.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

/**
 * Message promises not chased on their own: their group already shows as a call promise with a brief, or another
 * message about the same thing is the one being chased (the earliest due).
 */
export async function shadowedMessages(db: SupabaseClient, promises: { id: string; group_id: string | null; due_at: string | null }[]) {
  const groups = [...new Set(promises.map((p) => p.group_id).filter((g): g is string => Boolean(g)))];
  if (!groups.length) return new Set<string>();
  const [{ data: calls }, { data: msgs }] = await Promise.all([
    db.from("call_commitments").select("group_id").in("group_id", groups).eq("status", "briefed"),
    db.from("message_promises").select("id, group_id, due_at").in("group_id", groups).in("status", MSG_OPEN),
  ]);
  const withCall = new Set((calls ?? []).map((c) => c.group_id as string));
  const lead = new Map<string, { id: string; due: string }>();
  for (const m of msgs ?? []) {
    const cur = lead.get(m.group_id as string);
    const due = String(m.due_at ?? "");
    if (!cur || due < cur.due || (due === cur.due && String(m.id) < cur.id)) lead.set(m.group_id as string, { id: m.id as string, due });
  }
  return new Set(promises.filter((p) => p.group_id && (withCall.has(p.group_id) || (lead.get(p.group_id) && lead.get(p.group_id)!.id !== p.id))).map((p) => p.id));
}
