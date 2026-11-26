import { describe, expect, it } from "vitest";
import { dueChips, fromEtLocal, matchTeammate, mayEditTicket, parseDue, toEtLocal } from "@/lib/ticket-edit-core";

// A ticket's "with X · Due …" edited on the ticket like Asana (owner, Nov 26 2026)

describe("who may edit a ticket's assignee and due date", () => {
  it("a lead, an exec or the person it's with; nobody else", () => {
    expect(mayEditTicket({ id: "a", isLead: true }, "b")).toBe(true);
    expect(mayEditTicket({ id: "a", isExec: true }, null)).toBe(true);
    expect(mayEditTicket({ id: "b" }, "b")).toBe(true);
    expect(mayEditTicket({ id: "c" }, "b")).toBe(false);
    expect(mayEditTicket({ id: "c" }, null)).toBe(false);
    expect(mayEditTicket(null, "b")).toBe(false);
  });
});

describe("due dates in Eastern time", () => {
  it("round-trips a wall-clock time, in and out of daylight saving", () => {
    expect(fromEtLocal("2026-11-30T15:06")).toBe("2026-11-30T20:06:00.000Z");
    expect(fromEtLocal("2026-07-01T09:00")).toBe("2026-07-01T13:00:00.000Z");
    expect(toEtLocal("2026-11-30T20:06:09.291Z")).toBe("2026-11-30T15:06");
  });
  it("reads what someone said: a day alone is 5 PM", () => {
    expect(parseDue("2026-12-01")).toBe("2026-12-01T22:00:00.000Z");
    expect(parseDue("2026-12-01 17:30")).toBe("2026-12-01T22:30:00.000Z");
    expect(parseDue("Tuesday")).toBeNull();
    expect(parseDue("2026-12-01 25:00")).toBeNull();
  });
  it("quick picks keep the due time of day: Today, Tomorrow, Next Mon, +1 week", () => {
    // Thursday Nov 26 2026, 10 AM Eastern; due Mon Nov 30, 3:06 PM
    const now = new Date("2026-11-26T15:00:00Z");
    const chips = dueChips(now, "2026-11-30T20:06:00Z");
    expect(chips.map((c) => c.label)).toEqual(["Today", "Tomorrow", "Next Mon", "+1 week"]);
    expect(chips.map((c) => toEtLocal(c.iso))).toEqual(["2026-11-26T15:06", "2026-11-27T15:06", "2026-11-30T15:06", "2026-12-07T15:06"]);
    // No due date yet: 5 PM, a week from today; on a Monday, Next Mon is a week on
    const monday = dueChips(new Date("2026-11-30T15:00:00Z"), null);
    expect(monday.map((c) => toEtLocal(c.iso))).toEqual(["2026-11-30T17:00", "2026-12-01T17:00", "2026-12-07T17:00", "2026-12-07T17:00"]);
  });
});

describe("the assistant's teammate match", () => {
  const people = [
    { id: "1", name: "Jesus Ortega", role: "video_editor" },
    { id: "2", name: "Nelson Diaz", role: "graphic_designer" },
    { id: "3", name: "Jessica Lane", role: "copywriter" },
  ];
  it("a first name, a full name, or a role", () => {
    expect(matchTeammate(people, "Jesus").map((p) => p.id)).toEqual(["1"]);
    expect(matchTeammate(people, "nelson diaz").map((p) => p.id)).toEqual(["2"]);
    expect(matchTeammate(people, "the video editor").map((p) => p.id)).toEqual(["1"]);
    expect(matchTeammate(people, "Zed")).toEqual([]);
  });
});
