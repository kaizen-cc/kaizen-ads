import { describe, expect, it } from "vitest";
import { addToBrief, bookingAnswers, briefDue, briefTitle, businessOf, callBriefText, classifyEvent, cleanCallBrief, eventHash, eventKey, externalsOf, runnerOf, siteOf, whenLabel, type BriefEvent, type ClientRef } from "@/lib/sales-briefs-core";
import { contextPrompt, parseCallContext } from "@/lib/agent-call/call-context";
import { mayOpen } from "@/lib/ai-access-core";
import { PROSPECT_STATUSES, briefHref, forwardStatus } from "@/lib/sales-core";

const clients: ClientRef[] = [
  { id: "c1", name: "Crust Pizza", emails: ["owner@crustpizza.com"], domains: ["crustpizza.com"] },
  { id: "c2", name: "Angry Chickz", emails: ["marco@gmail.com"], domains: [] },
];
const at = (iso: string) => ({ dateTime: iso });
const calendly = `Event Name: Discovery Call

Location: This is a Google Meet web conference.

Please share anything that will help prepare for our meeting.
We want more filler bookings at our second location.

Company name:
Glow Med Spa

Website:
glowmedspa.com

What's your monthly marketing budget?
$3,000 - $5,000

Need to make changes to this event?`;

const sales: BriefEvent = {
  id: "ev1",
  iCalUID: "uid-1@google.com",
  summary: "Discovery Call between Kyle and Ana Ruiz",
  description: calendly,
  start: at("2026-11-26T15:00:00Z"),
  end: at("2026-11-26T15:30:00Z"),
  organizer: { email: "kyle@kaizenmarketing.agency", self: true },
  attendees: [
    { email: "kyle@kaizenmarketing.agency", self: true, responseStatus: "accepted" },
    { email: "ana@glowmedspa.com", displayName: "Ana Ruiz" },
  ],
};

describe("sales call briefs: which meetings are sales calls", () => {
  it("an outside guest who isn't a client, booked through Calendly", () => {
    expect(classifyEvent(sales, clients).kind).toBe("sales");
    expect(externalsOf(sales)).toEqual([{ email: "ana@glowmedspa.com", name: "Ana Ruiz" }]);
  });
  it("a client booking the Discovery Call link is still a client call (by email, company domain or name)", () => {
    expect(classifyEvent({ ...sales, attendees: [{ email: "owner@crustpizza.com" }] }, clients).kind).toBe("client");
    expect(classifyEvent({ ...sales, attendees: [{ email: "chef@crustpizza.com" }] }, clients).kind).toBe("client");
    expect(classifyEvent({ ...sales, summary: "Discovery Call: Angry Chickz", attendees: [{ email: "someone@gmail.com" }] }, clients).kind).toBe("client");
    expect(classifyEvent({ ...sales, attendees: [{ email: "x@gmail.com" }], description: "Company name: Crust Pizza" }, clients).kind).toBe("client");
  });
  it("internal-only, cancelled, all-day, declined and vendor meetings are left alone", () => {
    expect(classifyEvent({ ...sales, attendees: [{ email: "kyle@kaizenmarketing.agency" }, { email: "santi@kaizenmarketing.agency" }] }, clients).kind).toBe("internal");
    expect(classifyEvent({ ...sales, status: "cancelled" }, clients).kind).toBe("skip");
    expect(classifyEvent({ ...sales, start: { date: "2026-11-26" } }, clients).kind).toBe("skip");
    expect(classifyEvent({ ...sales, attendees: [{ email: "kyle@kaizenmarketing.agency", self: true, responseStatus: "declined" }, { email: "ana@glowmedspa.com" }] }, clients).kind).toBe("skip");
    expect(classifyEvent({ ...sales, summary: "Meta rep check-in", description: "" }, clients).kind).toBe("other");
    expect(classifyEvent({ ...sales, summary: "Interview: video editor candidate", description: "" }, clients).kind).toBe("other");
  });
  it("Calendly's own addresses aren't guests", () => {
    expect(externalsOf({ ...sales, attendees: [...(sales.attendees ?? []), { email: "notifications@calendly.com" }] })).toHaveLength(1);
  });
  it("one meeting, one brief: the iCalUID is the key across calendars", () => {
    expect(eventKey(sales)).toBe("uid-1@google.com");
    expect(eventKey({ ...sales, iCalUID: null })).toBe("ev1");
  });
});

describe("sales call briefs: when, who, what changed", () => {
  it("due 18 hours before; booked later than that, at once; never after it starts", () => {
    const start = "2026-11-26T15:00:00Z";
    expect(briefDue(start, new Date("2026-11-25T20:00:00Z"))).toBe(false); // 19h before
    expect(briefDue(start, new Date("2026-11-25T21:30:00Z"))).toBe(true); // 17.5h before
    expect(briefDue(start, new Date("2026-11-26T14:00:00Z"))).toBe(true); // booked an hour before
    expect(briefDue(start, new Date("2026-11-26T15:01:00Z"))).toBe(false);
  });
  it("a change to the time, guests or answers changes the fingerprint; nothing else does", () => {
    const h = eventHash(sales);
    expect(eventHash({ ...sales, htmlLink: "x" })).toBe(h);
    expect(eventHash({ ...sales, start: at("2026-11-26T16:00:00Z") })).not.toBe(h);
    expect(eventHash({ ...sales, attendees: [...(sales.attendees ?? []), { email: "partner@glowmedspa.com" }] })).not.toBe(h);
    expect(eventHash({ ...sales, description: `${calendly} more` })).not.toBe(h);
  });
  it("the organizer runs it; else the Kaizen attendee who works sales; else the calendar it was on", () => {
    const team = [
      { id: "kyle", email: "kyle@kaizenmarketing.agency", sells: true },
      { id: "maria", email: "maria@kaizenmarketing.agency", sells: false },
      { id: "head", email: "head@kaizenmarketing.agency", sells: true },
    ];
    expect(runnerOf(sales, team, "maria@kaizenmarketing.agency")).toBe("kyle");
    const external = { ...sales, organizer: { email: "ana@glowmedspa.com" }, attendees: [{ email: "maria@kaizenmarketing.agency" }, { email: "head@kaizenmarketing.agency" }, { email: "ana@glowmedspa.com" }] };
    expect(runnerOf(external, team, "maria@kaizenmarketing.agency")).toBe("head");
    expect(runnerOf({ ...external, attendees: [{ email: "ana@glowmedspa.com" }] }, team, "maria@kaizenmarketing.agency")).toBe("maria");
  });
});

describe("sales call briefs: reading the booking", () => {
  it("reads Calendly's questions and answers", () => {
    const a = bookingAnswers(calendly);
    expect(a).toContainEqual({ q: "Company name", a: "Glow Med Spa" });
    expect(a).toContainEqual({ q: "What's your monthly marketing budget?", a: "$3,000 - $5,000" });
    expect(a.find((x) => /prepare/.test(x.q))?.a).toMatch(/filler bookings/);
    expect(a.some((x) => /Event Name|Location/.test(x.q))).toBe(false);
  });
  it("the business and its site come from the answers, else the title or the guest's company domain", () => {
    expect(businessOf(sales)).toBe("Glow Med Spa");
    expect(siteOf(sales)).toBe("https://glowmedspa.com");
    expect(businessOf({ ...sales, description: "", summary: "Bayshore Body <> Kaizen" })).toBe("Bayshore Body");
    expect(businessOf({ ...sales, description: "", summary: "Intro (Sunshine Pools)" })).toBe("Sunshine Pools");
    expect(businessOf({ ...sales, description: "", summary: "Chat", attendees: [{ email: "jo@tampa-roofing.com" }] })).toBe("Tampa Roofing");
    expect(siteOf({ ...sales, description: "", attendees: [{ email: "jo@gmail.com" }] })).toBeNull();
  });
  it("the item reads like the owner asked", () => {
    const now = new Date("2026-11-25T21:30:00Z");
    expect(whenLabel("2026-11-26T15:00:00Z", now)).toBe("tomorrow 10am");
    expect(briefTitle("Glow Med Spa", "2026-11-26T15:00:00Z", now)).toBe("Sales call with Glow Med Spa tomorrow 10am: brief ready");
    expect(whenLabel("2026-11-25T23:30:00Z", now)).toBe("today 6:30pm");
  });
});

describe("sales call briefs: the brief and talking to the Sales agent about it", () => {
  const b = cleanCallBrief({ who: "A two-location med spa", they_want: "More filler bookings", fit: { score: 140, why: "High ticket" }, services: [{ service: "Meta advertising package", why: "No ads", price: "$1,000/month" }, { why: "nameless" }], objections: [{ objection: "Too pricey", answer: "Month to month" }], discovery_questions: ["Which location is slower?"], proof: [], next_step: "Offer a free audit", watch_outs: [], pitch_ideas: ["Your reviews are the ad"] }, { booking: bookingAnswers(calendly), in_motion: null });
  it("cleans the model's brief", () => {
    expect(b.fit.score).toBe(100);
    expect(b.services).toHaveLength(1);
    expect(b.booking.length).toBeGreaterThan(2);
  });
  it("lines saved from a conversation join the brief once", () => {
    const n = addToBrief(addToBrief(b, "pitch_ideas", ["Lead with Westchase", "your reviews are the ad"]), "pitch_ideas", ["Lead with Westchase"]);
    expect(n.pitch_ideas).toEqual(["Your reviews are the ad", "Lead with Westchase"]);
  });
  it("reads as text with the internal-proof rule", () => {
    const t = callBriefText("Glow Med Spa", "tomorrow 10am", { ...b, proof: ["A med spa on Meta"] });
    expect(t).toMatch(/Sales call with Glow Med Spa, tomorrow 10am/);
    expect(t).toMatch(/1\. Which location is slower\?/);
    expect(t).toMatch(/never by name/);
  });
  it("a call can carry a prospect, and the Sales agent is told to use it and save what it finds", () => {
    const ctx = parseCallContext({ screen: "a sales call brief", prospectId: "11111111-2222-3333-4444-555555555555" });
    expect(ctx?.prospectId).toBe("11111111-2222-3333-4444-555555555555");
    expect(parseCallContext({ screen: "x", prospectId: "not-an-id" })?.prospectId).toBeUndefined();
    const out = contextPrompt({ screen: "a sales call brief", prospect: { name: "Glow Med Spa", text: "brief here" } });
    expect(out).toContain('<the_prospect name="Glow Med Spa">');
    expect(out).toContain("save_to_brief");
  });
});

describe("sales call briefs: access and stages", () => {
  it("the Sales pages are the execs' only; anyone else running the call gets the brief in their item's sheet", () => {
    const editor = { role: "video_editor", isExec: false, isLead: false };
    const lead = { role: "head_of_meta", isExec: false, isLead: true };
    for (const who of [editor, lead]) {
      expect(mayOpen("/sales/briefs/abc", who).ok).toBe(false);
      expect(mayOpen("/sales", who).ok).toBe(false);
    }
    expect(mayOpen("/sales/briefs/abc", { role: "coo", isExec: true }).ok).toBe(true);
    expect(briefHref("b1", true)).toBe("/sales/briefs/b1");
    expect(briefHref("b1", false)).toBe("/pipeline?block=needs&item=salesbrief%3Ab1");
    expect(mayOpen(briefHref("b1", false), editor).ok).toBe(true);
  });
  it("a booked call moves the prospect to 'call booked' but never back", () => {
    expect(PROSPECT_STATUSES).toContain("call_booked");
    expect(forwardStatus("researched", "call_booked")).toBe("call_booked");
    expect(forwardStatus("proposal", "call_booked")).toBe("proposal");
  });
});
