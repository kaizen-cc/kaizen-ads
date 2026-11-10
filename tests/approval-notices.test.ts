import { describe, expect, it } from "vitest";
import { addBusinessDays, businessClamp, chasers, clientMessage, dueTimes, isBusinessTime, noticeKey, nyWall, planClient, type Logged, type Waiting } from "@/lib/approval-notices-core";

// Client notifications and chasing on creative with the client: business time (1 and 2 business days on the business
// clock, Mon to Fri 8am to 6pm New York), one post per batch and day, reminders that never go twice, auto-approval only
// for clients who opted in, customer success (or the execs) at 48 business hours, and white label text with no agency.

const ny = (s: string) => {
  const [d, t = "00:00"] = s.split(" ");
  const [y, m, day] = d.split("-").map(Number);
  const [h, min] = t.split(":").map(Number);
  return nyWall(y, m, day, h, min);
};
const iso = (s: string) => ny(s).toISOString();

describe("business time", () => {
  it("counts 24h and 48h as 1 and 2 business days at the same time of day", () => {
    // Tuesday 10am → Wednesday 10am, Thursday 10am
    const d = dueTimes(ny("2026-11-10 10:00"));
    expect(d.remind24.toISOString()).toBe(iso("2026-11-11 10:00"));
    expect(d.remind48.toISOString()).toBe(iso("2026-11-12 10:00"));
  });

  it("skips the weekend", () => {
    // Friday 3pm → Monday 3pm, Tuesday 3pm
    const d = dueTimes(ny("2026-11-13 15:00"));
    expect(d.remind24.toISOString()).toBe(iso("2026-11-16 15:00"));
    expect(d.remind48.toISOString()).toBe(iso("2026-11-17 15:00"));
  });

  it("starts the clock at 8am the next business day when told in the evening", () => {
    // Friday 7pm: the clock starts Monday 8am, so the reminders are Tuesday and Wednesday at 8am
    expect(businessClamp(ny("2026-11-13 19:00")).toISOString()).toBe(iso("2026-11-16 08:00"));
    const d = dueTimes(ny("2026-11-13 19:00"));
    expect(d.remind24.toISOString()).toBe(iso("2026-11-17 08:00"));
    expect(d.remind48.toISOString()).toBe(iso("2026-11-18 08:00"));
    // Wednesday 10pm → Thursday 8am start → Friday 8am, Monday 8am
    const w = dueTimes(ny("2026-11-11 22:00"));
    expect(w.remind24.toISOString()).toBe(iso("2026-11-13 08:00"));
    expect(w.remind48.toISOString()).toBe(iso("2026-11-16 08:00"));
  });

  it("starts at 8am the same day when told before opening, and over a Saturday", () => {
    expect(businessClamp(ny("2026-11-10 06:30")).toISOString()).toBe(iso("2026-11-10 08:00"));
    expect(addBusinessDays(ny("2026-11-14 11:00"), 1).toISOString()).toBe(iso("2026-11-17 08:00"));
  });

  it("skips holidays", () => {
    const holidays = new Set(["2026-11-26", "2026-11-27"]);
    // Wednesday before Thanksgiving, 2pm → Monday 2pm, Tuesday 2pm
    const d = dueTimes(ny("2026-11-25 14:00"), holidays);
    expect(d.remind24.toISOString()).toBe(iso("2026-11-30 14:00"));
    expect(d.remind48.toISOString()).toBe(iso("2026-12-01 14:00"));
  });

  it("keeps the wall time across the change to winter time", () => {
    // DST ends Sunday Nov 1 2026: Friday Oct 30 9am → Monday Nov 2 9am (New York)
    expect(addBusinessDays(ny("2026-10-30 09:00"), 1).toISOString()).toBe(iso("2026-11-02 09:00"));
  });

  it("knows business hours", () => {
    expect(isBusinessTime(ny("2026-11-10 08:00"))).toBe(true);
    expect(isBusinessTime(ny("2026-11-10 17:59"))).toBe(true);
    expect(isBusinessTime(ny("2026-11-10 18:00"))).toBe(false);
    expect(isBusinessTime(ny("2026-11-14 12:00"))).toBe(false);
  });
});

const item = (id: string, roundAt: string, pieces = 2): Waiting => ({ requestId: id, number: 1000, title: `Ticket ${id}`, roundAt: iso(roundAt), pieces });
const sent = (entries: [string, string, string?][]): Logged => new Map(entries.map(([k, at, status]) => [k, { at: iso(at), status: status ?? "sent" }]));

describe("the plan for a client", () => {
  it("announces a settled batch once, in one post", () => {
    const items = [item("a", "2026-11-10 09:00"), item("b", "2026-11-10 09:05")];
    const p = planClient({ items, logged: new Map(), reach: true, optedIn: false, now: ny("2026-11-10 09:30") });
    expect(p.announce.map((w) => w.requestId)).toEqual(["a", "b"]);
    // Still settling: the newest went over a minute ago
    expect(planClient({ items, logged: new Map(), reach: true, optedIn: false, now: ny("2026-11-10 09:06") }).announce).toEqual([]);
  });

  it("never posts twice for the same item, and waits for tomorrow after today's post", () => {
    const a = item("a", "2026-11-10 09:00");
    const logged = sent([[noticeKey("ready", "a", a.roundAt), "2026-11-10 09:30"]]);
    expect(planClient({ items: [a], logged, reach: true, optedIn: false, now: ny("2026-11-10 10:00") }).announce).toEqual([]);
    // A second batch the same day waits
    const b = item("b", "2026-11-10 13:00");
    expect(planClient({ items: [a, b], logged, reach: true, optedIn: false, now: ny("2026-11-10 14:00") }).announce).toEqual([]);
    // ...and goes the next business day
    expect(planClient({ items: [a, b], logged, reach: true, optedIn: false, now: ny("2026-11-11 08:15") }).announce.map((w) => w.requestId)).toEqual(["b"]);
  });

  it("a new round of review is a new item", () => {
    const first = item("a", "2026-11-03 09:00");
    const again = item("a", "2026-11-10 09:00");
    const logged = sent([[noticeKey("ready", "a", first.roundAt), "2026-11-03 09:30"]]);
    expect(planClient({ items: [again], logged, reach: true, optedIn: false, now: ny("2026-11-10 10:00") }).announce).toHaveLength(1);
  });

  it("posts nothing outside business hours or with a switch off", () => {
    const items = [item("a", "2026-11-10 09:00")];
    expect(planClient({ items, logged: new Map(), reach: true, optedIn: false, now: ny("2026-11-10 19:00") }).announce).toEqual([]);
    expect(planClient({ items, logged: new Map(), reach: false, optedIn: false, now: ny("2026-11-10 10:00") }).announce).toEqual([]);
  });

  it("reminds at 24 and 48 business hours, each once", () => {
    const a = item("a", "2026-11-13 14:00");
    const told = sent([[noticeKey("ready", "a", a.roundAt), "2026-11-13 15:00"]]);
    // Friday 3pm told: Monday 2:59pm nothing, Monday 3pm the first reminder
    expect(planClient({ items: [a], logged: told, reach: true, optedIn: false, now: ny("2026-11-16 14:59") }).remind24).toEqual([]);
    expect(planClient({ items: [a], logged: told, reach: true, optedIn: false, now: ny("2026-11-16 15:00") }).remind24).toHaveLength(1);
    const after24 = new Map([...told, ...sent([[noticeKey("remind_24", "a", a.roundAt), "2026-11-16 15:00"]])]);
    expect(planClient({ items: [a], logged: after24, reach: true, optedIn: false, now: ny("2026-11-16 17:00") }).remind24).toEqual([]);
    // Tuesday 3pm: the second, and customer success
    const p = planClient({ items: [a], logged: after24, reach: true, optedIn: false, now: ny("2026-11-17 15:00") });
    expect(p.remind48).toHaveLength(1);
    expect(p.escalate).toHaveLength(1);
    expect(p.autoApprove).toEqual([]);
    const after48 = new Map([...after24, ...sent([[noticeKey("remind_48", "a", a.roundAt), "2026-11-17 15:00"], [noticeKey("escalated", "a", a.roundAt), "2026-11-17 15:00"]])]);
    const q = planClient({ items: [a], logged: after48, reach: true, optedIn: false, now: ny("2026-11-18 10:00") });
    expect([q.remind24, q.remind48, q.escalate, q.autoApprove]).toEqual([[], [], [], []]);
  });

  it("auto-approves only for clients who opted in, and only what they were told about", () => {
    const a = item("a", "2026-11-10 09:00");
    const told = sent([[noticeKey("ready", "a", a.roundAt), "2026-11-10 09:30"]]);
    const at48 = ny("2026-11-12 09:30");
    const opted = planClient({ items: [a], logged: told, reach: true, optedIn: true, now: at48 });
    expect(opted.autoApprove).toHaveLength(1);
    expect(opted.remind48).toEqual([]);
    expect(opted.escalate).toEqual([]);
    const notOpted = planClient({ items: [a], logged: told, reach: true, optedIn: false, now: at48 });
    expect(notOpted.autoApprove).toEqual([]);
    // Opted in but never told (the switches were off): nothing is approved for them; customer success chases
    const untold = planClient({ items: [a], logged: new Map(), reach: false, optedIn: true, now: at48 });
    expect(untold.autoApprove).toEqual([]);
    expect(untold.escalate).toHaveLength(1);
    // Held (couldn't reach them) doesn't count as told
    const held = planClient({ items: [a], logged: sent([[noticeKey("ready", "a", a.roundAt), "2026-11-10 09:30", "held"]]), reach: true, optedIn: true, now: at48 });
    expect(held.autoApprove).toEqual([]);
    // Already approved: never twice
    const done = new Map([...told, ...sent([[noticeKey("auto_approved", "a", a.roundAt), "2026-11-12 09:30"]])]);
    expect(planClient({ items: [a], logged: done, reach: true, optedIn: true, now: ny("2026-11-12 11:00") }).autoApprove).toEqual([]);
  });

  it("escalates to customer success from when it went to them when the client was never told", () => {
    const a = item("a", "2026-11-13 19:00");
    expect(planClient({ items: [a], logged: new Map(), reach: false, optedIn: false, now: ny("2026-11-17 07:59") }).escalate).toEqual([]);
    expect(planClient({ items: [a], logged: new Map(), reach: false, optedIn: false, now: ny("2026-11-18 08:00") }).escalate).toHaveLength(1);
  });
});

describe("who chases", () => {
  it("is the customer success seat on the client, primary first", () => {
    expect(
      chasers(
        [
          { profile_id: "buyer", role: "meta_buyer" },
          { profile_id: "cs2", role: "coordinator", is_primary: false },
          { profile_id: "cs1", role: "coordinator", is_primary: true },
        ],
        ["exec"],
      ),
    ).toEqual(["cs1", "cs2"]);
  });
  it("falls back to the execs when nobody holds it", () => {
    expect(chasers([{ profile_id: "buyer", role: "meta_buyer" }], ["e1", "e2", "e1"])).toEqual(["e1", "e2"]);
  });
});

describe("what the client reads", () => {
  const url = "https://ads.kaizenmarketing.agency/c/crust-pizza";
  it("says how many, with the portal link", () => {
    const m = clientMessage("ready", { count: 3, url });
    expect(m.slack).toContain("3 new creatives are ready for your review");
    expect(m.slack).toContain(`<${url}|`);
    expect(m.cta?.url).toBe(url);
    expect(clientMessage("ready", { count: 1, url }).slack).toContain("1 new creative is ready");
  });
  it("never mentions the agency for a white label client", () => {
    for (const kind of ["ready", "remind_24", "remind_48", "auto_approved"] as const) {
      const m = clientMessage(kind, { count: 2, url, whiteLabel: true });
      const all = [m.slack, m.subject, m.title, ...m.lines].join("\n");
      expect(all.toLowerCase()).not.toContain("kaizen");
      expect(all).not.toContain("http");
      expect(m.cta).toBeUndefined();
      expect(m.slack.length).toBeGreaterThan(20);
    }
  });
});
