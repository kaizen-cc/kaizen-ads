import { describe, expect, it } from "vitest";
import { matchPerson, median, membersOf, normName, parseVerdicts, pct, replyStats, reportDue, reportTimeliness, requestTimeliness, syncOf, tabHref, tabOf, teamOf, trendOf } from "@/lib/team-kpis-core";
import { buildPasses, buildReturns, holdTimes, isBottleneck, STRATEGIST_STAGES, stintsOf, type Piece } from "@/lib/email-kpis-core";
import { teamBoardsFor } from "@/lib/kaizen-ai/team-kpi-tools";

// The people are roles, never names: a stand-in team covering every case the boards must get right
const people = [
  { id: "exec", role: "executive", is_exec: true },
  { id: "head-email", role: "head_of_email" },
  { id: "head-creative", role: "head_of_creative" },
  { id: "strat", role: "email_strategist" },
  { id: "designer", role: "email_designer" },
  { id: "builder-designs", role: "email_builder", also_designs_email: true },
  { id: "builder", role: "email_builder" },
  { id: "builder-seat", role: "email_builder" },
  { id: "video", role: "video_editor" },
  { id: "lead-video", role: "lead_video_editor" },
  { id: "graphic", role: "graphic_designer" },
  { id: "lead-graphic", role: "lead_graphic_designer" },
  { id: "writer", role: "copywriter" },
  { id: "social", role: "social_media_manager" },
];
const seats = [
  { profile_id: "builder-seat", role: "email_designer" },
  // A video editor holding an email designer seat is still not on the email board (the role decides)
  { profile_id: "video", role: "email_designer" },
  // The head of email holds strategist seats: still never on her own board
  { profile_id: "head-email", role: "email_strategist" },
  { profile_id: "exec", role: "email_strategist" },
];
const ids = (s: Set<string>) => [...s].sort();

describe("who is on each tab", () => {
  it("Email design: designers and builders who design, never a video editor, a head or an exec", () => {
    expect(ids(membersOf("email", "design", people, seats))).toEqual(["builder-designs", "builder-seat", "designer"]);
  });
  it("Email build: builders only", () => {
    expect(ids(membersOf("email", "build", people, seats))).toEqual(["builder", "builder-designs", "builder-seat"]);
  });
  it("Email copy and strategy: strategists only (a designer never shows on Copy)", () => {
    expect(ids(membersOf("email", "copy", people, seats))).toEqual(["strat"]);
    expect(ids(membersOf("email", "strategy", people, seats))).toEqual(["strat"]);
  });
  it("Creative: designers (lead included), video editors (lead included), copywriters; never the Head of Creative", () => {
    expect(ids(membersOf("creative", "design", people))).toEqual(["graphic", "lead-graphic"]);
    expect(ids(membersOf("creative", "video", people))).toEqual(["lead-video", "video"]);
    expect(ids(membersOf("creative", "copy", people))).toEqual(["writer"]);
  });
  it("leaves out whoever is looking", () => {
    expect(membersOf("email", "design", people, seats, "designer").has("designer")).toBe(false);
  });
  it("the whole team (workload) has strategists, designers and builders", () => {
    expect(ids(teamOf("email", people, seats))).toEqual(["builder", "builder-designs", "builder-seat", "designer", "strat"]);
  });
  it("tabs live in the address; an older copy link is the Copy tab", () => {
    expect(tabOf("email", "kpis", "build")).toBe("build");
    expect(tabOf("email", "copy-kpis", undefined)).toBe("copy");
    expect(tabOf("email", "kpis", "video")).toBe("design");
    expect(tabOf("creative", "kpis", "video")).toBe("video");
    expect(tabHref("email", "strategy", "30")).toBe("/board/email?view=kpis&tab=strategy&period=30");
    expect(tabHref("creative", "copy", "cycle")).toBe("/board?view=kpis&tab=copy");
  });
  it("only execs and the right heads read the boards (the assistant tool)", () => {
    expect(teamBoardsFor({ role: "executive", isExec: true, isLead: false })).toEqual(["email", "creative"]);
    expect(teamBoardsFor({ role: "head_of_email", isExec: false, isLead: true })).toEqual(["email"]);
    expect(teamBoardsFor({ role: "head_of_creative", isExec: false, isLead: true })).toEqual(["creative"]);
    expect(teamBoardsFor({ role: "email_designer", isExec: false, isLead: false })).toEqual([]);
  });
});

describe("matching an Asana name to a teammate", () => {
  const team = [
    { id: "video", full_name: "Daniel", role: "video_editor" },
    { id: "designer", full_name: "Dani Beltran", role: "email_designer" },
    { id: "builder", full_name: "Andres Cortez", role: "email_builder" },
    { id: "head", full_name: "Mel Crosson", role: "head_of_email" },
    { id: "a", full_name: "Sam Lee", role: "email_designer" },
    { id: "b", full_name: "Sam Park", role: "email_designer" },
  ];
  const email = (p: { role: string }) => p.role.startsWith("email") || p.role === "head_of_email";
  it("a longer first name with the same last name is the designer, never the video editor sharing its start", () => {
    expect(matchPerson("Danielis Beltran", team, email)?.id).toBe("designer");
  });
  it("accents don't matter", () => {
    expect(normName("Andrés  Cortez")).toBe("andres cortez");
    expect(matchPerson("Andrés Cortez", team, email)?.id).toBe("builder");
  });
  it("a first name alone matches when only one person has it", () => {
    expect(matchPerson("Mel", team, email)?.id).toBe("head");
  });
  it("two equally close people is no match", () => {
    expect(matchPerson("Sam", team, email)).toBeNull();
    expect(matchPerson("Sam Park", team, email)?.id).toBe("b");
  });
  it("different last names never match", () => {
    expect(matchPerson("Dani Smith", team, email)).toBeNull();
    expect(matchPerson(null, team)).toBeNull();
  });
});

describe("the cards' math", () => {
  it("rates and medians", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(trendOf(70, 60, 2)).toBe("up");
    expect(trendOf(60, 61, 2)).toBe("flat");
    expect(trendOf(null, 60)).toBeNull();
  });
  it("a request needs the full lead before its send date", () => {
    // Monday Nov 2 to Friday Nov 13 at 5pm: 9 business days and change
    const early = requestTimeliness("2026-11-02T14:00:00Z", "2026-11-13");
    expect(early?.onTime).toBe(true);
    const late = requestTimeliness("2026-11-10T14:00:00Z", "2026-11-13");
    expect(late?.onTime).toBe(false);
    expect(late!.short).toBeGreaterThan(5);
    expect(requestTimeliness("2026-11-10T14:00:00Z", null)).toBeNull();
  });
  it("reports: weekly due two days after the week, monthly three business days after the month", () => {
    expect(reportDue("weekly", "2026-11-15")).toBe("2026-11-17");
    // October 31 2026 is a Saturday: Mon 2, Tue 3, Wed 4
    expect(reportDue("monthly", "2026-10-31")).toBe("2026-11-04");
    const r = reportTimeliness(
      [
        { kind: "weekly", periodEnd: "2026-11-08", postedAt: "2026-11-10T20:00:00Z" }, // on time (Tue)
        { kind: "weekly", periodEnd: "2026-11-01", postedAt: "2026-11-05T15:00:00Z" }, // late
        { kind: "monthly", periodEnd: "2026-10-31", postedAt: null }, // not sent, past due: late
        { kind: "weekly", periodEnd: "2026-11-15", postedAt: null }, // not due yet: not counted
        { kind: "weekly", periodEnd: "2026-10-25", postedAt: null, status: "skipped" }, // skipped: not counted
      ],
      "2026-11-16",
    );
    expect(r.onTime).toBe(1);
    expect(r.late).toBe(2);
    expect(r.rate).toBe(33);
  });
  it("replies owed: median hours to answer, waiting and escalated", () => {
    const s = replyStats([
      { asked_at: "2026-11-16T10:00:00Z", answered_at: "2026-11-16T12:00:00Z", status: "answered" },
      { asked_at: "2026-11-16T10:00:00Z", answered_at: "2026-11-16T16:00:00Z", status: "answered" },
      { asked_at: "2026-11-16T10:00:00Z", answered_at: null, status: "escalated" },
      { asked_at: "2026-11-16T10:00:00Z", answered_at: null, status: "dismissed" },
    ]);
    expect(s).toEqual({ medianHours: 4, answered: 2, waiting: 1, escalated: 1 });
  });
  it("a client whose platform isn't reading says so, never a silent zero", () => {
    expect(syncOf("connected", "Klaviyo", null, null).ok).toBe(true);
    expect(syncOf("missing", "Klaviyo", null, null)).toMatchObject({ ok: false, label: "No email platform connected" });
    const f = syncOf("failing", "Klaviyo", "2026-11-10T12:00:00Z", "Klaviyo refused the key.");
    expect(f).toMatchObject({ ok: false, label: "Klaviyo isn't syncing", detail: "Klaviyo refused the key." });
    expect(syncOf("behind", "Brevo", "2026-11-10T17:00:00Z", null).label).toBe("Brevo hasn't synced since Nov 10");
  });
});

// November 2026 (New York): the 16th is a Monday
const at = (day: number, hour = 15) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
function piece(stints: Piece["stints"], over: Partial<Piece> = {}): Piece {
  return { key: "k:1", source: "kaizen", number: 1, title: "Batch", clientId: "c1", client: "Acme", slug: "acme", kind: "batch", createdAt: at(16, 13), open: false, stage: "live", href: "#", external: false, dueFirst: null, dueNow: null, dues: [], stints, uploads: [], notes: [], rewrites: [], drafted: null, copyApproved: null, minutesOver: 0, holderNow: null, messages: 1, ...over };
}

describe("builders and strategists", () => {
  const p = piece(
    stintsOf(
      at(16, 13),
      "copy_review",
      [
        { at: at(16, 15), to: "ready_for_design" },
        { at: at(18, 15), to: "for_review" },
        { at: at(19, 15), to: "ready_for_build" },
        { at: at(20, 15), to: "ready_to_send" },
        { at: at(23, 15), to: "ready_for_build" }, // came back: a wrong link
        { at: at(24, 15), to: "ready_to_send" },
        { at: at(25, 15), to: "live" },
      ],
      [
        { at: at(16, 13), to: "strat" },
        { at: at(16, 15), to: "designer" },
        { at: at(18, 15), to: "strat" },
        { at: at(19, 15), to: "builder" },
        { at: at(20, 15), to: "strat" },
        { at: at(23, 15), to: "builder" },
        { at: at(24, 15), to: "strat" },
      ],
      null,
      false,
    ),
  );
  it("builds finished, credited to the builder, with business days", () => {
    const b = buildPasses([p], at(1), at(30));
    expect(b.map((x) => x.person)).toEqual(["builder", "builder"]);
    expect(b[0].days).toBe(1);
    expect(b.every((x) => x.onTime)).toBe(true);
  });
  it("a build that came back counts against the builder who had it", () => {
    const r = buildReturns([p], at(1));
    expect(r).toHaveLength(1);
    expect(r[0].person).toBe("builder");
  });
  it("time work sits with the strategist, and the bottleneck flag", () => {
    const h = holdTimes([p], STRATEGIST_STAGES, at(1), at(30)).filter((x) => x.person === "strat");
    expect(h.map((x) => x.stage)).toEqual(["copy_review", "for_review", "ready_to_send", "ready_to_send"]);
    // Friday 3pm to Monday 3pm is one business day
    expect(h[2].days).toBe(1);
    expect(isBottleneck(1.6, 0)).toBe(true);
    expect(isBottleneck(1.1, 2)).toBe(true);
    expect(isBottleneck(1.1, 1)).toBe(false);
    expect(isBottleneck(null, 0)).toBe(false);
  });
});

describe("reading the error classifier", () => {
  it("keeps only indexes in the batch, each once, with a short type", () => {
    const out = parseVerdicts(
      {
        items: [
          { i: 0, verdict: "error", type: "Wrong link" },
          { i: 0, verdict: "preference", type: "" },
          { i: 1, verdict: "preference", type: "ignored" },
          { i: 2, verdict: "maybe", type: "" },
          { i: 3, verdict: "error", type: "" },
          { i: 9, verdict: "error", type: "out of range" },
          { i: "4", verdict: "error", type: "A very long label that goes on far beyond forty characters" },
          null,
        ],
      },
      5,
    );
    expect(out).toEqual([
      { index: 0, verdict: "error", type: "Wrong link" },
      { index: 1, verdict: "preference", type: null },
      { index: 2, verdict: "unclear", type: null },
      { index: 3, verdict: "error", type: "Error" },
      { index: 4, verdict: "error", type: "A very long label that goes on far beyon" },
    ]);
  });
  it("reads JSON text, fenced or bare, and a bare list", () => {
    expect(parseVerdicts('```json\n{"items":[{"i":0,"verdict":"error","type":"Typo"}]}\n```', 1)).toEqual([{ index: 0, verdict: "error", type: "Typo" }]);
    expect(parseVerdicts([{ i: 0, verdict: "unclear", type: "" }], 1)).toEqual([{ index: 0, verdict: "unclear", type: null }]);
    expect(parseVerdicts("not json", 3)).toEqual([]);
    expect(parseVerdicts(undefined, 3)).toEqual([]);
  });
});
