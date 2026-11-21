import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askRefOf, handOverLine } from "@/lib/agent-call/ask-rules";

// Issue #99: a client's follow-ups are one reminder with a checklist; delegating one line handed the whole reminder
// (every line) to the first person picked. Each line now goes on its own.
describe("delegating one line of a client's follow-ups", () => {
  const list = [
    { text: "Send the Q4 calendar", done: false },
    { text: "Confirm the budget", done: false },
    { text: "Book the shoot", done: true },
  ];

  it("hands over only that line and keeps the rest with the owner", () => {
    expect(handOverLine(list, 1)).toEqual({ line: list[0], rest: [list[1], list[2]], close: false });
    expect(handOverLine(list, 2)).toEqual({ line: list[1], rest: [list[0], list[2]], close: false });
  });

  it("closes the reminder once nothing open is left on it", () => {
    expect(handOverLine([list[1], list[2]], 1)?.close).toBe(true);
    expect(handOverLine([list[0]], 1)).toEqual({ line: list[0], rest: [], close: true });
  });

  it("refuses a line that isn't there", () => {
    expect(handOverLine(list, 0)).toBeNull();
    expect(handOverLine(list, 4)).toBeNull();
  });

  it("reads a whole reminder or one of its lines from the item ref", () => {
    expect(askRefOf("ask:abc-123")).toEqual({ id: "abc-123", line: null });
    expect(askRefOf("ask:abc-123#2")).toEqual({ id: "abc-123", line: 2 });
    expect(askRefOf("promise:abc")).toBeNull();
  });

  it("each line on the Overview's follow-ups card has its own Delegate, sending just that line", () => {
    const view = readFileSync("src/app/(team)/pipeline/views/next-list.tsx", "utf8");
    expect(view).toMatch(/<DelegatePicker small[\s\S]*delegateAskLine\(\{ askId: line\.askId, line:/);
    const handover = readFileSync("src/lib/handover.ts", "utf8");
    expect(handover).toContain("handOverLine(");
  });
});
