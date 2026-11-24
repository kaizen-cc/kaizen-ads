import { describe, expect, it } from "vitest";
import { dayLogicHash } from "../day-logic-hash.mjs";

describe("the fingerprint of the code that builds a day", () => {
  it("covers what gathers, owns and closes a day, and is stable", () => {
    const a = dayLogicHash();
    for (const f of ["today.ts", "today-snapshot.ts", "exec-overview.ts", "item-owners.ts", "agent-asks.ts", "support-day.ts", "maker-day.ts", "today-lines.ts"]) expect(a.files).toContain(f);
    expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(dayLogicHash().hash).toBe(a.hash);
  });
});
