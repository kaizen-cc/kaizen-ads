import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { LIVE } from "@/lib/live";
import { shownStatus } from "@/lib/kpi/calc";
import { seatJob, workFor } from "@/lib/handoff-roles";

// Handing an account to the next person on any seat (the Meta or Google buyer, the designer, the video editor, the email
// strategist, designer or builder, the social manager or creative). Whoever changes the seat (the client page, the
// Handoffs page, the Account Overview sheet, a chat), the seat's open work follows (src/lib/handoff-roles.ts). Then the
// strategist writes the new person a handoff for their job: everything outstanding (tickets, tasks, promises, owed
// replies, direction changes, sprints, deadlines, approvals), what the client has said, dos and don'ts, what to tell
// the client, and a checklist for the person handing over. They read it in the app or save it as a PDF, and can ask
// questions about it. The client sees no gap: nothing drops, nothing is sent twice.

export type HandoffDoc = {
  headline: string;
  summary: string;
  dos: string[];
  donts: string[];
  learnings: string[];
  inMotion: { what: string; status: string }[];
  clientSaid: { what: string; when: string; where: string }[];
  brand: { voice: string; audience: string; rules: string[] };
  gtm: { stage: string; strategy: string; changed: string };
  keepInMind: string[];
  similar: { client: string; why: string; borrow: string }[];
  firstWeek: string[];
  /** Everything open on the seat, with when it's due and what to do (handoffs written before every seat had one lack it) */
  outstanding?: { what: string; due: string; where: string; action: string }[];
  /** What the client should hear about the change, if anything */
  tellClient?: string[];
  /** For the person handing over: what to pass on before they step away */
  handOver?: string[];
};

/** A client back from a pause or the archive: the buyer's brief for picking the account back up. */
export type ComebackDoc = {
  headline: string;
  summary: string;
  away: { since: string; length: string; why: string };
  leftOff: { state: string; lastMoves: string[]; unfinished: string[] };
  sinceThen: string[];
  now: string;
  dos: string[];
  donts: string[];
  keepInMind: string[];
  restart: { step: string; why: string }[];
  askClient: string[];
};

/** level: how much thinking the answer got (quick, standard, deep); researched: it searched the web for it */
/** Something the client desk changed in the knowledge base, and what undoes it */
export type DeskAction = { label: string; undo?: { type: "memory" | "undated" | "angle" | "website"; id: string; prev?: string }; undone?: boolean };
export type ChatTurn = {
  role: "user" | "assistant";
  text: string;
  at: string;
  by?: string;
  level?: "quick" | "standard" | "deep";
  researched?: boolean;
  /** Files and links shared with the message (filed in the client's documents) */
  attachments?: { id: string; name: string; kind: "file" | "link" }[];
  /** What the desk changed in the knowledge base */
  done?: DeskAction[];
  /** A change in the ad account (or the buyer) it planned: the plan card follows it there, to confirm */
  plan?: { id: string };
  /** A launch (a Meta launch sheet, or new Google Ads from words or a sheet): the launch card follows it there (questions, plan, confirm) */
  launch?: { id: string; platform?: "meta" | "google" };
  /** A place in the app the answer points to (the sprint the suggestions went on, the buyer's tasks) */
  link?: { href: string; label: string };
};

const S = { type: "string" };
const LIST = { type: "array", items: S };
const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  headline: S,
  summary: S,
  dos: LIST,
  donts: LIST,
  learnings: LIST,
  inMotion: { type: "array", items: obj({ what: S, status: S }) },
  clientSaid: { type: "array", items: obj({ what: S, when: S, where: S }) },
  brand: obj({ voice: S, audience: S, rules: LIST }),
  gtm: obj({ stage: S, strategy: S, changed: S }),
  keepInMind: LIST,
  similar: { type: "array", items: obj({ client: S, why: S, borrow: S }) },
  firstWeek: LIST,
  outstanding: { type: "array", items: obj({ what: S, due: S, where: S, action: S }) },
  tellClient: LIST,
  handOver: LIST,
});

const SYSTEM = `You write the handoff for the {LABEL} at Kaizen Marketing who is taking over a client (the {LABEL} {JOB}). They have never worked on it; the client must feel no gap at all: nothing dropped, nothing missed, nothing sent twice. Write it for their job, focused on {FOCUS}. Give them everything they need to run it well from day one, from what you're given only; never invent. Plain, direct, specific: names of offers, products, audiences, numbers, dates. Refer to people by role ("the previous {LABEL}", "the copywriter", "the client"), not by name, except the client's own contacts.
headline: where the account stands, in at most 14 words (no numbers beyond the one that matters most). summary: 3 to 5 sentences: who the client is, what they sell and to whom, how the account is doing against its KPI, and the single most important thing to know.
dos and donts: rules for this client's ads, creative and copy, from the client memory, Brand Bible and what the client has said (up to 8 each).
learnings: what has worked and what hasn't on this account, with evidence (up to 8).
inMotion: open tickets, the optimization sprint's open moves, promises from calls and anything else under way, each with its status and what the new {LABEL} needs to do about it.
clientSaid: what the client asked for, liked, disliked, expected or complained about in the last 45 days, across every team (ads, email, organic, calls, Slack, email), newest first. when: the date. where: the channel ("call with the email team", "Slack").
brand: voice, audience, and the hard rules from the Brand Bible (banned claims, must-haves). Empty strings and no rules when there's no Brand Bible.
gtm: stage (where the go-to-market strategy is: draft, reviewed, in place, missing), strategy (its core in 2 or 3 sentences) and changed (what has changed or been decided recently). Say plainly when there's none.
keepInMind: the major things that could go wrong or that the client is sensitive about (up to 6).
similar: accounts already on the new {LABEL}'s list that are similar (same market or sub-vertical), with why they're alike and what to borrow from how that account is run. Only from the list you're given; empty if none is truly similar.
firstWeek: 3 to 6 concrete first moves for the new {LABEL}, in order.
outstanding: every open thing on this seat and the account that the new {LABEL} must pick up, most urgent first: open tickets and Asana tasks, email or social work in progress, promises made to the client, messages waiting on our reply, direction changes from the client, sprint moves, approvals waiting on the client or on us, launches and offers coming up. what: the item; due: the date or "no date"; where: where it lives (ticket number, Asana, Slack, email); action: what they do about it. Empty only when nothing is open.
tellClient: what, if anything, the client should be told about the change or about what's outstanding (a new point of contact, a date that moves); empty when nothing.
handOver: 3 to 8 things the person handing over should pass on before stepping away: context only they have, files or logins, conversations to introduce, anything half-done. Specific to this account.
Refer to the seat by its job ("the previous {LABEL}"). Where a field is about ads (gtm, similar) and doesn't apply to this job, keep it short and say so.`;
const systemFor = (role: string) => {
  const j = seatJob(role);
  return SYSTEM.replaceAll("{LABEL}", j.label).replaceAll("{JOB}", j.job).replaceAll("{FOCUS}", j.focus);
};

const COMEBACK_SCHEMA = obj({
  headline: S,
  summary: S,
  away: obj({ since: S, length: S, why: S }),
  leftOff: obj({ state: S, lastMoves: LIST, unfinished: LIST }),
  sinceThen: LIST,
  now: S,
  dos: LIST,
  donts: LIST,
  keepInMind: LIST,
  restart: { type: "array", items: obj({ step: S, why: S }) },
  askClient: LIST,
});

const COMEBACK_SYSTEM = `You write the comeback brief for a media buyer at Kaizen Marketing whose client has just come back after a pause (or after being archived). The buyer needs to pick the account back up well: where we left it, what changed while we were away, and what to do first. Use only what you're given; never invent. When something isn't in the data, say so plainly rather than guessing. Plain, direct, specific: campaigns, offers, audiences, numbers, dates. Refer to Kaizen people by role ("the previous buyer", "the copywriter"), not by name; the client's own contacts by name.
headline: where the account stands coming back, at most 14 words. summary: 3 to 5 sentences: who the client is, why and when we stopped, how the account looked then versus now, and the single most important thing for the restart.
away: since (the date we last worked the account, from the archive date or, failing that, the last change, ticket or message from the team), length (how long, in words), why (the reason given, or "no reason recorded").
leftOff: state (how the account was performing against its KPI when we stopped, and what was running), lastMoves (the last changes made in the ad accounts before we stopped, newest first, up to 8, with dates), unfinished (sprint moves, tickets, promises and anything else left open).
sinceThen: what happened while we were away, newest first: changes in the ad accounts (by anyone), spend, what the client said or sent, new files on their Drive. Empty if nothing.
now: what the fresh sync shows today: is anything spending, which campaigns are on or off, the KPI versus target where there are numbers, anything broken (disapproved ads, a disabled account, missing tracking).
dos and donts: the rules for this client's ads, creative and copy, from the client memory, Brand Bible and what they've said (up to 6 each).
keepInMind: what could go wrong on the restart or what the client is sensitive about (up to 6).
restart: 4 to 8 concrete steps to bring the account back, in order, each with why. Start with the checks (access, billing, tracking, offers still current) before spending.
askClient: questions to confirm with the client before relaunching (offers, budget, goals, anything that may have changed). Up to 6.`;

/**
 * The seat's open work moves to the new person (src/lib/handoff-roles.ts): for the Meta buyer its KPI, open tickets and
 * sprint as before; for every seat what the old person held on this client. Work shared across seats (promises, owed
 * replies, tasks) moves only when the old person keeps no other seat on the client.
 */
async function moveWork(admin: SupabaseClient, clientId: string, role: string, fromId: string | null, toId: string) {
  const moved: Record<string, number> = {};
  const { data: still } = fromId ? await admin.from("client_assignments").select("role").eq("client_id", clientId).eq("profile_id", fromId) : { data: [] };
  const keepsASeat = (still ?? []).length > 0;
  for (const w of workFor(role)) {
    // The Meta buyer's KPI, tickets and sprint are the seat's whoever held them; everything else was the old person's
    const seatWide = role === "meta_buyer" && ["kpis", "tickets", "sprints"].includes(w.key);
    if (!seatWide && !fromId) continue;
    if (w.shared && keepsASeat) continue;
    let q = admin.from(w.table).update({ [w.column]: toId }).eq("client_id", clientId);
    if (!seatWide) q = q.eq(w.column, fromId as string);
    for (const [k, v] of Object.entries(w.open)) q = v === null ? q.is(k, null) : q.eq(k, v as string | boolean);
    if (w.notIn) q = q.not(w.notIn[0], "in", `(${w.notIn[1].map((x) => `"${x}"`).join(",")})`);
    const { data, error } = await q.select("client_id");
    if (!error) moved[w.key] = (data ?? []).length;
  }
  return moved;
}

/**
 * A client's seat changed hands: move the work and open a handoff for the new person (written in the background by
 * writeHandoff). Nothing happens when the seat didn't actually change or was cleared. Every seat gets one; the Meta
 * buyer's is the original.
 */
export async function handOff(admin: SupabaseClient, clientId: string, fromId: string | null, toId: string | null, byId: string | null, via: "app" | "sheet" | "form", role = "meta_buyer") {
  if (!toId || toId === fromId) return null;
  // A first assignment on any other seat is a start, not a handover (onboarding covers it): nothing to move or hand over
  if (role !== "meta_buyer" && !fromId) return null;
  const moved = await moveWork(admin, clientId, role, fromId, toId);
  // No handoff for someone who hasn't signed in to Kaizen OS yet (the team is still being onboarded): the work
  // still moves to them, but there's nobody to read a doc
  const { data: buyer } = await admin.from("profiles").select("auth_user_id").eq("id", toId).maybeSingle();
  if (!buyer?.auth_user_id) return null;
  // A client back live in the last two weeks: the new buyer gets the comeback brief (where it was left, how to restart)
  const { data: c } = await admin.from("clients").select("reactivated_at").eq("id", clientId).maybeSingle();
  const kind = role === "meta_buyer" && c?.reactivated_at && Date.now() - new Date(c.reactivated_at).getTime() < 14 * 86_400_000 ? "comeback" : "handoff";
  const { data } = await admin.from("account_handoffs").insert({ client_id: clientId, from_id: fromId, to_id: toId, by_id: byId, via, moved, kind, role }).select("id").single();
  return (data?.id as string | undefined) ?? null;
}

/** Everything the handoff and the account chat read beyond the client context: the last 45 days, what's open, peers. */
async function gather(admin: SupabaseClient, clientId: string, buyerId: string | null, role = "meta_buyer") {
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const open = await outstandingFor(admin, clientId);
  const [{ data: c }, { data: items }, { data: tickets }, { data: sprints }, { data: promises }, { data: gtm }, { data: mine }] = await Promise.all([
    admin.from("clients").select("name, vertical_id").eq("id", clientId).single(),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(80),
    admin.from("requests").select("number, title, stage, stage_due_at").eq("client_id", clientId).neq("stage", "launched").is("deleted_at", null).order("created_at").limit(30),
    admin.from("optimization_sprints").select("id, started_at, sprint_actions(title, status, when, why)").eq("client_id", clientId).eq("status", "active").limit(2),
    admin.from("call_commitments").select("what, kind, due_at, status").eq("client_id", clientId).in("status", ["open", "briefed"]).limit(15),
    admin.from("client_gtm_strategies").select("status, version, read_this_first, open_items, generated_at, reviewed_at").eq("client_id", clientId).maybeSingle(),
    buyerId ? admin.from("client_assignments").select("client_id, clients(name, status, archived_at, vertical_id)").eq("profile_id", buyerId).eq("role", role) : Promise.resolve({ data: [] as { client_id: string; clients: unknown }[] }),
  ]);
  // The new buyer's other live accounts, same sub-vertical first, with what we've learned on each
  const peers = (mine ?? [])
    .map((m) => ({ id: m.client_id as string, ...(m.clients as unknown as { name: string; status: string; archived_at: string | null; vertical_id: string | null }) }))
    .filter((p) => p.id !== clientId && !p.archived_at && (LIVE as readonly string[]).includes(p.status))
    .sort((a, b) => Number(b.vertical_id === c?.vertical_id) - Number(a.vertical_id === c?.vertical_id))
    .slice(0, 12);
  const { data: peerMemory } = peers.length ? await admin.from("client_memory").select("client_id, kind, body").in("client_id", peers.map((p) => p.id)).eq("status", "active").limit(120) : { data: [] };
  const verticalIds = [...new Set([c?.vertical_id, ...peers.map((p) => p.vertical_id)].filter(Boolean))] as string[];
  const { data: verticals } = verticalIds.length ? await admin.from("verticals").select("id, name").in("id", verticalIds) : { data: [] };
  const vName = (id: string | null) => (verticals ?? []).find((v) => v.id === id)?.name ?? "not placed";

  const lines = [
    `<last_45_days>`,
    ...(items ?? []).map((i) => `- ${String(i.occurred_at).slice(0, 10)} [${i.source}${i.author ? `, ${i.author}` : ""}] ${i.title ?? ""}: ${(i.body ?? "").replace(/\s+/g, " ").slice(0, 600)}`),
    `</last_45_days>`,
    `<open_tickets>`,
    ...(tickets ?? []).map((t) => `- #${t.number} ${t.title}: ${t.stage}${t.stage_due_at ? `, due ${String(t.stage_due_at).slice(0, 10)}` : ""}`),
    `</open_tickets>`,
    `<optimization_sprint>`,
    ...(sprints ?? []).flatMap((s) => (s.sprint_actions as unknown as { title: string; status: string; when: string; why: string }[]).map((a) => `- [${a.status}] ${a.title} (${a.when}): ${a.why}`)),
    `</optimization_sprint>`,
    `<call_promises_open>`,
    ...(promises ?? []).map((p) => `- ${p.what} (${p.kind}, due ${String(p.due_at).slice(0, 10)}, ${p.status})`),
    `</call_promises_open>`,
    open,
    `<gtm_status>${gtm ? `${gtm.status}, version ${gtm.version}, written ${String(gtm.generated_at ?? "").slice(0, 10)}${gtm.reviewed_at ? `, reviewed ${String(gtm.reviewed_at).slice(0, 10)}` : ", not reviewed"}${gtm.open_items ? `\nOpen items: ${JSON.stringify(gtm.open_items).slice(0, 1500)}` : ""}` : "No go-to-market strategy yet"}</gtm_status>`,
    `<this_client_sub_vertical>${vName(c?.vertical_id ?? null)}</this_client_sub_vertical>`,
    ...(buyerId ? [`<new_buyers_other_accounts>`] : []),
    ...peers.map(
      (p) =>
        `- ${p.name} (sub-vertical: ${vName(p.vertical_id)})${(peerMemory ?? [])
          .filter((m) => m.client_id === p.id)
          .slice(0, 8)
          .map((m) => `\n    [${m.kind}] ${m.body}`)
          .join("")}`,
    ),
    ...(buyerId ? [`</new_buyers_other_accounts>`] : []),
  ];
  return { name: c?.name ?? "the client", extra: lines.join("\n") };
}

/** Everything open on a client across every line: what a handoff must not let drop */
async function outstandingFor(admin: SupabaseClient, clientId: string): Promise<string> {
  const day = (x: unknown) => (x ? String(x).slice(0, 10) : "no date");
  const [{ data: email }, { data: promised }, { data: owed }, { data: direction }, { data: asana }, { data: tasks }, { data: targets }, { data: channel }] = await Promise.all([
    admin.from("email_tickets").select("number, title, kind, stage, due_on, stage_due_at").eq("client_id", clientId).is("deleted_at", null).neq("stage", "live").order("created_at").limit(25),
    admin.from("message_promises").select("what, due_at, status, source, channel_name").eq("client_id", clientId).in("status", ["open", "in_motion", "overdue", "escalated"]).limit(20),
    admin.from("owed_replies").select("gist, subject, from_name, asked_at, source, channel_name, status").eq("client_id", clientId).in("status", ["watching", "nudged", "escalated"]).limit(15),
    admin.from("client_direction_changes").select("summary, kind, said_at, source").eq("client_id", clientId).eq("status", "open").limit(10),
    admin.from("asana_tasks").select("name, section, stage, due_on, assignee_name").eq("client_id", clientId).eq("open", true).limit(25),
    admin.from("client_tasks").select("title, due_on, owner_role").eq("client_id", clientId).is("done_at", null).limit(20),
    admin.from("kpi_targets").select("platform, label, conversion, target, monthly_budget").eq("client_id", clientId).eq("active", true).limit(10),
    admin.from("channel_targets").select("line, metric, target, notes").eq("client_id", clientId).limit(20),
  ]);
  const block = (tag: string, rows: string[]) => [`<${tag}>`, ...(rows.length ? rows : ["none"]), `</${tag}>`];
  return [
    ...block("email_tickets_open", (email ?? []).map((t) => `- E${t.number} ${t.title} (${t.kind}): ${t.stage}, due ${day(t.due_on ?? t.stage_due_at)}`)),
    ...block("promises_to_the_client_open", (promised ?? []).map((p) => `- ${p.what} (${p.status}, due ${day(p.due_at)}, ${p.source}${p.channel_name ? ` #${p.channel_name}` : ""})`)),
    ...block("messages_waiting_on_our_reply", (owed ?? []).map((o) => `- ${o.gist ?? o.subject ?? "a message"} from ${o.from_name ?? "the client"} (${o.source}${o.channel_name ? ` #${o.channel_name}` : ""}, asked ${day(o.asked_at)}, ${o.status})`)),
    ...block("client_direction_changes_open", (direction ?? []).map((d) => `- ${d.summary} (${d.kind}, ${d.source}, ${day(d.said_at)})`)),
    ...block("asana_tasks_open", (asana ?? []).map((a) => `- ${a.name} (${a.section ?? a.stage ?? "open"}, due ${day(a.due_on)}${a.assignee_name ? `, ${a.assignee_name}` : ""})`)),
    ...block("setup_tasks_open", (tasks ?? []).map((t) => `- ${t.title} (${t.owner_role ?? "team"}, due ${day(t.due_on)})`)),
    ...block("kpis", [...(targets ?? []).map((t) => `- ${t.platform} ${t.label ?? ""}: ${t.conversion ?? ""} target ${t.target ?? "?"}${t.monthly_budget ? `, budget ${t.monthly_budget}/mo` : ""}`), ...(channel ?? []).map((c) => `- ${c.line} ${c.metric}: target ${c.target}${c.notes ? ` (${c.notes})` : ""}`)]),
  ].join("\n");
}

/** The client context plus the last 45 days and what's open; with a person, also their other accounts on that seat (for a handoff). */
export async function accountBrief(admin: SupabaseClient, clientId: string, buyerId: string | null, fresh = false, role = "meta_buyer") {
  const ctx = await clientContext(admin, clientId, { fresh });
  if (!ctx) throw new Error("Client not found");
  const g = await gather(admin, clientId, buyerId, role);
  return { name: g.name, text: `${contextBlock(ctx)}\n\n${g.extra}` };
}

/** The handoff for the person taking over a seat on a client (also written ahead of a planned move, to read before approving it) */
export async function handoffDoc(admin: SupabaseClient, clientId: string, toId: string, fromId: string | null, role = "meta_buyer"): Promise<HandoffDoc> {
  const b = await accountBrief(admin, clientId, toId, false, role);
  const j = seatJob(role);
  return askJson<HandoffDoc>({
    agent: "strategist",
    label: "account handoff",
    clientId,
    system: systemFor(role),
    schema: SCHEMA,
    maxTokens: 24000,
    onText: () => {},
    prompt: `${b.text}\n\nWrite the handoff for the ${j.label} taking over ${b.name}${fromId ? ` from the previous ${j.label}` : ""}.`,
  });
}

/** Writes the handoff doc. Safe to run again (a retry, or "Write it again"). */
export async function writeHandoff(admin: SupabaseClient, id: string) {
  const { data: h } = await admin.from("account_handoffs").select("client_id, to_id, from_id, moved, kind, role").eq("id", id).single();
  if (!h) return;
  await admin.from("account_handoffs").update({ status: "writing", error: null }).eq("id", id);
  if (h.kind === "comeback") return writeComeback(admin, id, h.client_id);
  try {
    const doc = await handoffDoc(admin, h.client_id, h.to_id, h.from_id, (h.role as string | null) ?? "meta_buyer");
    await admin.from("account_handoffs").update({ status: "ready", doc, ready_at: new Date().toISOString() }).eq("id", id);
  } catch (e) {
    await admin.from("account_handoffs").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", id);
  }
}

/** Where the account was left, what happened since, and what it looks like now (after the fresh sync). */
async function comebackFacts(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: archived }, { data: targets }] = await Promise.all([
    admin.from("clients").select("name, meta_ad_account_id, reactivated_at").eq("id", clientId).single(),
    admin.from("client_archive_events").select("at, reason, source, from_status").eq("client_id", clientId).eq("action", "archived").order("at", { ascending: false }).limit(1),
    admin.from("kpi_targets").select("id, platform, label, ad_account_id, conversion, target, monthly_budget, sheet").eq("client_id", clientId).eq("active", true),
  ]);
  const accounts = [...new Set([c?.meta_ad_account_id, ...(targets ?? []).map((t) => t.ad_account_id)].filter(Boolean) as string[])].flatMap((a) => [a, `act_${a}`, a.replace(/^act_/, "")]);
  const backAt: string = c?.reactivated_at ?? new Date().toISOString();
  const stoppedAt: string = archived?.[0]?.at ?? backAt;
  const [{ data: changes }, { data: snaps }, { data: audit }, { data: sprint }, { data: before }, { data: during }, { data: tickets }] = await Promise.all([
    accounts.length ? admin.from("ad_account_changes").select("at, who, what, object, platform").in("ad_account_id", accounts).order("at", { ascending: false }).limit(40) : Promise.resolve({ data: [] }),
    (targets ?? []).length ? admin.from("kpi_snapshots").select("target_id, status, windows, data_through").in("target_id", (targets ?? []).map((t) => t.id)) : Promise.resolve({ data: [] }),
    admin.from("account_audits").select("created_at, result").eq("client_id", clientId).not("result", "is", null).order("created_at", { ascending: false }).limit(1),
    admin.from("optimization_sprints").select("status, started_at, sprint_actions(title, status, when, why)").eq("client_id", clientId).order("started_at", { ascending: false }).limit(1),
    admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).lt("occurred_at", stoppedAt).order("occurred_at", { ascending: false }).limit(30),
    archived?.[0] ? admin.from("context_items").select("source, occurred_at, author, title, body").eq("client_id", clientId).gte("occurred_at", stoppedAt).order("occurred_at", { ascending: false }).limit(40) : Promise.resolve({ data: [] }),
    admin.from("requests").select("number, title, stage, updated_at").eq("client_id", clientId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(6),
  ]);
  type Item = { occurred_at: string; source: string; author: string | null; title: string | null; body: string | null };
  const snap = new Map((snaps ?? []).map((x) => [x.target_id as string, x]));
  const line = (i: Item) => `- ${String(i.occurred_at).slice(0, 10)} [${i.source}${i.author ? `, ${i.author}` : ""}] ${i.title ?? ""}: ${(i.body ?? "").replace(/\s+/g, " ").slice(0, 400)}`;
  const s0 = sprint?.[0];
  return [
    `<coming_back>Back live on ${backAt.slice(0, 10)}.${
      archived?.[0]
        ? ` Archived on ${String(archived[0].at).slice(0, 10)} (was ${archived[0].from_status ?? "unknown"}), reason: ${archived[0].reason ?? "none recorded"}, via ${archived[0].source ?? "the team"}.`
        : " Was paused (no archive record): infer when work stopped from the last changes, tickets and messages."
    }</coming_back>`,
    `<kpi_now note="after a fresh sync today">`,
    ...(targets ?? []).map((t) => {
      const s = snap.get(t.id as string);
      return `- ${t.platform}${t.label ? ` · ${t.label}` : ""} (${t.ad_account_id ?? "no account"}): counts ${t.conversion}, target ${t.target ?? "not set"}, monthly budget ${t.monthly_budget ?? "not set"}; status ${s ? shownStatus(s.status as string | null, t.target as number | null) : "no numbers"}, data through ${s?.data_through ?? "n/a"}; windows ${JSON.stringify(s?.windows ?? {}).slice(0, 1500)}${t.sheet ? `; buyer's notes ${JSON.stringify(t.sheet).slice(0, 800)}` : ""}`;
    }),
    `</kpi_now>`,
    `<ad_account_changes newest_first>`,
    ...(changes ?? []).map((x) => `- ${String(x.at).slice(0, 10)} ${x.platform}${x.who ? ` by ${x.who}` : ""}: ${x.what}${x.object ? ` (${x.object})` : ""}`),
    `</ad_account_changes>`,
    `<last_audit>${audit?.[0] ? `${String(audit[0].created_at).slice(0, 10)}: ${JSON.stringify(audit[0].result ?? {}).slice(0, 3000)}` : "none"}</last_audit>`,
    `<last_sprint>${
      s0 ? `${s0.status}, started ${String(s0.started_at).slice(0, 10)}\n${(s0.sprint_actions as unknown as { title: string; status: string; when: string; why: string }[]).map((a) => `- [${a.status}] ${a.title} (${a.when}): ${a.why}`).join("\n")}` : "none"
    }</last_sprint>`,
    `<last_tickets>`,
    ...(tickets ?? []).map((t) => `- #${t.number} ${t.title}: ${t.stage}, last touched ${String(t.updated_at).slice(0, 10)}`),
    `</last_tickets>`,
    `<before_we_stopped newest_first>`,
    ...((before ?? []) as Item[]).map(line),
    `</before_we_stopped>`,
    `<while_away newest_first>`,
    ...((during ?? []) as Item[]).map(line),
    `</while_away>`,
  ].join("\n");
}

/** Writes a comeback brief: the client context, plus where we left the account and what's changed since. */
async function writeComeback(admin: SupabaseClient, id: string, clientId: string) {
  try {
    const b = await accountBrief(admin, clientId, null);
    const facts = await comebackFacts(admin, clientId);
    const doc = await askJson<ComebackDoc>({
      agent: "strategist",
      label: "comeback brief",
      clientId,
      system: COMEBACK_SYSTEM,
      schema: COMEBACK_SCHEMA,
      maxTokens: 24000,
      onText: () => {},
      prompt: `${b.text}\n\n${facts}\n\nWrite the comeback brief for the media buyer picking ${b.name} back up.`,
    });
    await admin.from("account_handoffs").update({ status: "ready", doc, ready_at: new Date().toISOString() }).eq("id", id);
  } catch (e) {
    await admin.from("account_handoffs").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", id);
  }
}

/** A client back live: a comeback brief for each of their buyers (Meta and Google) who uses Kaizen OS, once a day at most. */
export async function startComebacks(admin: SupabaseClient, clientId: string, byId: string | null) {
  const { data: buyers } = await admin.from("client_assignments").select("profile_id, profiles(auth_user_id)").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer", "tiktok_buyer"]);
  const ids = [...new Set((buyers ?? []).filter((b) => (b.profiles as unknown as { auth_user_id: string | null } | null)?.auth_user_id).map((b) => b.profile_id as string))];
  const since = new Date(Date.now() - 20 * 3_600_000).toISOString();
  const made: string[] = [];
  for (const to of ids) {
    const { data: recent } = await admin.from("account_handoffs").select("id").eq("client_id", clientId).eq("to_id", to).eq("kind", "comeback").gte("created_at", since).limit(1);
    if (recent?.length) continue;
    const { data } = await admin.from("account_handoffs").insert({ client_id: clientId, to_id: to, by_id: byId, via: "reactivated", kind: "comeback" }).select("id").single();
    if (data?.id) made.push(data.id as string);
  }
  await Promise.all(made.map((id) => writeHandoff(admin, id)));
  return made.length;
}

const CHAT_SYSTEM = `You answer a Kaizen media buyer's questions about one client account they're running. Use only what you're given (the client context, the last 45 days, what's open, the handoff); when it isn't there, say so plainly and say who or where to ask (the client page, the previous buyer's notes, the client). Be brief and specific, like a colleague who knows the account: 1 to 6 sentences or a short list. Say where a fact comes from when it matters ("the client said on the Oct 9 call"). Plain text, no markdown (no asterisks or headings); start list lines with "- ". No emojis.`;

/** One question about the account, answered from everything the system knows; the thread is kept on the handoff. */
export async function askAboutAccount(admin: SupabaseClient, handoffId: string, question: string, by: string) {
  const { data: h } = await admin.from("account_handoffs").select("client_id, to_id, doc, chat").eq("id", handoffId).single();
  if (!h) throw new Error("Handoff not found");
  const b = await accountBrief(admin, h.client_id, h.to_id, true);
  const chat = (h.chat ?? []) as ChatTurn[];
  const out = await askJson<{ answer: string }>({
    agent: "strategist",
    label: "account question",
    clientId: h.client_id,
    system: CHAT_SYSTEM,
    schema: obj({ answer: S }),
    maxTokens: 6000,
    prompt: `${b.text}\n\n<handoff>\n${JSON.stringify(h.doc ?? {}).slice(0, 12000)}\n</handoff>\n\n<conversation>\n${chat
      .slice(-12)
      .map((t) => `${t.role === "user" ? "Buyer" : "You"}: ${t.text}`)
      .join("\n")}\n</conversation>\n\nThe buyer asks: ${question.trim().slice(0, 2000)}`,
  });
  const now = new Date().toISOString();
  const next: ChatTurn[] = [...chat, { role: "user", text: question.trim().slice(0, 2000), at: now, by }, { role: "assistant", text: out.answer, at: now }];
  await admin.from("account_handoffs").update({ chat: next.slice(-60) }).eq("id", handoffId);
  return next;
}
