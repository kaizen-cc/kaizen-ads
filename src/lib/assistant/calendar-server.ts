import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallSlots } from "@/lib/agent-call/core";
import { serviceAccountClientId } from "./platform-drafts-core";
import { needsConnection, type NeedsConnection } from "@/lib/personal-connections-core";
import { busyOf, calendarScopeMissing, DEFAULT_MINUTES, DEFAULT_TZ, defaultWindow, freeStarts, nextBatch, overlaps, rfc3339, sameDomain, slotLabel, slotView, zonedTime, type Person } from "./scheduling-core";

// Internal calls on Google Calendar, the server side shared by the assistant's tools and the slot cards: who the
// teammates are, everyone's free/busy in their own working hours, the times offered (kept as a proposal so More times
// shows the next batch), and one booking path for a tap on a card and a spoken yes alike, whichever comes first (the
// other then sees it booked). Teammates only. Every booking is logged (assistant_meetings).

const CAL = "https://www.googleapis.com/calendar/v3";
export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";
export const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export type Me = { id: string; email: string; fullName: string };
export type Who = { id: string; name: string; email: string };
export type Fail = { ok: false; error: string; for_the_admin?: string; options?: string[]; needs_connection?: NeedsConnection["needs_connection"]; say?: string };

/** Google's refusal of a calendar scope, as the admin's one step (the client ID from the key, never the key) */
export function scopeFail(scope: string, what: string): Fail {
  const id = serviceAccountClientId(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const n = needsConnection("calendar", "admin");
  return {
    ok: false,
    needs_connection: n.needs_connection,
    say: n.say,
    error: `${what} needs one Admin console setting first, so nothing was booked.`,
    for_the_admin: `Add ${scope} to the service account's domain-wide delegation${id ? ` (client ID ${id})` : ""}: admin.google.com, Security > Access and data control > API controls > Manage domain-wide delegation.`,
  };
}

export async function gcal<T>(token: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${CAL}${path}${qs ? `?${qs}` : ""}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (!res.ok) throw new Error(`Google ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The teammates named ("Mel", "the head of email"), each with their email; teammates on Kaizen's domain only */
export async function teammatesNamed(admin: SupabaseClient, me: Me, names: unknown): Promise<{ ok: true; people: Who[] } | Fail> {
  const list = (Array.isArray(names) ? names : [names]).map((n) => clip(n, 80)).filter(Boolean).slice(0, 8);
  if (!list.length) return { ok: false, error: "Who's the call with? Ask in a few words." };
  const { recipientFor } = await import("./routing-server");
  const ids: string[] = [];
  for (const to of list) {
    const r = await recipientFor(admin, { to, client: null, agentRole: null, exclude: me.id });
    if (!r.ok) return { ok: false, error: r.note, options: r.options };
    if (!ids.includes(r.to.id)) ids.push(r.to.id);
  }
  return teammatesById(admin, me, ids);
}

export async function teammatesById(admin: SupabaseClient, me: Me, ids: string[]): Promise<{ ok: true; people: Who[] } | Fail> {
  const { data } = await admin.from("profiles").select("id, full_name, email").in("id", ids);
  const people = ((data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => ({ id: p.id, name: p.full_name ?? "A teammate", email: String(p.email ?? "").toLowerCase() }));
  const outside = people.filter((p) => !p.email || !sameDomain(p.email, me.email));
  if (outside.length) return { ok: false, error: `Only Kaizen teammates for now: ${outside.map((p) => p.name).join(", ")} has no Kaizen address on file.` };
  if (!people.length) return { ok: false, error: "Those teammates aren't in the app any more." };
  return { ok: true, people };
}

/** Someone's own calendar timezone (Google's setting, read when calendar.readonly is allowed), else New York */
export async function timezoneOf(email: string): Promise<string> {
  try {
    const { googleCalendarToken } = await import("@/lib/context/google");
    const r = await gcal<{ value?: string }>(await googleCalendarToken(email), "GET", "/users/me/settings/timezone");
    if (!r.value) return DEFAULT_TZ;
    new Intl.DateTimeFormat("en-US", { timeZone: r.value }); // throws on a zone this runtime doesn't know
    return r.value;
  } catch {
    return DEFAULT_TZ;
  }
}

/** A free/busy token as someone: calendar.freebusy, else calendar.readonly (either works for FreeBusy) */
async function freeBusyToken(email: string): Promise<string> {
  const { googleFreeBusyToken, googleCalendarToken } = await import("@/lib/context/google");
  try {
    return await googleFreeBusyToken(email);
  } catch (e) {
    try {
      return await googleCalendarToken(email);
    } catch {
      throw e;
    }
  }
}

/** Everyone's busy blocks: one FreeBusy ask as the asker, then as each person whose calendar it couldn't see */
export async function busyFor(askerEmail: string, emails: string[], from: number, to: number): Promise<Map<string, { start: number; end: number }[]>> {
  type FB = { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
  const ask = (token: string, ids: string[]) => gcal<FB>(token, "POST", "/freeBusy", {}, { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: ids.map((id) => ({ id })) });
  const out = new Map<string, { start: number; end: number }[]>();
  const first = await ask(await freeBusyToken(askerEmail), emails);
  for (const e of emails) {
    const c = first.calendars?.[e];
    if (c && !c.errors?.length) out.set(e, busyOf(c.busy));
    else {
      const own = await ask(await freeBusyToken(e), [e]);
      out.set(e, busyOf(own.calendars?.[e]?.busy));
    }
  }
  return out;
}

type Proposal = { id: string; profile_id: string; call_id: string | null; attendee_ids: string[]; minutes: number; title: string | null; agenda: string | null; timezone: string; from_day: string; to_day: string; earliest: number | null; latest: number | null; shown: string[]; status: "open" | "booked"; meeting_id: string | null };

/** Every start that works for everyone in a proposal's window (their own hours and timezones) */
async function startsFor(me: Me, people: Who[], p: Pick<Proposal, "timezone" | "from_day" | "to_day" | "minutes" | "earliest" | "latest">): Promise<number[]> {
  const theirs = await Promise.all(people.map((x) => timezoneOf(x.email)));
  const emails = [me.email.toLowerCase(), ...people.map((x) => x.email)];
  const busy = await busyFor(me.email, emails, zonedTime(p.from_day, 0, p.timezone), zonedTime(p.to_day, 24 * 60, p.timezone));
  const all: Person[] = [{ tz: p.timezone, busy: busy.get(emails[0]) ?? [] }, ...people.map((x, i) => ({ tz: theirs[i], busy: busy.get(x.email) ?? [] }))];
  return freeStarts({ people: all, tz: p.timezone, fromDay: p.from_day, toDay: p.to_day, minutes: p.minutes, earliest: p.earliest, latest: p.latest, notBefore: Date.now() + 15 * 60_000 });
}

/** What a slot card shows for a proposal */
function cardOf(p: Proposal, people: Who[], starts: number[], booked: CallSlots["booked"] = null, more = true): CallSlots {
  return {
    proposalId: p.id,
    title: p.title || `Call with ${people.map((x) => x.name.split(" ")[0]).join(", ")}`,
    minutes: p.minutes,
    attendees: people.map((x) => x.name),
    timezone: p.timezone,
    options: starts.map((s) => slotView(s, s + p.minutes * 60_000, p.timezone)),
    status: booked ? "booked" : "open",
    booked,
    more,
  };
}

export type Proposed = { ok: true; slots: CallSlots; timezone: string } | Fail;

/** Times for a call: a proposal saved with the first two or three options */
export async function proposeTimes(
  admin: SupabaseClient,
  me: Me,
  input: { people: Who[]; minutes?: number; fromDay?: string | null; toDay?: string | null; earliest?: number | null; latest?: number | null; title?: string | null; agenda?: string | null; callId?: string | null },
): Promise<Proposed> {
  try {
    const tz = await timezoneOf(me.email);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    const fromDay = input.fromDay && DAY.test(input.fromDay) && input.fromDay >= today ? input.fromDay : today;
    const toDay = input.toDay && DAY.test(input.toDay) && input.toDay >= fromDay ? input.toDay : defaultWindow(fromDay).toDay;
    const minutes = Math.min(240, Math.max(15, Number(input.minutes) || DEFAULT_MINUTES));
    const base = { timezone: tz, from_day: fromDay, to_day: toDay, minutes, earliest: input.earliest ?? null, latest: input.latest ?? null };
    const starts = await startsFor(me, input.people, base);
    const first = nextBatch(starts, [], tz);
    const { data, error } = await admin
      .from("meeting_proposals")
      .insert({ profile_id: me.id, call_id: input.callId ?? null, attendee_ids: input.people.map((x) => x.id), title: clip(input.title, 150) || null, agenda: String(input.agenda ?? "").trim().slice(0, 2000) || null, shown: first.map((s) => new Date(s).toISOString()), ...base })
      .select("*")
      .single();
    if (error || !data) return { ok: false, error: "The times couldn't be kept on our side. Try again." };
    return { ok: true, timezone: tz, slots: cardOf(data as Proposal, input.people, first, null, starts.length > first.length) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (calendarScopeMissing(m)) return scopeFail(READ_SCOPE, "Checking calendars");
    console.error("[meeting times]", m);
    return { ok: false, error: `Google Calendar didn't answer (${clip(m, 160)}). Try again in a moment.` };
  }
}

async function proposalOf(admin: SupabaseClient, me: Me, id: string): Promise<Proposal | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await admin.from("meeting_proposals").select("*").eq("id", id).eq("profile_id", me.id).maybeSingle();
  return (data as Proposal | null) ?? null;
}

/** More times: the next batch after what's been shown, looking a week further when this window runs out */
export async function moreTimes(admin: SupabaseClient, me: Me, proposalId: string): Promise<{ ok: true; slots: CallSlots } | Fail> {
  const p = await proposalOf(admin, me, proposalId);
  if (!p) return { ok: false, error: "Those times aren't yours to change." };
  const who = await teammatesById(admin, me, p.attendee_ids);
  if (!who.ok) return who;
  try {
    const shown = p.shown.map((s) => Date.parse(s));
    let window = p;
    let starts = await startsFor(me, who.people, window);
    let batch = nextBatch(starts, shown, p.timezone);
    for (let i = 0; !batch.length && i < 2; i++) {
      const next = new Date(Date.parse(`${window.to_day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      window = { ...window, to_day: defaultWindow(next).toDay };
      starts = await startsFor(me, who.people, window);
      batch = nextBatch(starts, shown, p.timezone);
    }
    await admin
      .from("meeting_proposals")
      .update({ to_day: window.to_day, shown: [...p.shown, ...batch.map((s) => new Date(s).toISOString())], updated_at: new Date().toISOString() })
      .eq("id", p.id);
    return { ok: true, slots: cardOf(window, who.people, batch, null, batch.length > 0) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (calendarScopeMissing(m)) return scopeFail(READ_SCOPE, "Checking calendars");
    return { ok: false, error: `Google Calendar didn't answer (${clip(m, 160)}).` };
  }
}

export type BookedMeeting = { ok: true; already: boolean; meetingId: string | null; label: string; link: string | null; meet: string | null; with: string[]; slots: CallSlots };

/**
 * Books one start from a proposal on the asker's own calendar as them (they're the organizer): the teammates invited
 * (sendUpdates all), a Meet link, the title and agenda. Once only: a second try (the tap after a spoken yes, or the
 * other way round) answers with what was booked. The caller has the person's yes (a tap on Book, or their words).
 */
export async function bookProposal(admin: SupabaseClient, me: Me, proposalId: string, startIso: string, opts: { title?: string | null; agenda?: string | null; via?: string } = {}): Promise<BookedMeeting | Fail> {
  const p = await proposalOf(admin, me, proposalId);
  if (!p) return { ok: false, error: "Those times aren't on file. Find a time again." };
  const who = await teammatesById(admin, me, p.attendee_ids);
  if (!who.ok) return who;
  if (p.status === "booked" && p.meeting_id) {
    const { data: m } = await admin.from("assistant_meetings").select("id, starts_at, timezone, calendar_link, meet_link, status").eq("id", p.meeting_id).maybeSingle();
    if (m && m.status !== "cancelled") {
      const label = slotLabel(Date.parse(m.starts_at as string), m.timezone as string);
      const booked = { label, link: (m.calendar_link as string | null) ?? null, meet: (m.meet_link as string | null) ?? null };
      return { ok: true, already: true, meetingId: m.id as string, label, link: booked.link, meet: booked.meet, with: who.people.map((x) => x.name), slots: cardOf(p, who.people, [], booked, false) };
    }
  }
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return { ok: false, error: "That isn't one of the times offered." };
  if (start < Date.now()) return { ok: false, error: "That time has passed. Pick another, or tap More times." };
  const end = start + p.minutes * 60_000;
  const title = clip(opts.title, 150) || p.title || `${me.fullName.split(" ")[0]} / ${who.people.map((x) => x.name.split(" ")[0]).join(", ")}`;
  const agenda = String(opts.agenda ?? p.agenda ?? "").trim().slice(0, 2000);
  const tz = p.timezone || DEFAULT_TZ;
  try {
    // Someone may have filled it since the times were offered
    const emails = [me.email.toLowerCase(), ...who.people.map((x) => x.email)];
    const busy = await busyFor(me.email, emails, start, end).catch(() => null);
    const taken = busy ? [...busy.entries()].filter(([, b]) => b.some((x) => overlaps(x, { start, end }))).map(([e]) => (e === emails[0] ? "you" : (who.people.find((x) => x.email === e)?.name ?? e))) : [];
    if (taken.length) return { ok: false, error: `That time isn't free any more (${taken.join(", ")}). Pick another, or tap More times.` };
    const { googleCalendarEventsToken } = await import("@/lib/context/google");
    type Ev = { id: string; htmlLink?: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] } };
    const ev = await gcal<Ev>(await googleCalendarEventsToken(me.email), "POST", "/calendars/primary/events", { conferenceDataVersion: "1", sendUpdates: "all" }, {
      summary: title,
      description: agenda ? `${agenda}\n\nBooked with Kaizen OS.` : "Booked with Kaizen OS.",
      start: { dateTime: rfc3339(start, tz), timeZone: tz },
      end: { dateTime: rfc3339(end, tz), timeZone: tz },
      attendees: who.people.map((x) => ({ email: x.email, displayName: x.name })),
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      guestsCanModify: false,
    });
    const meet = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((x) => x.entryPointType === "video")?.uri ?? null;
    const { data: row } = await admin
      .from("assistant_meetings")
      .insert({ profile_id: me.id, google_event_id: ev.id, calendar_link: ev.htmlLink ?? null, meet_link: meet, title, agenda: agenda || null, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), timezone: tz, attendees: who.people.map((x) => ({ name: x.name, email: x.email })), booked_via: opts.via ?? "assistant", call_id: p.call_id, history: [{ at: new Date().toISOString(), did: "booked", via: opts.via ?? "assistant" }] })
      .select("id")
      .single();
    await admin.from("meeting_proposals").update({ status: "booked", meeting_id: row?.id ?? null, title, updated_at: new Date().toISOString() }).eq("id", p.id);
    const label = slotLabel(start, tz);
    const booked = { label, link: ev.htmlLink ?? null, meet };
    return { ok: true, already: false, meetingId: (row?.id as string | undefined) ?? null, label, link: booked.link, meet, with: who.people.map((x) => x.name), slots: cardOf({ ...p, title }, who.people, [], booked, false) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (calendarScopeMissing(m)) return scopeFail(EVENTS_SCOPE, "Booking calls on Google Calendar");
    console.error("[book meeting]", m);
    return { ok: false, error: `Google Calendar didn't take it (${clip(m, 160)}). Nothing was booked.` };
  }
}
