import { describe, expect, it } from "vitest";
import { fitPayload } from "@/lib/brief-drafts-core";

describe("a brief in progress, kept in the database", () => {
  const form = { at: 1, step: 3, draft: { clientId: "c1", title: "Black Friday statics", brief: "Short brief" }, ai: { status: "done", notes: "x".repeat(400) }, review: { status: "idle" }, queue: [] };
  it("keeps the whole form when it fits", () => {
    expect(fitPayload(form)).toBe(form);
  });
  it("drops the AI's working notes before the request itself", () => {
    const kept = fitPayload(form, 300)!;
    expect(kept).not.toHaveProperty("ai");
    expect(kept).not.toHaveProperty("review");
    expect(kept.draft).toEqual(form.draft);
    expect(kept.step).toBe(3);
  });
  it("keeps nothing it can't keep whole", () => {
    expect(fitPayload({ draft: { brief: "y".repeat(1000) } }, 300)).toBeNull();
  });
});
