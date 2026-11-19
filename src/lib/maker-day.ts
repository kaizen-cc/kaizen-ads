import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { TodayDraft } from "@/lib/today";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { stageInfo, type Stage } from "@/lib/stages";
import { COPY_STAGES, EMAIL_MAKER_STAGES, MAKER_STAGES, URGENCY_SCORE, asanaRevisions, byDue, inMakerPool, makerKind, makerPool, urgencyOf, whenLabel } from "@/lib/maker-day-core";
import { emailStageInfo, type EmailStage } from "@/lib/email-board-core";

// A maker's day (graphic designers and video editors; the rules in src/lib/maker-day-core.ts): what's on their plate,
// most urgent first, and what's about to hit their board ("On your radar"): briefs drafted or approved for their
// clients and not started, promises made on calls, Slack or email that will become creative, and a client's change of
// direction that touches a piece they're making. No client metrics, ever.

const PER_SOURCE = 5;
const RADAR_MAX = 12;
const nyToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const day = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const stageLabel = (s: string | null) => (s ? (stageInfo(s as Stage)?.label ?? s.replace(/_/g, " ")) : "No column");

export type MakerTask = {
  key: string;
  kind: "asana" | "ticket" | "email_ticket" | "email_asana";
  client: string;
  clientSlug: string;
  clientId: string | null;
  title: string;
  stage: string | null;
  stageLabel: string;
  due: string | null;
  revisions: number;
  href: string;
  /** Waiting on them (brief, in production, client revision), or with someone else (review, copy, the client) */
  onThem: boolean;
};

/** Every open piece on a maker, overdue first: by what they make (creative, email or copy) */
export async function makerTasks(db: SupabaseClient, me: Pick<Staff, "id" | "role">): Promise<MakerTask[]> {
  const kind = makerKind(me.role);
  if (kind === "email") return emailTasks(db, me);
  if (kind === "copy") return copyTasks(db);
  return creativeTasks(db, me);
}

const emailLabel = (s: string | null) => (s ? (emailStageInfo(s as EmailStage)?.label ?? s.replace(/_/g, " ")) : "No column");

/** An email designer's or builder's: their Email Board tickets and their tasks on Asana's email board */
async function emailTasks(db: SupabaseClient, me: Pick<Staff, "id" | "role">): Promise<MakerTask[]> {
  const mineStages = EMAIL_MAKER_STAGES[me.role ?? ""] ?? new Set<string>();
  const [{ data: tickets }, { data: tasks }] = await Promise.all([
    db.from("email_tickets").select("id, number, title, stage, due_on, client_rounds, client_id, clients(name, slug)").eq("assignee_id", me.id).neq("stage", "live").is("deleted_at", null).limit(100),
    db.from("email_asana_tasks").select("gid, name, url, due_on, section, stage, client_id, moves, clients(name, slug)").eq("profile_id", me.id).eq("open", true).is("ticket_id", null).limit(150),
  ]);
  const out: MakerTask[] = [];
  for (const r of tickets ?? []) {
    const c = r.clients as unknown as { name: string; slug: string } | null;
    out.push({ key: `mine:email:${r.id}`, kind: "email_ticket", client: c?.name ?? "", clientSlug: c?.slug ?? "", clientId: (r.client_id as string) ?? null, title: `#${r.number} ${r.title}`, stage: r.stage as string, stageLabel: emailLabel(r.stage as string), due: (r.due_on as string | null) ?? null, revisions: Number(r.client_rounds) || 0, href: `/board/email?t=${r.number}`, onThem: !mineStages.size || mineStages.has(r.stage as string) });
  }
  for (const t of tasks ?? []) {
    const c = t.clients as unknown as { name: string; slug: string } | null;
    const stage = (t.stage as string | null) ?? null;
    out.push({ key: `mine:email-asana:${t.gid}`, kind: "email_asana", client: c?.name ?? "", clientSlug: c?.slug ?? "", clientId: (t.client_id as string | null) ?? null, title: t.name as string, stage, stageLabel: (t.section as string | null) ?? emailLabel(stage), due: (t.due_on as string | null) ?? null, revisions: asanaRevisions(t.moves as { from?: string; to?: string }[] | null), href: (t.url as string | null) ?? `https://app.asana.com/0/0/${t.gid}`, onThem: stage == null || !mineStages.size || mineStages.has(stage) });
  }
  return byDue(out);
}

/** The copywriter's: every piece in the copy columns (Asana's Ready for Copy and Copy for Review, and the board's) */
async function copyTasks(db: SupabaseClient): Promise<MakerTask[]> {
  const [{ data: tickets }, { data: tasks }] = await Promise.all([
    db.from("board_requests").select("id, number, title, client_name, client_slug, client_id, stage, stage_due_at, internal_rounds, client_rounds").in("stage", [...COPY_STAGES]).is("deleted_at", null).limit(100),
    db.from("asana_tasks").select("gid, name, url, due_on, section, stage, client_id, moves, clients(name, slug)").eq("open", true).is("request_id", null).in("stage", [...COPY_STAGES]).limit(150),
  ]);
  const out: MakerTask[] = [];
  for (const r of tickets ?? [])
    out.push({ key: `mine:ticket:${r.id}`, kind: "ticket", client: (r.client_name as string) ?? "", clientSlug: (r.client_slug as string) ?? "", clientId: (r.client_id as string) ?? null, title: `#${r.number} ${r.title}`, stage: r.stage as string, stageLabel: stageLabel(r.stage as string), due: r.stage_due_at ? new Date(r.stage_due_at as string).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null, revisions: (Number(r.internal_rounds) || 0) + (Number(r.client_rounds) || 0), href: `/board?t=${r.number}`, onThem: r.stage === "copy" });
  for (const t of tasks ?? []) {
    const c = t.clients as unknown as { name: string; slug: string } | null;
    out.push({ key: `mine:asana:${t.gid}`, kind: "asana", client: c?.name ?? "", clientSlug: c?.slug ?? "", clientId: (t.client_id as string | null) ?? null, title: t.name as string, stage: t.stage as string, stageLabel: (t.section as string | null) ?? stageLabel(t.stage as string), due: (t.due_on as string | null) ?? null, revisions: asanaRevisions(t.moves as { from?: string; to?: string }[] | null), href: (t.url as string | null) ?? `https://app.asana.com/0/0/${t.gid}`, onThem: t.stage === "copy" });
  }
  return byDue(out);
}

/** A designer's or video editor's: their Asana creative tasks and any Kaizen board tickets */
async function creativeTasks(db: SupabaseClient, me: Pick<Staff, "id">): Promise<MakerTask[]> {
  const [{ data: tickets }, { data: tasks }] = await Promise.all([
    db.from("board_requests").select("id, number, title, client_name, client_slug, client_id, stage, stage_due_at, internal_rounds, client_rounds").eq("assignee_id", me.id).neq("stage", "launched").limit(100),
    db.from("asana_tasks").select("gid, name, url, due_on, section, stage, client_id, moves, clients(name, slug)").eq("profile_id", me.id).eq("open", true).is("request_id", null).limit(150),
  ]);
  const out: MakerTask[] = [];
  for (const r of tickets ?? [])
    out.push({
      key: `mine:ticket:${r.id}`,
      kind: "ticket",
      client: (r.client_name as string) ?? "",
      clientSlug: (r.client_slug as string) ?? "",
      clientId: (r.client_id as string) ?? null,
      title: `#${r.number} ${r.title}`,
      stage: r.stage as string,
      stageLabel: stageLabel(r.stage as string),
      due: r.stage_due_at ? new Date(r.stage_due_at as string).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : null,
      revisions: (Number(r.internal_rounds) || 0) + (Number(r.client_rounds) || 0),
      href: `/board?t=${r.number}`,
      onThem: MAKER_STAGES.has(r.stage as string),
    });
  for (const t of tasks ?? []) {
    const c = t.clients as unknown as { name: string; slug: string } | null;
    // A launched task is done for them, whatever Asana still says
    if (/launched/i.test((t.section as string | null) ?? "")) continue;
    const stage = (t.stage as string | null) ?? null;
    out.push({
      key: `mine:asana:${t.gid}`,
      kind: "asana",
      client: c?.name ?? "",
      clientSlug: c?.slug ?? "",
      clientId: (t.client_id as string | null) ?? null,
      title: t.name as string,
      stage,
      stageLabel: (t.section as string | null) ?? stageLabel(stage),
      due: (t.due_on as string | null) ?? null,
      revisions: asanaRevisions(t.moves as { from?: string; to?: string }[] | null),
      href: (t.url as string | null) ?? `https://app.asana.com/0/0/${t.gid}`,
      onThem: stage == null || MAKER_STAGES.has(stage),
    });
  }
  return byDue(out);
}

/** Their plate as recap items: each piece waiting on them, overdue first, then today, revisions, this week, the rest */
export async function makerPlate(db: SupabaseClient, me: Pick<Staff, "id" | "role">): Promise<TodayDraft[]> {
  const today = nyToday();
  return (await makerTasks(db, me))
    .filter((t) => t.onThem)
    .map((t) => {
      const u = urgencyOf(t, today);
      const where = t.kind === "asana" || t.kind === "email_asana" ? `In Asana's ${t.stageLabel} column` : `On the board in ${t.stageLabel}`;
      return {
        key: t.key,
        topic: "mine" as const,
        score: URGENCY_SCORE[u] + (u === "overdue" ? Math.min(8, Math.max(0, -(Date.parse(`${t.due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)) : 0),
        client: t.client || "Your work",
        clientSlug: t.clientSlug,
        clientId: t.clientId,
        stat: u === "revision" ? { value: String(Math.max(1, t.revisions)), label: t.revisions === 1 ? "round of changes" : "rounds of changes" } : { value: whenLabel(t.due, today).replace(/^Due /, "").replace(/^Was due /, ""), label: u === "overdue" ? "was due" : t.due ? "due" : "no due date yet" },
        title: t.title,
        story: `${where}, assigned to you. ${whenLabel(t.due, today)}.${t.revisions ? ` ${t.revisions} ${t.revisions === 1 ? "round" : "rounds"} of changes so far.` : ""}`,
        why: u === "overdue" ? "Past its due date" : u === "today" ? "Due today" : u === "revision" ? "Sent back with changes" : u === "week" ? "Due this week" : "On your plate",
        evidence: [],
        action: { label: t.kind === "asana" || t.kind === "email_asana" ? "Open in Asana" : "Open the ticket", href: t.href },
      };
    });
}

/**
 * What's about to hit their board, for the clients they hold a designer or video editor seat on, in their pool: a
 * brief drafted or approved and not started, a promise from a call, Slack or email that will become creative, and a
 * client's change of direction touching a piece they're making. Read with the service role (makers can't read
 * drafts or other people's promises), only for their own seats, and only the words needed: never a metric.
 */
export async function makerRadar(db: SupabaseClient, me: Pick<Staff, "id" | "role">): Promise<TodayDraft[]> {
  const kind = makerKind(me.role);
  if (kind === "email") return emailRadar(db, me);
  if (kind === "copy") return copyRadar(db);
  return creativeRadar(db, me);
}

/** Pieces a few steps before someone's column, as radar items ("coming to you") */
function comingItems(rows: { key: string; client: string; slug: string; clientId: string | null; title: string; where: string; since: string | null; href: string }[], label: string): TodayDraft[] {
  return rows.slice(0, PER_SOURCE * 2).map((r) => ({
    key: r.key,
    topic: "radar",
    score: 50,
    client: r.client,
    clientSlug: r.slug,
    clientId: r.clientId,
    stat: { value: "Next", label },
    title: r.title,
    story: `${r.where}${r.since ? ` since ${day(r.since)}` : ""}. It comes to you next.`,
    why: "Coming to your board",
    evidence: [],
    action: { label: /^https?:/.test(r.href) ? "Open in Asana" : "Open it", href: r.href },
  })) as TodayDraft[];
}

/** An email maker's radar: emails a step before their column (copy being reviewed for a designer, approved for a builder) */
async function emailRadar(db: SupabaseClient, me: Pick<Staff, "id" | "role">): Promise<TodayDraft[]> {
  const before = me.role === "email_builder" ? ["with_client", "for_review"] : ["copy_review"];
  const seatRole = me.role === "email_builder" ? "email_builder" : "email_designer";
  const reader = adminConfigured() ? createAdminClient() : db;
  const [{ data: seats }, mine] = await Promise.all([reader.from("client_assignments").select("client_id").eq("profile_id", me.id).eq("role", seatRole), emailTasks(db, me)]);
  const ids = [...new Set([...(seats ?? []).map((s) => s.client_id as string), ...mine.map((t) => t.clientId).filter((x): x is string => Boolean(x))])];
  if (!ids.length) return [];
  const { data } = await reader.from("email_tickets").select("id, number, title, stage, stage_entered_at, client_id, assignee_id, clients(name, slug)").in("client_id", ids).in("stage", before).is("deleted_at", null).order("stage_entered_at").limit(PER_SOURCE * 2);
  return comingItems(
    (data ?? []).filter((r) => r.assignee_id !== me.id).map((r) => {
      const c = r.clients as unknown as { name: string; slug: string } | null;
      return { key: `radar:email:${r.id}`, client: c?.name ?? "", slug: c?.slug ?? "", clientId: r.client_id as string, title: `#${r.number} ${r.title}`, where: `On the Email Board in ${emailLabel(r.stage as string)}`, since: (r.stage_entered_at as string | null) ?? null, href: `/board/email?t=${r.number}` };
    }),
    me.role === "email_builder" ? "to build next" : "to design next",
  ).filter((i) => i.client);
}

/** The copywriter's radar: creative in review now, heading to copy next */
async function copyRadar(db: SupabaseClient): Promise<TodayDraft[]> {
  const [{ data: tickets }, { data: tasks }] = await Promise.all([
    db.from("board_requests").select("id, number, title, client_name, client_slug, client_id, stage_entered_at").eq("stage", "internal_review").is("deleted_at", null).order("stage_entered_at").limit(PER_SOURCE),
    db.from("asana_tasks").select("gid, name, url, client_id, asana_modified_at, clients(name, slug)").eq("open", true).is("request_id", null).eq("stage", "internal_review").order("asana_modified_at").limit(PER_SOURCE),
  ]);
  return comingItems(
    [
      ...(tickets ?? []).map((r) => ({ key: `radar:copy:${r.id}`, client: (r.client_name as string) ?? "", slug: (r.client_slug as string) ?? "", clientId: (r.client_id as string) ?? null, title: `#${r.number} ${r.title}`, where: "In creative review on the board", since: (r.stage_entered_at as string | null) ?? null, href: `/board?t=${r.number}` })),
      ...(tasks ?? []).map((t) => {
        const c = t.clients as unknown as { name: string; slug: string } | null;
        return { key: `radar:copy-asana:${t.gid}`, client: c?.name ?? "", slug: c?.slug ?? "", clientId: (t.client_id as string | null) ?? null, title: t.name as string, where: "In Creative for Review in Asana", since: null, href: (t.url as string | null) ?? `https://app.asana.com/0/0/${t.gid}` };
      }),
    ],
    "copy next",
  ).filter((i) => i.client);
}

/** A designer's or video editor's radar (below) */
async function creativeRadar(db: SupabaseClient, me: Pick<Staff, "id" | "role">): Promise<TodayDraft[]> {
  const reader = adminConfigured() ? createAdminClient() : db;
  const seatRole = makerPool(me.role) === "videos" ? "video_editor" : "graphic_designer";
  const [{ data: seats }, mine] = await Promise.all([reader.from("client_assignments").select("client_id, clients(name, slug)").eq("profile_id", me.id).eq("role", seatRole), makerTasks(db, me)]);
  // Their clients: the ones they hold a seat on, and the ones they're making something for right now (most makers
  // work across clients without a seat)
  const clients = new Map((seats ?? []).map((s) => [s.client_id as string, s.clients as unknown as { name: string; slug: string } | null]));
  for (const t of mine) if (t.clientId && !clients.has(t.clientId)) clients.set(t.clientId, { name: t.client, slug: t.clientSlug });
  // Only clients we do creative for: nothing is coming to a designer's board from the rest
  const { clientsWithLine } = await import("@/lib/service-gate");
  const doing = await clientsWithLine(reader, "creative", [...clients.keys()]);
  const ids = [...clients.keys()].filter((id) => doing.has(id));
  const refs = mine.map((t) => (t.kind === "asana" ? t.key.split(":")[2] : t.key.split(":")[2]));
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const soon = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const [{ data: drafts }, { data: queued }, { data: calls }, { data: said }, { data: changes }] = await Promise.all([
    ids.length ? reader.from("creative_suggestions").select("id, client_id, kind, draft, created_at, deadline").eq("status", "open").in("client_id", ids).gte("created_at", since).order("created_at", { ascending: false }).limit(20) : { data: [] },
    ids.length ? reader.from("asana_tasks").select("gid, name, format, client_id, asana_created_at, profile_id").eq("open", true).eq("stage", "requested").is("request_id", null).in("client_id", ids).limit(60) : { data: [] },
    ids.length ? reader.from("call_commitments").select("id, client_id, kind, what, due_at, created_at").in("status", ["open", "briefed"]).in("kind", ["creative", "offer", "copy"]).in("client_id", ids).is("merged_into", null).gte("due_at", new Date(Date.now() - 3 * 86_400_000).toISOString()).lte("due_at", soon).order("due_at").limit(PER_SOURCE) : { data: [] },
    ids.length ? reader.from("message_promises").select("id, client_id, source, kind, what, said_at, due_at").in("status", ["open", "overdue", "escalated"]).in("kind", ["creative", "offer", "copy"]).in("client_id", ids).gte("said_at", since).order("said_at", { ascending: false }).limit(PER_SOURCE) : { data: [] },
    refs.length ? reader.from("direction_change_tasks").select("id, change_id, client_id, task_ref, title, fix, action, client_direction_changes!inner(summary, status, source, said_at)").in("task_ref", refs).eq("action", "pending").eq("client_direction_changes.status", "open").limit(40) : { data: [] },
  ]);
  const name = (id: string) => clients.get(id)?.name ?? "";
  const slug = (id: string) => clients.get(id)?.slug ?? "";
  const out: TodayDraft[] = [];
  const item = (d: Omit<TodayDraft, "topic" | "evidence"> & { evidence?: string[] }): TodayDraft => ({ topic: "radar", evidence: [], ...d }) as TodayDraft;

  // A client changed direction on a piece they're making: the one radar item they act on now
  for (const c of changes ?? []) {
    const ch = c.client_direction_changes as unknown as { summary: string; source: string; said_at: string | null } | null;
    const t = mine.find((m) => m.key.endsWith(`:${c.task_ref}`));
    out.push(
      item({
        key: `radar:change:${c.id}`,
        score: 70,
        client: t?.client || name(c.client_id as string) || "A client",
        clientSlug: t?.clientSlug || slug(c.client_id as string),
        clientId: (c.client_id as string) ?? null,
        stat: { value: "Change", label: "from the client" },
        title: `The client changed direction: ${clip(ch?.summary ?? "", 120)}`,
        story: `It touches "${c.title}", which you're making${ch?.said_at ? ` (said ${day(ch.said_at)})` : ""}. Your lead decides whether it's adapted or sent back; hold off on what it changes.`,
        why: "Touches a piece on your plate",
        action: t ? { label: t.kind === "asana" ? "Open in Asana" : "Open the ticket", href: t.href } : { label: "Open the client", href: `/clients/${slug(c.client_id as string)}` },
      }),
    );
  }
  // Briefed and on the board, not assigned yet (or yours, not started): it lands with the next assignment
  for (const t of queued ?? []) {
    if (!inMakerPool(me.role, t.format as string | null)) continue;
    if (t.profile_id && t.profile_id !== me.id) continue;
    if (t.profile_id === me.id) continue; // already on their plate
    out.push(
      item({
        key: `radar:queued:${t.gid}`,
        score: 52,
        client: name(t.client_id as string),
        clientSlug: slug(t.client_id as string),
        clientId: t.client_id as string,
        stat: { value: "Briefed", label: "not assigned yet" },
        title: t.name as string,
        story: `Approved and waiting in Creative Brief since ${day(t.asana_created_at as string)}, not assigned yet. It's for one of your clients, so it likely lands with you next.`,
        why: "Coming to your board",
        action: { label: "Open the board", href: `/board?client=${encodeURIComponent(slug(t.client_id as string))}` },
      }),
    );
  }
  // Drafted briefs waiting on a lead's approval
  for (const d of drafts ?? []) {
    const dr = d.draft as { title?: string; formats?: { format: string }[]; summary?: boolean } | null;
    if (!dr?.title || !(dr.formats ?? []).some((f) => inMakerPool(me.role, f.format))) continue;
    out.push(
      item({
        key: `radar:draft:${d.id}`,
        score: d.deadline ? 56 : 46,
        client: name(d.client_id as string),
        clientSlug: slug(d.client_id as string),
        clientId: d.client_id as string,
        stat: d.deadline ? { value: day(d.deadline as string), label: "has to be live by" } : { value: "Drafted", label: "waiting on approval" },
        title: dr.title,
        story: `A brief drafted ${day(d.created_at as string)}, waiting on a lead's approval. Once it's approved it lands on the board${d.deadline ? `, and it has to be live by ${day(d.deadline as string)}` : ""}.`,
        why: "Coming to your board",
        action: { label: "Open the client", href: `/clients/${slug(d.client_id as string)}?service=creative` },
      }),
    );
  }
  // Promised on a call: it becomes a creative request
  for (const p of calls ?? []) {
    out.push(
      item({
        key: `radar:call:${p.id}`,
        score: 50,
        client: name(p.client_id as string),
        clientSlug: slug(p.client_id as string),
        clientId: p.client_id as string,
        stat: { value: day(p.due_at as string), label: "promised by" },
        title: clip(p.what as string, 140),
        story: `Promised to the client on a call (${day(p.created_at as string)}). It becomes a creative request, likely around ${day(p.due_at as string)}.`,
        why: "Discussed on a call",
        action: { label: "Open the client", href: `/clients/${slug(p.client_id as string)}` },
      }),
    );
  }
  // Said yes to in Slack or email: the same
  for (const p of said ?? []) {
    const where = p.source === "gmail" ? "by email" : "in Slack";
    out.push(
      item({
        key: `radar:said:${p.id}`,
        score: 48,
        client: name(p.client_id as string),
        clientSlug: slug(p.client_id as string),
        clientId: p.client_id as string,
        stat: p.due_at ? { value: day(p.due_at as string), label: "due" } : { value: "Soon", label: "coming in" },
        title: clip(p.what as string, 140),
        story: `Agreed with the client ${where} on ${day(p.said_at as string)}. It becomes a creative request${p.due_at ? ` around ${day(p.due_at as string)}` : " soon"}.`,
        why: `Discussed ${where}`,
        action: { label: "Open the client", href: `/clients/${slug(p.client_id as string)}` },
      }),
    );
  }
  // A short list, not a feed: the strongest few from each source, at most RADAR_MAX in all
  const per = new Map<string, number>();
  return out
    .filter((i) => i.client)
    .filter((i) => {
      const src = i.key.split(":")[1];
      const n = (per.get(src) ?? 0) + 1;
      per.set(src, n);
      return n <= PER_SOURCE;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, RADAR_MAX);
}

/**
 * Customer success's radar: what's about to land on them with a client. Pieces ready to go to the client for review,
 * and a client's change of direction still open. Promises from calls are already in their day.
 */
export async function csRadar(db: SupabaseClient): Promise<TodayDraft[]> {
  const [{ data: tickets }, { data: tasks }, { data: changes }] = await Promise.all([
    db.from("board_requests").select("id, number, title, client_name, client_slug, client_id, stage_entered_at").eq("stage", "ready_for_client").is("deleted_at", null).order("stage_entered_at").limit(PER_SOURCE),
    db.from("asana_tasks").select("gid, name, url, client_id, asana_modified_at, clients(name, slug)").eq("open", true).is("request_id", null).eq("section", "Ready for Client").order("asana_modified_at").limit(PER_SOURCE),
    db.from("client_direction_changes").select("id, summary, said_at, created_at, client_id, clients(name, slug)").eq("status", "open").order("created_at", { ascending: false }).limit(PER_SOURCE),
  ]);
  const out = comingItems(
    [
      ...(tickets ?? []).map((r) => ({ key: `radar:to-client:${r.id}`, client: (r.client_name as string) ?? "", slug: (r.client_slug as string) ?? "", clientId: (r.client_id as string) ?? null, title: `#${r.number} ${r.title}`, where: "Ready to go to the client for review", since: (r.stage_entered_at as string | null) ?? null, href: `/board?t=${r.number}` })),
      ...(tasks ?? []).map((t) => {
        const c = t.clients as unknown as { name: string; slug: string } | null;
        return { key: `radar:to-client-asana:${t.gid}`, client: c?.name ?? "", slug: c?.slug ?? "", clientId: (t.client_id as string | null) ?? null, title: t.name as string, where: "In Ready for Client in Asana", since: null, href: (t.url as string | null) ?? `https://app.asana.com/0/0/${t.gid}` };
      }),
    ],
    "to the client next",
  ).map((i) => ({ ...i, story: i.story.replace("It comes to you next.", "It goes to the client for review next.") }));
  for (const c of changes ?? []) {
    const cl = c.clients as unknown as { name: string; slug: string } | null;
    if (!cl) continue;
    out.push({ key: `radar:client-change:${c.id}`, topic: "radar", score: 62, client: cl.name, clientSlug: cl.slug, clientId: c.client_id as string, stat: { value: "Change", label: "from the client" }, title: `${cl.name} changed direction: ${clip(c.summary as string, 120)}`, story: `Said ${day((c.said_at as string | null) ?? (c.created_at as string))}. The pieces it touches are flagged for the team; the client may need to hear what changes and when.`, why: "A client change in motion", evidence: [], action: { label: "Open the change", href: `/clients/${cl.slug}?direction=${c.id}` } } as TodayDraft);
  }
  return out.filter((i) => i.client);
}
