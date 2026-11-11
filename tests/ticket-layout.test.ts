import { describe, expect, it } from "vitest";
import { STAGES, type Stage } from "@/lib/stages";
import { makingMinutes, productionBar, span, ticketRole, ticketView, type ProductionState, type TicketRole } from "@/lib/ticket-layout";

const ROLES: TicketRole[] = ["lead", "copywriter", "maker", "team"];
const base: ProductionState = { uploaded: 0, uploading: 0, missing: [], review: { status: "none", current: false }, openComments: 0 };
const p = (x: Partial<ProductionState>): ProductionState => ({ ...base, ...x, review: { ...base.review, ...x.review } });
const kinds = (b: ReturnType<typeof productionBar>) => [b.primary?.kind ?? null, ...b.secondary.map((c) => c.kind)];

describe("ticketView: each stage shows only what it needs, with one main action", () => {
  it("every stage has a view, and the main action is a single button (or who has it)", () => {
    for (const s of STAGES.map((x) => x.key as Stage))
      for (const r of ROLES) {
        const v = ticketView(s, r);
        expect(v.bar.secondary.length).toBeLessThanOrEqual(2);
        expect(Boolean(v.bar.primary) || Boolean(v.bar.wait) || s === "launched").toBe(true);
      }
  });

  it("requested: the brief chat, and Start production", () => {
    const v = ticketView("requested", "maker");
    expect(v.sections).toEqual(["brief-chat"]);
    expect(v.bar.primary).toEqual({ kind: "start-production", label: "Start production" });
  });

  it("in production: the copy or script, the sizes, the creative", () => {
    expect(ticketView("in_production", "maker").sections).toEqual(["copy-draft", "ratios", "creative"]);
    expect(ticketView("client_revision", "maker").sections[0]).toBe("client-notes");
  });

  it("creative review: View creative first, then Approve creative with Review creative; others see who has it", () => {
    expect(ticketView("internal_review", "lead").sections).toEqual(["ai-summary", "story", "creative-strip"]);
    expect(ticketView("internal_review", "lead").bar.primary?.kind).toBe("view-creative");
    const after = ticketView("internal_review", "lead", { opened: true }).bar;
    expect(after.primary?.kind).toBe("approve-creative");
    expect(after.secondary.map((c) => c.kind)).toEqual(["review-creative"]);
    for (const r of ["copywriter", "maker", "team"] as TicketRole[]) {
      const b = ticketView("internal_review", r, { opened: true }).bar;
      expect(b.primary).toBeNull();
      expect(b.wait).toMatch(/Head of Creative/);
    }
  });

  it("copy: automatic, nobody's button", () => {
    const b = ticketView("copy", "lead").bar;
    expect(b.primary).toBeNull();
    expect(b.wait).toMatch(/copywriter/i);
  });

  it("copy review: View copy first, then Approve copy with Review copy", () => {
    expect(ticketView("copy_review", "copywriter").bar.primary?.kind).toBe("view-copy");
    const b = ticketView("copy_review", "copywriter", { opened: true }).bar;
    expect(b.primary?.kind).toBe("approve-copy");
    expect(b.secondary.map((c) => c.kind)).toEqual(["review-copy"]);
    expect(ticketView("copy_review", "maker", { opened: true }).bar.primary).toBeNull();
  });

  it("with the client: summary, creative and copy on click; Approved by client or Send for revision", () => {
    const v = ticketView("client_review", "team");
    expect(v.sections).toEqual(["creative-strip", "copy-strip"]);
    expect(v.bar.primary?.kind).toBe("client-approved");
    expect(v.bar.secondary.map((c) => c.kind)).toEqual(["client-revision"]);
  });

  it("ready to launch: Make campaign live, then View in Ads Manager and Complete task once launched", () => {
    expect(ticketView("ready_for_launch", "team").sections).toEqual(["creative-strip", "copy-strip", "launcher"]);
    expect(ticketView("ready_for_launch", "team").bar.primary?.kind).toBe("make-live");
    for (const status of ["none", "planning", "ready", "blocked", "failed"] as const) expect(ticketView("ready_for_launch", "team", { launch: { status, link: null, sandbox: false } }).bar.primary?.kind).toBe("make-live");
    expect(ticketView("ready_for_launch", "team", { launch: { status: "launching", link: null, sandbox: false } }).bar.wait).toMatch(/Meta/);
    const done = ticketView("ready_for_launch", "team", { launch: { status: "launched", link: "https://adsmanager.facebook.com/x", sandbox: false } }).bar;
    expect(done.primary?.kind).toBe("ads-manager");
    expect(done.secondary.map((c) => c.kind)).toEqual(["complete"]);
  });

  it("completed: read-only, with the Ads Manager link when there is one", () => {
    const v = ticketView("launched", "lead", { launch: { status: "launched", link: "https://x", sandbox: false } });
    expect(v.readOnly).toBe(true);
    expect(v.bar.primary?.kind).toBe("ads-manager");
    expect(ticketView("launched", "lead").bar.primary).toBeNull();
  });
});

describe("productionBar: the main action moves with the work", () => {
  it("no uploads: Upload creative", () => {
    expect(kinds(productionBar(base))).toEqual(["upload"]);
  });
  it("uploading: says so, no button", () => {
    const b = productionBar(p({ uploaded: 1, uploading: 2 }));
    expect(b.primary).toBeNull();
    expect(b.wait).toMatch(/Uploading/);
  });
  it("sizes missing: uploading them is the step", () => {
    expect(kinds(productionBar(p({ uploaded: 1, missing: ["Missing 9:16 for D1"] })))).toEqual(["upload"]);
  });
  it("uploaded, everything in, not reviewed: Review my creative", () => {
    expect(kinds(productionBar(p({ uploaded: 2 })))).toEqual(["ai-review"]);
  });
  it("review running: says so", () => {
    expect(productionBar(p({ uploaded: 2, review: { status: "running", current: true } })).wait).toMatch(/reviewing/);
  });
  it("reviewed with comments: View comments, then Upload new version and Send for approval", () => {
    expect(kinds(productionBar(p({ uploaded: 2, review: { status: "done", current: true }, openComments: 3 })))).toEqual(["view-comments", "upload-version", "send-approval"]);
  });
  it("reviewed clean: Send for approval", () => {
    expect(kinds(productionBar(p({ uploaded: 2, review: { status: "done", current: true } })))).toEqual(["send-approval", "upload-version"]);
  });
  it("new version since the review: review it again, and it can still be sent", () => {
    expect(kinds(productionBar(p({ uploaded: 2, review: { status: "done", current: false }, openComments: 1 })))).toEqual(["ai-review", "view-comments", "send-approval"]);
  });
  it("a failed review: run it again", () => {
    expect(kinds(productionBar(p({ uploaded: 1, review: { status: "failed", current: false } })))).toEqual(["ai-review"]);
  });
});

describe("ticketRole", () => {
  it("leads review, copywriters approve copy, the assignee makes", () => {
    expect(ticketRole({ review: true })).toBe("lead");
    expect(ticketRole({ approveCopy: true })).toBe("copywriter");
    expect(ticketRole({}, true)).toBe("maker");
    expect(ticketRole({})).toBe("team");
  });
});

describe("makingMinutes: time in production from the ticket's moves", () => {
  it("adds up production and client changes, until now when it's still there", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();
    const events = [
      { kind: "created", toStage: "requested" as Stage, at: at(0) },
      { kind: "stage", toStage: "in_production" as Stage, at: at(1) },
      { kind: "stage", toStage: "internal_review" as Stage, at: at(4) },
      { kind: "stage", toStage: "client_revision" as Stage, at: at(10) },
    ];
    expect(makingMinutes(events, Date.parse(at(12)))).toBe(5 * 60);
    expect(span(5 * 60)).toBe("5h");
    expect(span(26 * 60 + 30)).toBe("1d 2h");
    expect(span(45)).toBe("45m");
  });
  it("ignores deletes and restores", () => {
    const events = [{ kind: "stage", toStage: "in_production" as Stage, at: "2026-11-10T00:00:00Z", data: { action: "restored" } }];
    expect(makingMinutes(events, Date.parse("2026-11-10T05:00:00Z"))).toBe(0);
  });
});
