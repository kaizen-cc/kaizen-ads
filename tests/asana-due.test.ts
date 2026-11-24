import { describe as group, expect, it } from "vitest";
import { asanaSummary, describe, dueBucket, linkLabel, orderAsana } from "@/lib/asana-due";

// Tuesday Nov 24 2026, 10am in New York
const now = new Date("2026-11-24T15:00:00Z");

group("Next for me in Asana, by when it's due", () => {
  it("buckets by New York day: overdue, today, tomorrow, by Friday, later", () => {
    expect(dueBucket("2026-11-20", now)).toBe("overdue");
    expect(dueBucket("2026-11-24T21:00:00Z", now)).toBe("today");
    expect(dueBucket("2026-11-25", now)).toBe("tomorrow");
    expect(dueBucket("2026-11-27", now)).toBe("week");
    expect(dueBucket("2026-11-30", now)).toBe("later");
    expect(dueBucket(null, now)).toBe("later");
  });

  it("the big number is due today with overdue said; tomorrow and the week are chips; everything is the count in all", () => {
    const cards = [{ due: "2026-11-20" }, { due: "2026-11-24" }, { due: "2026-11-24" }, { due: "2026-11-25" }, { due: "2026-11-26" }, { due: null }, { due: "2026-12-10" }];
    expect(asanaSummary(cards, now)).toEqual({ big: 3, label: "due today, incl. 1 overdue", chips: ["1 tomorrow", "1 by Friday"], all: 7 });
    expect(asanaSummary([{ due: "2026-11-25" }, { due: null }], now)).toEqual({ big: 0, label: "due today", chips: ["1 tomorrow"], all: 2 });
  });

  it("lists overdue, today, tomorrow, this week, and folds the rest", () => {
    const { soon, later } = orderAsana([{ due: null }, { due: "2026-11-26" }, { due: "2026-11-24" }, { due: "2026-11-21" }, { due: "2026-11-25" }, { due: "2026-12-01" }], now);
    expect(soon.map((c) => c.due)).toEqual(["2026-11-21", "2026-11-24", "2026-11-25", "2026-11-26"]);
    expect(later.map((c) => c.due)).toEqual(["2026-12-01", null]);
  });
});

group("a task's description, never raw addresses", () => {
  it("labels links and keeps about two lines", () => {
    expect(linkLabel("https://www.loom.com/share/abc123")).toBe("Loom video");
    expect(linkLabel("https://app.asana.com/app/asana/-/get_asset?asset_id=12")).toBe("Attachment");
    const d = describe("Walkthrough here https://www.loom.com/share/abc123. Files: https://app.asana.com/app/asana/-/get_asset?asset_id=12 thanks");
    expect(d).toEqual([{ text: "Walkthrough here " }, { text: "Loom video", href: "https://www.loom.com/share/abc123" }, { text: ". Files: " }, { text: "Attachment", href: "https://app.asana.com/app/asana/-/get_asset?asset_id=12" }, { text: " thanks" }]);
    expect(describe("word ".repeat(100), 50).map((p) => p.text).join("").length).toBeLessThanOrEqual(52);
  });
});
