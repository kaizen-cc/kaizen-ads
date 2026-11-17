import { describe, expect, it } from "vitest";
import { activeDays, agoShort, changeLines, changeText, diffChanges, lastManual, type ObjectSnap } from "@/lib/email-ops/changes-core";
import { parseCampaignSnaps, parseFlowSnaps, parseFormSnaps, parseNamedSnaps } from "@/lib/klaviyo/changes-core";
import { emailScore, type EmailInputs } from "@/lib/email-score";
import { autoMoves, movement, plainMessage, snapshotOf, tally, verdictOf, workLine } from "@/lib/email-ops/sprint-core";

const since = "2026-11-10T00:00:00Z";
const now = "2026-11-17T12:00:00Z";
const flow = (status: string, updated = "2026-11-01T10:00:00Z"): ObjectSnap => ({ type: "flow", id: "F1", name: "Welcome", status, created: "2026-10-01T10:00:00Z", updated });

describe("change history diff", () => {
  it("sees what was created and edited since the last read, and not before", () => {
    const { events } = diffChanges(
      [
        { type: "campaign", id: "C1", name: "Black Friday", status: "Draft", created: "2026-11-15T09:00:00Z", updated: "2026-11-16T14:00:00Z" },
        { type: "template", id: "T1", name: "Old", status: null, created: "2026-01-01T00:00:00Z", updated: "2026-02-01T00:00:00Z" },
        { type: "list", id: "L1", name: "VIP", status: null, created: "2026-11-12T08:00:00Z", updated: "2026-11-12T08:00:00Z" },
      ],
      null,
      { since, now },
    );
    expect(events.map((e) => `${e.type}:${e.kind}`)).toEqual(["campaign:edited", "campaign:created", "list:created"]);
    expect(events.every((e) => e.manual)).toBe(true);
  });

  it("an edit right at creation is the creation, not an edit", () => {
    const { events } = diffChanges([{ type: "segment", id: "S1", name: "Engaged", status: null, created: "2026-11-12T08:00:00Z", updated: "2026-11-12T08:02:00Z" }], null, { since, now });
    expect(events.map((e) => e.kind)).toEqual(["created"]);
  });

  it("a flow switched live shows as a status change, only from the second read", () => {
    const first = diffChanges([flow("draft")], null, { since, now });
    expect(first.events).toEqual([]);
    expect(first.state.status["flow:F1"]).toBe("draft");
    const second = diffChanges([flow("live", "2026-11-17T09:00:00Z")], first.state, { since, now });
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ kind: "status", detail: "draft to live", at: "2026-11-17T09:00:00Z" });
    expect(changeText(second.events[0])).toBe('Flow "Welcome" set live (was draft)');
  });

  it("a scheduled campaign shows once as scheduled, and its send as automatic", () => {
    const sched: ObjectSnap = { type: "campaign", id: "C2", name: "Weekend", status: "Scheduled", created: "2026-11-14T09:00:00Z", updated: "2026-11-15T10:00:00Z", scheduledAt: "2026-11-18T15:00:00Z" };
    const a = diffChanges([sched], null, { since, now });
    expect(a.events.map((e) => e.kind)).toEqual(["scheduled", "created"]);
    const sent: ObjectSnap = { ...sched, status: "Sent", updated: "2026-11-16T15:05:00Z", sentAt: "2026-11-16T15:00:00Z" };
    const b = diffChanges([sent], a.state, { since, now });
    // The send bumped the updated time: that's the send, not an edit
    expect(b.events.map((e) => e.kind).sort()).toEqual(["created", "sent"]);
    const send = b.events.find((e) => e.kind === "sent")!;
    expect(send.manual).toBe(false);
    expect(lastManual(b.events)?.kind).toBe("created");
  });

  it("the same change seen twice keeps one key, so it is stored once", () => {
    const o: ObjectSnap = { type: "flow_step", id: "A1", name: "Abandoned cart", parent: "Abandoned cart", step: "SEND_EMAIL", status: "live", created: "2026-09-01T00:00:00Z", updated: "2026-11-16T11:00:00Z" };
    const a = diffChanges([o], null, { since, now });
    const b = diffChanges([o], a.state, { since, now });
    expect(a.events[0].key).toBe(b.events[0].key);
    expect(changeText(a.events[0])).toBe('Email in "Abandoned cart" edited');
  });

  it("something gone from a whole listing was removed; a partial listing keeps what it didn't see", () => {
    const a = diffChanges([flow("live"), { type: "campaign", id: "C9", name: "Old", status: "Sent", created: null, updated: null }], null, { since, now, complete: ["flow"] });
    const b = diffChanges([], a.state, { since, now, complete: ["flow"] });
    expect(b.events.map((e) => `${e.type}:${e.kind}`)).toEqual(["flow:removed"]);
    expect(changeText(b.events[0])).toBe('Flow "Welcome" removed or archived');
    expect(b.state.status["campaign:C9"]).toBe("Sent");
    expect(b.state.status["flow:F1"]).toBeUndefined();
  });

  it("a form going live is published", () => {
    const form = (status: string): ObjectSnap => ({ type: "form", id: "P1", name: "Popup", status, created: "2026-01-01T00:00:00Z", updated: "2026-11-16T12:00:00Z" });
    const a = diffChanges([form("draft")], { at: since, status: { "form:P1": "draft" } }, { since, now });
    const b = diffChanges([form("live")], a.state, { since, now });
    expect(b.events.map((e) => e.kind)).toEqual(["published"]);
  });

  it("lines for the prompts, newest first, and how many days had work", () => {
    const events = [
      { type: "campaign" as const, name: "A", kind: "created" as const, detail: null, at: "2026-11-16T10:00:00Z", manual: true },
      { type: "campaign" as const, name: "A", kind: "sent" as const, detail: null, at: "2026-11-17T10:00:00Z", manual: false },
      { type: "flow" as const, name: "W", kind: "edited" as const, detail: null, at: "2026-11-16T18:00:00Z", manual: true },
    ];
    expect(changeLines(events)[0]).toContain("went out by itself");
    expect(changeLines(events)[1]).toContain('Flow "W" edited');
    expect(activeDays(events, "2026-11-10T00:00:00Z")).toBe(1);
    expect(agoShort("2026-11-17T09:00:00Z", Date.parse(now))).toBe("3h");
    expect(agoShort("2026-11-12T12:00:00Z", Date.parse(now))).toBe("5 days");
  });
});

describe("Klaviyo answers read into the history", () => {
  it("reads campaigns, flows with their steps, named things and forms", () => {
    expect(parseCampaignSnaps({ data: [{ id: "c1", attributes: { name: "BF", status: "Scheduled", created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-11T00:00:00Z", scheduled_at: "2026-11-20T00:00:00Z" } }] })[0]).toMatchObject({ type: "campaign", status: "Scheduled", scheduledAt: "2026-11-20T00:00:00Z" });
    const flows = parseFlowSnaps({
      data: [{ id: "f1", attributes: { name: "Welcome", status: "live", created: "2026-01-01T00:00:00Z", updated: "2026-11-01T00:00:00Z" }, relationships: { "flow-actions": { data: [{ id: "a1", type: "flow-action" }] } } }, { id: "f2", attributes: { name: "Gone", archived: true } }],
      included: [{ id: "a1", type: "flow-action", attributes: { action_type: "SEND_EMAIL", status: "live", created: "2026-01-01T00:00:00Z", updated: "2026-11-15T00:00:00Z" } }],
    });
    expect(flows.map((f) => `${f.type}:${f.id}`)).toEqual(["flow:f1", "flow_step:a1"]);
    expect(flows[1]).toMatchObject({ parent: "Welcome", step: "SEND_EMAIL" });
    expect(parseNamedSnaps({ data: [{ id: "t1", attributes: { name: "Promo", created: "x", updated: "y" } }] }, "template")[0]).toMatchObject({ type: "template", created: "x", updated: "y" });
    expect(parseFormSnaps({ data: [{ id: "p1", attributes: { name: "Popup", status: "live", created_at: "a", updated_at: "b" } }] })[0]).toMatchObject({ type: "form", status: "live", created: "a", updated: "b" });
  });
});

describe("sprints and the change history", () => {
  const bad: EmailInputs = { attributed: 0.1, rpr: 0.05, deliverability: 50, campaignOpen: 0.2, campaignClick: 0.004, flowOpen: 0.3, flowClick: 0.01 };
  const start = snapshotOf(emailScore(bad), "2026-11-17T12:00:00Z");
  it("nothing ticked is only 'no action' when nothing changed in the account either", () => {
    expect(verdictOf(movement(start, start), tally(["todo"]), start, 0)).toBe("no_action");
    expect(verdictOf(movement(start, start), tally(["todo"]), start, 3)).toBe("on_track");
  });
  it("says what the account shows against the ticks", () => {
    expect(workLine(tally(["done"]), 0)).toContain("can't see the ticked moves");
    expect(workLine(tally(["todo"]), 2)).toContain("no move is ticked");
    expect(workLine(tally(["todo"]), null)).toBe("");
    expect(plainMessage("on_track", movement(start, start), tally(["doing"]), start, 1)).toContain("1 change in the email account");
  });
  it("a sprint opened by itself starts with today's and this week's moves", () => {
    expect(autoMoves([{ when: "next" }, { when: "now" }, { when: "this_week" }])).toEqual([1, 2]);
    expect(autoMoves([{ when: "next" }, { when: "next" }])).toEqual([0, 1]);
  });
});
