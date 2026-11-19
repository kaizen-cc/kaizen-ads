import { describe, expect, it } from "vitest";
import { asanaRevisions, byDue, forMaker, inMakerPool, isMaker, makerItem, makerNextItem, makerPool, urgencyOf, whenLabel } from "@/lib/maker-day-core";

describe("who is a maker", () => {
  it("graphic designers and video editors, not their leads or anyone else", () => {
    expect(isMaker("graphic_designer")).toBe(true);
    expect(isMaker("video_editor")).toBe(true);
    for (const r of ["lead_graphic_designer", "lead_video_editor", "head_of_creative", "media_buyer", "executive", null]) expect(isMaker(r)).toBe(false);
  });
  it("each makes for their own pool", () => {
    expect(makerPool("video_editor")).toBe("videos");
    expect(makerPool("graphic_designer")).toBe("images");
    expect(inMakerPool("graphic_designer", "carousel")).toBe(true);
    expect(inMakerPool("graphic_designer", "video")).toBe(false);
    expect(inMakerPool("video_editor", "video")).toBe(true);
  });
});

describe("no client metrics ever reach a maker", () => {
  it("keeps their plate, their radar and messages that are theirs", () => {
    for (const k of ["mine:asana:1", "mine:ticket:2", "mine:task:3", "radar:draft:4", "radar:change:5", "owed:6", "owed2:7", "said:8", "said2:9"]) expect(makerItem(k)).toBe(true);
  });
  it("drops accounts, social and email lines, allotments, briefs, ads, onboarding and someone else's escalations", () => {
    for (const k of ["social-quiet:c1", "social-target:c1", "email-score:c1", "kpi:t1", "allot-behind:c1", "brief:s1", "fatigue:c1:a1", "attention:x", "onboarding:c1", "owed-lead:1", "said-lead:2", "promise:3", "contact:c1", "fire:c1"]) expect(makerItem(k)).toBe(false);
    expect(forMaker([{ key: "mine:asana:1" }, { key: "social-quiet:mcintyres" }, { key: "radar:call:2" }]).map((i) => i.key)).toEqual(["mine:asana:1", "radar:call:2"]);
  });
  it("Next for me keeps their own work only", () => {
    for (const k of ["ticket", "review", "task", "direction", "ask"]) expect(makerNextItem(k)).toBe(true);
    for (const k of ["kpi", "fatigue", "allotment", "client", "sprint", "refresh", "intake"]) expect(makerNextItem(k)).toBe(false);
  });
});

describe("their plate, by urgency", () => {
  const today = "2026-11-19";
  it("overdue, due today, sent back, this week, later", () => {
    expect(urgencyOf({ due: "2026-11-17", stage: "in_production" }, today)).toBe("overdue");
    expect(urgencyOf({ due: "2026-11-19", stage: "requested" }, today)).toBe("today");
    expect(urgencyOf({ due: "2026-11-24", stage: "client_revision" }, today)).toBe("revision");
    expect(urgencyOf({ due: "2026-11-24", stage: "in_production" }, today)).toBe("week");
    expect(urgencyOf({ due: "2026-12-10", stage: "requested" }, today)).toBe("later");
    expect(urgencyOf({ due: null, stage: "requested" }, today)).toBe("later");
  });
  it("lists overdue first, then due soonest, undated last", () => {
    const list = byDue([
      { id: "a", due: null, stage: "requested" },
      { id: "b", due: "2026-11-25", stage: "requested" },
      { id: "c", due: "2026-11-12", stage: "in_production" },
      { id: "d", due: "2026-11-20", stage: "requested" },
    ]);
    expect(list.map((t) => t.id)).toEqual(["c", "d", "b", "a"]);
  });
  it("says when, in words", () => {
    expect(whenLabel("2026-11-19", today)).toBe("Due today");
    expect(whenLabel("2026-11-20", today)).toBe("Due tomorrow");
    expect(whenLabel("2026-11-18", today)).toBe("Was due yesterday");
    expect(whenLabel("2026-11-15", today)).toBe("Was due 4 days ago");
    expect(whenLabel(null, today)).toBe("No due date");
  });
  it("counts an Asana task's rounds of changes from its column moves", () => {
    expect(
      asanaRevisions([
        { from: "Creative Brief", to: "In Progress" },
        { from: "In Progress", to: "Creative for Review" },
        { from: "Creative for Review", to: "In Progress" },
        { from: "Sent to Client", to: "Client Revision" },
      ]),
    ).toBe(2);
    expect(asanaRevisions(null)).toBe(0);
  });
});
