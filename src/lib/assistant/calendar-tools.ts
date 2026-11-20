import "server-only";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";
import { saidYes } from "./core";
import { serviceAccountClientId } from "./platform-drafts-core";
import { busyOf, calendarScopeMissing, DEFAULT_MINUTES, DEFAULT_TZ, defaultWindow, findSlots, overlaps, parseClock, rfc3339, sameDomain, slotLabel, zonedTime, type Person } from "./scheduling-core";

// Internal calls on Google Calendar, for every teammate's assistant, every agent and Kaizen AI (owner, Nov 20 2026):
// "find a time with Mel" checks everyone's free/busy in their own working hours and offers two or three times; on the
// asker's yes the event goes on their own calendar as them (they're the organizer), with the invites sent, a Meet
// link, and a title and agenda from the conversation. Moving or cancelling one the assistant booked also waits for a
// yes. Teammates only for now (addresses on Kaizen's own domain). Every booking is logged (assistant_meetings).

const CAL = "https://www.googleapis.com/calendar/v3";
const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const YES_FIELD = { type: "boolean", description: "true only after the person picked this time or said yes to this exact booking, in their own words this turn" };

type Who = { id: string; name: string; email: string };
type Fail = { error: string; for_the_admin?: string; options?: string[]; note?: string };

/** The admin's one step when Google refuses a calendar scope (the client ID from the key, never the key) */
function scopeFail(scope: string, what: string): Fail {
  const id = serviceAccountClientId(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return {
    error: `${what} needs one Admin console setting first, so nothing was booked. Say so in a sentence.`,
    for_the_admin: `Add ${scope} to the service account's domain-wide delegation${id ? ` (client ID ${id})` : ""}: admin.google.com, Security > Access and data control > API controls > Manage domain-wide delegation.`,
  };
}

async function gcal<T>(token: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${CAL}${path}${qs ? `?${qs}` : ""}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (!res.ok) throw new Error(`Google ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** The teammates named ("Mel", "the head of email"), each with their email; teammates on Kaizen's domain only */
async function teammates(ctx: ToolCtx, names: unknown): Promise<{ ok: true; people: Who[] } | ({ ok: false } & Fail)> {
  const list = (Array.isArray(names) ? names : [names]).map((n) => clip(n, 80)).filter(Boolean).slice(0, 8);
  if (!list.length) return { ok: false, error: "Who's the call with? Ask in a few words." };
  const { recipientFor } = await import("./routing-server");
  const ids: string[] = [];
  for (const to of list) {
    const r = await recipientFor(ctx.admin, { to, client: null, agentRole: null, exclude: ctx.me.id });
    if (!r.ok) return { ok: false, error: r.note, options: r.options };
    if (!ids.includes(r.to.id)) ids.push(r.to.id);
  }
  const { data } = await ctx.admin.from("profiles").select("id, full_name, email").in("id", ids);
  const people = ((data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => ({ id: p.id, name: p.full_name ?? "A teammate", email: String(p.email ?? "").toLowerCase() }));
  const outside = people.filter((p) => !p.email || !sameDomain(p.email, ctx.me.email));
  if (outside.length) return { ok: false, error: `Only Kaizen teammates for now: ${outside.map((p) => p.name).join(", ")} has no Kaizen address on file.` };
  return { ok: true, people };
}

/** Someone's own calendar timezone (Google's setting), New York when it can't be read */
async function timezoneOf(email: string): Promise<string> {
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

/** Everyone's busy blocks between two instants: one FreeBusy ask as the asker, then as each person whose calendar it couldn't see */
async function busyFor(askerEmail: string, emails: string[], from: number, to: number): Promise<Map<string, { start: number; end: number }[]>> {
  const { googleCalendarToken } = await import("@/lib/context/google");
  type FB = { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
  const ask = (token: string, ids: string[]) => gcal<FB>(token, "POST", "/freeBusy", {}, { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: ids.map((id) => ({ id })) });
  const out = new Map<string, { start: number; end: number }[]>();
  const first = await ask(await googleCalendarToken(askerEmail), emails);
  for (const e of emails) {
    const c = first.calendars?.[e];
    if (c && !c.errors?.length) out.set(e, busyOf(c.busy));
    else {
      const own = await ask(await googleCalendarToken(e), [e]);
      out.set(e, busyOf(own.calendars?.[e]?.busy));
    }
  }
  return out;
}

const nyToday = (tz: string) => new Date().toLocaleDateString("en-CA", { timeZone: tz });

/** A card: on a call or the assistant's chat (buttons there), else a card in the Kaizen AI thread */
function showTimes(ctx: ToolCtx, key: string, title: string, detail: string, options: { label: string; say: string }[]) {
  if (ctx.emit) ctx.emit({ t: "card", card: { id: `times-${key}`, title, detail, href: "/assistant", external: false, cta: "", choices: options } });
  else ctx.cards.push({ type: "list", title, items: options.map((o) => ({ title: o.label, detail })) });
}
function showEvent(ctx: ToolCtx, key: string, title: string, detail: string, href: string) {
  if (ctx.emit) ctx.emit({ t: "card", card: { id: `meeting-${key}`, title, detail, href, external: true, cta: "Open in Calendar" } });
  else ctx.cards.push({ type: "link", title, detail, href, cta: "Open in Calendar", external: true });
}

type Booked = { id: string; google_event_id: string; title: string; starts_at: string; ends_at: string; timezone: string; attendees: { name: string; email: string }[]; status: string; history: unknown[]; calendar_link: string | null; meet_link: string | null };

/** One meeting the person had the assistant book (by its id or words in its title; else the next one coming up) */
async function bookedMeeting(ctx: ToolCtx, which: unknown): Promise<{ ok: true; m: Booked } | { ok: false; note: string; booked?: { meeting: string; title: string; when: string }[] }> {
  const { data } = await ctx.admin.from("assistant_meetings").select("id, google_event_id, title, starts_at, ends_at, timezone, attendees, status, history, calendar_link, meet_link").eq("profile_id", ctx.me.id).neq("status", "cancelled").gte("ends_at", new Date().toISOString()).order("starts_at").limit(20);
  const rows = (data ?? []) as Booked[];
  if (!rows.length) return { ok: false, note: "Nothing the assistant booked for them is coming up. Only calls booked here can be moved or cancelled from here." };
  const w = clip(which, 80).toLowerCase();
  const hit = !w ? rows[0] : (rows.find((r) => r.id === w) ?? rows.find((r) => r.title.toLowerCase().includes(w) || r.attendees.some((a) => a.name.toLowerCase().includes(w))));
  if (!hit) return { ok: false, note: "Which call? Name it from this list in a few words.", booked: rows.map((r) => ({ meeting: r.id, title: r.title, when: slotLabel(Date.parse(r.starts_at), r.timezone) })) };
  return { ok: true, m: hit };
}

const startOf = (v: unknown): number | null => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
};

export function calendarTools(ctx: ToolCtx): ChatTool[] {
  const viewing = async () => (await import("@/lib/kaizen-ai/my-tools")).viewingAs(ctx);
  return [
    {
      name: "find_meeting_time",
      description:
        "Finds times for an internal call with teammates ('find a time with Mel', 'set up 45 minutes with the head of email this week'): checks the asker's and everyone's Google Calendar free/busy, inside each person's working hours in their own timezone (Mon–Fri 9–6 New York when unknown), and offers 2–3 options. with: teammates by name or role. Turn 'tomorrow', 'this week', 'after 2pm' into from_day/to_day (YYYY-MM-DD) and earliest/latest (times in the asker's timezone). 30 minutes unless a length is said. Then read the options in a sentence (on a call, say them aloud; in the chat they show as buttons) and ask which works. Book only with book_meeting after they pick one or say yes. Teammates only: client meetings aren't booked from here yet.",
      input_schema: {
        type: "object",
        properties: {
          with: { type: "array", items: { type: "string" }, description: "Teammates on the call besides the asker, by name or role" },
          minutes: { type: "integer", minimum: 15, maximum: 240, description: "How long (default 30)" },
          from_day: { type: "string", description: "YYYY-MM-DD, the first day to look (default today)" },
          to_day: { type: "string", description: "YYYY-MM-DD, the last day to look (default four working days after today)" },
          earliest: { type: "string", description: "Not before this time of day, e.g. 14:00 or 2pm" },
          latest: { type: "string", description: "Ending by this time of day, e.g. 17:00" },
          title: { type: "string", description: "What the call is about, a few words" },
        },
        required: ["with"],
        additionalProperties: false,
      },
      status: (input) => `Checking calendars${Array.isArray(input.with) && input.with.length ? ` with ${clip(input.with.join(", "), 40)}` : ""}…`,
      run: async (input) => {
        if (await viewing()) return { error: "Scheduling isn't available while viewing as someone else." };
        const { googleConfigured } = await import("@/lib/context/google");
        if (!googleConfigured()) return { error: "Google isn't connected to Kaizen OS yet, so calendars can't be checked." };
        const who = await teammates(ctx, input.with);
        if (!who.ok) return who;
        const minutes = Math.min(240, Math.max(15, Number(input.minutes) || DEFAULT_MINUTES));
        try {
          const [tz, ...theirs] = await Promise.all([timezoneOf(ctx.me.email), ...who.people.map((p) => timezoneOf(p.email))]);
          const today = nyToday(tz);
          const win = defaultWindow(today);
          const fromDay = DAY.test(String(input.from_day)) && String(input.from_day) >= today ? String(input.from_day) : win.fromDay;
          const toDay = DAY.test(String(input.to_day)) && String(input.to_day) >= fromDay ? String(input.to_day) : fromDay === today ? win.toDay : defaultWindow(fromDay).toDay;
          const from = zonedTime(fromDay, 0, tz);
          const to = zonedTime(toDay, 24 * 60, tz);
          const emails = [ctx.me.email.toLowerCase(), ...who.people.map((p) => p.email)];
          const busy = await busyFor(ctx.me.email, emails, from, to);
          const people: Person[] = [{ tz, busy: busy.get(emails[0]) ?? [] }, ...who.people.map((p, i) => ({ tz: theirs[i], busy: busy.get(p.email) ?? [] }))];
          const slots = findSlots({ people, tz, fromDay, toDay, minutes, earliest: parseClock(input.earliest), latest: parseClock(input.latest), notBefore: Date.now() + 15 * 60_000 });
          const names = who.people.map((p) => p.name).join(", ");
          if (!slots.length) return { found: 0, from: fromDay, to: toDay, note: `No ${minutes}-minute time works for everyone between ${fromDay} and ${toDay} inside working hours. Say so and offer to look further out or with a shorter call.` };
          const others = who.people.map((p, i) => ({ name: p.name, tz: theirs[i] })).filter((p) => p.tz !== tz);
          const options = slots.map((s, i) => ({
            option: i + 1,
            start: rfc3339(s.start, tz),
            label: slotLabel(s.start, tz),
            ...(others.length ? { for_them: others.map((o) => `${o.name}: ${slotLabel(s.start, o.tz, true)}`).join("; ") } : {}),
          }));
          showTimes(ctx, `${Date.now().toString(36)}`, `Times with ${names}`, `${minutes} min${clip(input.title, 60) ? ` · ${clip(input.title, 60)}` : ""}`, options.map((o) => ({ label: o.label, say: `Yes, book ${o.label}.` })));
          return { found: options.length, timezone: tz, minutes, with: who.people.map((p) => p.name), options, note: "Offer these in a sentence (times in their timezone) and ask which works. Book with book_meeting (its start) only after they pick one or say yes." };
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (calendarScopeMissing(m)) return scopeFail(READ_SCOPE, "Checking calendars");
          console.error("[find_meeting_time]", m);
          return { error: `Google Calendar didn't answer (${clip(m, 160)}). Try again in a moment.` };
        }
      },
    },
    {
      name: "book_meeting",
      description:
        "Books an internal call on the asker's own Google Calendar as them (they're the organizer), invites the teammates (Google emails the invites), adds a Google Meet link, and a title and a short agenda you write from the conversation. Sending invites is a message on their behalf: run it only after they picked a time from find_meeting_time or clearly said yes to this exact time and person_said_yes is true. Then say it's booked in a few words; the card links to the event.",
      input_schema: {
        type: "object",
        properties: {
          with: { type: "array", items: { type: "string" }, description: "The teammates, by name or role (as for find_meeting_time)" },
          start: { type: "string", description: "The start picked, exactly as find_meeting_time gave it (2026-11-24T14:00:00-05:00)" },
          minutes: { type: "integer", minimum: 15, maximum: 240 },
          title: { type: "string", description: "The event's title, short: 'Santi / Mel: Q1 email plan'" },
          agenda: { type: "string", description: "Two to four short lines from the conversation: what the call is for" },
          person_said_yes: YES_FIELD,
        },
        required: ["with", "start", "title", "person_said_yes"],
        additionalProperties: false,
      },
      status: () => "Booking it…",
      run: async (input) => {
        if (await viewing()) return { error: "Scheduling isn't available while viewing as someone else." };
        if (input.person_said_yes !== true || !saidYes(ctx.said ?? "")) return { booked: false, note: "Not run: say the time and who in a sentence and ask; book with person_said_yes: true on their yes (or their pick)." };
        const start = startOf(input.start);
        if (start == null) return { booked: false, error: "That start isn't a time. Use one find_meeting_time gave." };
        if (start < Date.now()) return { booked: false, error: "That time has passed. Find another (find_meeting_time)." };
        const who = await teammates(ctx, input.with);
        if (!who.ok) return { booked: false, ...who };
        const minutes = Math.min(240, Math.max(15, Number(input.minutes) || DEFAULT_MINUTES));
        const end = start + minutes * 60_000;
        const title = clip(input.title, 150) || `${ctx.me.fullName.split(" ")[0]} / ${who.people.map((p) => p.name.split(" ")[0]).join(", ")}`;
        const agenda = String(input.agenda ?? "").trim().slice(0, 2000);
        const { googleCalendarEventsToken } = await import("@/lib/context/google");
        try {
          const tz = await timezoneOf(ctx.me.email);
          // Someone may have filled it since the options were offered
          const emails = [ctx.me.email.toLowerCase(), ...who.people.map((p) => p.email)];
          const busy = await busyFor(ctx.me.email, emails, start, end).catch(() => null);
          const taken = busy ? [...busy.entries()].filter(([, b]) => b.some((x) => overlaps(x, { start, end }))).map(([e]) => (e === emails[0] ? "you" : (who.people.find((p) => p.email === e)?.name ?? e))) : [];
          if (taken.length) return { booked: false, note: `That time isn't free any more (${taken.join(", ")}). Say so and find another (find_meeting_time).` };
          const token = await googleCalendarEventsToken(ctx.me.email);
          type Ev = { id: string; htmlLink?: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] } };
          const ev = await gcal<Ev>(token, "POST", "/calendars/primary/events", { conferenceDataVersion: "1", sendUpdates: "all" }, {
            summary: title,
            description: agenda ? `${agenda}\n\nBooked with Kaizen OS.` : "Booked with Kaizen OS.",
            start: { dateTime: rfc3339(start, tz), timeZone: tz },
            end: { dateTime: rfc3339(end, tz), timeZone: tz },
            attendees: who.people.map((p) => ({ email: p.email, displayName: p.name })),
            conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
            guestsCanModify: false,
          });
          const meet = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null;
          const { data: row } = await ctx.admin
            .from("assistant_meetings")
            .insert({ profile_id: ctx.me.id, google_event_id: ev.id, calendar_link: ev.htmlLink ?? null, meet_link: meet, title, agenda: agenda || null, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), timezone: tz, attendees: who.people.map((p) => ({ name: p.name, email: p.email })), booked_via: ctx.agent ?? "assistant", history: [{ at: new Date().toISOString(), did: "booked" }] })
            .select("id")
            .single();
          const when = slotLabel(start, tz);
          showEvent(ctx, ev.id, title, `${when} · with ${who.people.map((p) => p.name).join(", ")}`, ev.htmlLink ?? "https://calendar.google.com/calendar/r");
          return { booked: true, meeting: row?.id ?? null, when, with: who.people.map((p) => p.name), meet: meet ?? undefined, link: ev.htmlLink ?? null, note: "Say it's booked and the invites went out, in a few words." };
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (calendarScopeMissing(m)) return { booked: false, ...scopeFail(m.includes("freeBusy") ? READ_SCOPE : EVENTS_SCOPE, "Booking calls on Google Calendar") };
          console.error("[book_meeting]", m);
          return { booked: false, error: `Google Calendar didn't take it (${clip(m, 160)}). Nothing was booked.` };
        }
      },
    },
    {
      name: "reschedule_meeting",
      description: "Moves a call the assistant booked for the person to a new time (Google tells the attendees). Find the new time first with find_meeting_time when they didn't give one. Runs only after they said yes to the new time (person_said_yes). meeting: the call's id from an earlier answer, or words from its title or a teammate's name; leave out for their next one.",
      input_schema: {
        type: "object",
        properties: { meeting: { type: "string" }, start: { type: "string", description: "The new start (2026-11-24T14:00:00-05:00)" }, minutes: { type: "integer", minimum: 15, maximum: 240, description: "A new length, if it changes" }, person_said_yes: YES_FIELD },
        required: ["start", "person_said_yes"],
        additionalProperties: false,
      },
      status: () => "Moving the call…",
      run: async (input) => {
        if (await viewing()) return { error: "Scheduling isn't available while viewing as someone else." };
        const found = await bookedMeeting(ctx, input.meeting);
        if (!found.ok) return { moved: false, ...found };
        const m = found.m;
        if (input.person_said_yes !== true || !saidYes(ctx.said ?? "")) return { moved: false, meeting: m.id, title: m.title, now: slotLabel(Date.parse(m.starts_at), m.timezone), note: "Not run: say which call and the new time in a sentence and ask; move it with person_said_yes: true on their yes." };
        const start = startOf(input.start);
        if (start == null || start < Date.now()) return { moved: false, error: "That new start isn't a time still ahead. Find one with find_meeting_time." };
        const minutes = Number(input.minutes) || Math.round((Date.parse(m.ends_at) - Date.parse(m.starts_at)) / 60_000);
        const end = start + minutes * 60_000;
        try {
          const { googleCalendarEventsToken } = await import("@/lib/context/google");
          const ev = await gcal<{ htmlLink?: string }>(await googleCalendarEventsToken(ctx.me.email), "PATCH", `/calendars/primary/events/${encodeURIComponent(m.google_event_id)}`, { sendUpdates: "all" }, { start: { dateTime: rfc3339(start, m.timezone), timeZone: m.timezone }, end: { dateTime: rfc3339(end, m.timezone), timeZone: m.timezone } });
          await ctx.admin
            .from("assistant_meetings")
            .update({ starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), status: "moved", calendar_link: ev.htmlLink ?? m.calendar_link, history: [...(m.history ?? []), { at: new Date().toISOString(), did: "moved", from: m.starts_at }], updated_at: new Date().toISOString() })
            .eq("id", m.id)
            .eq("profile_id", ctx.me.id);
          const when = slotLabel(start, m.timezone);
          showEvent(ctx, m.google_event_id, m.title, `Moved to ${when}`, ev.htmlLink ?? m.calendar_link ?? "https://calendar.google.com/calendar/r");
          return { moved: true, title: m.title, when, note: "Say it's moved and everyone was told, in a few words." };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (calendarScopeMissing(msg)) return { moved: false, ...scopeFail(EVENTS_SCOPE, "Moving calls on Google Calendar") };
          return { moved: false, error: `Google Calendar didn't take the change (${clip(msg, 160)}).` };
        }
      },
    },
    {
      name: "cancel_meeting",
      description: "Cancels a call the assistant booked for the person (Google tells the attendees). Runs only after they clearly confirmed cancelling that call (person_said_yes). meeting: its id, or words from its title or a teammate's name; leave out for their next one.",
      input_schema: { type: "object", properties: { meeting: { type: "string" }, person_said_yes: YES_FIELD }, required: ["person_said_yes"], additionalProperties: false },
      status: () => "Cancelling the call…",
      run: async (input) => {
        if (await viewing()) return { error: "Scheduling isn't available while viewing as someone else." };
        const found = await bookedMeeting(ctx, input.meeting);
        if (!found.ok) return { cancelled: false, ...found };
        const m = found.m;
        // "Yes, cancel it" is a yes here (the word cancel isn't a no to this)
        if (input.person_said_yes !== true || !saidYes(String(ctx.said ?? "").replace(/\bcancel\w*\b/gi, " "))) return { cancelled: false, meeting: m.id, title: m.title, when: slotLabel(Date.parse(m.starts_at), m.timezone), note: "Not run: name the call and its time in a sentence and ask if you should cancel it; run with person_said_yes: true on their yes." };
        try {
          const { googleCalendarEventsToken } = await import("@/lib/context/google");
          await gcal(await googleCalendarEventsToken(ctx.me.email), "DELETE", `/calendars/primary/events/${encodeURIComponent(m.google_event_id)}`, { sendUpdates: "all" });
          await ctx.admin
            .from("assistant_meetings")
            .update({ status: "cancelled", history: [...(m.history ?? []), { at: new Date().toISOString(), did: "cancelled" }], updated_at: new Date().toISOString() })
            .eq("id", m.id)
            .eq("profile_id", ctx.me.id);
          return { cancelled: true, title: m.title, note: "Say it's cancelled and everyone was told, in a few words." };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (calendarScopeMissing(msg)) return { cancelled: false, ...scopeFail(EVENTS_SCOPE, "Cancelling calls on Google Calendar") };
          return { cancelled: false, error: `Google Calendar didn't cancel it (${clip(msg, 160)}).` };
        }
      },
    },
  ];
}
