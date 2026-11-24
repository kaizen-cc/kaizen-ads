import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { dueRuns, nyClock, pushLine, routineOf, ROUTINES, type Days, type RecapSection, type RoutineKind, type RoutineReport } from "@/lib/routines-core";

// Per-person routines (owner, Nov 24 2026): Kaizen OS does what an exec's Claude scheduled runs did, inside the OS, for
// anyone who turns them on (execs and leads), at their own times. Each run writes a report (the person's recaps page and
// the bell, its first sentence the one thing to do first) and makes OS items only through the dedupe against reality
// (src/lib/reality-check.ts). Never a Slack DM, never an email, never anything sent for them; never a client's fee.
// Spec: docs/kyle-scheduled-runs.md.

type Admin = SupabaseClient;
type Person = { id: string; full_name: string; email: string; role: string; is_exec: boolean; is_lead: boolean };
const DAY = 86_400_000;

/** Every routine due right now, run once each, within the time budget */
export async function runDueRoutines(admin: Admin, opts: { budgetMs?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 240_000);
  const { data: rows } = await admin.from("routines").select("profile_id, kind, enabled, times, days").eq("enabled", true).limit(500);
  // Call prep runs off the calendar, not a time: each person's calls starting within the next hour or so, prepped once
  let prepped = 0;
  for (const r of (rows ?? []).filter((x) => x.kind === "call_prep")) {
    if (Date.now() > deadline) break;
    const { data: me } = await admin.from("profiles").select("id, full_name, email, role, is_exec, is_lead").eq("id", r.profile_id).maybeSingle();
    if (me?.email) prepped += await (await import("@/lib/routine-callprep")).prepUpcomingCalls(admin, me as Person).catch(() => 0);
  }
  const due: { profileId: string; kind: RoutineKind; key: string }[] = [];
  for (const r of rows ?? []) for (const key of dueRuns({ profileId: r.profile_id as string, kind: r.kind as string, times: (r.times as string[]) ?? [], days: r.days as Days, enabled: true }, now)) due.push({ profileId: r.profile_id as string, kind: r.kind as RoutineKind, key });
  if (!due.length) return { due: 0, ran: 0, prepped };
  const { data: ran } = await admin.from("routine_runs").select("run_key").in("run_key", due.map((d) => d.key));
  const done = new Set((ran ?? []).map((r) => r.run_key as string));
  let n = 0;
  for (const d of due) {
    if (done.has(d.key) || Date.now() > deadline) continue;
    await runRoutine(admin, d.profileId, d.kind, d.key).catch((e) => console.error("[routines]", d.key, e instanceof Error ? e.message : e));
    n++;
  }
  return { due: due.length, ran: n, prepped };
}

/** One run now (the schedule, or someone asking for it): claims its key, writes the report, rings the bell */
export async function runRoutine(admin: Admin, profileId: string, kind: RoutineKind, key?: string): Promise<{ id: string | null; report: RoutineReport | null; error?: string }> {
  const runKeyNow = key ?? `${profileId}|${kind}|now|${new Date().toISOString()}`;
  const { data: claimed, error: claimErr } = await admin.from("routine_runs").insert({ profile_id: profileId, kind, run_key: runKeyNow }).select("id").single();
  if (claimErr || !claimed) return { id: null, report: null, error: "Already ran" };
  const { data: me } = await admin.from("profiles").select("id, full_name, email, role, is_exec, is_lead").eq("id", profileId).maybeSingle();
  if (!me) return { id: claimed.id as string, report: null, error: "No such person" };
  try {
    const report = await RUNNERS[kind](admin, me as Person);
    await admin.from("routine_runs").update({ status: "done", headline: report.headline.slice(0, 400), report, finished_at: new Date().toISOString() }).eq("id", claimed.id);
    if (report.sections.some((s) => s.lines.length) || report.urgent) {
      const label = routineOf(kind)?.label ?? "Recap";
      await admin.from("notifications").upsert(
        { profile_id: profileId, kind: "recap", key: `routine:${claimed.id}`, title: `${label}: ${pushLine(report)}`.slice(0, 200), body: report.sections.map((s) => `${s.title}: ${s.lines.length}`).join(" · ").slice(0, 1000), href: `/routines?run=${claimed.id}`, priority: report.urgent ? "critical" : "normal" },
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
    }
    return { id: claimed.id as string, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("routine_runs").update({ status: "failed", error: msg.slice(0, 1000), finished_at: new Date().toISOString() }).eq("id", claimed.id);
    return { id: claimed.id as string, report: null, error: msg };
  }
}

// ─── What a window holds for one person ─────────────────────────────────────

type Ev = { id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string }; attendees?: { email?: string; responseStatus?: string }[]; hangoutLink?: string; description?: string; location?: string };
export type Meeting = { id: string; title: string; start: string; end: string | null; external: string[]; link: string | null; agenda: boolean };

/** Their calendar between two instants (their own Google calendar, read-only); null when it can't be read */
export async function meetingsBetween(email: string, from: string, to: string): Promise<Meeting[] | null> {
  try {
    const { googleCalendarToken, googleCalendarEventsToken } = await import("@/lib/context/google");
    const { gcal } = await import("@/lib/assistant/calendar-server");
    const token = await googleCalendarToken(email).catch(() => googleCalendarEventsToken(email));
    const r = await gcal<{ items?: Ev[] }>(token, "GET", "/calendars/primary/events", { timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "60" });
    const ours = (e: string) => /@kaizenmarketing\.agency$/i.test(e) || /calendar\.google\.com|resource\.calendar/i.test(e);
    return (r.items ?? [])
      .filter((e) => e.start?.dateTime)
      .map((e) => ({ id: e.id, title: e.summary ?? "(no title)", start: e.start!.dateTime!, end: e.end?.dateTime ?? null, external: (e.attendees ?? []).map((a) => String(a.email ?? "")).filter((a) => a && !ours(a)), link: e.hangoutLink ?? null, agenda: Boolean(e.description?.trim()) }));
  } catch {
    return null;
  }
}

/** Everything a recap reads for one person over a window: meetings, call notes, messages, their open items */
async function gather(admin: Admin, me: Person, from: string, to: string, ahead?: { from: string; to: string }) {
  const failed: string[] = [];
  const [meetings, upcoming, { data: calls }, { data: items }, owedMod, saidMod, callsMod, { data: comms }, { data: seats }] = await Promise.all([
    meetingsBetween(me.email, from, to),
    ahead ? meetingsBetween(me.email, ahead.from, ahead.to) : Promise.resolve([] as Meeting[]),
    admin.from("client_calls").select("id, title, occurred_at, attendees, host, url, summary, notes, client_id, clients(name)").gte("occurred_at", from).lte("occurred_at", to).order("occurred_at").limit(60),
    admin.from("agent_asks").select("id, title, due_on, status, client_id, created_at, urgent, draft, clients(name)").eq("owner_id", me.id).in("status", ["open", "staged"]).order("due_on", { ascending: true, nullsFirst: false }).limit(80),
    import("@/lib/owed-replies").then((m) => m.loadOwedReplies(admin, { id: me.id, role: me.role, isExec: me.is_exec, isLead: me.is_lead }, false)).catch(() => null),
    import("@/lib/message-promises").then((m) => m.loadSaidPromises(admin, { id: me.id, role: me.role, isExec: me.is_exec, isLead: me.is_lead })).catch(() => null),
    import("@/lib/promise-routing").then((m) => m.loadMyCallPromises(admin, me.id)).catch(() => null),
    admin.from("context_items").select("source, occurred_at, author, title, body, url, clients(name)").in("source", ["gmail", "slack_external"]).gte("occurred_at", from).lte("occurred_at", to).order("occurred_at", { ascending: false }).limit(60),
    admin.from("client_assignments").select("client_id").eq("profile_id", me.id),
  ]);
  if (meetings == null) failed.push("Google Calendar (not connected or no calendar access)");
  const mine = new Set((seats ?? []).map((s) => s.client_id as string));
  const email = me.email.toLowerCase();
  const myCalls = (calls ?? []).filter((c) => me.is_exec || String(c.host ?? "").toLowerCase() === email || ((c.attendees as string[] | null) ?? []).some((a) => String(a).toLowerCase() === email) || (c.client_id && mine.has(c.client_id as string)));
  return {
    failed,
    meetings: meetings ?? [],
    upcoming: upcoming ?? [],
    calls: myCalls.map((c) => ({ title: c.title as string, at: c.occurred_at as string, client: (c.clients as unknown as { name: string } | null)?.name ?? null, link: (c.url as string | null) ?? null, summary: String(c.summary ?? c.notes ?? "").replace(/\s+/g, " ").slice(0, 1400) })),
    items: (items ?? []).map((i) => ({ id: i.id as string, title: i.title as string, due: (i.due_on as string | null) ?? null, client: (i.clients as unknown as { name: string } | null)?.name ?? null, staged: i.status === "staged", draft: Boolean(i.draft), urgent: Boolean(i.urgent) })),
    owed: (owedMod ?? []).filter((o) => o.targetId === me.id).map((o) => ({ from: o.from, gist: o.gist, since: o.askedAt, client: o.client, link: o.url })),
    said: (saidMod ?? []).filter((p) => p.ownerId === me.id).map((p) => ({ what: p.what, due: p.dueAt, client: p.client, link: p.url })),
    callPromises: (callsMod ?? []).map((c) => ({ what: c.what, due: c.dueAt, client: c.client })),
    comms: (comms ?? []).map((c) => ({ at: c.occurred_at as string, source: c.source as string, author: (c.author as string | null) ?? null, client: (c.clients as unknown as { name: string } | null)?.name ?? null, text: `${c.title ? `${c.title}: ` : ""}${String(c.body ?? "")}`.replace(/\s+/g, " ").slice(0, 300), link: (c.url as string | null) ?? null })),
  };
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One or two sentences; the FIRST sentence is the single most important thing for them to do" },
    urgent: { type: "boolean", description: "True only for something that can't wait: a client giving notice or churning, an angry/escalating client, a billing dispute, a launch broken or blocked today, a hot prospect asking for something today" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          lines: { type: "array", items: { type: "object", properties: { text: { type: "string" }, href: { type: ["string", "null"] }, tag: { type: ["string", "null"], enum: ["certain", "likely", "guessing", null] } }, required: ["text", "href", "tag"], additionalProperties: false } },
        },
        required: ["title", "lines"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "urgent", "sections"],
  additionalProperties: false,
};

const RULES = `Rules: never state what Kaizen charges a client (fees, retainers, invoices); ad spend and budgets are fine. Revenue-first: protect revenue at risk, then grow revenue, then decisions only they can make. Tag claims you inferred [likely] or [guessing] (tag field), facts from the data [certain]. One line each, plain words, with the link (href) when the data has one. Never invent a meeting, number, quote or link. Leave a section out when it has nothing. Something already done or already being handled by a teammate is not an open item: say it's handled or leave it out; never chase it.`;

async function compose(me: Person, kind: RoutineKind, brief: string, data: unknown, failed: string[]): Promise<RoutineReport> {
  const out = await askJson<RoutineReport>({
    agent: "calls",
    label: `routine ${kind}`,
    override: { model: "sonnet", effort: "medium" },
    maxTokens: 5000,
    system: `You write ${routineOf(kind)?.label ?? "a recap"} for a ${me.role.replace(/_/g, " ")} at Kaizen, a paid ads, creative, email and social agency, inside Kaizen OS. ${brief}\n${RULES}`,
    schema: REPORT_SCHEMA,
    prompt: `Today (New York): ${nyClock(new Date()).date}.\n${failed.length ? `Sources that couldn't be read (name them in one line at the end): ${failed.join("; ")}\n` : ""}\n<data>\n${JSON.stringify(data).slice(0, 60_000)}\n</data>`,
  });
  return { headline: out.headline, urgent: Boolean(out.urgent), sections: (out.sections ?? []).filter((s: RecapSection) => s.lines?.length), failedSources: failed };
}

const iso = (ms: number) => new Date(ms).toISOString();
/** The New York midnight of a date as an instant (approximate within the DST hour, fine for windows) */
const nyMidnight = (date: string) => new Date(`${date}T05:00:00Z`).toISOString();
const prevBusinessDay = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
};

// ─── The recaps ─────────────────────────────────────────────────────────────

async function morning(admin: Admin, me: Person): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const from = new Date(Date.parse(nyMidnight(prevBusinessDay(today))) + 18 * 3_600_000).toISOString(); // the previous business day's 6pm
  const g = await gather(admin, me, from, iso(Date.now()), { from: iso(Date.now()), to: nyMidnight(new Date(Date.parse(today) + DAY).toISOString().slice(0, 10)) });
  return compose(
    me,
    "morning",
    `The window is since the previous business day's 6pm. Sections in this order: "Top 3" (revenue-first; start with the single most important thing), "Overnight" (calls, client/prospect/team emails, client Slack; one line + link each), "Still open from yesterday" (their items due yesterday or overdue; client messages with no reply for over a business day; drafts still waiting for them to send; promises past their date), "Today" (meetings on their calendar today with one line of prep for client and sales calls; their items due today).`,
    g,
    g.failed,
  );
}

async function afternoon(admin: Admin, me: Person): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const g = await gather(admin, me, nyMidnight(today), iso(Date.now()), { from: iso(Date.now()), to: nyMidnight(new Date(Date.parse(today) + DAY).toISOString().slice(0, 10)) });
  return compose(
    me,
    "afternoon",
    `The window is today so far. Lead with the single most important takeaway. Sections: "Meetings today" (every meeting that has started: time and title, type, 2-3 lines, decisions, numbers, risk, Kaizen action items with owner and due, what the other side owes, the notes link; meetings that ended in the last ~20 minutes may still be processing: say so), "Coverage gaps" (meetings with no notes), "Your action items from today", "Notable comms today", "Still to come today" (remaining meetings with one line of prep).`,
    g,
    g.failed,
  );
}

async function eod(admin: Admin, me: Person): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const three = new Date(Date.parse(nyMidnight(today)) + 15 * 3_600_000 - 15 * 60_000).toISOString();
  const tomorrow = new Date(Date.parse(today) + DAY).toISOString().slice(0, 10);
  const g = await gather(admin, me, three, iso(Date.now()), { from: nyMidnight(tomorrow), to: nyMidnight(new Date(Date.parse(tomorrow) + DAY).toISOString().slice(0, 10)) });
  return compose(
    me,
    "eod",
    `The window is since 3pm, plus the close-out of the whole day. Lead with the single most important open item going into tomorrow. Sections: "Top priority", "Meetings since 3pm" (summary, decisions, numbers, risk, action items with owner and due, notes link; no notes go under "Coverage gaps"), "Comms" (key client/prospect/team messages since 3pm, one line + link), "Still open today" (what they committed to or were asked today that isn't done: items due today, replies owed, drafts waiting to send, teammates blocked on them; mark each "do tonight" or "first thing tomorrow"), "Tomorrow" (meetings needing prep, one line each).`,
    g,
    g.failed,
  );
}

async function weekRecap(admin: Admin, me: Person): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const monday = new Date(Date.parse(today) - ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
  const nextTue = new Date(Date.parse(monday) + 9 * DAY).toISOString().slice(0, 10);
  const g = await gather(admin, me, nyMidnight(monday), iso(Date.now()), { from: iso(Date.now()), to: nyMidnight(nextTue) });
  const [{ data: created }, { data: closed }, { data: prospects }] = await Promise.all([
    admin.from("agent_asks").select("id", { count: "exact", head: true }).eq("owner_id", me.id).gte("created_at", nyMidnight(monday)),
    admin.from("agent_asks").select("id", { count: "exact", head: true }).eq("owner_id", me.id).eq("status", "done").gte("done_at", nyMidnight(monday)),
    admin.from("prospects").select("name, status, notes, updated_at").not("status", "in", "(won,lost)").order("updated_at", { ascending: false }).limit(25),
  ]);
  return compose(
    me,
    "week_recap",
    `Read-only. The week is Monday to now. First line (headline): the single most important thing before Monday and why. Sections: "Ranked actions" (one list of every open action ranked: Tier 1 revenue at risk (churn signals, angry clients, deliverables overdue or due within 48h, billing disputes); Tier 2 revenue growth (hot sales follow-ups, proposals owed, upsell signals, onboarding blockers delaying billing); Tier 3 their overdue or due-soon commitments and decisions only they can make; Tier 4 team delivery at risk; Tier 5 internal ops; each with client, owner, due and why it ranks there), "Waiting on others" (by client, oldest first), "Week in numbers" (calls, new sales records, items created vs completed), "Risks to watch next week" (at most 5), "Calendar heads-up" (Monday and Tuesday meetings that need prep).`,
    { ...g, itemsCreatedThisWeek: created, itemsCompletedThisWeek: closed, salesPipeline: prospects ?? [] },
    g.failed,
  );
}

async function weekAhead(admin: Admin, me: Person): Promise<RoutineReport> {
  const today = nyClock(new Date()).date;
  const friday = new Date(Date.parse(today) - 2 * DAY).toISOString().slice(0, 10);
  const monday = new Date(Date.parse(today) + DAY).toISOString().slice(0, 10);
  const saturday = new Date(Date.parse(monday) + 5 * DAY).toISOString().slice(0, 10);
  const g = await gather(admin, me, new Date(Date.parse(nyMidnight(friday)) + 16.5 * 3_600_000).toISOString(), iso(Date.now()), { from: nyMidnight(monday), to: nyMidnight(saturday) });
  return compose(
    me,
    "week_ahead",
    `Read-only, Sunday evening. Headline: the most important thing before Monday's first meeting. Sections: "Before Monday 9am" (a checklist), "Monday meetings" (each Monday meeting: for client meetings the goal in one line, what we owe and whether it's done, what they owe, the top risk with numbers, 2-3 talking points, anything to do or send before; for sales/discovery calls what's known and 3 discovery questions; for internal meetings what they owe that team; flag meetings with no agenda, no video link, or conflicts), "Over the weekend" (messages that will look ignored by Monday 10am), "This week" (key meetings by day, deadlines including overdue, launches, overbooked days or days with no focus block), "Top 3" for the week, revenue-first.`,
    g,
    g.failed,
  );
}

const RUNNERS: Record<RoutineKind, (admin: Admin, me: Person) => Promise<RoutineReport>> = {
  morning,
  afternoon,
  eod,
  week_recap: weekRecap,
  week_ahead: weekAhead,
  debrief: (admin, me) => import("@/lib/routine-sweeps").then((m) => m.debrief(admin, me)),
  delegation: (admin, me) => import("@/lib/routine-sweeps").then((m) => m.delegation(admin, me)),
  nightly: (admin, me) => import("@/lib/routine-agent").then((m) => m.nightly(admin, me)),
  clean_sweep: (admin, me) => import("@/lib/routine-agent").then((m) => m.cleanSweep(admin, me)),
  // Run now: the calls starting in the next hour or so, prepped (each one lands as its own brief)
  call_prep: async (admin, me) => {
    const n = await (await import("@/lib/routine-callprep")).prepUpcomingCalls(admin, me);
    return { headline: n ? `${n} call${n === 1 ? "" : "s"} prepped: the briefs are below.` : "No client or sales calls in the next hour and a half to prep.", sections: [] };
  },
};

/** A person's routines, every kind, with the defaults filled in for the ones they haven't set */
export async function routinesOf(db: SupabaseClient, profileId: string) {
  const { data } = await db.from("routines").select("kind, enabled, times, days").eq("profile_id", profileId);
  const set = new Map((data ?? []).map((r) => [r.kind as string, r]));
  return ROUTINES.map((d) => {
    const r = set.get(d.kind);
    return { kind: d.kind, label: d.label, about: d.about, multi: Boolean(d.multi), enabled: Boolean(r?.enabled), times: ((r?.times as string[] | undefined) ?? d.times).slice(), days: ((r?.days as Days | undefined) ?? d.days) as Days };
  });
}
