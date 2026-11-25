import "server-only";
import { linksIn, withLinks } from "@/lib/item-facts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decide, type Candidate, type Existing, type RealityState } from "@/lib/reality-check-core";

// Dedupe against reality (owner, Nov 24 2026): every automated item generator checks here before it creates anything.
// It looks at the OS items (any owner, open and recently closed), the Asana mirror, promises from calls and messages,
// the done-check's closes and the creative board, for the same client (or the same person when there's no client),
// over the last 45 days. See ./reality-check-core.ts for how "the same work" is decided.

type Admin = SupabaseClient;
const DAYS = 45;

/** Everything the OS can see that might be this work, for these clients (and people, for work with no client) */
export async function loadReality(admin: Admin, o: { clientIds: (string | null)[]; ownerIds?: (string | null)[] }): Promise<Existing[]> {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const clients = [...new Set(o.clientIds.filter((x): x is string => Boolean(x)))];
  const owners = [...new Set((o.ownerIds ?? []).filter((x): x is string => Boolean(x)))];
  const none = Promise.resolve({ data: [] as Record<string, unknown>[] });
  const [asksC, asksO, asana, calls, said, checks, board, people, mine] = await Promise.all([
    clients.length ? admin.from("agent_asks").select("id, title, client_id, owner_id, status, created_at, done_at").in("client_id", clients).gte("created_at", since).limit(1500) : none,
    owners.length ? admin.from("agent_asks").select("id, title, client_id, owner_id, status, created_at, done_at").in("owner_id", owners).is("client_id", null).gte("created_at", since).limit(800) : none,
    clients.length ? admin.from("asana_tasks").select("gid, name, client_id, profile_id, open, url, completed_at").in("client_id", clients).limit(1500) : none,
    clients.length ? admin.from("call_commitments").select("id, what, client_id, routed_to, status, created_at").in("client_id", clients).gte("created_at", since).limit(1500) : none,
    clients.length || owners.length ? admin.from("message_promises").select("id, what, client_id, owner_id, status, closed_at, said_at").or([clients.length ? `client_id.in.(${clients.join(",")})` : "", owners.length ? `owner_id.in.(${owners.join(",")})` : ""].filter(Boolean).join(",")).gte("said_at", since).limit(800) : none,
    clients.length ? admin.from("done_checks").select("key, title, client_id, owner_id, closed_at, reopened_at").in("client_id", clients).not("closed_at", "is", null).limit(800) : none,
    clients.length ? admin.from("board_requests").select("id, number, title, client_id, assignee_id, stage, created_at").in("client_id", clients).gte("created_at", since).limit(800) : none,
    admin.from("profiles").select("id, full_name").limit(500),
    // Each connected person's own Asana tasks (src/lib/asana-person.ts): the ones an exec's own runs made, too
    // Only for the people an item is being made for: someone's Asana stands for their own work, never a teammate's
    owners.length ? admin.from("asana_person_tasks").select("gid, name, client_id, profile_id, completed, completed_at, url, asana_created_at").in("profile_id", owners).limit(2000) : none,
  ]);
  const name = new Map(((people.data ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]));
  const out: Existing[] = [];
  for (const r of [...((asksC.data ?? []) as Record<string, unknown>[]), ...((asksO.data ?? []) as Record<string, unknown>[])])
    out.push({ source: "item", id: String(r.id), title: String(r.title ?? ""), clientId: (r.client_id as string | null) ?? null, ownerId: (r.owner_id as string | null) ?? null, owner: name.get(String(r.owner_id)) ?? null, open: r.status === "open", href: "/pipeline", at: (r.done_at as string | null) ?? (r.created_at as string) });
  for (const r of (asana.data ?? []) as Record<string, unknown>[])
    out.push({ source: "asana", id: String(r.gid), title: String(r.name ?? ""), clientId: (r.client_id as string | null) ?? null, ownerId: (r.profile_id as string | null) ?? null, owner: name.get(String(r.profile_id)) ?? null, open: Boolean(r.open), href: (r.url as string | null) ?? null, at: (r.completed_at as string | null) ?? null });
  for (const r of (mine.data ?? []) as Record<string, unknown>[])
    out.push({ source: "asana", id: String(r.gid), title: String(r.name ?? "").replace(/^\[[^\]]{1,24}\]\s*/, ""), clientId: (r.client_id as string | null) ?? null, ownerId: (r.profile_id as string | null) ?? null, owner: name.get(String(r.profile_id)) ?? null, open: !r.completed, href: (r.url as string | null) ?? null, at: (r.completed_at as string | null) ?? (r.asana_created_at as string | null) ?? null });
  for (const r of (calls.data ?? []) as Record<string, unknown>[]) {
    const to = ((r.routed_to as string[] | null) ?? [])[0] ?? null;
    out.push({ source: "call", id: String(r.id), title: String(r.what ?? ""), clientId: (r.client_id as string | null) ?? null, ownerId: to, owner: to ? (name.get(to) ?? null) : null, open: ["open", "briefed", "in_motion"].includes(String(r.status)), href: null, at: r.created_at as string });
  }
  for (const r of (said.data ?? []) as Record<string, unknown>[])
    out.push({ source: "promise", id: String(r.id), title: String(r.what ?? ""), clientId: (r.client_id as string | null) ?? null, ownerId: (r.owner_id as string | null) ?? null, owner: name.get(String(r.owner_id)) ?? null, open: ["open", "overdue", "escalated", "in_motion"].includes(String(r.status)), href: null, at: (r.closed_at as string | null) ?? (r.said_at as string) });
  for (const r of (checks.data ?? []) as Record<string, unknown>[])
    if (!r.reopened_at) out.push({ source: "done_check", id: String(r.key), title: String(r.title ?? ""), clientId: (r.client_id as string | null) ?? null, ownerId: (r.owner_id as string | null) ?? null, owner: name.get(String(r.owner_id)) ?? null, open: false, href: null, at: r.closed_at as string });
  for (const r of (board.data ?? []) as Record<string, unknown>[])
    out.push({ source: "board", id: String(r.id), title: String(r.title ?? ""), clientId: (r.client_id as string | null) ?? null, ownerId: (r.assignee_id as string | null) ?? null, owner: name.get(String(r.assignee_id)) ?? null, open: r.stage !== "launched", href: r.number ? `/board?t=${r.number}` : null, at: r.created_at as string });
  return out;
}

/** One candidate against reality (loads what it needs; for many candidates load once with loadReality and use decide) */
export async function realityOf(admin: Admin, c: Candidate): Promise<{ state: RealityState; match: Existing | null }> {
  const found = await loadReality(admin, { clientIds: [c.clientId ?? null], ownerIds: [c.ownerId ?? null] }).catch(() => [] as Existing[]);
  return decide(c, found);
}

/**
 * Creates an OS item only when it's new. In motion: the existing item gets a short note with where this came up (once)
 * and nothing is created; done: nothing is created. Returns what happened so the caller can report it.
 */
/** Its sheet's facts: what the maker gave, plus every link in its words (the Slack message, Asana task, Gmail thread) */
function factsFor(row: { detail?: string | null; facts?: import("@/lib/item-facts").ItemFacts | null }) {
  const links = linksIn(row.detail);
  if (!row.facts && !links.length) return null;
  return withLinks(row.facts ?? {}, links);
}

export async function createItemIfNew(
  admin: Admin,
  row: { kind?: "task" | "reminder"; owner_id: string; asked_by?: string | null; client_id: string | null; title: string; detail?: string | null; due_on?: string | null; source_ref?: string | null; urgent?: boolean; checklist?: unknown[]; facts?: import("@/lib/item-facts").ItemFacts | null },
  found?: Existing[],
): Promise<{ state: RealityState; id: string | null; match: Existing | null; blocked?: true }> {
  // People matters never become an item (owner, Nov 24 2026): nothing is made, nothing is noted anywhere
  const { isPeopleMatter } = await import("@/lib/people-matters");
  if (isPeopleMatter(`${row.title}\n${row.detail ?? ""}`)) return { state: "done", id: null, match: null, blocked: true };
  if (row.source_ref) {
    const { data: same } = await admin.from("agent_asks").select("id, status").eq("source_ref", row.source_ref).limit(1).maybeSingle();
    if (same) return { state: same.status === "open" ? "in_motion" : "done", id: same.id as string, match: null };
  }
  const pool = found ?? (await loadReality(admin, { clientIds: [row.client_id], ownerIds: [row.owner_id] }).catch(() => [] as Existing[]));
  const d = decide({ title: row.title, clientId: row.client_id, ownerId: row.owner_id, sourceRef: row.source_ref ?? null }, pool);
  if (d.state === "in_motion" && d.match?.source === "item" && row.source_ref) {
    // The same work came up again: noted on the item that already has it (once per source), never a second item
    const { data: it } = await admin.from("agent_asks").select("detail").eq("id", d.match.id).maybeSingle();
    const line = `Also came up: ${row.title}${row.detail ? ` (${String(row.detail).split("\n")[0].slice(0, 200)})` : ""} [${row.source_ref}]`;
    if (it && !String(it.detail ?? "").includes(`[${row.source_ref}]`)) await admin.from("agent_asks").update({ detail: `${String(it.detail ?? "").trim()}\n${line}`.trim().slice(0, 4000) }).eq("id", d.match.id);
  }
  if (d.state !== "new") return { state: d.state, id: null, match: d.match };
  const { data, error } = await admin
    .from("agent_asks")
    .insert({ kind: row.kind ?? "task", owner_id: row.owner_id, asked_by: row.asked_by ?? row.owner_id, client_id: row.client_id, title: row.title.slice(0, 300), detail: row.detail?.slice(0, 4000) ?? null, due_on: row.due_on ?? null, source_ref: row.source_ref ?? null, urgent: Boolean(row.urgent), ...(row.checklist ? { checklist: row.checklist } : {}), facts: factsFor(row) })
    .select("id")
    .single();
  if (error || !data) return { state: "new", id: null, match: null };
  pool.push({ source: "item", id: data.id as string, title: row.title, clientId: row.client_id, ownerId: row.owner_id, owner: null, open: true, href: "/pipeline", at: new Date().toISOString() });
  return { state: "new", id: data.id as string, match: null };
}
