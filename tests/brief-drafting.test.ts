import { describe, expect, it } from "vitest";
import {
  accountState,
  canApprove,
  canForceSwap,
  catchUpWeek,
  churning,
  cleanDeadline,
  dueLabel,
  groupByClient,
  hasRealReason,
  isoWeek,
  leadsFor,
  mixFor,
  outranks,
  paceFor,
  pacingTake,
  pickTrack,
  swapVerdict,
  weekPace,
  type ReadyItem,
} from "@/lib/brief-drafting-core";

describe("the mix follows the account's performance", () => {
  it("reads the account from its KPIs, ignoring ones with no read", () => {
    expect(accountState([{ status: "good" }, { status: "excellent" }, { status: "idle" }])).toBe("beating");
    expect(accountState([{ status: "good" }, { status: "off" }])).toBe("behind");
    expect(accountState([{ status: "close" }])).toBe("behind");
    expect(accountState([{ status: "off" }, { status: "off" }])).toBe("nothing");
    expect(accountState([{ status: "setup" }, { status: "unset" }])).toBe("unknown");
  });

  it("beating: 60% iterations; behind: 60% net new; nothing working: mostly net new", () => {
    expect(mixFor("beating")).toMatchObject({ iterate: 60, netNew: 40 });
    expect(mixFor("behind")).toMatchObject({ iterate: 40, netNew: 60 });
    expect(mixFor("nothing").netNew).toBeGreaterThanOrEqual(80);
    for (const s of ["beating", "behind", "nothing", "unknown"] as const) expect(mixFor(s).reason.length).toBeGreaterThan(20);
  });

  it("picks the track furthest under its share", () => {
    const beating = mixFor("beating");
    expect(pickTrack(beating, { iterate: 0, netNew: 0 })).toBe("iterate");
    expect(pickTrack(beating, { iterate: 3, netNew: 1 })).toBe("net_new");
    expect(pickTrack(beating, { iterate: 1, netNew: 1 })).toBe("iterate");
    expect(pickTrack(mixFor("nothing"), { iterate: 0, netNew: 3 })).toBe("iterate");
    expect(pickTrack(mixFor("nothing"), { iterate: 1, netNew: 1 })).toBe("net_new");
  });
});

describe("pacing: an even line through the billing cycle", () => {
  const cycle = { cycleStart: "2026-11-01", cycleEnd: "2026-12-01" };

  it("gives each week a share, never front- or back-loaded", () => {
    const w1 = weekPace({ cap: 12, asked: 0, open: 0, today: "2026-11-02", ...cycle });
    expect(w1.week).toBe(0);
    expect(w1.weekShare).toBe(3);
    expect(w1.dueByWeekEnd).toBe(3);
    expect(w1.room).toBe(3);
    const w3 = weekPace({ cap: 12, asked: 3, open: 0, today: "2026-11-16", ...cycle });
    expect(w3.dueByWeekEnd).toBe(9);
    expect(w3.room).toBe(6);
  });

  it("puts the last stub days in the last week (all of it due by the reset)", () => {
    const last = weekPace({ cap: 12, asked: 8, open: 0, today: "2026-11-29", ...cycle });
    expect(last.dueByWeekEnd).toBe(12);
    expect(last.room).toBe(4);
  });

  it("counts drafts waiting on approval, so pacing slows after an urgent brief", () => {
    const before = weekPace({ cap: 12, asked: 0, open: 0, today: "2026-11-03", ...cycle });
    const after = weekPace({ cap: 12, asked: 0, open: 4, today: "2026-11-03", ...cycle });
    expect(before.room).toBe(3);
    expect(after.room).toBe(0);
    expect(pacingTake(after.room)).toBe(0);
  });

  it("takes at most one brief's worth at a time", () => {
    expect(pacingTake(8)).toBe(3);
    expect(pacingTake(2)).toBe(2);
  });

  it("says when an urgent brief goes over the week's share, and why", () => {
    const w = weekPace({ cap: 12, asked: 2, open: 0, today: "2026-11-03", ...cycle });
    const p = paceFor("images", 12, w, 2, 4, "the client asked for it by 2026-11-07");
    expect(p.over).toBe(true);
    expect(p.line).toMatch(/Over this week's share by 3 images: the client asked/);
    expect(p.line).toMatch(/slow down/);
    expect(paceFor("videos", 4, weekPace({ cap: 4, asked: 0, open: 0, today: "2026-11-03", ...cycle }), 0, 1, null).over).toBe(false);
  });
});

describe("a healthy catch-up, never the whole gap at once", () => {
  const cycle = { cycleStart: "2026-11-01", cycleEnd: "2026-12-01" };
  it("spreads what's missing over the days left: 21 behind with 9 days left is 17 this week, not 21", () => {
    const w = catchUpWeek({ cap: 30, asked: 9, askedThisWeek: 0, open: 0, today: "2026-11-22", ...cycle });
    expect(w.daysLeft).toBe(9);
    expect(w.weekShare).toBe(17);
    expect(w.room).toBe(17);
    expect(w.behind).toBe(true);
  });
  it("on the even line, the share is the even line", () => {
    const w = catchUpWeek({ cap: 12, asked: 0, askedThisWeek: 0, open: 0, today: "2026-11-02", ...cycle });
    expect(w.weekShare).toBe(3);
    expect(w.behind).toBe(false);
  });
  it("counts what was asked this week and what waits on approval against the share", () => {
    const w = catchUpWeek({ cap: 30, asked: 14, askedThisWeek: 5, open: 6, today: "2026-11-22", ...cycle });
    expect(w.weekShare).toBe(17);
    expect(w.askedThisWeek).toBe(5);
    expect(w.room).toBe(6);
  });
  it("in the last week, all of what's missing", () => {
    const w = catchUpWeek({ cap: 30, asked: 20, askedThisWeek: 0, open: 0, today: "2026-11-29", ...cycle });
    expect(w.weekShare).toBe(10);
  });
  it("ahead of the line, nothing more this week", () => {
    expect(catchUpWeek({ cap: 12, asked: 8, askedThisWeek: 0, open: 0, today: "2026-11-03", ...cycle }).room).toBe(0);
  });
});

describe("replacements never burn hours", () => {
  it("swaps freely only what isn't made yet", () => {
    expect(swapVerdict({ kind: "draft", stage: null, status: "open" }, false)).toBe("swap");
    expect(swapVerdict({ kind: "draft", stage: null, status: "approved" }, false)).toBe("never");
    expect(swapVerdict({ kind: "request", stage: "requested" }, false)).toBe("swap");
    expect(swapVerdict({ kind: "asana", stage: "requested" }, false)).toBe("swap");
  });

  it("keeps work in production in its slot unless a lead forces it, and then adapts it", () => {
    expect(swapVerdict({ kind: "request", stage: "in_production" }, false)).toBe("never");
    expect(swapVerdict({ kind: "asana", stage: "internal_review" }, true)).toBe("adapt");
    expect(swapVerdict({ kind: "request", stage: "launched" }, true)).toBe("never");
    expect(canForceSwap({ role: "head_of_creative" })).toBe(true);
    expect(canForceSwap({ role: "lead_video_editor" })).toBe(true);
    expect(canForceSwap({ role: "media_buyer" })).toBe(false);
    expect(canForceSwap({ role: "graphic_designer" })).toBe(false);
    expect(canForceSwap({ role: "x", isExec: true })).toBe(true);
  });

  it("warns at three swaps a cycle", () => {
    expect(churning(2)).toBe(false);
    expect(churning(3)).toBe(true);
  });

  it("ranks the client, then the media buyer, then the creative team", () => {
    expect(outranks("client", "media_buyer")).toBe(true);
    expect(outranks("media_buyer", "creative")).toBe(true);
    expect(outranks("creative", "client")).toBe(false);
    expect(outranks("media_buyer", "client")).toBe(false);
    expect(outranks("creative", "creative")).toBe(true);
  });
});

describe("who approves, by role", () => {
  const none = new Set<string>();
  it("the creative leads, the head of Meta and the executives, anywhere", () => {
    for (const role of ["head_of_creative", "lead_video_editor", "lead_graphic_designer", "head_of_meta"]) expect(canApprove({ role }, none, "c1")).toBe(true);
    expect(canApprove({ role: "executive", isExec: true }, none, "c1")).toBe(true);
  });
  it("a media buyer only on the accounts they hold the Meta seat on", () => {
    expect(canApprove({ role: "media_buyer" }, new Set(["c1"]), "c1")).toBe(true);
    expect(canApprove({ role: "media_buyer" }, new Set(["c1"]), "c2")).toBe(false);
  });
  it("no one else", () => {
    for (const role of ["graphic_designer", "video_editor", "head_of_google", "copywriter"]) expect(canApprove({ role }, none, "c1")).toBe(false);
  });
  it("tells the leads of the brief's formats", () => {
    expect(leadsFor(["video"]).sort()).toEqual(["head_of_creative", "lead_video_editor"]);
    expect(leadsFor(["carousel"]).sort()).toEqual(["head_of_creative", "lead_graphic_designer"]);
  });
});

describe("every brief cites its real reason", () => {
  it("a message needs its words and when", () => {
    expect(hasRealReason({ source: "email", quote: "Can we push 20% off for Black Friday?", at: "2026-11-18T10:00:00Z" })).toBe(true);
    expect(hasRealReason({ source: "slack", quote: "Can we push 20% off for Black Friday?", at: null })).toBe(false);
  });
  it("an ad or the numbers need a number", () => {
    expect(hasRealReason({ source: "ad", quote: '"Fresh daily": cost per lead up 40%, CTR down 22%' })).toBe(true);
    expect(hasRealReason({ source: "numbers", quote: "A video answering the price objection" })).toBe(false);
    expect(hasRealReason({ source: "pattern", quote: "UGC unboxing: proven for 3 of 4 businesses like this one" })).toBe(true);
  });
  it("nothing to cite, nothing shown", () => {
    expect(hasRealReason(null)).toBe(false);
    expect(hasRealReason({ source: "call", quote: "short", at: "2026-11-18" })).toBe(false);
  });
});

describe("deadlines and order", () => {
  it("keeps only a real date from today to 120 days out", () => {
    expect(cleanDeadline("2026-11-27", "2026-11-19")).toBe("2026-11-27");
    expect(cleanDeadline("2026-11-10", "2026-11-19")).toBeNull();
    expect(cleanDeadline("2026-02-30", "2026-01-19")).toBeNull();
    expect(cleanDeadline("next friday", "2026-11-19")).toBeNull();
    expect(cleanDeadline("2027-06-01", "2026-11-19")).toBeNull();
  });

  it("labels how close it is", () => {
    expect(dueLabel("2026-11-19", "2026-11-19")).toBe("Due today");
    expect(dueLabel("2026-11-20", "2026-11-19")).toBe("Due tomorrow");
    expect(dueLabel("2026-11-23", "2026-11-19")).toBe("Due in 4 days");
    expect(dueLabel("2026-11-18", "2026-11-19")).toBe("Past due");
    expect(dueLabel(null, "2026-11-19")).toBeNull();
  });

  it("groups by client, most urgent first", () => {
    const at = "2026-11-19T00:00:00Z";
    const items: ReadyItem[] = [
      { id: "1", clientId: "a", client: "A", kind: "pacing", urgent: false, deadline: null, askedBy: "creative", createdAt: at },
      { id: "2", clientId: "b", client: "B", kind: "offer", urgent: true, deadline: "2026-11-21", askedBy: "client", createdAt: at },
      { id: "3", clientId: "a", client: "A", kind: "fatigue", urgent: false, deadline: null, askedBy: "media_buyer", createdAt: at },
      { id: "4", clientId: "a", client: "A", kind: "offer", urgent: true, deadline: "2026-11-25", askedBy: "client", createdAt: at },
    ];
    const g = groupByClient(items);
    expect(g.map((x) => x.client)).toEqual(["B", "A"]);
    expect(g[1].items.map((i) => i.id)).toEqual(["4", "3", "1"]);
  });

  it("counts KPI drops once a week", () => {
    expect(isoWeek("2026-11-19")).toBe("2026-W47");
    expect(isoWeek("2026-11-16")).toBe("2026-W47");
    expect(isoWeek("2026-11-23")).toBe("2026-W48");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
  });
});
