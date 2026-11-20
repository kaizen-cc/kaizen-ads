import "server-only";
import type { CallSlots } from "@/lib/agent-call/core";
import type { ChatTool, ToolCtx } from "@/lib/kaizen-ai/tools";
import { saidYes } from "./core";
import { bookProposal, EVENTS_SCOPE, gcal, proposeTimes, scopeFail, teammatesNamed } from "./calendar-server";
import { calendarScopeMissing, parseClock, rfc3339, slotLabel } from "./scheduling-core";

// Internal calls on Google Calendar, for every teammate's assistant, every agent and Kaizen AI (owner, Nov 20 2026):
// "find a time with Mel" checks everyone's free/busy in their own working hours and shows two or three times as slot
// cards (on a call too, read aloud as well): a tap opens the confirm step and one more tap books it; a spoken yes books
// it the same way, whichever comes first, and the card then shows it booked. The event goes on the asker's own
// calendar as them, with the invites sent, a Meet link, and a title and agenda from the conversation. Moving or
// cancelling one booked here also waits for a yes. Teammates only for now (calendar-server.ts).

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const YES_FIELD = { type: "boolean", description: "true only after the person picked this time or said yes to this exact booking, in their own words this turn" };
const meOf = (ctx: ToolCtx) => ({ id: ctx.me.id, email: ctx.me.email, fullName: ctx.me.fullName });

/** The slot card: on a call or the assistant's chat right away, else on the Kaizen AI message (the same card) */
function showSlots(ctx: ToolCtx, slots: CallSlots) {
  if (ctx.emit) ctx.emit({ t: "card", card: { id: `slots-${slots.proposalId}`, title: slots.title, detail: slots.attendees.join(", "), href: `/assistant#times-${slots.proposalId}`, external: false, cta: "", slots } });
  else {
    const at = ctx.cards.findIndex((c) => c.type === "slots" && c.slots.proposalId === slots.proposalId);
    if (at >= 0) ctx.cards.splice(at, 1);
    ctx.cards.push({ type: "slots", slots });
  }
}
function showEvent(ctx: ToolCtx, key: string, title: string, detail: string, href: string) {
  if (ctx.emit) ctx.emit({ t: "card", card: { id: `meeting-${key}`, title, detail, href, external: true, cta: "Open in Calendar" } });
  else ctx.cards.push({ type: "link", title, detail, href, cta: "Open in Calendar", external: true });
}

type Booked = { id: string; google_event_id: string; title: string; starts_at: string; ends_at: string; timezone: string; attendees: { name: string; email: string }[]; status: string; history: unknown[]; calendar_link: string | null };

/** One meeting the person had the assistant book (by its id or words in its title; else the next one coming up) */
async function bookedMeeting(ctx: ToolCtx, which: unknown): Promise<{ ok: true; m: Booked } | { ok: false; note: string; booked?: { meeting: string; title: string; when: string }[] }> {
  const { data } = await ctx.admin.from("assistant_meetings").select("id, google_event_id, title, starts_at, ends_at, timezone, attendees, status, history, calendar_link").eq("profile_id", ctx.me.id).neq("status", "cancelled").gte("ends_at", new Date().toISOString()).order("starts_at").limit(20);
  const rows = (data ?? []) as Booked[];
  if (!rows.length) return { ok: false, note: "Nothing booked here for them is coming up. Only calls booked from Kaizen OS can be moved or cancelled from here." };
  const w = clip(which, 80).toLowerCase();
  const hit = !w ? rows[0] : (rows.find((r) => r.id === w) ?? rows.find((r) => r.title.toLowerCase().includes(w) || r.attendees.some((a) => a.name.toLowerCase().includes(w))));
  if (!hit) return { ok: false, note: "Which call? Name it from this list in a few words.", booked: rows.map((r) => ({ meeting: r.id, title: r.title, when: slotLabel(Date.parse(r.starts_at), r.timezone) })) };
  return { ok: true, m: hit };
}

export function calendarTools(ctx: ToolCtx): ChatTool[] {
  const viewing = async () => (await import("@/lib/kaizen-ai/my-tools")).viewingAs(ctx);
  const NOT_WHILE_VIEWING = { error: "Scheduling isn't available while viewing as someone else." };
  return [
    {
      name: "find_meeting_time",
      description:
        "Finds times for an internal call with teammates ('find a time with Mel', 'set up 45 minutes with the head of email this week'): checks the asker's and everyone's Google Calendar free/busy inside each person's working hours in their own timezone (Mon–Fri 9–6 New York when unknown) and shows 2–3 times as slot cards on screen (always, on a call too: tap one, confirm, booked; More times for the next batch). with: teammates by name or role. Turn 'tomorrow', 'this week', 'after 2pm' into from_day/to_day (YYYY-MM-DD) and earliest/latest (times in the asker's timezone). 30 minutes unless a length is said. Give a title and a short agenda from the conversation. Then read the times in a sentence (on a call, say them aloud) and ask which works. A spoken pick or yes books it with book_meeting; a tap on the card books it by itself. Teammates only: client meetings aren't booked from here yet.",
      input_schema: {
        type: "object",
        properties: {
          with: { type: "array", items: { type: "string" }, description: "Teammates on the call besides the asker, by name or role" },
          minutes: { type: "integer", minimum: 15, maximum: 240, description: "How long (default 30)" },
          from_day: { type: "string", description: "YYYY-MM-DD, the first day to look (default today)" },
          to_day: { type: "string", description: "YYYY-MM-DD, the last day to look (default four working days later)" },
          earliest: { type: "string", description: "Not before this time of day, e.g. 14:00 or 2pm" },
          latest: { type: "string", description: "Ending by this time of day, e.g. 17:00" },
          title: { type: "string", description: "The event's title, short: 'Santi / Mel: Q1 email plan'" },
          agenda: { type: "string", description: "Two to four short lines from the conversation: what the call is for" },
        },
        required: ["with"],
        additionalProperties: false,
      },
      status: (input) => `Checking calendars${Array.isArray(input.with) && input.with.length ? ` with ${clip(input.with.join(", "), 40)}` : ""}…`,
      run: async (input) => {
        if (await viewing()) return NOT_WHILE_VIEWING;
        const { googleConfigured } = await import("@/lib/context/google");
        if (!googleConfigured()) return { error: "Google isn't connected to Kaizen OS yet, so calendars can't be checked." };
        const who = await teammatesNamed(ctx.admin, meOf(ctx), input.with);
        if (!who.ok) return who;
        const r = await proposeTimes(ctx.admin, meOf(ctx), {
          people: who.people,
          minutes: Number(input.minutes) || undefined,
          fromDay: clip(input.from_day, 10) || null,
          toDay: clip(input.to_day, 10) || null,
          earliest: parseClock(input.earliest),
          latest: parseClock(input.latest),
          title: clip(input.title, 150) || null,
          agenda: String(input.agenda ?? "").slice(0, 2000) || null,
        });
        if (!r.ok) return r;
        if (!r.slots.options.length) return { found: 0, times: r.slots.proposalId, note: `No ${r.slots.minutes}-minute time works for everyone in that window inside working hours. Say so and offer to look further out or with a shorter call.` };
        showSlots(ctx, r.slots);
        return {
          found: r.slots.options.length,
          times: r.slots.proposalId,
          timezone: r.timezone,
          minutes: r.slots.minutes,
          with: r.slots.attendees,
          options: r.slots.options.map((o, i) => ({ option: i + 1, start: o.start, label: `${o.day}, ${o.date}, ${o.range}` })),
          note: "They're on screen as slot cards (a tap books it there). Read the times in a sentence and ask which works. On their spoken pick or yes, book with book_meeting (times and that option's start).",
        };
      },
    },
    {
      name: "book_meeting",
      description:
        "Books one of the times find_meeting_time offered on the asker's own Google Calendar as them (they're the organizer): the teammates invited (Google emails the invites), a Google Meet link, the title and agenda. Sending invites is a message on their behalf: run it only after they picked a time or clearly said yes to it, with person_said_yes true. If they already booked it by tapping the card, it says so (nothing is booked twice). Then say it's booked in a few words; the card shows it booked with a link.",
      input_schema: {
        type: "object",
        properties: {
          times: { type: "string", description: "The times id find_meeting_time gave" },
          start: { type: "string", description: "The start picked, exactly as find_meeting_time gave it (2026-11-24T14:00:00-05:00)" },
          title: { type: "string", description: "A better title, if the conversation gave one" },
          agenda: { type: "string" },
          person_said_yes: YES_FIELD,
        },
        required: ["times", "start", "person_said_yes"],
        additionalProperties: false,
      },
      status: () => "Booking it…",
      run: async (input) => {
        if (await viewing()) return NOT_WHILE_VIEWING;
        if (input.person_said_yes !== true || !saidYes(ctx.said ?? "")) return { booked: false, note: "Not run: say the time and who in a sentence and ask; book with person_said_yes: true on their yes (or their pick)." };
        const r = await bookProposal(ctx.admin, meOf(ctx), clip(input.times, 40), clip(input.start, 40), { title: clip(input.title, 150) || null, agenda: String(input.agenda ?? "").slice(0, 2000) || null, via: ctx.agent ?? "assistant" });
        if (!r.ok) return { booked: false, ...r };
        showSlots(ctx, r.slots);
        return { booked: true, already: r.already || undefined, when: r.label, with: r.with, meet: r.meet ?? undefined, link: r.link, note: r.already ? "It was already booked from the card: say so in a few words." : "Say it's booked and the invites went out, in a few words." };
      },
    },
    {
      name: "reschedule_meeting",
      description: "Moves a call booked from Kaizen OS to a new time (Google tells the attendees). Find the new time first with find_meeting_time when they didn't give one. Runs only after they said yes to the new time (person_said_yes). meeting: the call's id from an earlier answer, or words from its title or a teammate's name; leave out for their next one.",
      input_schema: {
        type: "object",
        properties: { meeting: { type: "string" }, start: { type: "string", description: "The new start (2026-11-24T14:00:00-05:00)" }, minutes: { type: "integer", minimum: 15, maximum: 240, description: "A new length, if it changes" }, person_said_yes: YES_FIELD },
        required: ["start", "person_said_yes"],
        additionalProperties: false,
      },
      status: () => "Moving the call…",
      run: async (input) => {
        if (await viewing()) return NOT_WHILE_VIEWING;
        const found = await bookedMeeting(ctx, input.meeting);
        if (!found.ok) return { moved: false, ...found };
        const m = found.m;
        if (input.person_said_yes !== true || !saidYes(ctx.said ?? "")) return { moved: false, meeting: m.id, title: m.title, now: slotLabel(Date.parse(m.starts_at), m.timezone), note: "Not run: say which call and the new time in a sentence and ask; move it with person_said_yes: true on their yes." };
        const start = Date.parse(String(input.start ?? ""));
        if (!Number.isFinite(start) || start < Date.now()) return { moved: false, error: "That new start isn't a time still ahead. Find one with find_meeting_time." };
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
      description: "Cancels a call booked from Kaizen OS (Google tells the attendees). Runs only after they clearly confirmed cancelling that call (person_said_yes). meeting: its id, or words from its title or a teammate's name; leave out for their next one.",
      input_schema: { type: "object", properties: { meeting: { type: "string" }, person_said_yes: YES_FIELD }, required: ["person_said_yes"], additionalProperties: false },
      status: () => "Cancelling the call…",
      run: async (input) => {
        if (await viewing()) return NOT_WHILE_VIEWING;
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
