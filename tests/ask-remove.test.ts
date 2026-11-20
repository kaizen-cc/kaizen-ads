import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { removeItem } from "@/lib/agent-call/ask-rules";

describe("removing a reminder line that's no longer needed", () => {
  const list = [
    { text: "Send the Q4 calendar", done: false },
    { text: "Confirm the budget", done: true },
    { text: "Book the shoot", done: false },
  ];

  it("takes that one line off, by its words, and leaves the rest as they were", () => {
    expect(removeItem(list, "Confirm the budget")).toEqual([list[0], list[2]]);
    expect(removeItem(list, "  book the SHOOT ")).toEqual([list[0], list[1]]);
  });

  it("changes nothing when the line is already gone", () => {
    expect(removeItem(list, "Something else")).toEqual(list);
  });

  it("sets the reminder aside (dismissed), only the owner's own, and the Overview asks before removing", () => {
    const actions = readFileSync("src/app/(team)/pipeline/next-actions.ts", "utf8");
    expect(actions).toMatch(/export async function removeAsks[\s\S]*status: "dismissed"[\s\S]*\.eq\("owner_id", me\.id\)/);
    const view = readFileSync("src/app/(team)/pipeline/views/next-list.tsx", "utf8");
    expect(view).toMatch(/confirm\(`Remove /);
    expect(view).toContain("removeAsks(ids)");
    expect(view).toContain("removeAskGroupItem(");
  });
});
