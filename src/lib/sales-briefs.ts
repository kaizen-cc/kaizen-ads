import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { cleanSite, forwardStatus, nameKey, siteHost, type ProspectStatus } from "@/lib/sales-core";
import {
  BRIEF_LEAD_HOURS,
  OWN_DOMAIN,
  bookingAnswers,
  briefDue,
  briefTitle,
  businessOf,
  callBriefText,
  classifyEvent,
  cleanCallBrief,
  eventHash,
  eventKey,
  externalsOf,
  plainDescription,
  runnerOf,
  siteOf,
  whenLabel,
  type BriefEvent,
  type CallBrief,
  type ClientRef,
} from "@/lib/sales-briefs-core";

// Sales call briefs (owner, Nov 24 2026). Every half hour: read the team's Google Calendars (read only, the Workspace's
// domain-wide delegation, as the integration check before client calls does) for the next four days; every meeting
// with people outside Kaizen who aren't a current client is a sales call (src/lib/sales-briefs-core.ts). One row per
// meeting (its iCalUID), whoever's calendars it's on. 18 hours before it (or as soon as it's seen, when booked later)
// the Sales agent researches the business (the prospect's research, refreshed when stale), reads the booking's
// answers and any prior contact (Gmail with the guests, the prospect's notes and earlier briefs), and writes the brief
// for whoever runs the call. Delivered as a Needs me item (src/lib/today.ts) with a bell notice that rings their
// assistant; linked from the prospect (made if new, stage "call booked"). An event that changes is briefed again; one
// cancelled (gone from a calendar that was read) is marked cancelled and its item and notice go away; once the call
// is over the item turns into a short debrief prompt (the call review on the prospect). Nothing goes to Drive.

type Admin = SupabaseClient;
const HORIZON_HOURS = 96;
const STALE_RESEARCH_DAYS = 21;

export type BriefRow = {
  id: string;
  event_key: string;
  event_id: string | null;
  calendar_email: string | null;
  prospect_id: string | null;
  owner_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string | null;
  organizer: string | null;
  attendees: { email: string; name: string | null }[];
  description: string | null;
  html_link: string | null;
  event_hash: string | null;
  status: "pending" | "ready" | "cancelled" | "done" | "failed" | "stopped";
  brief: (CallBrief & { business?: string; site?: string | null }) | null;
  error: string | null;
  made_at: string | null;
  notified_at: string | null;
};
export const BRIEF_COLS = "id, event_key, event_id, calendar_email, prospect_id, owner_id, title, starts_at, ends_at, organizer, attendees, description, html_link, event_hash, status, brief, error, made_at, notified_at";

/** The current clients as the classifier needs them: contacts' emails, company domains (contacts and website) */
export async function clientRefs(admin: Admin): Promise<ClientRef[]> {
  const [{ data: clients }, { data: contacts }] = await Promise.all([
    admin.from("clients").select("id, name, website").is("archived_at", null).limit(2000),
    admin.from("contact_clients").select("client_id, contacts(email)").is("removed_at", null).limit(8000),
  ]);
  const emails = new Map<string, string[]>();
  for (const r of contacts ?? []) {
    const e = String((r as unknown as { contacts: { email: string | null } | null }).contacts?.email ?? "").toLowerCase();
    if (e) emails.set(r.client_id as string, [...(emails.get(r.client_id as string) ?? []), e]);
  }
  return ((clients ?? []) as { id: string; name: string; website: string | null }[]).map((c) => {
    const es = emails.get(c.id) ?? [];
    const domains = new Set(es.map((e) => e.split("@")[1]).filter((d): d is string => Boolean(d) && !/^(gmail|googlemail|yahoo|hotmail|outlook|icloud|aol|live|msn|me|proton(mail)?)\./.test(`${d}.`)));
    const site = siteHost(c.website);
    if (site) domains.add(site);
    return { id: c.id, name: c.name, emails: es, domains: [...domains] };
  });
}

type Team = { id: string; email: string; name: string; sells: boolean; exec?: boolean }[];

async function teamOf(admin: Admin): Promise<Team> {
  const { data } = await admin.from("profiles").select("id, full_name, email, is_exec, is_lead, is_active").eq("is_active", true).not("joined_at", "is", null);
  return ((data ?? []) as { id: string; full_name: string; email: string | null; is_exec: boolean | null; is_lead: boolean | null }[])
    .filter((p) => p.email && p.email.toLowerCase().endsWith(`@${OWN_DOMAIN}`))
    .map((p) => ({ id: p.id, email: p.email!.toLowerCase(), name: p.full_name, sells: Boolean(p.is_exec || p.is_lead), exec: Boolean(p.is_exec) }));
}

export type SeenCall = { ev: BriefEvent; foundOn: string[]; why: string };

/** Every upcoming sales call on the team's calendars, by meeting; and which calendars could be read */
export async function scanCalendars(admin: Admin, now = new Date(), hours = HORIZON_HOURS): Promise<{ calls: Map<string, SeenCall>; read: Set<string>; failed: string[]; team: Team; clients: ClientRef[] }> {
  const [team, clients] = await Promise.all([teamOf(admin), clientRefs(admin)]);
  const { googleCalendarToken, google, googleConfigured } = await import("@/lib/context/google");
  const calls = new Map<string, SeenCall>();
  const read = new Set<string>();
  const failed: string[] = [];
  if (!googleConfigured()) return { calls, read, failed: ["Google isn't connected"], team, clients };
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + hours * 3_600_000).toISOString();
  await Promise.all(
    team.map(async (p) => {
      try {
        const token = await googleCalendarToken(p.email);
        const res = await google<{ items?: BriefEvent[] }>(token, "https://www.googleapis.com/calendar/v3/calendars/primary/events", { timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
        read.add(p.email);
        for (const ev of res.items ?? []) {
          const c = classifyEvent(ev, clients);
          if (c.kind !== "sales") continue;
          const key = eventKey(ev);
          if (!key) continue;
          const cur = calls.get(key);
          if (cur) {
            if (!cur.foundOn.includes(p.email)) cur.foundOn.push(p.email);
            // The organizer's copy carries the booking's description most completely
            if (ev.organizer?.self && !cur.ev.organizer?.self) cur.ev = ev;
          } else calls.set(key, { ev, foundOn: [p.email], why: c.why });
        }
      } catch (e) {
        failed.push(`${p.name}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
      }
    }),
  );
  return { calls, read, failed, team, clients };
}

/** The prospect a call is with: found by its site or name, else made (stage "call booked"); an open one moves to it */
async function prospectFor(admin: Admin, row: BriefRow, business: string, site: string | null, ownerId: string | null): Promise<{ id: string; name: string; brief: unknown; researched_at: string | null; status: ProspectStatus; archived_at?: string | null; archive_reason?: string | null; archive_note?: string | null }> {
  type Found = { id: string; name: string; brief: unknown; researched_at: string | null; status: ProspectStatus; archived_at?: string | null; archive_reason?: string | null; archive_note?: string | null };
  const host = siteHost(site);
  let found: Found | null = null;
  if (host) found = ((await admin.from("prospects").select("id, name, brief, researched_at, status, archived_at, archive_reason, archive_note").ilike("website", `%${host}%`).limit(1).maybeSingle()).data as Found | null) ?? null;
  if (!found) {
    const { data } = await admin.from("prospects").select("id, name, brief, researched_at, status, archived_at, archive_reason, archive_note").order("updated_at", { ascending: false }).limit(1000);
    const k = nameKey(business);
    found = ((data ?? []) as Found[]).find((p) => k.length >= 4 && nameKey(p.name) === k) ?? null;
  }
  if (row.prospect_id && !found) found = ((await admin.from("prospects").select("id, name, brief, researched_at, status, archived_at, archive_reason, archive_note").eq("id", row.prospect_id).maybeSingle()).data as Found | null) ?? null;
  if (found) {
    if (found.archived_at) return found;
    const next = forwardStatus(found.status, "call_booked");
    if (next !== found.status) await admin.from("prospects").update({ status: next, updated_at: new Date().toISOString() }).eq("id", found.id);
    return { ...found, status: next };
  }
  const guest = row.attendees[0];
  const { data, error } = await admin
    .from("prospects")
    .insert({ name: business.slice(0, 160), website: cleanSite(site), status: "call_booked", owner_id: ownerId, created_by: ownerId, source: `calendar: ${row.title.slice(0, 120)}`, contacts: guest ? [{ name: guest.name ?? guest.email, role: "booked the call", where: guest.email }] : [] })
    .select("id, name, brief, researched_at, status, archived_at, archive_reason, archive_note")
    .single();
  if (error || !data) throw new Error(error?.message ?? "The prospect couldn't be saved.");
  return data as { id: string; name: string; brief: unknown; researched_at: string | null; status: ProspectStatus };
}

/** Earlier contact with the guests: the runner's Gmail threads with them (newest first), the prospect's own notes, earlier briefs */
async function priorContact(admin: Admin, row: BriefRow, prospectId: string, runnerEmail: string | null): Promise<string> {
  const lines: string[] = [];
  const emails = row.attendees.map((a) => a.email).slice(0, 4);
  if (runnerEmail && emails.length) {
    try {
      const { gmailToken, google } = await import("@/lib/context/google");
      const token = await gmailToken(runnerEmail);
      const q = `(${emails.map((e) => `from:${e} OR to:${e}`).join(" OR ")}) newer_than:2y`;
      const list = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q, maxResults: "6" });
      for (const m of list.messages ?? []) {
        const msg = await google<{ snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { format: "metadata", metadataHeaders: "Subject" });
        const subject = msg.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
        lines.push(`Email ${new Date(Number(msg.internalDate ?? 0)).toISOString().slice(0, 10)}: ${subject} — ${String(msg.snippet ?? "").slice(0, 240)}`);
      }
    } catch {
      lines.push("(Their Gmail couldn't be read for earlier emails.)");
    }
  }
  const [{ data: notes }, { data: briefs }, { data: p }] = await Promise.all([
    admin.from("prospect_notes").select("kind, title, created_at").eq("prospect_id", prospectId).neq("kind", "research").order("created_at", { ascending: false }).limit(5),
    admin.from("sales_call_briefs").select("title, starts_at, status").eq("prospect_id", prospectId).neq("id", row.id).order("starts_at", { ascending: false }).limit(3),
    admin.from("prospects").select("status, notes, source").eq("id", prospectId).maybeSingle(),
  ]);
  for (const n of notes ?? []) lines.push(`Saved on the prospect ${String(n.created_at).slice(0, 10)}: ${n.kind} ${n.title ?? ""}`);
  for (const b of briefs ?? []) lines.push(`Earlier call ${String(b.starts_at).slice(0, 10)}: ${b.title} (${b.status})`);
  if (p?.notes) lines.push(`Team notes on the prospect: ${String(p.notes).slice(0, 600)}`);
  if (p?.status) lines.push(`Pipeline stage: ${p.status}${p.source ? ` (came from ${p.source})` : ""}`);
  return lines.join("\n") || "No earlier contact found.";
}

const STR = { type: "string" };
const STRS = { type: "array", items: STR };
const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["who", "they_want", "prior_contact", "fit", "services", "objections", "discovery_questions", "proof", "next_step", "watch_outs", "pitch_ideas"],
  properties: {
    who: STR,
    they_want: STR,
    prior_contact: STR,
    fit: { type: "object", additionalProperties: false, required: ["score", "why"], properties: { score: { type: "integer" }, why: STR } },
    services: { type: "array", items: { type: "object", additionalProperties: false, required: ["service", "why", "price"], properties: { service: STR, why: STR, price: STR } } },
    objections: { type: "array", items: { type: "object", additionalProperties: false, required: ["objection", "answer"], properties: { objection: STR, answer: STR } } },
    discovery_questions: STRS,
    proof: STRS,
    next_step: STR,
    watch_outs: STRS,
    pitch_ideas: STRS,
  },
};

/** Writes one call's brief (research first when the prospect's is missing or stale) and delivers it */
export async function makeBrief(admin: Admin, row: BriefRow, team: Team, now = new Date()): Promise<{ ok: true; business: string; prospectId: string } | { ok: false; error: string }> {
  const ev: BriefEvent = { id: row.event_id ?? row.event_key, summary: row.title, description: row.description, attendees: row.attendees.map((a) => ({ email: a.email, displayName: a.name })), organizer: row.organizer ? { email: row.organizer } : null, start: { dateTime: row.starts_at } };
  const business = businessOf(ev);
  const site = siteOf(ev);
  const runner = team.find((p) => p.id === row.owner_id) ?? null;
  const prospect = await prospectFor(admin, row, business, site, row.owner_id);
  // Research the business when there's none yet or it's old (a minute or two); the brief still goes out without it
  const stale = !prospect.researched_at || Date.now() - Date.parse(prospect.researched_at) > STALE_RESEARCH_DAYS * 86_400_000;
  let researchText = "";
  if (stale && row.owner_id) {
    const { researchProspect } = await import("@/lib/sales-agent");
    const r = await researchProspect(admin, admin, { id: row.owner_id }, { prospectId: prospect.id, name: prospect.name, website: site, question: `Before a sales call: ${row.title}` }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    researchText = r.ok ? r.text : `(Research didn't finish: ${r.error})`;
  } else if (prospect.brief) {
    const { briefText, cleanBrief } = await import("@/lib/sales-core");
    researchText = briefText(prospect.name, cleanBrief(prospect.brief));
  }
  const booking = bookingAnswers(row.description);
  // Dedupe against reality: someone already preparing this call (an item about it) is said in the brief, never doubled
  const { loadReality } = await import("@/lib/reality-check");
  const { decide } = await import("@/lib/reality-check-core");
  const pool = await loadReality(admin, { clientIds: [null], ownerIds: [row.owner_id] }).catch(() => []);
  const real = decide({ title: `Prepare for the sales call with ${business}`, clientId: null, ownerId: row.owner_id }, pool);
  const inMotion = real.state === "in_motion" && real.match ? `${real.match.title}${real.match.owner ? ` (${real.match.owner})` : ""}` : null;
  const [{ rateCardText, clientProofText }, prior] = await Promise.all([import("@/lib/sales-agent"), priorContact(admin, row, prospect.id, runner?.email ?? null)]);
  const [rates, proof] = await Promise.all([rateCardText(admin), clientProofText(admin, `${business} ${researchText.slice(0, 1200)}`)]);
  const { PEOPLE_RULE, scrubPeopleMatters } = await import("@/lib/people-matters");
  const raw = await askJson<Record<string, unknown>>({
    agent: "sales_research",
    label: "sales call brief",
    schema: BRIEF_SCHEMA,
    maxTokens: 6000,
    system: `You are Kaizen's Sales agent, preparing the Kaizen person who runs a sales call ${whenLabel(row.starts_at, now)}. Write a brief they can read in two minutes.
- who: who the business is and who's on the call (name, role if known), in two sentences.
- they_want: what they said they want, from the booking answers and earlier contact, in their words where possible; "not said yet" when unknown.
- prior_contact: earlier emails, calls or notes in one or two sentences; "none found" when there's nothing.
- fit: score 0-100 and why (real offer, ticket size or margin for paid media, demand, gaps Kaizen fixes, ability to pay).
- services: only from the rate card, with its price as written; why each fits what they want.
- objections: the 3-4 most likely, each with a short honest answer.
- discovery_questions: 3-5, specific to this business and what they said.
- proof: from Kaizen's similar clients, by industry and result, never by client name. Empty if none are similar.
- next_step: the offer to make at the end of the call (an audit, a proposal with named services, a follow-up).
- watch_outs: anything to be careful about (a gap in what's known, a red flag in the answers, budget below the minimum).
- pitch_ideas: 2-4 angles to open with.
Only what the material supports; never invent a number, review or fact. Kaizen's roles, never team members' names. ${PEOPLE_RULE}`,
    prompt: `<the_call title="${row.title.replace(/"/g, "'")}" when="${row.starts_at}">\nGuests: ${row.attendees.map((a) => `${a.name ?? ""} <${a.email}>`).join(", ") || "unknown"}\n</the_call>\n\n<booking_and_description>\n${plainDescription(row.description).slice(0, 6000) || "(no description)"}\n</booking_and_description>\n\n<research>\n${researchText.slice(0, 14_000) || "(not researched)"}\n</research>\n\n<prior_contact>\n${prior.slice(0, 4000)}\n</prior_contact>\n\n<rate_card>\n${rates}\n</rate_card>\n\n<kaizen_clients note="internal proof">\n${proof}\n</kaizen_clients>`,
  });
  const scrub = (v: unknown): unknown => (typeof v === "string" ? scrubPeopleMatters(v) : Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v);
  // Booked with a prospect that was archived: the brief still goes out, flagged with why it was archived
  const { archiveText } = await import("@/lib/sales-core");
  const archived = prospect.archived_at ? `previously archived ${prospect.archived_at.slice(0, 10)}: ${archiveText(prospect.archive_reason, prospect.archive_note)}` : null;
  const brief = { ...cleanCallBrief(scrub(raw), { booking, in_motion: inMotion, archived }), business, site };
  const nowIso = new Date().toISOString();
  await admin.from("sales_call_briefs").update({ brief, status: "ready", prospect_id: prospect.id, made_at: nowIso, error: null, updated_at: nowIso }).eq("id", row.id);
  await admin.from("prospect_notes").insert({ prospect_id: prospect.id, kind: "note", title: `Call brief: ${row.title.slice(0, 100)}`, body: { brief_id: row.id, starts_at: row.starts_at, text: callBriefText(business, whenLabel(row.starts_at, now), brief) }, created_by: row.owner_id });
  if (row.owner_id && !row.notified_at) {
    await admin.from("notifications").upsert(
      { profile_id: row.owner_id, kind: "sales_brief", key: `sales-brief:${row.id}`, title: briefTitle(business, row.starts_at, now), body: brief.they_want ? `They want: ${brief.they_want}`.slice(0, 400) : `Fit ${brief.fit.score ?? "?"}/100. ${brief.next_step}`.slice(0, 400), href: (await import("@/lib/sales-core")).briefHref(row.id, runner?.exec), priority: "normal" },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
    await admin.from("sales_call_briefs").update({ notified_at: nowIso }).eq("id", row.id);
  }
  return { ok: true, business, prospectId: prospect.id };
}

export type PlannedBrief = { title: string; business: string; when: string; startsAt: string; runner: string | null; due: boolean; status: string; why: string };

/**
 * The run: read the calendars, keep one row per upcoming sales call (new, changed, cancelled), write the briefs that
 * are due (a few a run), and close calls that are over. dryRun: read only, returns what it would brief.
 */
export async function runSalesBriefs(admin: Admin, opts: { now?: Date; max?: number; budgetMs?: number; dryRun?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 600_000;
  const { calls, read, failed, team } = await scanCalendars(admin, now);
  const keys = [...calls.keys()];
  const { data: existing } = keys.length ? await admin.from("sales_call_briefs").select(BRIEF_COLS).in("event_key", keys) : { data: [] };
  const have = new Map(((existing ?? []) as BriefRow[]).map((r) => [r.event_key, r]));
  const planned: PlannedBrief[] = [];
  let added = 0;
  let changed = 0;
  for (const [key, c] of calls) {
    const ev = c.ev;
    const start = ev.start?.dateTime ?? "";
    const owner = runnerOf(ev, team, c.foundOn[0]);
    const row = { event_key: key, event_id: ev.id, calendar_email: c.foundOn[0], owner_id: owner, title: String(ev.summary ?? "Meeting").slice(0, 300), starts_at: start, ends_at: ev.end?.dateTime ?? null, organizer: ev.organizer?.email ?? null, attendees: externalsOf(ev), description: plainDescription(ev.description).slice(0, 12_000) || null, html_link: ev.htmlLink ?? null, event_hash: eventHash(ev) };
    const cur = have.get(key);
    planned.push({ title: row.title, business: businessOf(ev), when: whenLabel(start, now), startsAt: start, runner: team.find((p) => p.id === owner)?.name ?? null, due: briefDue(start, now), status: cur?.status ?? "new", why: c.why });
    if (opts.dryRun) continue;
    if (!cur) {
      const { error } = await admin.from("sales_call_briefs").insert({ ...row, status: "pending" });
      if (!error) added++;
    } else if (cur.status !== "stopped" && (cur.event_hash !== row.event_hash || cur.status === "cancelled")) {
      // Changed (time, guests, answers) or back after a cancel: briefed again; the item stays until the new one's ready
      await admin.from("sales_call_briefs").update({ ...row, status: "pending", notified_at: cur.owner_id === owner ? cur.notified_at : null, updated_at: new Date().toISOString() }).eq("id", cur.id);
      changed++;
    }
  }
  if (opts.dryRun) return { dryRun: true, calendars: read.size, unreadable: failed.length, calls: planned.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };

  // Cancelled: an upcoming call no longer on the calendar it was found on (that calendar was read this run)
  const horizon = new Date(now.getTime() + HORIZON_HOURS * 3_600_000).toISOString();
  const { data: upcoming } = await admin.from("sales_call_briefs").select("id, event_key, calendar_email, owner_id").in("status", ["pending", "ready", "failed"]).gt("starts_at", now.toISOString()).lt("starts_at", horizon);
  let cancelled = 0;
  for (const r of upcoming ?? []) {
    if (calls.has(r.event_key as string) || !read.has(String(r.calendar_email ?? "").toLowerCase())) continue;
    await admin.from("sales_call_briefs").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", r.id);
    if (r.owner_id) await admin.from("notifications").update({ cleared_at: new Date().toISOString(), read_at: new Date().toISOString() }).eq("profile_id", r.owner_id).eq("key", `sales-brief:${r.id}`);
    cancelled++;
  }

  // Over: two hours after it started the brief is done (the item turns into the debrief prompt for two days)
  const { count: over } = await admin.from("sales_call_briefs").update({ status: "done", updated_at: new Date().toISOString() }, { count: "exact" }).eq("status", "ready").lt("starts_at", new Date(now.getTime() - 2 * 3_600_000).toISOString());

  // Writing briefs can be paused (app_settings.sales_briefs.write = false): the calls are still found and kept, nothing
  // is written or delivered until it's switched back on
  if (!(await briefsWriting(admin))) return { calendars: read.size, unreadable: failed.length, failed: failed.slice(0, 5), salesCalls: calls.size, added, changed, cancelled, over: over ?? 0, made: [], errors: [], paused: true, calls: planned.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };

  // Due now: written in order of the call, a few a run (each is a minute or two)
  const { data: pending } = await admin.from("sales_call_briefs").select(BRIEF_COLS).eq("status", "pending").gt("starts_at", now.toISOString()).lte("starts_at", new Date(now.getTime() + BRIEF_LEAD_HOURS * 3_600_000).toISOString()).order("starts_at").limit(opts.max ?? 3);
  const made: string[] = [];
  const errors: string[] = [];
  for (const r of (pending ?? []) as BriefRow[]) {
    if (Date.now() - started > budget) break;
    const out = await makeBrief(admin, r, team, now).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (out.ok) made.push(out.business);
    else {
      errors.push(`${r.title}: ${out.error}`);
      await admin.from("sales_call_briefs").update({ status: "failed", error: out.error.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
  return { calendars: read.size, unreadable: failed.length, failed: failed.slice(0, 5), salesCalls: calls.size, added, changed, cancelled, over: over ?? 0, made, errors };
}

/** Whether briefs are being written (off by app_settings.sales_briefs = { write: false }) */
export async function briefsWriting(admin: Admin): Promise<boolean> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "sales_briefs").maybeSingle();
  return (data?.value as { write?: boolean } | null)?.write !== false;
}

/** One brief the person may read (theirs, or any for an exec or lead), through their own session */
export async function getBrief(db: SupabaseClient, id: string): Promise<BriefRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await db.from("sales_call_briefs").select(BRIEF_COLS).eq("id", id).maybeSingle();
  return (data as BriefRow | null) ?? null;
}
