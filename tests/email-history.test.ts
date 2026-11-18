import { describe, expect, it } from "vitest";
import { historyBusy, historyGap, historyHolds, historyWindows, monthStart, readingLine, stretchLabel, type HistoryState } from "@/lib/email-history/core";
import { catchUpKind } from "@/lib/channel-reports/core";
import { activePauses, pauseHolds, withoutPaused } from "@/lib/account-watch/pauses-core";

describe("a range before the stored history", () => {
  const today = "2026-11-18";
  it("Crust: Mar 1 asked, stored from Aug 19 -> Mar to Aug is missing", () => {
    expect(historyGap({ wantStart: "2026-03-01", stored: "2026-08-19", today })).toEqual({ from: "2026-03-01", to: "2026-08-18" });
  });
  it("starts at the month the range starts in", () => {
    expect(historyGap({ wantStart: "2026-03-14", stored: "2026-08-19", today })?.from).toBe("2026-03-01");
  });
  it("nothing is missing inside the stored days, or before anything is stored", () => {
    expect(historyGap({ wantStart: "2026-09-01", stored: "2026-08-19", today })).toBeNull();
    expect(historyGap({ wantStart: "2026-08-19", stored: "2026-08-19", today })).toBeNull();
    expect(historyGap({ wantStart: "2026-03-01", stored: null, today })).toBeNull();
  });
  it("what an earlier read covered (even empty) is not asked again", () => {
    expect(historyGap({ wantStart: "2026-03-01", stored: "2026-08-19", covered: "2026-03-01", today })).toBeNull();
    expect(historyGap({ wantStart: "2026-01-01", stored: "2026-08-19", covered: "2026-05-01", today })).toEqual({ from: "2026-01-01", to: "2026-04-30" });
  });
  it("never goes past two years, or before the client's start", () => {
    expect(historyGap({ wantStart: "2020-01-01", stored: "2026-08-19", today })?.from).toBe("2024-11-19");
    expect(historyGap({ wantStart: "2020-01-01", stored: "2026-08-19", today, floor: "2026-02-10" })?.from).toBe("2026-02-01");
  });
  it("words the stretch", () => {
    expect(stretchLabel("2026-03-01", "2026-08-18")).toBe("Mar to Aug");
    expect(stretchLabel("2026-05-01", "2026-05-31")).toBe("May");
    expect(stretchLabel("2025-11-01", "2026-02-28")).toBe("Nov 2025 to Feb 2026");
    expect(readingLine("Klaviyo", "2026-03-01", "2026-08-18")).toBe("Reading Mar to Aug history from Klaviyo...");
    expect(monthStart("2026-03-14")).toBe("2026-03-01");
  });
  it("reads newest first in pieces", () => {
    const w = historyWindows("2026-03-01", "2026-08-18", 45);
    expect(w[0].end).toBe("2026-08-18");
    expect(w.at(-1)!.start).toBe("2026-03-01");
    expect(w.every((x) => x.start <= x.end)).toBe(true);
  });
  it("holds a report back only while the read is live and covers its first day", () => {
    const s: HistoryState = { status: "running", want: "2026-03-01", to: "2026-08-18", cursor: null, pct: 10, step: "", at: new Date().toISOString() };
    expect(historyHolds(s, "2026-03-01")).toBe(true);
    expect(historyHolds(s, "2026-09-10")).toBe(false);
    expect(historyHolds({ ...s, status: "done" }, "2026-03-01")).toBe(false);
    expect(historyBusy({ ...s, at: new Date(Date.now() - 3_600_000).toISOString() })).toBe(false);
  });
  it("catches up a newly connected client the days after Monday", () => {
    expect(catchUpKind({ weekday: "Wed", dom: 18, hour: 9 })).toBe("weekly");
    expect(catchUpKind({ weekday: "Tue", dom: 3, hour: 9 })).toBe("monthly");
    expect(catchUpKind({ weekday: "Mon", dom: 16, hour: 9 })).toBeNull();
    expect(catchUpKind({ weekday: "Wed", dom: 18, hour: 3 })).toBeNull();
  });
});

describe("pauses", () => {
  const rows = [
    { client_id: "a", service: "email-marketing", until: "2026-12-01", reason: "off season" },
    { client_id: "b", service: "email-marketing", until: "2026-11-01", reason: "ended" },
    { client_id: "c", service: "email-marketing", until: "2026-12-01", reason: "x", cleared_at: "2026-11-10" },
    { client_id: "d", service: "social-media", until: "2026-12-01", reason: "other line" },
  ];
  it("holds until its date, inclusive, unless ended early", () => {
    expect(pauseHolds({ until: "2026-11-18" }, "2026-11-18")).toBe(true);
    expect(pauseHolds({ until: "2026-11-17" }, "2026-11-18")).toBe(false);
    expect(pauseHolds({ until: "2026-12-01", cleared_at: "x" }, "2026-11-18")).toBe(false);
  });
  it("lists the paused clients of one service", () => {
    const m = activePauses(rows, "email-marketing", "2026-11-18");
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")?.reason).toBe("off season");
  });
  it("leaves paused clients out and keeps the rest", () => {
    const paused = activePauses(rows, "email-marketing", "2026-11-18");
    const items = [{ clientId: "a" }, { clientId: "b" }, { clientId: null }];
    expect(withoutPaused(items, (x) => x.clientId, paused)).toEqual([{ clientId: "b" }, { clientId: null }]);
  });
});
