import { describe, expect, it } from "vitest";
import { groupLog, lengthLabel, projectMonth, sortPeople, teamOf, workingDaysLeft, type UsagePerson } from "@/lib/calls-usage-core";
import { mayOpen } from "@/lib/ai-access-core";

describe("Calls & usage: the owner only", () => {
  it("the assistant opens it for the owner, never for an exec or while viewing as someone", () => {
    expect(mayOpen("/settings?tab=calls", { role: "executive", isExec: true, canViewAs: true }).ok).toBe(true);
    expect(mayOpen("/settings?tab=calls&view=usage", { role: "executive", isExec: true }).ok).toBe(false);
    expect(mayOpen("/settings?tab=calls", { role: "executive", isExec: true, canViewAs: true, viewAs: { actorId: "x" } }).ok).toBe(false);
  });
});

describe("teams", () => {
  it("puts each role on its line, executives first whatever the role says", () => {
    expect(teamOf("media_buyer")).toBe("ads");
    expect(teamOf("head_of_google")).toBe("ads");
    expect(teamOf("lead_graphic_designer")).toBe("creative");
    expect(teamOf("copywriter")).toBe("creative");
    expect(teamOf("email_builder")).toBe("email");
    expect(teamOf("head_of_social")).toBe("social");
    expect(teamOf("tracking_specialist")).toBe("cs");
    expect(teamOf("head_of_meta", true)).toBe("execs");
    expect(teamOf(null)).toBe("other");
  });
});

describe("the month-end projection", () => {
  it("counts the working days after today", () => {
    expect(workingDaysLeft("2026-11-24")).toBe(4); // Wed 25 to Mon 30, weekend skipped
    expect(workingDaysLeft("2026-11-30")).toBe(0);
  });
  it("is month to date plus the pace per active day times the working days left", () => {
    const p = projectMonth(100, 10, "2026-11-24");
    expect(p.pace).toBe(10);
    expect(p.projected).toBe(140);
    expect(projectMonth(0, 0, "2026-11-24").projected).toBe(0);
  });
});

describe("the call log", () => {
  it("flagged first, then by team, newest first", () => {
    const g = groupLog([
      { id: "1", kind: "call", team: "ads", flagged: false, at: "2026-11-20T10:00:00Z" },
      { id: "2", kind: "chat", team: "execs", flagged: false, at: "2026-11-21T10:00:00Z" },
      { id: "3", kind: "call", team: "ads", flagged: true, at: "2026-11-19T10:00:00Z" },
      { id: "4", kind: "call", team: "ads", flagged: false, at: "2026-11-22T10:00:00Z" },
    ]);
    expect(g.map((x) => x.flagged)).toEqual([true, false]);
    expect(g[1].teams.map((t) => t.team)).toEqual(["execs", "ads"]);
    expect(g[1].teams[1].entries.map((e) => e.id)).toEqual(["4", "1"]);
  });
  it("says lengths plainly", () => {
    expect(lengthLabel(40)).toBe("40s");
    expect(lengthLabel(720)).toBe("12m");
    expect(lengthLabel(3900)).toBe("1h 05m");
  });
  it("sorts people by the column asked", () => {
    const base = { team: "ads" as const, calls: 0, chats: 0, minutes: 0, messages: 0, input: 0, output: 0, cacheW: 0, cacheR: 0, cost: 0, projected: 0, activeDays: 1, daily: [] };
    const people: UsagePerson[] = [
      { ...base, id: "a", name: "Bea", cost: 5, input: 10 },
      { ...base, id: "b", name: "Al", cost: 9, input: 1 },
    ];
    expect(sortPeople(people, "cost").map((p) => p.id)).toEqual(["b", "a"]);
    expect(sortPeople(people, "tokens").map((p) => p.id)).toEqual(["a", "b"]);
    expect(sortPeople(people, "name").map((p) => p.id)).toEqual(["b", "a"]);
  });
});
