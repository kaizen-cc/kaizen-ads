import { describe, expect, it } from "vitest";
import { memoryPrompt, sentencesAbout, MEMORY_PAGE } from "@/lib/kaizen-ai/memory-core";
import { CALL_LIMIT_SECONDS, CALL_WARN_SECONDS } from "@/lib/agent-call/core";
import { stillOpen } from "@/lib/agent-call/modality";

describe("Kaizen AI remembers across a person's chats", () => {
  const personal = "How they like to talk:\n- length: short\n\nWhat they've told you:\n- work: Always lead subject lines with the offer.";

  it("their own memory and general lessons apply in every chat, client or not", () => {
    const none = memoryPrompt({ personal, client: null, threads: [], calls: [] });
    expect(none).toMatch(/Always lead subject lines with the offer/);
    expect(none).toMatch(/Memory is on across all their chats/);
    const remedy = memoryPrompt({ personal, client: "Remedy Place", threads: [], calls: [] });
    expect(remedy).toMatch(/Always lead subject lines with the offer/);
  });

  it("a client's chat knows what they discussed about that client elsewhere", () => {
    const p = memoryPrompt({ personal: "", client: "Remedy Place", threads: [{ title: "Remedy Place Black Friday", at: "2026-11-20T10:00:00Z", gist: "We agreed on three sends: Nov 24, 27 and 28." }], calls: [] });
    expect(p).toMatch(/2026-11-20 chat "Remedy Place Black Friday": We agreed on three sends/);
  });

  it("another client's details never reach this client's chat", () => {
    const summary = "Went over La Jetée's holiday menu launch. Remedy Place wants the welcome flow rebuilt before December. La Jetée's open rate dipped.";
    expect(sentencesAbout(summary, "Remedy Place")).toBe("Remedy Place wants the welcome flow rebuilt before December.");
    const p = memoryPrompt({ personal: "", client: "Remedy Place", threads: [], calls: [{ at: "2026-11-21T15:00:00Z", summary }] });
    expect(p).toMatch(/welcome flow rebuilt/);
    expect(p).not.toMatch(/La Jet/);
    // A call that never mentions this client adds nothing
    expect(memoryPrompt({ personal: "", client: "Remedy Place", threads: [], calls: [{ at: "2026-11-21T15:00:00Z", summary: "La Jetée only." }] })).toBe("");
  });

  it("says where to see or forget it", () => {
    expect(MEMORY_PAGE).toBe("/assistant?tab=memory");
  });
});

describe("calls run an hour and carry on past it", () => {
  it("an hour, with the warning five minutes before", () => {
    expect(CALL_LIMIT_SECONDS).toBe(3600);
    expect(CALL_WARN_SECONDS).toBe(3300);
  });

  it("a call carried on past the hour stays open from its fresh hour (the mode log)", () => {
    const start = Date.parse("2026-11-23T10:00:00Z");
    const now = start + 70 * 60_000;
    const startedAt = new Date(start).toISOString();
    expect(stillOpen({ mode: "voice", startedAt, callLimitSeconds: CALL_LIMIT_SECONDS, now })).toBe(false);
    const renewed = [{ mode: "voice" as const, at: startedAt }, { mode: "voice" as const, at: new Date(start + 60 * 60_000).toISOString() }];
    expect(stillOpen({ mode: "voice", startedAt, log: renewed, callLimitSeconds: CALL_LIMIT_SECONDS, now })).toBe(true);
  });
});
