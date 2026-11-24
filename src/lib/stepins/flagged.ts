import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { execHears } from "@/lib/exec-overview-core";
import { REVIEW_LINE_LABEL, weekStartOf, type Review, type ReviewItem, type ReviewLine } from "@/lib/line-review/core";
import { flagHoles, flagStanding, type FlagStatus, type Rung } from "./core";

// "Flagged this week" under the execs' step-in deck (owner, Nov 23 2026): every account the line heads' Monday review
// flagged, in the exec's lines (plus any client on fire), with the hole in a few words, the person it's on, whether
// it's moving or stuck, and where it sits on the ladder (with the owner, with the lead, a step-in). Each is a living
// item: any exec can comment to the person it's on (it reaches them in the app, on a shared thread every exec sees),
// put it on someone else and set a due date. That never takes it off the owner or escalates it: it's visibility.

export type FlaggedItem = { text: string; owner: string | null; since: string | null; atLead: boolean };
export type Flagged = {
  id: string;
  key: string;
  clientId: string;
  client: string;
  slug: string;
  line: ReviewLine;
  lineLabel: string;
  holes: string[];
  owner: { id: string; label: string } | null;
  assignedBy: boolean;
  dueOn: string | null;
  rung: Rung;
  status: FlagStatus;
  risk: number;
  stepin: boolean;
  /** The card's insides: results and budget, what the team did and hasn't, the linked items on the ladder */
  results: ReviewItem[];
  done: string[];
  notDone: string[];
  items: FlaggedItem[];
  comments: { id: string; body: string; kind: string; at: string; author: string | null }[];
};

export const flagKey = (reviewId: string) => `flag:${reviewId}`;
const nyDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const first = (n: string) => n.trim().split(/\s+/)[0] || n;

/** The accounts flagged this week that this exec sees, worst first (step-ins on top) */
export async function loadFlagged(admin: SupabaseClient, me: Staff): Promise<Flagged[]> {
  if (!me.isExec) return [];
  const week = weekStartOf(nyDay());
  const [{ loadExecFocus }, { roleLabel }] = await Promise.all([import("@/lib/exec-focus/server"), import("@/lib/roles")]);
  const [{ data: reviews }, focus, { data: people }, { data: steps }, { data: ladder }] = await Promise.all([
    admin.from("line_reviews").select("id, client_id, line, risk, status, review, assignee_id, due_on, clients!inner(name, slug, archived_at)").eq("week_start", week).is("clients.archived_at", null).limit(1000),
    loadExecFocus(admin, me.id).catch(() => []),
    admin.from("profiles").select("id, full_name, role, is_active"),
    admin.from("exec_stepins").select("client_id, status, fire, handler_id, due_on").in("status", ["open", "handled"]),
    admin.from("ladder_nudges").select("client_id, line, what, since, exec_at, owner:profiles!ladder_nudges_owner_id_fkey(full_name, role)").in("status", ["open", "sent"]).not("client_id", "is", null).limit(2000),
  ]);
  const pById = new Map(((people ?? []) as { id: string; full_name: string; role: string; is_active: boolean }[]).map((p) => [p.id, p]));
  const label = (p: { full_name: string; role: string }) => `${first(p.full_name)} (${roleLabel(p.role as Parameters<typeof roleLabel>[0])})`;
  const stepBy = new Map(((steps ?? []) as { client_id: string; status: string; fire: boolean; handler_id: string | null; due_on: string | null }[]).map((s) => [s.client_id, s]));
  const LADDER_LINE: Record<string, ReviewLine> = { meta: "meta", tiktok: "meta", google: "google", email: "email", social: "social" };
  const out: Flagged[] = [];
  for (const r of (reviews ?? []) as unknown as { id: string; client_id: string; line: ReviewLine; risk: number; status: string; review: Review; assignee_id: string | null; due_on: string | null; clients: { name: string; slug: string } }[]) {
    const step = stepBy.get(r.client_id);
    // Their lines, or a client on fire (every exec)
    if (!execHears(r.line, focus) && !step?.fire) continue;
    const holes = flagHoles(r.review ?? {});
    if (!holes.length && !step) continue;
    const items = ((ladder ?? []) as unknown as { client_id: string; line: string | null; what: string; since: string; exec_at: string | null; owner: { full_name: string; role: string } | null }[])
      .filter((l) => l.client_id === r.client_id && (!l.line || LADDER_LINE[l.line] === r.line))
      .map((l) => ({ text: l.what, owner: l.owner ? label(l.owner) : null, since: l.since, atLead: true }));
    // Who it's on: an exec handling its step-in, else who an exec put it on, else the seat holder
    const handler = step?.status === "open" && step.handler_id ? pById.get(step.handler_id) : null;
    const assignee = handler ?? (r.assignee_id ? pById.get(r.assignee_id) : null);
    const seat = r.review?.owner?.id ? pById.get(r.review.owner.id) : null;
    const ownerP = assignee?.is_active ? assignee : seat?.is_active ? seat : null;
    const st = flagStanding({ stepin: Boolean(step && step.status === "open"), ladder: items, handled: r.status === "sent" && !items.length });
    const delivered = (r.review?.scope?.delivered ?? []).map((d) => d.text).filter((t) => !/^0 |: \$0$/.test(t));
    const notDone = [...(r.review?.commitments ?? []), ...(r.review?.scope?.promised ?? [])].map((d) => `${d.who && !d.who.startsWith("<@") ? `${d.who}: ` : ""}${d.text}`);
    out.push({
      id: r.id,
      key: flagKey(r.id),
      clientId: r.client_id,
      client: r.clients.name,
      slug: r.clients.slug,
      line: r.line,
      lineLabel: REVIEW_LINE_LABEL[r.line],
      holes: holes.length ? holes : ["Step-in"],
      owner: ownerP ? { id: ownerP.id, label: label(ownerP) } : null,
      assignedBy: Boolean(assignee),
      dueOn: handler ? (step?.due_on ?? r.due_on) : r.due_on,
      rung: st.rung,
      status: st.status,
      risk: r.risk + (step?.status === "open" ? 1000 : 0),
      stepin: step?.status === "open",
      results: [...(r.review?.results ?? []), ...(r.review?.budget ?? []).map((b) => ({ text: `${b.platform === "google" ? "Google" : b.platform === "tiktok" ? "TikTok" : "Meta"} spend $${Math.round(b.spent).toLocaleString("en-US")} of $${Math.round(b.budget).toLocaleString("en-US")}, on course for $${Math.round(b.projected).toLocaleString("en-US")}`, confidence: b.confidence }))].slice(0, 6),
      done: delivered.slice(0, 5),
      notDone: notDone.slice(0, 5),
      items: items.slice(0, 6),
      comments: [],
    });
  }
  out.sort((a, b) => b.risk - a.risk || a.client.localeCompare(b.client));
  const keys = out.map((f) => f.key);
  if (keys.length) {
    const { data: cs } = await admin.from("item_comments").select("id, key, body, kind, created_at, author:profiles!item_comments_author_id_fkey(full_name)").in("key", keys.slice(0, 500)).order("created_at").limit(3000);
    const by = new Map<string, Flagged["comments"]>();
    for (const c of (cs ?? []) as unknown as { id: string; key: string; body: string; kind: string; created_at: string; author: { full_name: string } | null }[]) by.set(c.key, [...(by.get(c.key) ?? []), { id: c.id, body: c.body, kind: c.kind, at: c.created_at, author: c.author?.full_name ?? null }]);
    for (const f of out) f.comments = by.get(f.key) ?? [];
  }
  return out;
}

type Result = { ok: true; message?: string } | { ok: false; error: string };

async function ownRow(admin: SupabaseClient, me: Staff, id: string) {
  if (!me.isExec) return { error: "Flagged accounts are for the executives." } as const;
  if (me.viewAs) return { error: `You're viewing as ${me.viewAs.label}: exit to make changes.` } as const;
  const { data } = await admin.from("line_reviews").select("id, client_id, line, review, assignee_id, clients(name, slug)").eq("id", id).maybeSingle();
  if (!data) return { error: "That account isn't flagged anymore." } as const;
  return { row: data as unknown as { id: string; client_id: string; line: ReviewLine; review: Review; assignee_id: string | null; clients: { name: string; slug: string } } } as const;
}

/** The person a flagged account is on: who an exec put it on, else the seat holder (active only) */
async function ownerOf(admin: SupabaseClient, row: { assignee_id: string | null; review: Review }): Promise<string | null> {
  const ids = [row.assignee_id, row.review?.owner?.id].filter((x): x is string => Boolean(x));
  if (!ids.length) return null;
  const { data } = await admin.from("profiles").select("id, is_active").in("id", ids);
  const active = new Set((data ?? []).filter((p) => p.is_active).map((p) => p.id as string));
  return ids.find((x) => active.has(x)) ?? null;
}

/** Tell the owner and the other execs, in the app; the owner's link opens the thread on their Overview */
async function tell(admin: SupabaseClient, me: Staff, row: { id: string; client_id: string; line: ReviewLine; clients: { name: string } }, ownerId: string | null, what: string) {
  const { data: execs } = await admin.from("profiles").select("id").eq("is_active", true).eq("is_exec", true);
  const to = [...new Set([...(execs ?? []).map((e) => e.id as string), ...(ownerId ? [ownerId] : [])])].filter((x) => x !== me.id);
  if (!to.length) return;
  const title = `${me.fullName.split(" ")[0]} on ${row.clients.name} (${REVIEW_LINE_LABEL[row.line]})`;
  await admin.from("notifications").upsert(
    to.map((pid) => ({ profile_id: pid, kind: "comment", title: title.slice(0, 200), body: what.slice(0, 1000), href: pid === ownerId ? `/pipeline?comments=${encodeURIComponent(flagKey(row.id))}` : `/stepins?flagged=1#f-${row.id}`, client_id: row.client_id, key: `comment:${flagKey(row.id)}`, priority: "normal", read_at: null, cleared_at: null, actor_id: me.id })),
    { onConflict: "profile_id,key" },
  );
}

async function note(admin: SupabaseClient, me: Staff, row: { id: string; client_id: string; line: ReviewLine; clients: { name: string } }, body: string) {
  const key = flagKey(row.id);
  await admin.from("item_comments").insert({ key, client_id: row.client_id, author_id: me.id, body: body.slice(0, 4000), kind: "comment" });
  const { data: t } = await admin.from("item_threads").select("comments").eq("key", key).maybeSingle();
  const at = new Date().toISOString();
  await admin.from("item_threads").upsert({ key, client_id: row.client_id, title: `${row.clients.name}: ${REVIEW_LINE_LABEL[row.line]} this week`, comments: Number(t?.comments ?? 0) + 1, last_comment_at: at, updated_at: at }, { onConflict: "key" });
}

/** An exec's comment to the person a flagged account is on (it stays theirs; nothing escalates) */
export async function commentFlagged(admin: SupabaseClient, me: Staff, id: string, body: string): Promise<Result> {
  const o = await ownRow(admin, me, id);
  if ("error" in o) return { ok: false, error: o.error! };
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, error: "Write a comment first." };
  await note(admin, me, o.row, text);
  await tell(admin, me, o.row, await ownerOf(admin, o.row), text);
  return { ok: true, message: "Sent. The owner and the other execs see it." };
}

/** Put a flagged account on someone else and/or set a due date */
export async function assignFlagged(admin: SupabaseClient, me: Staff, id: string, i: { personId?: string | null; personName?: string | null; dueOn?: string | null }): Promise<Result> {
  const o = await ownRow(admin, me, id);
  if ("error" in o) return { ok: false, error: o.error! };
  let pid = i.personId ?? null;
  if (!pid && i.personName) {
    const { data: p } = await admin.from("profiles").select("id, full_name").eq("is_active", true).ilike("full_name", `%${i.personName.replace(/[%_]/g, "")}%`).limit(2);
    if (p?.length !== 1) return { ok: false, error: p?.length ? `More than one person matches ${i.personName}: ${p.map((x) => x.full_name).join(", ")}.` : `Nobody active called ${i.personName}.` };
    pid = p[0].id as string;
  }
  let who = "";
  if (pid) {
    const { data: p } = await admin.from("profiles").select("full_name, role, is_active").eq("id", pid).maybeSingle();
    if (!p?.is_active) return { ok: false, error: "That person isn't on the team anymore." };
    const { roleLabel } = await import("@/lib/roles");
    who = `${first(p.full_name as string)} (${roleLabel(p.role as Parameters<typeof roleLabel>[0])})`;
  }
  const due = i.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(i.dueOn) ? i.dueOn : null;
  await admin.from("line_reviews").update({ ...(pid ? { assignee_id: pid } : {}), ...(i.dueOn !== undefined ? { due_on: due } : {}) }).eq("id", id);
  const what = `${pid ? `Now on ${who}` : "Due date set"}${due ? `, due ${new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}.`;
  await note(admin, me, o.row, what);
  await tell(admin, me, o.row, pid ?? (await ownerOf(admin, o.row)), what);
  return { ok: true, message: what };
}
