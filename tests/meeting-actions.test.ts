import { describe, expect, it } from "vitest";
import { execOnMeeting, meetingRef, ownerFor, peopleMatter, type Teammate } from "@/lib/meeting-actions-core";

const team: Teammate[] = [
  { id: "k", full_name: "Kyle Barry", email: "kyle@kaizenmarketing.agency", is_exec: true },
  { id: "r", full_name: "Ryan Brand", email: "ryan@kaizenmarketing.agency", is_exec: true },
  { id: "l", full_name: "Lawrence Samuel", email: "lawrence@kaizenmarketing.agency", is_exec: false },
  { id: "s1", full_name: "Sam Ortiz", email: "sam.o@kaizenmarketing.agency", is_exec: false },
  { id: "s2", full_name: "Sam Lee", email: "sam.l@kaizenmarketing.agency", is_exec: false },
];

describe("exec meeting notes feed tasks for their owners", () => {
  it("files an item to the teammate it names, never a guess", () => {
    expect(ownerFor("Kyle Barry", team)?.id).toBe("k");
    expect(ownerFor("kyle", team)?.id).toBe("k");
    expect(ownerFor("ryan@kaizenmarketing.agency", team)?.id).toBe("r");
    expect(ownerFor("Sam", team)).toBeNull();
    expect(ownerFor("Creative team", team)).toBeNull();
  });
  it("reads meetings an executive ran or sat in on, by host or attendee", () => {
    expect(execOnMeeting("santi@x.com", ["Ryan Brand Kyle Barry Santi Lozano"], team)).toBe(true);
    expect(execOnMeeting("kyle@kaizenmarketing.agency", [], team)).toBe(true);
    expect(execOnMeeting("lawrence@kaizenmarketing.agency", ["Lawrence Samuel"], team)).toBe(false);
  });
  it("files each item once", () => {
    expect(meetingRef("c1", 2)).toBe("meet:c1:2");
  });
});

describe("people matters never become tasks (owner, Nov 24 2026)", () => {
  it("drops items the model flags as personnel", () => {
    expect(peopleMatter({ owner: "Ryan Brand", task: "Talk to Lawrence", detail: "", personnel: true, about: ["Lawrence Samuel"] }, team)).toBe(true);
  });
  it("drops items that name a people matter even when the flag is missed", () => {
    expect(peopleMatter({ owner: "Ryan Brand", task: "Prepare Lawrence's performance review", detail: "", personnel: false, about: [] }, team)).toBe(true);
    expect(peopleMatter({ owner: "Kyle Barry", task: "Tell the client the designer is being let go", detail: "we are letting him go Friday", personnel: false, about: [] }, team)).toBe(true);
  });
  it("never gives someone a task drawn from a conversation about them", () => {
    expect(peopleMatter({ owner: "Lawrence Samuel", task: "Speed up turnaround", detail: "", personnel: false, about: ["Lawrence Samuel"] }, team)).toBe(true);
  });
  it("keeps ordinary work, including ad words that look similar", () => {
    expect(peopleMatter({ owner: "Kyle Barry", task: "Audit OceanBox and raise the Meta budget", detail: "Meta warning on the ad set", personnel: false, about: [] }, team)).toBe(false);
  });
});
