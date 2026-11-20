import { describe, expect, it } from "vitest";
import { leastUsedFirst } from "@/lib/activity";
import { hasImported, importSummary } from "@/lib/kaizen-ai/imports-summary";

describe("usage by person (least used first)", () => {
  it("puts never-active people first, then the fewest minutes, then the longest since last on", () => {
    const rows = [
      { name: "Busy", lastActiveAt: "2026-11-19T10:00:00Z", minutes: 900 },
      { name: "Quiet old", lastActiveAt: "2026-11-01T10:00:00Z", minutes: 30 },
      { name: "Never", lastActiveAt: null, minutes: 0 },
      { name: "Quiet recent", lastActiveAt: "2026-11-18T10:00:00Z", minutes: 30 },
      { name: "Light", lastActiveAt: "2026-11-19T10:00:00Z", minutes: 120 },
    ];
    expect(leastUsedFirst(rows).map((r) => r.name)).toEqual(["Never", "Quiet old", "Quiet recent", "Light", "Busy"]);
  });

  it("leaves the list it was given alone", () => {
    const rows = [
      { name: "B", lastActiveAt: null, minutes: 5 },
      { name: "A", lastActiveAt: null, minutes: 0 },
    ];
    leastUsedFirst(rows);
    expect(rows[0].name).toBe("B");
  });
});

describe("Kaizen AI imports on the Team page", () => {
  it("reads what was imported, only the kinds they have", () => {
    expect(importSummary({ chats: 12, projects: 2, docs: 5 })).toBe("12 chats · 2 projects · 5 docs");
    expect(importSummary({ chats: 1, projects: 0, docs: 1 })).toBe("1 chat · 1 doc");
    expect(hasImported({ chats: 0, projects: 1, docs: 0 })).toBe(true);
  });

  it("reads as nothing imported when there's nothing (or it couldn't be read)", () => {
    expect(importSummary({ chats: 0, projects: 0, docs: 0 })).toBeNull();
    expect(importSummary(null)).toBeNull();
    expect(hasImported(undefined)).toBe(false);
  });
});
