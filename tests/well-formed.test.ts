import { describe, expect, it } from "vitest";
import { wellFormed, wellFormedText } from "@/lib/agent-call/well-formed";

// The assistant said "Sorry, I lost my train of thought" on every turn: an email gist cut at 100 characters split an
// emoji, and the API refuses a request holding half of one ("no low surrogate in string")
describe("wellFormed", () => {
  const cut = `Reply to Ana on email: ${"x".repeat(10)}🎉 launch`.slice(0, 34);

  it("replaces half an emoji left by a cut", () => {
    expect(cut.isWellFormed()).toBe(false);
    const fixed = wellFormedText(cut);
    expect(fixed.isWellFormed()).toBe(true);
    expect(fixed.endsWith("�")).toBe(true);
    expect(wellFormedText("\uDC00 lone low")).toBe("� lone low");
  });

  it("leaves whole emoji and plain text untouched", () => {
    const ok = "Launch day 🎉👍🏽 — all set";
    expect(wellFormedText(ok)).toBe(ok);
  });

  it("cleans every string in a request, keeping its shape", () => {
    const msgs = [
      { role: "user", content: cut },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: cut }] }] },
    ];
    const out = wellFormed(msgs);
    expect(JSON.stringify(out).includes("\\ud83c")).toBe(false);
    expect(out[1].content).toEqual([{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: wellFormedText(cut) }] }]);
    expect(msgs[0].content).toBe(cut);
  });
});
