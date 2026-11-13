import { describe, expect, it } from "vitest";
import { appendLog, bringBackUntil, canBringBack, isSkipReason, latestSkip, logLine, parseLog, skipEntry, skipLine, unskipEntry } from "@/lib/reports/skip-log";

const by = { by: "u1", byName: "Dana Reyes" };

describe("report skip log", () => {
  it("keeps only well-formed entries", () => {
    expect(parseLog(null)).toEqual([]);
    expect(parseLog([{ action: "nope", at: "2026-11-13T12:00:00Z" }, { action: "skipped" }, "x", { action: "skipped", at: "2026-11-13T12:00:00Z", reason: "old_way" }])).toHaveLength(1);
  });

  it("appends to what is there and caps the length", () => {
    const one = appendLog([], skipEntry({ reason: "old_way", ...by, at: "2026-11-13T12:00:00Z" }));
    const two = appendLog(one, unskipEntry({ ...by, at: "2026-11-14T12:00:00Z" }));
    expect(two.map((e) => e.action)).toEqual(["skipped", "unskipped"]);
    let big: unknown = [];
    for (let i = 0; i < 130; i++) big = appendLog(big, skipEntry({ reason: "not_ready", ...by, at: "2026-11-13T12:00:00Z" }));
    expect(parseLog(big)).toHaveLength(100);
  });

  it("cleans the note", () => {
    expect(skipEntry({ reason: "own_way", note: "  sent \n  it on a call ", ...by }).note).toBe("sent it on a call");
    expect(skipEntry({ reason: "own_way", note: "   ", ...by }).note).toBeNull();
  });

  it("only a skip that was not brought back is in force", () => {
    const s = skipEntry({ reason: "old_way", ...by, at: "2026-11-13T15:00:00Z" });
    expect(latestSkip([s])?.reason).toBe("old_way");
    expect(latestSkip(appendLog([s], unskipEntry({ ...by })))).toBeNull();
    expect(latestSkip(undefined)).toBeNull();
  });

  it("summarises the skip", () => {
    const s = skipEntry({ reason: "old_way", ...by, at: "2026-11-13T15:00:00Z" });
    expect(skipLine(s)).toBe("Skipped by Dana · Nov 13 · Sent it the old way");
    expect(logLine({ ...s, note: "Sent from their CRM" })).toBe('Skipped by Dana · Nov 13 · Sent it the old way · "Sent from their CRM"');
    expect(logLine(unskipEntry({ ...by, at: "2026-11-14T15:00:00Z" }))).toBe("Brought back by Dana · Nov 14");
  });

  it("knows the reasons", () => {
    expect(isSkipReason("paused")).toBe(true);
    expect(isSkipReason("because")).toBe(false);
  });

  it("can be brought back until the next period is over", () => {
    expect(bringBackUntil("weekly", "2026-11-08")).toBe("2026-11-15");
    expect(bringBackUntil("monthly", "2026-10-31")).toBe("2026-11-30");
    expect(bringBackUntil("monthly", "2026-12-31")).toBe("2027-01-31");
    expect(canBringBack("weekly", "2026-11-08", "2026-11-15")).toBe(true);
    expect(canBringBack("weekly", "2026-11-08", "2026-11-16")).toBe(false);
  });
});
