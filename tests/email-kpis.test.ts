import { describe, expect, it } from "vitest";
import {
  baselines,
  cadenceStatus,
  clientRounds,
  copyApprovals,
  countVerdict,
  designPasses,
  firstPasses,
  flowTrend,
  hitRate,
  judge,
  liftOf,
  metDue,
  phaseOfColumn,
  pushes,
  revisionTurns,
  scoreOf,
  sendbacksOf,
  severityOf,
  stintsOf,
  styleResults,
  toClient,
  type Piece,
  type Sent,
} from "@/lib/email-kpis-core";

// Mondays to Fridays in November 2026 (New York): the 16th is a Monday
const at = (day: number, hour = 15) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();

function piece(over: Partial<Piece> & Pick<Piece, "stints">): Piece {
  return {
    key: "k:1",
    source: "kaizen",
    number: 1,
    title: "Black Friday batch",
    clientId: "c1",
    client: "Acme",
    slug: "acme",
    kind: "batch",
    createdAt: at(16, 13),
    open: false,
    stage: "live",
    href: "/board/email?t=1",
    external: false,
    dueFirst: null,
    dueNow: null,
    dues: [],
    uploads: [],
    notes: [],
    rewrites: [],
    drafted: null,
    copyApproved: null,
    minutesOver: 0,
    holderNow: null,
    messages: 3,
    ...over,
  };
}

describe("stintsOf", () => {
  it("reads a ticket's moves and hand-offs into stints, the new owner from the move on", () => {
    const s = stintsOf(
      at(16, 13),
      "copy_review",
      [
        { at: at(16, 15), to: "ready_for_design" },
        { at: at(18, 15), to: "for_review" },
      ],
      [
        { at: at(16, 13), from: null, to: "strategist" },
        // The board logs the hand-off a moment after the move: it belongs to the new stage
        { at: new Date(Date.parse(at(16, 15)) + 2000).toISOString(), from: "strategist", to: "designer" },
        { at: new Date(Date.parse(at(18, 15)) + 2000).toISOString(), from: "designer", to: "strategist" },
      ],
      "strategist",
    );
    expect(s.map((x) => [x.stage, x.holder, x.next])).toEqual([
      ["copy_review", "strategist", "ready_for_design"],
      ["ready_for_design", "designer", "for_review"],
      ["for_review", "strategist", null],
    ]);
  });

  it("splits a stint where it changed hands in the middle", () => {
    const s = stintsOf(at(16, 13), "ready_for_design", [{ at: at(19, 15), to: "for_review" }], [{ at: at(17, 15), from: "a", to: "b" }], null, false);
    expect(s.filter((x) => x.stage === "ready_for_design").map((x) => x.holder)).toEqual(["a", "b"]);
  });

  it("maps Asana's columns, with done columns as done", () => {
    expect(phaseOfColumn("Ready for Design")).toBe("ready_for_design");
    expect(phaseOfColumn("Sent")).toBe("done");
    expect(phaseOfColumn("Scheduled")).toBe("done");
    expect(phaseOfColumn("Needs Revision")).toBe("revisions");
    expect(phaseOfColumn("Email Requests")).toBe("copy_review");
    expect(phaseOfColumn("Sent to Client")).toBe("with_client");
    expect(phaseOfColumn("Something else")).toBeNull();
  });
});

describe("design passes, first pass and sendbacks", () => {
  const p = piece({
    stints: [
      { stage: "copy_review", from: at(16, 13), to: at(16, 15), holder: "strategist", next: "ready_for_design" },
      { stage: "ready_for_design", from: at(16, 15), to: at(17, 15), holder: "designer", next: "for_review" },
      { stage: "for_review", from: at(17, 15), to: at(17, 18), holder: "strategist", next: "with_client" },
      { stage: "with_client", from: at(17, 18), to: at(19, 15), holder: "strategist", next: "revisions" },
      { stage: "revisions", from: at(19, 15), to: at(20, 15), holder: "designer", next: "for_review" },
      { stage: "for_review", from: at(20, 15), to: at(20, 16), holder: "strategist", next: "with_client" },
      { stage: "with_client", from: at(20, 16), to: at(23, 15), holder: "strategist", next: "ready_for_build" },
      { stage: "ready_for_build", from: at(23, 15), to: at(23, 18), holder: "builder", next: "ready_to_send" },
      { stage: "ready_to_send", from: at(23, 18), to: at(24, 15), holder: "strategist", next: "live" },
    ],
    notes: [{ at: at(19, 14), route: null, text: "Make the hero image bigger and the button colour darker" }],
    uploads: [{ at: at(17, 10), by: "designer", messageId: "m1", version: 1 }],
    dueFirst: "2026-11-23",
  });
  const from = at(1);
  const to = at(30);

  it("counts a design passed on, in business days against the 2-day target", () => {
    const passes = designPasses([p], from, to);
    expect(passes).toHaveLength(1);
    expect(passes[0].person).toBe("designer");
    expect(passes[0].days).toBeCloseTo(1, 5);
    expect(passes[0].onTime).toBe(true);
  });

  it("credits the client's design changes to the designer, and fails the first pass", () => {
    const backs = sendbacksOf([p], from);
    expect(backs).toHaveLength(1);
    expect(backs[0]).toMatchObject({ kind: "client", route: "design", person: "designer" });
    expect(backs[0].note).toMatch(/hero image/);
    expect(firstPasses([p], from, to)).toEqual([expect.objectContaining({ person: "designer", pass: false })]);
  });

  it("credits copy-only changes to the strategist and keeps the designer's first pass", () => {
    const copy = { ...p, notes: [{ at: at(19, 14), route: "copy" as const, text: "Change the subject line" }] };
    expect(sendbacksOf([copy], from)[0]).toMatchObject({ route: "copy", person: "strategist" });
    expect(firstPasses([copy], from, to)[0].pass).toBe(true);
    expect(revisionTurns([copy], from, to, "design")).toHaveLength(0);
    expect(revisionTurns([copy], from, to, "copy")).toHaveLength(1);
  });

  it("times the request to the client and the revision turnaround", () => {
    const reach = toClient([p], from, to);
    expect(reach[0].person).toBe("designer");
    expect(reach[0].days).toBeCloseTo(1 + 5 / 24, 5);
    const revs = revisionTurns([p], from, to, "design");
    expect(revs).toEqual([expect.objectContaining({ person: "designer" })]);
    expect(revs[0].days).toBeCloseTo(1, 5);
  });

  it("checks ready to send against the first due date", () => {
    expect(metDue(p)).toMatchObject({ met: true });
    expect(metDue({ ...p, dueFirst: "2026-11-20" })).toMatchObject({ met: false });
  });

  it("splits client changes into copy and design", () => {
    expect(clientRounds([p], from, to)).toMatchObject({ copy: 0, design: 1, reviewed: 1 });
  });
});

describe("pushes and copy approvals", () => {
  it("counts a due date moved later only by whoever held the ticket then", () => {
    const p = piece({
      stints: [{ stage: "ready_for_design", from: at(16), to: null, holder: "designer", next: null }],
      dues: [
        { at: at(17), from: "2026-11-20", to: "2026-11-25", by: "designer" },
        { at: at(18), from: "2026-11-25", to: "2026-11-27", by: "someone else" },
        { at: at(18), from: "2026-11-25", to: "2026-11-24", by: "designer" },
      ],
    });
    expect(pushes(p, at(1))).toEqual([{ by: "designer", at: at(17), from: "2026-11-20", to: "2026-11-25" }]);
  });

  it("knows whether the AI's copy went through first time", () => {
    const base = { stints: [{ stage: "copy_review" as const, from: at(16, 13), to: at(17, 13), holder: "strategist", next: "ready_for_design" as const }], copyApproved: { at: at(17, 13), by: "strategist" }, drafted: at(16, 14) };
    const clean = copyApprovals([piece(base)], at(1), at(30));
    expect(clean[0]).toMatchObject({ person: "strategist", firstPass: true, rewrites: 0 });
    expect(clean[0].days).toBeCloseTo(1, 5);
    expect(clean[0].draftHours).toBeCloseTo(1, 5);
    const rewritten = copyApprovals([piece({ ...base, rewrites: [{ at: at(16, 18), note: "Shorter" }] })], at(1), at(30));
    expect(rewritten[0]).toMatchObject({ firstPass: false, rewrites: 1 });
    // Asana tasks don't say whether the copy was rewritten
    expect(copyApprovals([piece({ ...base, source: "asana", copyApproved: null })], at(1), at(30))[0].firstPass).toBeNull();
  });
});

describe("the score", () => {
  it("weighs first pass, turnaround, revisions and nothing left sitting like the creative team", () => {
    expect(scoreOf({ firstPass: 100, turnaround: 2, target: 2, revision: 1, sitting: 0 })).toBe(100);
    expect(scoreOf({ firstPass: 50, turnaround: 4, target: 2, revision: null, sitting: 1 })).toBe(Math.round((50 * 0.4 + 50 * 0.3 + 80 * 0.15) / 0.85));
    expect(scoreOf({ firstPass: null, turnaround: null, target: 2, revision: null, sitting: 0 })).toBeNull();
  });

  it("says a count went up or down in plain words", () => {
    expect(countVerdict("Designs passed on", 14, 11, "up")).toBe("Better: 3 more than the period before.");
    expect(countVerdict("Designs passed on", 9, 11, "up")).toBe("Worse: 2 fewer than the period before.");
  });
});

describe("judging sent emails against their own account", () => {
  const mk = (id: string, click: number, open: number, revenue = 100, recipients = 1000): Sent => ({ id, clientId: "c1", name: id, subject: id, preview: null, channel: "email", sendTime: at(16), recipients, openRate: open, clickRate: click, revenue });
  const sent = [mk("a", 0.02, 0.4), mk("b", 0.02, 0.4), mk("c", 0.02, 0.4), mk("d", 0.02, 0.4)];
  const base = baselines(sent).get("c1");

  it("takes each account's medians", () => {
    expect(base).toMatchObject({ n: 4, click: 0.02, open: 0.4, rpr: 0.1 });
  });

  it("calls a winner 20% above the usual clicks without making less, a loser 20% below", () => {
    expect(judge(mk("w", 0.025, 0.4), base, "click")).toBe("winner");
    expect(judge(mk("cheap", 0.025, 0.4, 10), base, "click")).toBe("par");
    expect(judge(mk("l", 0.015, 0.4), base, "click")).toBe("loser");
    expect(judge(mk("p", 0.021, 0.4), base, "click")).toBe("par");
    expect(judge(mk("small", 0.05, 0.4, 100, 50), base, "click")).toBeNull();
    expect(judge(mk("sms", 0.05, 0.4), { ...base!, n: 3 }, "click")).toBeNull();
  });

  it("judges subject lines on opens, 12% either way", () => {
    expect(judge(mk("o", 0.02, 0.46), base, "open")).toBe("winner");
    expect(judge(mk("o", 0.02, 0.34), base, "open")).toBe("loser");
    expect(liftOf(0.46, 0.4)).toBe(15);
    expect(hitRate(["winner", "loser", "par", null, "winner"])).toEqual({ w: 2, l: 1, par: 1, rate: 67 });
  });

  it("reads subject styles by how often they won", () => {
    const rows = [
      { subject: "Last chance: 20% off", verdict: "winner" as const },
      { subject: "Ends tonight", verdict: "winner" as const },
      { subject: "Our new collection is here and it is wonderful to look at", verdict: "loser" as const },
      { subject: "Is this you?", verdict: "par" as const },
    ];
    const urgency = styleResults(rows).find((s) => s.name === "Urgency");
    expect(urgency).toMatchObject({ winners: 2, judged: 2, rate: 100 });
  });
});

describe("tiring flows and sending pace", () => {
  it("compares a flow's last 30 days with the 60 before", () => {
    const t = flowTrend({ recipients30: 1000, recipients90: 3000, rate30: 0.02, rate90: 0.03 });
    expect(t!.before).toBeCloseTo(0.035, 5);
    expect(t!.change).toBeCloseTo(0.02 / 0.035 - 1, 5);
    expect(severityOf(t!.change)).toBe("tired");
    expect(severityOf(-0.25)).toBe("tiring");
    expect(severityOf(-0.1)).toBeNull();
    expect(flowTrend({ recipients30: 100, recipients90: 3000, rate30: 0.02, rate90: 0.03 })).toBeNull();
  });

  it("flags a client with nothing sent and nothing in the works, and one behind last cycle's pace", () => {
    expect(cadenceStatus({ sent: 0, usual: 8, open: 0, elapsed: 0.5 })).toBe("none");
    expect(cadenceStatus({ sent: 1, usual: 8, open: 0, elapsed: 0.6 })).toBe("behind");
    expect(cadenceStatus({ sent: 4, usual: 8, open: 1, elapsed: 0.5 })).toBe("on_track");
    expect(cadenceStatus({ sent: 8, usual: 8, open: 0, elapsed: 0.5 })).toBe("ahead");
    expect(cadenceStatus({ sent: 0, usual: 0, open: 2, elapsed: 0.5 })).toBe("on_track");
  });
});
