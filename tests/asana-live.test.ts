import { describe, expect, it } from "vitest";
import { changeNote, dueLabel, quickDue, sortTasks } from "@/lib/asana-live-core";

const now = new Date("2026-11-20T15:00:00Z"); // a Friday in New York

describe("quick due dates", () => {
  it("reads today, tomorrow, weekdays and dates", () => {
    expect(quickDue("today", now)).toBe("2026-11-20");
    expect(quickDue("tomorrow", now)).toBe("2026-11-21");
    expect(quickDue("monday", now)).toBe("2026-11-23");
    expect(quickDue("friday", now)).toBe("2026-11-27");
    expect(quickDue("2026-12-01", now)).toBe("2026-12-01");
    expect(quickDue("someday", now)).toBeNull();
  });
});

describe("the Asana comment naming who changed it", () => {
  it("says what changed and who, via Kaizen OS", () => {
    expect(changeNote({ due: "2026-11-24" }, { due: "2026-11-20", start: null, name: "x", section: null, completed: false }, "Sam Lee")).toBe("Due date moved to Nov 24 by Sam Lee via Kaizen OS");
    expect(changeNote({ completed: true, sectionName: "Done" }, { due: null, start: null, name: "x", section: { gid: "1", name: "Doing" }, completed: false }, "Sam")).toBe("Marked complete; Moved to Done by Sam via Kaizen OS");
  });
  it("is nothing when nothing changed", () => {
    expect(changeNote({ due: "2026-11-20" }, { due: "2026-11-20", start: null, name: "x", section: null, completed: false }, "Sam")).toBeNull();
  });
});

describe("the task list", () => {
  it("puts overdue first, undated last", () => {
    const t = (name: string, due: string | null) => ({ name, due });
    expect(sortTasks([t("c", null), t("b", "2026-11-25"), t("a", "2026-11-18")]).map((x) => x.name)).toEqual(["a", "b", "c"]);
  });
  it("labels the due date", () => {
    expect(dueLabel("2026-11-18", "2026-11-20")).toEqual({ text: "Overdue · Nov 18", late: true });
    expect(dueLabel("2026-11-21", "2026-11-20").text).toBe("Tomorrow");
  });
});
