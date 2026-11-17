import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { extraTeams, roleLabel } from "@/lib/roles";
import { orderForToday, type DayItem } from "./core";

// What the assistant knows about the person it's talking with, read with their own session (their rights decide):
// who they are, their clients and seats, their day (the recap and Next for me, critical first), their open tickets on
// both boards, reports waiting on them, unread notifications, replies they owe, reminders and tasks from the agents,
// and which of their own connectors are on. Kept short: the assistant drills in with its tools. Read once every few
// minutes per person (a call's turns share it).

const TTL = 3 * 60_000;
const cache = new Map<string, { at: number; text: string; items: WorkItem[] }>();

/** One thing on the person, as the assistant lists it */
export type WorkItem = DayItem & { client: string; why: string; href: string | null; source: "recap" | "next" | "ticket" | "email_ticket" | "report" | "notification" | "owed" | "ask" };

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    console.error("[assistant context]", e instanceof Error ? e.message : e);
    return fallback;
  }
};

/** Everything on this person today, ordered: critical first, then simple to complex */
export async function myWork(db: SupabaseClient, me: Staff): Promise<WorkItem[]> {
  const [{ todaySnapshot }, { loadNextForMe }, { loadOwedReplies }] = await Promise.all([import("@/lib/today-snapshot"), import("@/lib/next-for-me"), import("@/lib/owed-replies")]);
  const [snap, next, owed, tickets, emailTickets, reports, notes, asks] = await Promise.all([
    settle(todaySnapshot(db, me).then((s) => s.today.items), []),
    settle(loadNextForMe(db, me), null),
    settle(loadOwedReplies(db, me, false), []),
    settle(
      Promise.resolve(db.from("requests").select("id, number, title, stage, priority, stage_due_at, clients(name)").eq("assignee_id", me.id).neq("stage", "launched").order("stage_due_at", { ascending: true }).limit(30)).then((r) => r.data ?? []),
      [],
    ),
    settle(
      Promise.resolve(db.from("email_tickets").select("id, number, title, stage, priority, due_on, clients(name)").eq("assignee_id", me.id).neq("stage", "live").is("deleted_at", null).limit(30)).then((r) => r.data ?? []),
      [],
    ),
    settle(
      Promise.resolve(db.from("reports").select("id, status, kind, period_end, clients(name)").eq("owner_id", me.id).in("status", ["draft", "failed"]).order("period_end", { ascending: false }).limit(15)).then((r) => r.data ?? []),
      [],
    ),
    settle(
      Promise.resolve(db.from("notifications").select("id, title, body, href, priority, created_at").eq("profile_id", me.id).is("read_at", null).order("created_at", { ascending: false }).limit(15)).then((r) => r.data ?? []),
      [],
    ),
    settle(
      Promise.resolve(db.from("agent_asks").select("id, kind, title, detail, due_on, clients(name)").eq("owner_id", me.id).eq("status", "open").limit(20)).then((r) => r.data ?? []),
      [],
    ),
  ]);
  const items: WorkItem[] = [];
  const seen = new Set<string>();
  const add = (w: WorkItem) => {
    const k = `${w.client}|${w.title}`.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    items.push(w);
  };
  const cname = (c: unknown) => clip((c as { name?: string } | null)?.name ?? "", 80);
  for (const i of snap) add({ id: `recap-${i.key}`, tier: i.tier, score: i.score, kind: i.topic, title: clip(i.title, 160), client: i.client, why: clip(i.why, 200), href: i.action?.href ?? i.alt?.href ?? null, source: "recap" });
  if (next)
    for (const [bucket, list] of [["now", next.now], ["decide", next.decide], ["waiting", next.waiting]] as const)
      for (const i of list) add({ id: `next-${i.id}`, tier: i.tone === "bad" ? "critical" : i.tone === "warn" || bucket === "now" ? "high" : "normal", kind: i.kind, title: clip(i.title, 160), client: i.client, why: clip(`${i.why}${i.when ? ` (${i.when})` : ""}`, 200), href: i.href ?? null, source: "next" });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  for (const t of tickets as { id: string; number: number; title: string; stage: string; priority: string; stage_due_at: string | null; clients: unknown }[]) {
    const late = t.stage_due_at ? Date.parse(t.stage_due_at) < Date.now() : false;
    add({ id: `t-${t.id}`, tier: late || t.priority === "urgent" ? "critical" : t.priority === "high" ? "high" : "normal", kind: `ticket ${t.stage}`, title: `#${t.number} ${clip(t.title, 120)} (${t.stage.replace(/_/g, " ")})`, client: cname(t.clients), why: late ? "Past its turnaround" : `Priority ${t.priority}`, href: `/board?t=${t.number}`, source: "ticket" });
  }
  for (const t of emailTickets as { id: string; number: number; title: string; stage: string; priority: string; due_on: string | null; clients: unknown }[]) {
    const late = Boolean(t.due_on && t.due_on < today);
    add({ id: `e-${t.id}`, tier: late || t.priority === "urgent" ? "critical" : t.priority === "high" ? "high" : "normal", kind: `email ticket ${t.stage}`, title: `Email #${t.number} ${clip(t.title, 120)} (${t.stage.replace(/_/g, " ")})`, client: cname(t.clients), why: late ? `Was due ${t.due_on}` : t.due_on ? `Due ${t.due_on}` : `Priority ${t.priority}`, href: `/board/email?t=${t.number}`, source: "email_ticket" });
  }
  for (const r of reports as { id: string; status: string; kind: string; period_end: string; clients: unknown }[])
    add({ id: `r-${r.id}`, tier: r.status === "failed" ? "high" : "normal", kind: "report", title: `${r.status === "failed" ? "Fix" : "Review and send"} the ${r.kind} report`, client: cname(r.clients), why: `Period to ${r.period_end}`, href: `/reports/${r.id}`, source: "report" });
  for (const o of owed) add({ id: `o-${o.id}`, tier: o.status === "escalated" ? "critical" : "high", kind: "reply", title: `Reply to ${clip(o.from, 60)} on ${o.source === "gmail" ? "email" : "Slack"}: ${clip(o.gist, 100)}`, client: o.client ?? "", why: `Asked ${o.askedAt.slice(0, 10)}`, href: o.url, source: "owed" });
  for (const a of asks as { id: string; kind: string; title: string; detail: string; due_on: string | null; clients: unknown }[])
    add({ id: `a-${a.id}`, tier: a.due_on && a.due_on < today ? "high" : "normal", kind: a.kind === "task" ? "task" : "reminder", title: clip(a.title, 160), client: cname(a.clients), why: clip(a.detail, 160), href: "/pipeline#next", source: "ask" });
  for (const n of notes as { id: string; title: string; body: string; href: string | null; priority: string }[])
    add({ id: `n-${n.id}`, tier: n.priority === "critical" ? "critical" : "normal", kind: "notification", title: clip(n.title, 160), client: "", why: clip(n.body, 160), href: n.href, source: "notification" });
  return orderForToday(items);
}

/** The compact context for each turn (cached a few minutes per person) */
export async function myContext(db: SupabaseClient, admin: SupabaseClient, me: Staff): Promise<{ text: string; items: WorkItem[] }> {
  const hit = cache.get(me.id);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const [profile, seats, items, connectors] = await Promise.all([
    settle(
      Promise.resolve(db.from("profiles").select("teams, also_social, also_designs_email").eq("id", me.id).maybeSingle()).then((r) => r.data),
      null,
    ),
    settle(
      Promise.resolve(db.from("client_assignments").select("role, is_primary, clients(name, slug, archived_at)").eq("profile_id", me.id).limit(80)).then((r) => r.data ?? []),
      [],
    ),
    myWork(db, me),
    settle(import("@/lib/connectors/server").then(({ connectedKeys }) => connectedKeys(me.id)), [] as string[]),
  ]);
  void admin;
  const teams = profile ? [...extraTeams(profile as { teams?: string[] | null; also_social?: boolean | null; also_designs_email?: boolean | null })] : [];
  type Seat = { role: string; is_primary: boolean | null; clients: { name: string; slug: string; archived_at: string | null } | null };
  const byClient = new Map<string, string[]>();
  for (const s of seats as unknown as Seat[]) {
    if (!s.clients || s.clients.archived_at) continue;
    byClient.set(s.clients.name, [...(byClient.get(s.clients.name) ?? []), `${s.role.replace(/_/g, " ")}${s.is_primary === false ? " (backup)" : ""}`]);
  }
  const critical = items.filter((i) => i.tier === "critical");
  const line = (i: WorkItem) => `- ${i.client ? `${i.client}: ` : ""}${i.title}${i.why ? `. ${i.why}` : ""}${i.href ? ` [open: ${i.href}]` : ""}`;
  const text = [
    `<who>${me.fullName}, ${roleLabel(me.role)}${me.isExec ? " (executive)" : me.isLead ? " (lead)" : ""}${teams.length ? `; also on the ${teams.join(" and ")} team${teams.length > 1 ? "s" : ""}` : ""}.</who>`,
    `<clients count="${byClient.size}">\n${[...byClient].slice(0, 60).map(([c, r]) => `- ${c}: ${r.join(", ")}`).join("\n") || "(no seats on clients)"}\n</clients>`,
    `<their_day critical="${critical.length}" total="${items.length}">\nIn order: critical first, then simple to complex.\n${items.slice(0, 30).map(line).join("\n") || "(nothing on them right now)"}${items.length > 30 ? `\n…and ${items.length - 30} more (use my_work)` : ""}\n</their_day>`,
    `<connectors>${connectors.length ? `Connected: ${connectors.join(", ")}.` : "None connected."}</connectors>`,
  ].join("\n\n");
  const out = { at: Date.now(), text, items };
  cache.set(me.id, out);
  return out;
}

/** Forget the cached context (after the assistant changes something, so the next turn reads it fresh) */
export const forgetContext = (profileId: string) => cache.delete(profileId);
