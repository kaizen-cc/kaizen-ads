import { describe, expect, it } from "vitest";
import { firstPass, mergePlan, similarity, type CandidateMove, type ExistingMove } from "@/lib/business-audit-merge";

const existing: ExistingMove[] = [
  { id: "m1", title: "Pause the three ad sets spending without purchases", status: "doing" },
  { id: "m2", title: "Raise the prospecting campaign budget by 20%", status: "todo" },
  { id: "m3", title: "Launch the new UGC creative in the testing campaign", status: "done" },
];

describe("similarity", () => {
  it("reads the same move in slightly different words as alike", () => {
    expect(similarity("Pause the three ad sets spending without purchases", "Pause 3 ad sets spending with no purchases")).toBeGreaterThanOrEqual(0.5);
  });
  it("keeps different moves apart", () => {
    expect(similarity("Raise the prospecting budget", "Add negative keywords for brand searches")).toBeLessThan(0.2);
  });
});

describe("firstPass", () => {
  it("settles clear duplicates (open or done) and leaves the rest for the AI while a move is in progress", () => {
    const c: CandidateMove[] = [
      { index: 0, title: "Launch the new UGC creative in the testing campaign" },
      { index: 1, title: "Add a lookalike audience from purchasers" },
    ];
    const r = firstPass(c, existing);
    expect(r.settled).toContainEqual({ index: 0, verdict: "duplicate", of: "m3" });
    // A move is in progress: anything not clearly a duplicate goes to the AI (a contradiction needn't share words)
    expect(r.unsure.map((x) => x.index)).toEqual([1]);
  });
  it("calls unrelated moves new when nothing is in progress", () => {
    const r = firstPass([{ index: 4, title: "Add negative keywords for job seekers" }], existing.filter((e) => e.status !== "doing"));
    expect(r.settled).toEqual([{ index: 4, verdict: "new" }]);
    expect(r.unsure).toEqual([]);
  });
  it("drops a candidate the audit said twice", () => {
    const r = firstPass(
      [
        { index: 0, title: "Refresh the tired carousel creative" },
        { index: 1, title: "Refresh tired carousel creative" },
      ],
      [],
    );
    expect(r.kept.map((x) => x.index)).toEqual([0]);
  });
});

describe("mergePlan", () => {
  const c: CandidateMove[] = [
    { index: 0, title: "Scale the winner" },
    { index: 1, title: "Cut the prospecting budget" },
    { index: 2, title: "Launch the UGC creative" },
    { index: 3, title: "Test a new offer" },
  ];
  it("adds new moves, leaves duplicates and sets contradictions aside, never touching existing moves", () => {
    const plan = mergePlan(c, existing, [
      { index: 0, verdict: "new" },
      { index: 1, verdict: "contradicts", of: "m2", note: "The sprint is raising it" },
      { index: 2, verdict: "duplicate", of: "m3" },
    ]);
    expect(plan.add.map((x) => x.index)).toEqual([0, 3]); // no verdict counts as new
    expect(plan.duplicates.map((x) => x.of.id)).toEqual(["m3"]);
    expect(plan.conflicts).toEqual([{ move: c[1], of: existing[1], note: "The sprint is raising it" }]);
  });
  it("can't contradict a move already done, and a verdict about a missing move counts as new", () => {
    const plan = mergePlan(c.slice(0, 2), existing, [
      { index: 0, verdict: "contradicts", of: "m3", note: "x" },
      { index: 1, verdict: "duplicate", of: "nope" },
    ]);
    expect(plan.add.map((x) => x.index)).toEqual([0, 1]);
    expect(plan.conflicts).toEqual([]);
  });
});
