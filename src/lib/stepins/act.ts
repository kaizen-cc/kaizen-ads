import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { execSees, type CardStatus, type Reason } from "./core";
import type { StepinCard } from "./run";

// Reading and working the shared step-in cards (the /stepins page, the Overview section and the assistant's tools).
// Executives only. Every exec sees the same card with everyone's comments (item_comments, key stepin:<client_id>) and
// actions; each action tells the other execs in the app (the bell), never Slack.

export type Stepin = {
  id: string;
  clientId: string;
  status: CardStatus;
  reasons: Reason[];
  card: StepinCard;
  fire: boolean;
  severity: number;
  handler: { id: string; name: string; label: string } | null;
  dueOn: string | null;
  handledBy: string | null;
  handledAt: string | null;
  handledNote: string | null;
  openedAt: string;
  reopenedAt: string | null;
  comments: { id: string; body: string; kind: string; at: string; author: string | null }[];
};

export const stepinKey = (clientId: string) => `stepin:${clientId}`;
type Result = { ok: true; message?: string } | { ok: false; error: string };

/** The cards this exec sees (a fire: every exec; otherwise their focus lines), worst first, with each card's thread */
export async function loadStepins(db: SupabaseClient, me: Staff, opts: { status?: "open" | "all" } = {}): Promise<Stepin[]> {
  if (!me.isExec) return [];
  const { loadExecFocus } = await import("@/lib/exec-focus/server");
  let q = db.from("exec_stepins").select("id, client_id, status, reasons, card, fire, severity, handler_id, due_on, handled_at, handled_note, opened_at, reopened_at, handler:profiles!exec_stepins_handler_id_fkey(full_name, role), closer:profiles!exec_stepins_handled_by_fkey(full_name)").order("severity", { ascending: false }).limit(200);
  q = opts.status === "all" ? q.neq("status", "recovered") : q.eq("status", "open");
  const [{ data }, focus] = await Promise.all([q, loadExecFocus(db, me.id).catch(() => [])]);
  const rows = ((data ?? []) as unknown as { id: string; client_id: string; status: CardStatus; reasons: Reason[]; card: StepinCard; fire: boolean; severity: number; handler_id: string | null; due_on: string | null; handled_at: string | null; handled_note: string | null; opened_at: string; reopened_at: string | null; handler: { full_name: string; role: string } | null; closer: { full_name: string } | null }[]).filter((r) => execSees(r.reasons, focus));
  const { roleLabel } = await import("@/lib/roles");
  const keys = rows.map((r) => stepinKey(r.client_id));
  const { data: cs } = keys.length ? await db.from("item_comments").select("id, key, body, kind, created_at, author:profiles!item_comments_author_id_fkey(full_name)").in("key", keys).order("created_at").limit(2000) : { data: [] };
  const byKey = new Map<string, Stepin["comments"]>();
  for (const c of (cs ?? []) as unknown as { id: string; key: string; body: string; kind: string; created_at: string; author: { full_name: string } | null }[]) byKey.set(c.key, [...(byKey.get(c.key) ?? []), { id: c.id, body: c.body, kind: c.kind, at: c.created_at, author: c.author?.full_name ?? null }]);
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    status: r.status,
    reasons: r.reasons ?? [],
    card: r.card,
    fire: r.fire,
    severity: r.severity,
    handler: r.handler_id ? { id: r.handler_id, name: r.handler?.full_name ?? "An exec", label: r.handler ? `${r.handler.full_name.split(" ")[0]} (${roleLabel(r.handler.role as Parameters<typeof roleLabel>[0])})` : "An exec" } : null,
    dueOn: r.due_on,
    handledBy: r.closer?.full_name ?? null,
    handledAt: r.handled_at,
    handledNote: r.handled_note,
    openedAt: r.opened_at,
    reopenedAt: r.reopened_at,
    comments: byKey.get(stepinKey(r.client_id)) ?? [],
  }));
}

async function own(admin: SupabaseClient, me: Staff, id: string) {
  if (!me.isExec) return { error: "Step-ins are for the executives." } as const;
  if (me.viewAs) return { error: `You're viewing as ${me.viewAs.label}: exit to make changes.` } as const;
  const { data } = await admin.from("exec_stepins").select("id, client_id, status, card").eq("id", id).maybeSingle();
  if (!data) return { error: "That step-in isn't there anymore." } as const;
  return { row: data as { id: string; client_id: string; status: CardStatus; card: StepinCard } } as const;
}

/** The other execs hear what one did on a card (in the app) */
async function tellExecs(admin: SupabaseClient, me: Staff, row: { client_id: string; card: StepinCard }, what: string) {
  const { data: execs } = await admin.from("profiles").select("id").eq("is_active", true).eq("is_exec", true).neq("id", me.id);
  const client = row.card?.client?.name ?? "A client";
  if (!execs?.length) return;
  await admin.from("notifications").upsert(
    execs.map((e) => ({ profile_id: e.id as string, kind: "comment", title: `${me.fullName} on ${client}'s step-in`.slice(0, 200), body: what.slice(0, 1000), href: `/stepins#s-${row.client_id}`, client_id: row.client_id, key: `stepin:${row.client_id}`, priority: "normal", read_at: null, cleared_at: null, actor_id: me.id })),
    { onConflict: "profile_id,key" },
  );
}

async function note(admin: SupabaseClient, me: Staff, row: { client_id: string; card: StepinCard }, body: string, kind: "comment" | "resumed" = "comment") {
  await admin.from("item_comments").insert({ key: stepinKey(row.client_id), client_id: row.client_id, author_id: me.id, body: body.slice(0, 4000), kind });
  const { data: t } = await admin.from("item_threads").select("comments").eq("key", stepinKey(row.client_id)).maybeSingle();
  const at = new Date().toISOString();
  await admin.from("item_threads").upsert({ key: stepinKey(row.client_id), client_id: row.client_id, title: `${row.card?.client?.name ?? "Client"} step-in`, comments: Number(t?.comments ?? 0) + (kind === "comment" ? 1 : 0), last_comment_at: at, updated_at: at }, { onConflict: "key" });
}

export async function commentStepin(admin: SupabaseClient, me: Staff, id: string, body: string): Promise<Result> {
  const o = await own(admin, me, id);
  if ("error" in o) return { ok: false, error: o.error! };
  const text = String(body ?? "").replace(/\s+$/g, "").trim();
  if (!text) return { ok: false, error: "Write a comment first." };
  await note(admin, me, o.row, text);
  await tellExecs(admin, me, o.row, text);
  return { ok: true, message: "Added. The other execs can see it." };
}

/** Who's handling it and by when (an exec, or a teammate the execs agreed on) */
export async function assignStepin(admin: SupabaseClient, me: Staff, id: string, i: { handlerId?: string | null; handlerName?: string | null; dueOn?: string | null }): Promise<Result> {
  const o = await own(admin, me, id);
  if ("error" in o) return { ok: false, error: o.error! };
  let handlerId = i.handlerId ?? null;
  let name = "";
  if (!handlerId && i.handlerName) {
    const { data: p } = await admin.from("profiles").select("id, full_name").eq("is_active", true).ilike("full_name", `%${i.handlerName.replace(/[%_]/g, "")}%`).limit(2);
    if (p?.length !== 1) return { ok: false, error: p?.length ? `More than one person matches ${i.handlerName}: ${p.map((x) => x.full_name).join(", ")}.` : `Nobody active called ${i.handlerName}.` };
    handlerId = p[0].id as string;
  }
  if (handlerId) {
    const { data: p } = await admin.from("profiles").select("full_name, is_active").eq("id", handlerId).maybeSingle();
    if (!p?.is_active) return { ok: false, error: "That person isn't on the team anymore." };
    name = p.full_name as string;
  }
  const due = i.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(i.dueOn) ? i.dueOn : null;
  await admin.from("exec_stepins").update({ ...(handlerId ? { handler_id: handlerId } : {}), ...(i.dueOn !== undefined ? { due_on: due } : {}), updated_at: new Date().toISOString() }).eq("id", id);
  const what = `${handlerId ? `${handlerId === me.id ? `${me.fullName.split(" ")[0]} is taking this` : `${name} is handling this`}` : "Due date set"}${due ? `, due ${new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}.`;
  await note(admin, me, o.row, what);
  await tellExecs(admin, me, o.row, what);
  if (handlerId && handlerId !== me.id)
    await admin.from("notifications").upsert(
      { profile_id: handlerId, kind: "comment", title: `${me.fullName.split(" ")[0]} put ${o.row.card?.client?.name ?? "a client"} on you`.slice(0, 200), body: `${o.row.card?.step ?? ""}${due ? ` Due ${due}.` : ""}`.trim().slice(0, 1000), href: `/pipeline?comments=${encodeURIComponent(stepinKey(o.row.client_id))}`, client_id: o.row.client_id, key: `stepin-on:${o.row.client_id}`, priority: "normal", read_at: null, cleared_at: null, actor_id: me.id },
      { onConflict: "profile_id,key" },
    );
  return { ok: true, message: what };
}

export async function closeStepin(admin: SupabaseClient, me: Staff, id: string, reason: string): Promise<Result> {
  const o = await own(admin, me, id);
  if ("error" in o) return { ok: false, error: o.error! };
  if (o.row.status !== "open") return { ok: false, error: `It's already ${o.row.status}.` };
  const at = new Date().toISOString();
  const why = String(reason ?? "").trim().slice(0, 500);
  await admin.from("exec_stepins").update({ status: "handled", handled_by: me.id, handled_at: at, handled_note: why || null, closed_at: at, updated_at: at }).eq("id", id);
  const what = `Marked handled${why ? `: ${why}` : ""}. It reopens if the account slides again.`;
  await note(admin, me, o.row, what, "resumed");
  await tellExecs(admin, me, o.row, what);
  return { ok: true, message: "Marked handled." };
}

export async function reopenStepin(admin: SupabaseClient, me: Staff, id: string): Promise<Result> {
  const o = await own(admin, me, id);
  if ("error" in o) return { ok: false, error: o.error! };
  if (o.row.status === "open") return { ok: false, error: "It's already open." };
  const at = new Date().toISOString();
  await admin.from("exec_stepins").update({ status: "open", reopened_at: at, handled_at: null, handled_by: null, handled_note: null, closed_at: null, updated_at: at }).eq("id", id);
  await note(admin, me, o.row, "Reopened.", "resumed");
  await tellExecs(admin, me, o.row, "Reopened the step-in.");
  return { ok: true, message: "Reopened." };
}
