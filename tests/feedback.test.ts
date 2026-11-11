import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIXES_PER_DAY,
  REPORTER_STATUS,
  addToRoadmap,
  areaFromRoute,
  autoFixDecision,
  byPriority,
  classifyScope,
  closestGroup,
  dailyFixCap,
  fixOutcome,
  groupStats,
  looksLikeNote,
  pathLabel,
  priorityScore,
  reporterStatus,
  routePattern,
  sectionOf,
  similarity,
  widerScope,
  type Scope,
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
  const r = { aiKind: "bug" as const, aiRail: "none" as const, type: "bug", text: "The Save button label is cut off", area: "Board" };

  it("sends a bug of any size to the pipeline, shipping itself when nothing touches a rail", () => {
    expect(classifyScope(r).scope).toBe("small_bug");
    // Wrong numbers in a report were held for review before; now they're fixed at once
    expect(classifyScope({ ...r, text: "Report PDF shows the wrong ROAS, not accurate at all", area: "Reports" }).scope).toBe("small_bug");
    expect(classifyScope({ ...r, text: "Report schedules count shows 0 but Meta says 3", area: "Reports" }).scope).toBe("small_bug");
  });

  it("builds a bug at the safety rails, but its fix waits for approval", () => {
    for (const [text, rail] of [
      ["the page fails because it needs a migration for the new column", "database"],
      ["I got logged out and can't sign in", "auth"],
      ["the launcher paused the wrong campaign", "ad_accounts"],
      ["the Stripe invoice is wrong", "billing"],
      ["the API key shows on the page", "secrets"],
      ["the .github workflow keeps failing", "pipeline"],
    ] as const) {
      const out = classifyScope({ ...r, text });
      expect(out.scope, text).toBe("big_issue");
      expect(out.rail, text).toBe(rail);
    }
    expect(classifyScope({ ...r, area: "Launcher" }).rail).toBe("ad_accounts");
    expect(classifyScope({ ...r, aiRail: "very_large" }).scope).toBe("big_issue");
  });

  it("sends a feature request to the owner as an Ask, never to a fix", () => {
    expect(classifyScope({ ...r, type: "idea" }).scope).toBe("feature");
    expect(classifyScope({ ...r, aiKind: "feature" }).scope).toBe("feature");
  });

  it("reads a note or an instruction as an Ask, not a bug (the Oceanbox report)", () => {
    const out = classifyScope({ ...r, text: "lets launch a campaign", note: "lets launch a campaign", area: "Clients" });
    expect(out.scope).toBe("feature");
    expect(out.unclear).toBe(true);
    expect(classifyScope({ ...r, aiKind: "unclear" }).unclear).toBe(true);
    expect(looksLikeNote("lets launch a search campaign")).toBe(true);
    expect(looksLikeNote("test")).toBe(true);
    expect(looksLikeNote("Not accurate information. Not accurate ROAS.")).toBe(false);
    expect(looksLikeNote("The upload button does nothing")).toBe(false);
    expect(looksLikeNote("Why is the board empty?")).toBe(false);
  });

  it("keeps a group as careful as its most careful report", () => {
    expect(widerScope("small_bug", "big_issue")).toBe("big_issue");
    expect(widerScope("feature", "small_bug")).toBe("small_bug");
    expect(widerScope("feature", "feature")).toBe("feature");
  });
});

describe("starting fixes", () => {
  const g = { scope: "small_bug" as Scope, status: "new", lane: "auto_fix", fixState: null, attempts: 0, startedToday: 0, failedToday: 0, github: true };

  it("starts a bug at once and lets it ship itself", () => expect(autoFixDecision(g)).toMatchObject({ action: "start", autoMerge: true }));
  it("starts a bug at the rails too, without auto-merge", () => expect(autoFixDecision({ ...g, scope: "big_issue", lane: "build" })).toMatchObject({ action: "start", autoMerge: false }));
  it("sends an Ask to the owner, and builds it only once the owner says so", () => {
    expect(autoFixDecision({ ...g, scope: "feature", lane: "review" }).action).toBe("ask");
    expect(autoFixDecision({ ...g, scope: "feature", lane: "build" })).toMatchObject({ action: "start", autoMerge: false });
  });
  it("waits past today's cap, which is configurable", () => {
    expect(autoFixDecision({ ...g, startedToday: DEFAULT_FIXES_PER_DAY }).action).toBe("wait");
    expect(autoFixDecision({ ...g, startedToday: 5, cap: 5 }).action).toBe("wait");
    expect(autoFixDecision({ ...g, startedToday: 5, cap: 20 }).action).toBe("start");
    expect(dailyFixCap("25")).toBe(25);
    expect(dailyFixCap(undefined)).toBe(DEFAULT_FIXES_PER_DAY);
    expect(dailyFixCap("lots")).toBe(DEFAULT_FIXES_PER_DAY);
    expect(dailyFixCap("0")).toBe(DEFAULT_FIXES_PER_DAY);
  });
  it("retries a failed fix once, then the owner looks", () => {
    expect(autoFixDecision({ ...g, fixState: "checks_failed", attempts: 1 }).action).toBe("start");
    expect(autoFixDecision({ ...g, fixState: "checks_failed", attempts: 2 }).action).toBe("stuck");
  });
  it("pauses when fixes keep failing", () => expect(autoFixDecision({ ...g, failedToday: 4 }).action).toBe("stuck"));
  it("leaves alone what's on its way or closed (the dedupe: a repeat joins, no second fix)", () => {
    expect(autoFixDecision({ ...g, fixState: "working" }).action).toBe("none");
    expect(autoFixDecision({ ...g, fixState: "pr_open", lane: "build", scope: "big_issue" }).action).toBe("none");
    expect(autoFixDecision({ ...g, status: "fixed" }).action).toBe("none");
  });
  it("is stuck without GitHub connected", () => expect(autoFixDecision({ ...g, github: false }).action).toBe("stuck"));
});

describe("reading a fix's state from GitHub", () => {
  const pr = { url: "https://github.com/x/y/pull/9", open: true, merged: false };

  it("sees a fix merged by the workflow", () => {
    const out = fixOutcome({ issueClosed: true, pr: { ...pr, open: false }, comments: ["Merged into main as abc1234 (every check passed).", "Every check passed: merged automatically."], minutesSinceStart: 20 });
    expect(out).toMatchObject({ state: "merged", commit: "abc1234" });
  });
  it("sees an approved fix merged", () =>
    expect(fixOutcome({ issueClosed: true, pr: { ...pr, open: false }, comments: ["Merged into main as def5678 (approved; every check passed)."], minutesSinceStart: 300 }).state).toBe("merged"));
  it("sees failed checks", () => expect(fixOutcome({ issueClosed: false, pr, comments: ["A check failed, so this fix wasn't merged. It needs another try."], minutesSinceStart: 30 }).state).toBe("checks_failed"));
  it("sees a fix ready to approve, new wording and old", () => {
    expect(fixOutcome({ issueClosed: false, pr, comments: ["Every check passed. It needs approval: it changes the database (supabase/migrations/x.sql)."], minutesSinceStart: 30 }).state).toBe("ready");
    expect(fixOutcome({ issueClosed: false, pr, comments: ["This fix changes the database, so it waits for a person to apply the migration and merge it."], minutesSinceStart: 30 }).state).toBe("ready");
  });
  it("sees a closed issue with no pull request as nothing to change, at once", () => {
    expect(fixOutcome({ issueClosed: true, pr: null, comments: ["This is a browser extension, not our code.", "Claude changed nothing: the reason is in the comment above."], minutesSinceStart: 10 })).toMatchObject({ state: "no_change", note: "This is a browser extension, not our code." });
    expect(fixOutcome({ issueClosed: false, pr: null, comments: [], minutesSinceStart: 10 }).state).toBe("working");
  });
  it("shows an open pull request with checks running", () => expect(fixOutcome({ issueClosed: false, pr, comments: [], minutesSinceStart: 10 }).state).toBe("pr_open"));
});

describe("where a group sits, and what its reporters see", () => {
  const g = (o: Partial<{ status: string; lane: string; scope: string; fixState: string | null; pending: boolean }>) => ({ status: "new", lane: "auto_fix", scope: "small_bug", fixState: null, ...o });

  it("puts each group in its section", () => {
    expect(sectionOf(g({ fixState: "working" }))).toBe("fixing");
    expect(sectionOf(g({ fixState: "queued" }))).toBe("fixing");
    expect(sectionOf(g({ lane: "build", scope: "big_issue", fixState: "working" }))).toBe("fixing");
    expect(sectionOf(g({ lane: "build", scope: "big_issue", fixState: "pr_open" }))).toBe("approval");
    expect(sectionOf(g({ lane: "review", fixState: "no_change" }))).toBe("approval");
    expect(sectionOf(g({ lane: "review", scope: "feature" }))).toBe("asks");
    expect(sectionOf(g({ lane: "build", scope: "feature", fixState: "working" }))).toBe("fixing");
    expect(sectionOf(g({ status: "fixed" }))).toBe("done");
    expect(sectionOf(g({ status: "wont_fix", scope: "feature", lane: "review" }))).toBe("done");
    expect(sectionOf(g({ pending: true }))).toBe("fixing");
  });

  it("maps a report's status for the person who sent it", () => {
    expect(reporterStatus(null)).toBe("received");
    expect(reporterStatus(g({ fixState: "working" }))).toBe("building");
    expect(reporterStatus(g({ fixState: "queued" }))).toBe("building");
    expect(reporterStatus(g({ lane: "build", scope: "big_issue", fixState: "pr_open" }))).toBe("fix_ready");
    expect(reporterStatus(g({ status: "fixed", fixState: "merged" }))).toBe("live");
    expect(reporterStatus(g({ lane: "review", scope: "feature" }))).toBe("with_owner");
    expect(reporterStatus(g({ lane: "review", fixState: "no_change" }))).toBe("with_owner");
    expect(reporterStatus(g({ status: "wont_fix" }))).toBe("wont_do");
    expect(REPORTER_STATUS.fix_ready.label).toBe("Fix ready");
  });

  it("labels the state for the owner", () => {
    expect(pathLabel(g({ fixState: "working" })).label).toBe("Fixing");
    expect(pathLabel(g({ lane: "build", scope: "big_issue", fixState: "pr_open", ready: true } as never)).label).toBe("Fix ready to approve");
    expect(pathLabel(g({ lane: "review", scope: "feature" })).label).toBe("Ask");
    expect(pathLabel(g({ status: "fixed" })).label).toBe("Live");
  });
});

describe("plan it: the roadmap", () => {
  it("adds a section at the end the first time, keeping CRLF", () => {
    const out = addToRoadmap("# Roadmap\r\n\r\n## Later\r\n\r\n- Something\r\n", "**Export CSV** (asked by 2 people)");
    expect(out).toBe("# Roadmap\r\n\r\n## Later\r\n\r\n- Something\r\n\r\n## Requested by the team\r\n\r\n- **Export CSV** (asked by 2 people)\r\n");
  });
  it("adds under the section's last line, before the next section, and never twice", () => {
    const md = "# R\n\n## Requested by the team\n\n- One\n\n## After\n\n- x\n";
    const out = addToRoadmap(md, "Two");
    expect(out).toBe("# R\n\n## Requested by the team\n\n- One\n- Two\n\n## After\n\n- x\n");
    expect(addToRoadmap(out, "Two")).toBe(out);
  });
});
