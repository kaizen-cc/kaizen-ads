import { describe, expect, it } from "vitest";
import { adsRisk, auditReminders, briefPriority, creativeRisk, ideaPriority, mineFirst, prioritizeIdeas, type DeskAudit, type DeskSprint, type IdeaInput } from "@/lib/overview-desk";

// The head of a line's Overview: their own accounts first then the team's (worst first), only the audits and sprints
// that need a head, and campaign ideas critical first

const risk = (score: number) => ({ score, reasons: score ? ["Off target"] : [] });

describe("mineFirst", () => {
  it("puts the person's own accounts first, then the team's, each worst first", () => {
    const rows = [
      { name: "Alpha", mine: false, risk: risk(10) },
      { name: "Bravo", mine: true, risk: risk(5) },
      { name: "Charlie", mine: false, risk: risk(140) },
      { name: "Delta", mine: true, risk: risk(100) },
      { name: "Echo", mine: true, risk: risk(100) },
    ];
    const { mine, team } = mineFirst(rows);
    expect(mine.map((r) => r.name)).toEqual(["Delta", "Echo", "Bravo"]);
    expect(team.map((r) => r.name)).toEqual(["Charlie", "Alpha"]);
  });
  it("a worse team account never jumps above the person's own", () => {
    const { mine, team } = mineFirst([
      { name: "Team red", mine: false, risk: risk(300) },
      { name: "Mine green", mine: true, risk: risk(0) },
    ]);
    expect([...mine, ...team].map((r) => r.name)).toEqual(["Mine green", "Team red"]);
  });
});

const NOW = "2026-11-18";
const audit = (x: Partial<DeskAudit>): DeskAudit => ({ id: "a", status: "ready", score: 70, band: "watch", headline: "h", createdAt: "2026-11-17T10:00:00Z", actions: 5, done: 0, lastTickAt: null, ...x });
const sprint = (x: Partial<DeskSprint>): DeskSprint => ({ id: "s", score: 70, baseline: 70, moves: 4, done: 1, startedAt: "2026-11-16T10:00:00Z", lastDoneAt: "2026-11-17T10:00:00Z", nextCheckAt: null, ...x });

describe("auditReminders", () => {
  const clients = ["fresh", "stale", "red", "redNew", "failed", "worse", "sprintStale", "done", "running"].map((clientId) => ({ clientId }));
  const audits = new Map<string, DeskAudit>([
    ["fresh", audit({ id: "fresh" })],
    ["stale", audit({ id: "stale", createdAt: "2026-10-30T10:00:00Z", done: 1, lastTickAt: "2026-11-01T10:00:00Z" })],
    ["red", audit({ id: "red", band: "bad", score: 40, createdAt: "2026-11-12T10:00:00Z" })],
    ["redNew", audit({ id: "redNew", band: "bad", score: 40, createdAt: "2026-11-17T10:00:00Z" })],
    ["failed", audit({ id: "failed", status: "failed", score: null, band: null })],
    ["done", audit({ id: "done", createdAt: "2026-10-01T10:00:00Z", actions: 3, done: 3 })],
    ["running", audit({ id: "running", status: "running" })],
  ]);
  const sprints = new Map<string, DeskSprint>([
    ["worse", sprint({ id: "worse", baseline: 72, score: 60 })],
    ["sprintStale", sprint({ id: "sprintStale", startedAt: "2026-10-20T10:00:00Z", lastDoneAt: "2026-10-25T10:00:00Z" })],
  ]);

  it("a head gets only what's critical or gone stale, critical first", () => {
    const got = auditReminders(clients, audits, sprints, NOW, { head: true });
    expect(got.map((r) => `${r.level}:${r.clientId}`)).toEqual(["critical:red", "critical:worse", "critical:failed", "stale:sprintStale", "stale:stale"]);
    // A fresh audit, a red one the strategist got yesterday, a finished one and one still running never reach the head
    for (const quiet of ["fresh", "redNew", "done", "running"]) expect(got.some((r) => r.clientId === quiet)).toBe(false);
  });

  it("says why in plain words", () => {
    const got = auditReminders(clients, audits, sprints, NOW, { head: true });
    expect(got.find((r) => r.clientId === "red")?.why).toBe("Red audit 6 days old, no sprint and nothing ticked");
    expect(got.find((r) => r.clientId === "worse")?.why).toBe("Score fell 12 points since the sprint began");
    expect(got.find((r) => r.clientId === "sprintStale")?.why).toBe("No move ticked in 24 days");
  });

  it("the strategist who owns the accounts sees their open ones too", () => {
    const got = auditReminders(clients, audits, sprints, NOW, { head: false });
    expect(got.map((r) => r.clientId)).toContain("fresh");
    expect(got.map((r) => r.clientId)).toContain("redNew");
    expect(got.find((r) => r.clientId === "fresh")?.level).toBe("open");
    expect(got.some((r) => r.clientId === "done" || r.clientId === "running")).toBe(false);
  });
});

const idea = (x: Partial<IdeaInput>): IdeaInput => ({ origin: "performance", title: "An idea", idea: "Send something good.", why: null, evidence: [], sendOn: null, ...x });

describe("ideaPriority", () => {
  it("critical: a send gap, a missing core flow, a revenue drop, a holiday about to be missed", () => {
    expect(ideaPriority(idea({ title: "Back in the inbox", idea: "We haven't sent a campaign in 3 weeks; a simple best sellers send." }), NOW).tier).toBe("critical");
    expect(ideaPriority(idea({ title: "Welcome series", idea: "There's no welcome flow live; set up a 3 email welcome." }), NOW).tier).toBe("critical");
    expect(ideaPriority(idea({ title: "Win them back", idea: "A best sellers push.", why: "Revenue dropped 30% from last month." }), NOW).tier).toBe("critical");
    const bf = ideaPriority(idea({ origin: "calendar", title: "Black Friday early access", idea: "VIPs get the sale first.", sendOn: "2026-11-27" }), NOW);
    expect(bf).toMatchObject({ tier: "critical", daysLeft: 9 });
    expect(bf.reason).toBe("A holiday in 9 days");
  });

  it("a launch the client raised that sends soon is critical; later it's worth doing", () => {
    expect(ideaPriority(idea({ origin: "slack", title: "New menu launch", sendOn: "2026-11-25" }), NOW).tier).toBe("critical");
    expect(ideaPriority(idea({ origin: "slack", title: "New menu launch", sendOn: "2027-01-25" }), NOW).tier).toBe("worth");
  });

  it("nice to have: fun national days, even close by", () => {
    const p = ideaPriority(idea({ origin: "calendar", title: "National Sandwich Day", idea: "A fun send.", sendOn: "2026-11-20" }), NOW);
    expect(p.tier).toBe("nice");
    expect(ideaPriority(idea({ origin: "calendar", title: "Christmas gift guide", sendOn: "2026-12-20" }), NOW).tier).toBe("worth");
  });

  it("a send day already gone is missed, not critical", () => {
    expect(ideaPriority(idea({ origin: "calendar", title: "Halloween treats", sendOn: "2026-10-31" }), NOW).tier).toBe("missed");
  });
});

describe("prioritizeIdeas", () => {
  it("critical first (soonest send day first), then worth doing, nice to have, missed", () => {
    const list = [
      idea({ title: "National Cookie Day", origin: "calendar", sendOn: "2026-12-04" }),
      idea({ title: "Subject line test", origin: "performance" }),
      idea({ title: "Cyber Monday", origin: "calendar", sendOn: "2026-11-30" }),
      idea({ title: "Halloween recap", origin: "calendar", sendOn: "2026-10-31" }),
      idea({ title: "Black Friday", origin: "calendar", sendOn: "2026-11-27" }),
    ];
    expect(prioritizeIdeas(list, NOW).map((i) => `${i.priority.tier}:${i.title}`)).toEqual(["critical:Black Friday", "critical:Cyber Monday", "worth:Subject line test", "nice:National Cookie Day", "missed:Halloween recap"]);
  });
});

describe("the ads and creative lines", () => {
  it("ad accounts: further off target ranks worse, then can't read, close, pacing, no KPI", () => {
    const rows = [
      { name: "Close", mine: false, risk: adsRisk({ status: "close", deviation: 0.1, pacing: null, hasAccount: true }) },
      { name: "Way off", mine: false, risk: adsRisk({ status: "off", deviation: 0.5, pacing: null, hasAccount: true }) },
      { name: "A bit off", mine: false, risk: adsRisk({ status: "off", deviation: 0.18, pacing: null, hasAccount: true }) },
      { name: "Blind", mine: false, risk: adsRisk({ status: "setup", deviation: null, pacing: null, hasAccount: true }) },
      { name: "Fine", mine: false, risk: adsRisk({ status: "good", deviation: -0.1, pacing: null, hasAccount: true }) },
      { name: "My close", mine: true, risk: adsRisk({ status: "close", deviation: 0.1, pacing: "over", hasAccount: true }) },
    ];
    const { mine, team } = mineFirst(rows);
    expect(mine.map((r) => r.name)).toEqual(["My close"]);
    expect(team.map((r) => r.name)).toEqual(["Way off", "A bit off", "Blind", "Close", "Fine"]);
    expect(rows[1].risk.reasons).toEqual(["50% off target"]);
    expect(rows[5].risk.reasons).toEqual(["Close to target", "Spending over pace"]);
  });

  it("creative clients: nothing delivered first, then behind, then on pace", () => {
    expect(creativeRisk({ tone: "bad", note: "Nothing delivered yet", waiting: 0, revisionsPerItem: 0 }).score).toBeGreaterThan(creativeRisk({ tone: "warn", note: "Behind on creative", waiting: 2, revisionsPerItem: 0 }).score);
    expect(creativeRisk({ tone: "ok", note: "On pace", waiting: 0, revisionsPerItem: 0 })).toEqual({ score: 0, reasons: [] });
  });

  it("an ads sprint whose last check says worse is critical for the head", () => {
    const got = auditReminders([{ clientId: "t1" }], new Map(), new Map([["t1", sprint({ id: "s1", score: null, baseline: null, worse: "The last check says it's getting worse" })]]), NOW, { head: true });
    expect(got).toMatchObject([{ level: "critical", kind: "sprint", why: "The last check says it's getting worse" }]);
  });

  it("suggested briefs: off target, unhappy and promised first; tests and moments are nice to have", () => {
    expect(briefPriority("kpi").tier).toBe("critical");
    expect(briefPriority("unhappy").tier).toBe("critical");
    expect(briefPriority("call").tier).toBe("critical");
    expect(briefPriority("fatigue", 20).tier).toBe("worth");
    expect(briefPriority("fatigue", 140)).toEqual({ tier: "critical", reason: "Ads wearing out on an account off target" });
    expect(briefPriority("market").tier).toBe("nice");
    expect(briefPriority("moment").tier).toBe("nice");
  });
});
