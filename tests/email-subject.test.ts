import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// "[email] send failed: The `\n` is not allowed in the `subject` field": every subject goes out on one line.
describe("email subjects", () => {
  it("are one line, whatever a client or campaign name carries", async () => {
    const { oneLine } = await import("@/lib/email");
    expect(oneLine("Acme weekly report\n· Nov 16 – Nov 22")).toBe("Acme weekly report · Nov 16 – Nov 22");
    expect(oneLine("a\r\n\tb   c")).toBe("a b c");
    expect(oneLine(undefined)).toBe("");
    expect(oneLine("x".repeat(400))).toHaveLength(300);
  });
});
