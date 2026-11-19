import { describe, expect, it } from "vitest";
import { actionLabel, allActed, changeLines, cleanDetection, directionNote, isOpenTask, noDash, recipientsFor, suggestStage, withClient, type OpenTask } from "@/lib/direction-core";

// A client changing direction mid-production: where flagged work goes back to, how the AI's answer is checked, who is
// told, and which tasks count as open work.

describe("where a flagged task goes back to", () => {
  it("copy-only changes go to Copy (creative) and Copy for review (email)", () => {
    expect(suggestStage("creative", "client_review", "copy")).toEqual({ fix: "copy", stage: "copy" });
    expect(suggestStage("asana_creative", "ready_for_launch", "copy")).toEqual({ fix: "copy", stage: "copy" });
    expect(suggestStage("email", "with_client", "copy")).toEqual({ fix: "copy", stage: "copy_review" });
    expect(suggestStage("asana_email", "ready_for_build", "copy")).toEqual({ fix: "copy", stage: "copy_review" });
  });

  it("design changes go to production (creative) and Ready for design (email)", () => {
    expect(suggestStage("creative", "client_review", "design")).toEqual({ fix: "design", stage: "in_production" });
    expect(suggestStage("asana_creative", "internal_review", "design")).toEqual({ fix: "design", stage: "in_production" });
    expect(suggestStage("email", "for_review", "design")).toEqual({ fix: "design", stage: "ready_for_design" });
  });

  it("both: production first on creative, copy first on email", () => {
    expect(suggestStage("creative", "copy_review", "both")).toEqual({ fix: "both", stage: "in_production" });
    expect(suggestStage("email", "with_client", "both")).toEqual({ fix: "both", stage: "copy_review" });
  });

  it("work not started yet is a brief update, left where it is", () => {
    expect(suggestStage("creative", "requested", "design")).toEqual({ fix: "brief", stage: null });
    expect(suggestStage("asana_email", "copy_review", "design")).toEqual({ fix: "brief", stage: null });
  });

  it("already at or before the stage: stays with the note", () => {
    expect(suggestStage("creative", "in_production", "design")).toEqual({ fix: "design", stage: null });
    expect(suggestStage("creative", "client_revision", "design")).toEqual({ fix: "design", stage: null });
    expect(suggestStage("creative", "in_production", "copy")).toEqual({ fix: "copy", stage: null });
  });

  it("stop never moves anything", () => {
    expect(suggestStage("creative", "client_review", "stop")).toEqual({ fix: "stop", stage: null });
  });

  it("reads as a button", () => {
    expect(actionLabel("creative", "design", "in_production")).toBe("Send back to In production");
    expect(actionLabel("email", "copy", "copy_review")).toBe("Send back to Copy for review");
    expect(actionLabel("creative", "brief", null)).toBe("Update the brief");
    expect(actionLabel("creative", "stop", null)).toBe("Stop");
  });
});

describe("the AI's answer, checked", () => {
  const tasks: OpenTask[] = [
    { kind: "asana_creative", ref: "1201", title: "Lakers playoff tickets static", stage: "client_review", assigneeId: "p-designer" },
    { kind: "asana_email", ref: "1202", title: "Week 12 campaign batch", stage: "ready_for_design", assigneeId: null },
    { kind: "creative", ref: "uuid-3", title: "Evergreen hero video", stage: "requested", assigneeId: "p-editor" },
  ];

  it("keeps listed tasks only, works out the stage itself, and strips em dashes", () => {
    const out = cleanDetection(
      {
        changes: [
          {
            kind: "priority",
            summary: "Evergreen creative only — stop team-specific",
            was: "Team-specific creative",
            now: "Evergreen",
            quote: "let's go evergreen",
            message: 2,
            tasks: [
              { n: 1, verdict: "affected", fix: "design", why: "It shows a team." },
              { n: 1, verdict: "maybe", fix: "copy", why: "dup" },
              { n: 9, verdict: "affected", fix: "design", why: "not a task" },
              { n: 3, verdict: "affected", fix: "design", why: "Not started." },
            ],
          },
        ],
      },
      tasks,
      2,
    );
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("Evergreen creative only, stop team-specific");
    expect(out[0].kind).toBe("priority");
    expect(out[0].message).toBe(2);
    expect(out[0].tasks.map((t) => [t.ref, t.verdict, t.fix, t.suggested])).toEqual([
      ["1201", "affected", "design", "in_production"],
      ["uuid-3", "affected", "brief", null],
    ]);
    expect(out[0].tasks[0].assigneeId).toBe("p-designer");
  });

  it("drops changes with no summary, and unknown kinds, fixes and messages fall back", () => {
    const out = cleanDetection({ changes: [{ summary: "  " }, { kind: "weird", summary: "New price", message: 7, tasks: [{ n: 2, verdict: "??", fix: "??", why: "" }] }] }, tasks, 3);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("other");
    expect(out[0].message).toBeNull();
    expect(out[0].tasks[0]).toMatchObject({ ref: "1202", verdict: "maybe", fix: "design", suggested: null, why: "Touched by the change." });
  });

  it("survives junk", () => {
    expect(cleanDetection(null, tasks, 1)).toEqual([]);
    expect(cleanDetection({ changes: "no" }, tasks, 1)).toEqual([]);
  });

  it("the note has no em dashes and says what to change", () => {
    const n = directionNote({ summary: "New price — $49", quote: "it's 49 now", was: "$59", now: "$49" }, { fix: "copy", why: "The price is in the headline." }, "Keep the layout");
    expect(n).not.toMatch(/—/);
    expect(n).toContain("Change the copy");
    expect(n).toContain("Note: Keep the layout");
    expect(noDash("a — b")).toBe("a, b");
  });
});

describe("who hears about it", () => {
  const seats = [
    { profile_id: "buyer", role: "meta_buyer" },
    { profile_id: "strategist", role: "email_strategist" },
    { profile_id: "cs", role: "coordinator" },
    { profile_id: "designer-seat", role: "graphic_designer" },
  ];

  it("creative work: the buyer, the Head of Creative and whoever holds it", () => {
    const r = recipientsFor({ seats, headsOfCreative: ["hoc"], execs: ["exec"], tasks: [{ kind: "asana_creative", stage: "in_production", assigneeId: "maker", verdict: "affected" }] });
    expect(r.ids.sort()).toEqual(["buyer", "hoc", "maker"]);
    expect(r.critical).toBe(false);
  });

  it("email work brings the strategist; work with the client brings customer success and is critical", () => {
    const r = recipientsFor({ seats, headsOfCreative: ["hoc"], execs: ["exec"], tasks: [{ kind: "email", stage: "with_client", assigneeId: null, verdict: "affected" }] });
    expect(r.ids.sort()).toEqual(["buyer", "cs", "strategist"]);
    expect(r.critical).toBe(true);
  });

  it("a maybe with the client isn't critical", () => {
    expect(recipientsFor({ seats, headsOfCreative: [], execs: [], tasks: [{ kind: "creative", stage: "client_review", assigneeId: null, verdict: "maybe" }] }).critical).toBe(false);
  });

  it("nobody at all: the execs", () => {
    expect(recipientsFor({ seats: [], headsOfCreative: [], execs: ["exec"], tasks: [] }).ids).toEqual(["exec"]);
  });

  it("knows what's with the client", () => {
    expect(withClient("asana_creative", "client_review")).toBe(true);
    expect(withClient("asana_email", "with_client")).toBe(true);
    expect(withClient("email", "revisions")).toBe(false);
  });
});

describe("which tasks are open work", () => {
  it("Asana mirrors: open, not moved into Kaizen, in a mapped column", () => {
    expect(isOpenTask("asana_creative", { open: true, request_id: null, stage: "in_production" })).toBe(true);
    expect(isOpenTask("asana_creative", { open: true, request_id: "r1", stage: "in_production" })).toBe(false);
    expect(isOpenTask("asana_creative", { open: false, request_id: null, stage: "copy" })).toBe(false);
    expect(isOpenTask("asana_email", { open: true, ticket_id: null, completed_at: null, stage: "copy_review" })).toBe(true);
    expect(isOpenTask("asana_email", { open: true, ticket_id: null, completed_at: "2026-11-01", stage: "copy_review" })).toBe(false);
    expect(isOpenTask("asana_email", { open: true, ticket_id: "t1", completed_at: null, stage: "copy_review" })).toBe(false);
  });

  it("Kaizen tickets: not deleted, not launched or live", () => {
    expect(isOpenTask("creative", { deleted_at: null, stage: "client_review" })).toBe(true);
    expect(isOpenTask("creative", { deleted_at: null, stage: "launched" })).toBe(false);
    expect(isOpenTask("creative", { deleted_at: "2026-11-02", stage: "copy" })).toBe(false);
    expect(isOpenTask("email", { deleted_at: null, stage: "live" })).toBe(false);
    expect(isOpenTask("email", { deleted_at: null, stage: "revisions" })).toBe(true);
  });

  it("a change is handled once every task is acted on", () => {
    expect(allActed([{ action: "sent_back" }, { action: "kept" }])).toBe(true);
    expect(allActed([{ action: "sent_back" }, { action: "pending" }])).toBe(false);
    expect(allActed([])).toBe(false);
  });
});

describe("kept with the right team, revisions apart", () => {
  const tasks: OpenTask[] = [
    { kind: "asana_email", ref: "e1", title: "12 Days of Xmas campaign", stage: "with_client", assigneeId: "builder" },
    { kind: "asana_creative", ref: "c1", title: "QLS static", stage: "in_production", assigneeId: "designer" },
  ];
  it("a one-piece edit is a revision on that piece, and only that team's", () => {
    const [c] = cleanDetection({ changes: [{ scope: "revision", lines: ["email"], kind: "product", summary: "Take the 4 straps off the 12 Days list", message: 1, tasks: [{ n: 1, verdict: "affected", fix: "both", why: "Sold out." }] }] }, tasks, 1);
    expect(c.scope).toBe("revision");
    expect(c.lines).toEqual(["email"]);
  });
  it("a revision with no piece to put it on is a change for the line", () => {
    const [c] = cleanDetection({ changes: [{ scope: "revision", lines: ["meta"], kind: "priority", summary: "Focus on QLS", message: 1, tasks: [] }] }, tasks, 1);
    expect(c.scope).toBe("direction");
    expect(c.lines).toEqual(["meta"]);
  });
  it("ads is every paid platform; the tasks' teams are added; junk is dropped", () => {
    expect(changeLines(["ads", "nope"], [])).toEqual(["meta", "google", "tiktok"]);
    expect(changeLines(["social"], [{ kind: "asana_creative" }])).toEqual(["creative", "social"]);
  });
  it("a revision tells whoever holds the piece, nobody else", () => {
    const seats = [{ profile_id: "buyer", role: "meta_buyer" }, { profile_id: "strategist", role: "email_strategist" }, { profile_id: "cs", role: "coordinator" }];
    const r = recipientsFor({ seats, headsOfCreative: ["hoc"], execs: ["exec"], scope: "revision", lines: ["email"], tasks: [{ kind: "asana_email", stage: "with_client", assigneeId: "builder", verdict: "affected" }] });
    expect(r.ids).toEqual(["builder"]);
    expect(r.critical).toBe(false);
  });
  it("an email-only change never brings the media buyer", () => {
    const seats = [{ profile_id: "buyer", role: "meta_buyer" }, { profile_id: "strategist", role: "email_strategist" }];
    const r = recipientsFor({ seats, headsOfCreative: [], execs: [], lines: ["email"], tasks: [{ kind: "asana_email", stage: "in_design", assigneeId: null, verdict: "affected" }] });
    expect(r.ids).toEqual(["strategist"]);
  });
});
