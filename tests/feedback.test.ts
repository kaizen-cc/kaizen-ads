import { describe, expect, it } from "vitest";
import {
  AUTO_FIX_PER_DAY,
  areaFromRoute,
  autoFixDecision,
  byPriority,
  classifyScope,
  closestGroup,
  fixOutcome,
  groupStats,
  pathLabel,
  priorityScore,
  routePattern,
  similarity,
  widerScope,
} from "@/lib/feedback-logic";

const now = new Date("2026-11-06T12:00:00Z").getTime();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

describe("where a report was left", () => {
  it("names the area from the page", () => {
    expect(areaFromRoute("/board")).toBe("Board");
    expect(areaFromRoute("/board/123")).toBe("Board");
    expect(areaFromRoute("/clients/nectr")).toBe("Clients");
    expect(areaFromRoute("/clients/nectr?tab=bible")).toBe("Brand Bible");
    expect(areaFromRoute("/winners")).toBe("Ideas");
    expect(areaFromRoute("/reports")).toBe("Reports");
    expect(areaFromRoute("/somewhere-new")).toBe("Other");
    expect(areaFromRoute(null)).toBe("Other");
  });

  it("reads the same screen the same for every client", () => {
    expect(routePattern("/clients/nectr/brand-bible?x=1")).toBe("/clients/[slug]/brand-bible");
    expect(routePattern("/board/2b1f3c4d-1111-4222-8333-444455556666")).toBe("/board/[id]");
  });
});

describe("grouping repeats", () => {
  const groups = [
    { id: "g1", type: "bug", area: "Board", title: "Upload button does nothing on the board", summary: "Clicking upload on a ticket does nothing", status: "new" },
    { id: "g2", type: "idea", area: "KPIs", title: "Show ROAS trend per week", summary: null, status: "planned" },
    { id: "g3", type: "bug", area: "Board", title: "Upload button broken", summary: null, status: "wont_fix" },
  ];

  it("scores the same words as alike and different ones as not", () => {
    expect(similarity("upload button does nothing", "the upload button does nothing at all")).toBeGreaterThan(0.6);
    expect(similarity("upload button does nothing", "ROAS chart is empty")).toBe(0);
  });

  it("puts a repeat in the group it repeats, in the same type and area", () => {
    expect(closestGroup({ type: "bug", area: "Board", text: "The upload button on the board does nothing when clicking" }, groups)).toBe("g1");
  });

  it("starts a new group for something new, and never joins a won't-fix one", () => {
    expect(closestGroup({ type: "bug", area: "Board", text: "Comments disappear after refresh" }, groups)).toBeNull();
    expect(closestGroup({ type: "bug", area: "Board", text: "Upload button broken" }, [groups[2]])).toBeNull();
  });

  it("needs a much closer match across areas", () => {
    expect(closestGroup({ type: "bug", area: "Clients", text: "upload button does nothing" }, groups)).toBeNull();
  });
});

describe("a group's counts", () => {
  it("counts reports, distinct people, the worst severity and any blocker", () => {
    const s = groupStats([
      { profileId: "a", severity: "low", blocksWork: false, createdAt: daysAgo(3) },
      { profileId: "a", severity: "high", blocksWork: false, createdAt: daysAgo(1) },
      { profileId: "b", severity: null, blocksWork: true, createdAt: daysAgo(2) },
    ]);
    expect(s).toEqual({ reports: 3, people: 2, severity: "high", blocksWork: true, firstReportedAt: daysAgo(3), lastReportedAt: daysAgo(1) });
  });

  it("is empty for no reports", () => {
    expect(groupStats([])).toMatchObject({ reports: 0, people: 0, severity: "low", blocksWork: false, firstReportedAt: null });
  });
});

describe("priority", () => {
  const base = { reports: 1, people: 1, severity: "low" as const, blocksWork: false, type: "bug", status: "new", lastReportedAt: daysAgo(1) };

  it("puts repeats first, and more people above the same person repeating", () => {
    const once = priorityScore(base, now);
    const fiveFromOne = priorityScore({ ...base, reports: 5 }, now);
    const fiveFromFive = priorityScore({ ...base, reports: 5, people: 5 }, now);
    expect(fiveFromOne).toBeGreaterThan(once);
    expect(fiveFromFive).toBeGreaterThan(fiveFromOne);
  });

  it("ranks a few people repeating a small thing above one person's medium one", () => {
    expect(priorityScore({ ...base, reports: 3, people: 3 }, now)).toBeGreaterThan(priorityScore({ ...base, severity: "medium" }, now));
  });

  it("weighs severity, blocking work and recency", () => {
    expect(priorityScore({ ...base, severity: "high" }, now)).toBeGreaterThan(priorityScore(base, now));
    expect(priorityScore({ ...base, blocksWork: true }, now)).toBeGreaterThan(priorityScore(base, now));
    expect(priorityScore(base, now)).toBeGreaterThan(priorityScore({ ...base, lastReportedAt: daysAgo(60) }, now));
  });

  it("drops closed groups to zero", () => {
    expect(priorityScore({ ...base, reports: 9, people: 4, status: "fixed" }, now)).toBe(0);
    expect(priorityScore({ ...base, status: "wont_fix" }, now)).toBe(0);
  });

  it("sorts by priority, then people, then reports", () => {
    const g = (id: string, priority: number, people: number, reports: number) => ({ id, priority, people, reports, lastReportedAt: daysAgo(1) });
    expect([g("a", 10, 1, 1), g("b", 30, 1, 1), g("c", 10, 3, 3), g("d", 10, 3, 4)].sort(byPriority).map((x) => x.id)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("which path a report takes", () => {
  const r = { aiScope: "small_bug" as const, type: "bug", severity: "low" as const, text: "The Save button label is cut off", area: "Board" };

  it("lets a small, contained bug fix itself", () => {
    expect(classifyScope(r).scope).toBe("small_bug");
  });

  it("sends ideas and feature asks to review", () => {
    expect(classifyScope({ ...r, type: "idea" }).scope).toBe("feature");
    expect(classifyScope({ ...r, aiScope: "feature" }).scope).toBe("feature");
  });

  it("never fixes data, money, ad accounts, sign-in or the database automatically, whatever the AI said", () => {
    for (const text of ["I lost my ticket notes, data lost", "the budget shows double", "it paused campaigns turned off", "logged out every hour", "permission denied for designers", "needs a migration"])
      expect(classifyScope({ ...r, text }).scope, text).toBe("big_issue");
    expect(classifyScope({ ...r, severity: "high" }).scope).toBe("big_issue");
    expect(classifyScope({ ...r, area: "Launcher" }).scope).toBe("big_issue");
    expect(classifyScope({ ...r, aiScope: "big_issue", type: "idea" }).scope).toBe("big_issue");
  });

  it("keeps a group as careful as its most careful report", () => {
    expect(widerScope("small_bug", "feature")).toBe("feature");
    expect(widerScope("feature", "big_issue")).toBe("big_issue");
    expect(widerScope("small_bug", "small_bug")).toBe("small_bug");
  });
});

describe("automatic fixes", () => {
  const g = { scope: "small_bug" as const, status: "new", fixState: null, attempts: 0, startedToday: 0, failedToday: 0, github: true };

  it("starts a small bug", () => expect(autoFixDecision(g).action).toBe("start"));
  it("sends big issues and features to review", () => {
    expect(autoFixDecision({ ...g, scope: "big_issue" }).action).toBe("review");
    expect(autoFixDecision({ ...g, scope: "feature" }).action).toBe("review");
  });
  it("waits once today's fixes are used", () => expect(autoFixDecision({ ...g, startedToday: AUTO_FIX_PER_DAY }).action).toBe("wait"));
  it("gives a fix that failed its checks one more try, then a person", () => {
    expect(autoFixDecision({ ...g, fixState: "checks_failed", attempts: 1 }).action).toBe("start");
    expect(autoFixDecision({ ...g, fixState: "checks_failed", attempts: 2 }).action).toBe("review");
  });
  it("pauses when fixes keep failing", () => expect(autoFixDecision({ ...g, failedToday: 2 }).action).toBe("review"));
  it("leaves one already on its way, and closed ones, alone", () => {
    expect(autoFixDecision({ ...g, fixState: "working" }).action).toBe("none");
    expect(autoFixDecision({ ...g, status: "fixed" }).action).toBe("none");
  });
  it("goes to review without GitHub connected", () => expect(autoFixDecision({ ...g, github: false }).action).toBe("review"));
});

describe("reading a fix's state from GitHub", () => {
  const pr = { url: "https://github.com/x/y/pull/9", open: true, merged: false };

  it("sees the workflow's own merge, with its commit", () => {
    const out = fixOutcome({ issueClosed: true, pr: { ...pr, open: false }, comments: ["Merged into main as abc1234 (every check passed).", "Low severity, and every check passed: merged automatically."], minutesSinceStart: 20 });
    expect(out).toMatchObject({ state: "merged", commit: "abc1234" });
  });

  it("sees a pull request merged by a person", () => expect(fixOutcome({ issueClosed: true, pr: { ...pr, open: false, merged: true }, comments: [], minutesSinceStart: 300 }).state).toBe("merged"));
  it("sees failed checks", () => expect(fixOutcome({ issueClosed: false, pr, comments: ["A check failed, so this one wasn't merged automatically. It needs a look."], minutesSinceStart: 30 }).state).toBe("checks_failed"));
  it("sees a fix held back for touching protected files", () => {
    expect(fixOutcome({ issueClosed: false, pr, comments: ["This fix changes the database, so it waits for a person to apply the migration and merge it."], minutesSinceStart: 30 }).state).toBe("protected");
    expect(fixOutcome({ issueClosed: false, pr, comments: ["This fix touches files an automatic fix never ships (7 files), so it waits for a person to review and merge it."], minutesSinceStart: 30 }).state).toBe("protected");
  });
  it("waits while Claude works, then reads no pull request as nothing to change", () => {
    expect(fixOutcome({ issueClosed: false, pr: null, comments: [], minutesSinceStart: 10 }).state).toBe("working");
    expect(fixOutcome({ issueClosed: false, pr: null, comments: ["This is a browser extension, not our code."], minutesSinceStart: 120 })).toMatchObject({ state: "no_change", note: "This is a browser extension, not our code." });
  });
  it("shows an open pull request", () => expect(fixOutcome({ issueClosed: false, pr, comments: [], minutesSinceStart: 10 }).state).toBe("pr_open"));
});

describe("the path shown on the page", () => {
  it("names each path", () => {
    expect(pathLabel({ status: "new", lane: "auto_fix", fixState: "working" }).label).toBe("Auto-fixing");
    expect(pathLabel({ status: "fixed", lane: "auto_fix", fixState: "merged" }).label).toBe("Fixed");
    expect(pathLabel({ status: "new", lane: "review", fixState: null }).label).toBe("Needs your review");
    expect(pathLabel({ status: "planned", lane: "build", fixState: "pr_open" }).label).toBe("Planned · PR to review");
    expect(pathLabel({ status: "wont_fix", lane: "review", fixState: null }).label).toBe("Won't do");
  });
});
