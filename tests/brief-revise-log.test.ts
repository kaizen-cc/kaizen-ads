import { describe, expect, it } from "vitest";
import { applyBriefPatch, askedChanges, changeLog, diffStates, stateOf, type AskItem, type BriefChange } from "@/lib/brief-patch";
import { composeBrief, emptySpec } from "@/lib/brief-spec";
import { immediateScope, learnedBlock, type Learning } from "@/lib/learning-rank";

// Accountable revisions: a correction becomes a checklist of every change it asked for, only those changes are applied
// (patch, don't rewrite: nothing else moves, nothing written before is dropped), and the change log says what was done
// and where, or not done and why, held to what the patch really changed. Then the correction carries over: a lesson
// about the craft of a brief reaches the brief writer on every client at once.

const ch = (p: Partial<BriefChange>): BriefChange => ({ field: "insight", op: "set", value: "", index: -1, status: "", answer: "", source: "", ...p });

const before = stateOf({
  title: "Gone by the First Song",
  angle: "Gate lines",
  audience: "Venue ops",
  sizes: ["4x5", "9x16"],
  brief: composeBrief("CrowdSync takes gate lines from 40 minutes to under 5.", {
    ...emptySpec(),
    insight: "At the Oct 18 show lines went from 40 minutes to under 5 (the manager on camera).",
    insightSource: "Client call Oct 21",
    beats: ["0:00-0:06 | Hook | On screen: the line | Text: \"What do fans miss?\"", "0:06-0:14 | Answer | On screen: the floor | Text: \"The first song\"", "0:14-0:20 | End card | On screen: logo"],
    versions: ["What do fans miss?", "40 minutes at the gate."],
    assets: Array.from({ length: 6 }, (_, i) => ({ item: `Need item ${i + 1}`, status: "need" as const })),
    confirm: [{ question: "Is the clip cleared?", answer: "", source: "" }],
    yourCall: "Yours.",
  }),
});

describe("a correction's checklist and change log", () => {
  const changes = [
    ch({ field: "beats", op: "replace", index: 0, value: '0:00-0:03 | Hook | On screen: the line | Text: "What do fans miss?" | Says: "The first song." (Source: manager 0:02)' }),
    ch({ field: "versions", op: "replace", index: 1, value: "40 minutes at the gate. | Also changes: the stadium clip in beat 2" }),
    ch({ field: "insight", op: "set", value: "A rewrite nobody asked for." }),
    ch({ field: "confirm", op: "replace", index: 7, value: "Blocker: Is the clip cleared?" }),
  ];
  const items: AskItem[] = [
    { ask: "Answer the hook in the first 3 seconds", done: true, where: "Beats, beat 1", why: "", changes: [0] },
    { ask: "V2 runs on the stadium clip, say so", done: true, where: "", why: "", changes: [1] },
    { ask: "Mark the clip clearance as a blocker", done: true, where: "Confirm with client", why: "", changes: [3] },
    { ask: "Name the venue manager on screen", done: false, where: "", why: "The context doesn't say who the manager is.", changes: [] },
  ];

  it("applies only what an ask points to: an unasked rewrite never lands, everything else stays word for word", () => {
    const asked = askedChanges(items, changes);
    expect(asked.unasked.map((c) => c.field)).toEqual(["insight"]);
    const out = applyBriefPatch(before, asked.keep);
    expect(out.state.spec.insight).toBe(before.spec.insight);
    expect(out.state.spec.assets).toEqual(before.spec.assets);
    expect(out.state.spec.beats[0]).toMatch(/Says: "The first song\."/);
    const diff = diffStates(before, out.state);
    expect(diff.map((d) => d.field).sort()).toEqual(["beats", "versions"]);
  });

  it("logs every ask: done with where, or not done with why, held to what really changed", () => {
    const asked = askedChanges(items, changes);
    const out = applyBriefPatch(before, asked.keep);
    const log = changeLog(items, changes, out.applied, out.refused);
    expect(log).toHaveLength(4);
    expect(log[0]).toEqual({ ask: "Answer the hook in the first 3 seconds", done: true, where: "Beats, beat 1", why: "" });
    expect(log[1]).toMatchObject({ done: true, where: "Versions (item 2)" });
    // Marked done, but its change pointed at an item that isn't there: not done, and why
    expect(log[2].done).toBe(false);
    expect(log[2].why).toMatch(/couldn't be made \(Confirm with client/);
    expect(log[3]).toEqual({ ask: "Name the venue manager on screen", done: false, where: "", why: "The context doesn't say who the manager is." });
  });

  it("says when an ask was marked done but nothing changed for it", () => {
    const log = changeLog([{ ask: "Shorten the hook", done: true, where: "", why: "", changes: [] }], [], [], []);
    expect(log[0]).toMatchObject({ done: false, why: "Marked done, but nothing in the brief changed for it." });
  });

  it("keeps every change of an older answer with no checklist, each its own line", () => {
    const only = [ch({ field: "audio", op: "set", value: "Music only." })];
    expect(askedChanges([], only).keep).toEqual(only);
    const out = applyBriefPatch(before, only);
    expect(changeLog([], only, out.applied, out.refused)).toEqual([{ ask: "Change Audio", done: true, where: "Audio", why: "" }]);
  });
});

describe("corrections carry over", () => {
  it("sends a brief-craft lesson to the brief writer on every client at once, a client's own stays with them", () => {
    expect(immediateScope("brief_corrections", "lesson", "everyone", 0.85)).toBe("everyone");
    expect(immediateScope("brief_corrections", "lesson", "everyone", 0.5)).toBe("client");
    expect(immediateScope("brief_corrections", "exception", "everyone", 0.9)).toBe("client");
    expect(immediateScope("brief_corrections", "lesson", "client", 0.9)).toBe("client");
    // Every other kind of pushback still waits for evidence from several clients
    expect(immediateScope("audit_rebuttals", "lesson", "everyone", 0.95)).toBe("client");
  });

  it("writes the lessons a brief is written with in one block, scope and condition first", () => {
    const l: Learning = { id: "l1", agentKey: "strategist", scope: "everyone", clientId: "c1", model: null, verticalId: null, kind: "lesson", condition: "when writing a video brief", lesson: "Answer the hook within the first 3 seconds.", confidence: 0.9, evidence: 2, evidenceClients: ["c1"], lastSeen: new Date().toISOString() };
    const block = learnedBlock([l], ["strategist"], "c2");
    expect(block).toContain('<learned_from_the_team client="c2" agents="strategist">');
    expect(block).toContain("- [every client, seen 2×] When writing a video brief: Answer the hook within the first 3 seconds.");
  });
});
