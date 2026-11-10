import { describe, expect, it } from "vitest";
import { aiWritten, savedGivesWay, sendAction, sendLabel } from "@/lib/brief-send";
import { stampAi } from "@/lib/brief-fingerprint";
import type { Draft } from "@/app/(team)/requests/new/draft";

const all = new Set(["image", "video", "carousel"] as const);
const written: Partial<Draft> = { title: "Price objection UGC", angle: "Worth it", audience: "Moms 30-45", brief: "Overview:\nA mom answers the price question.", formats: { video: { new: 1, variations: 0 } }, sizes: ["4x5", "9x16"] };

describe("a brief the AI wrote sends without a second review", () => {
  it("talked through, a suggested brief or Kaizen AI: AI-written", () => {
    expect(aiWritten({ ai: stampAi(written, { kind: "talk", seal: "" }, all) })).toBe(true);
    expect(aiWritten({ ai: stampAi(written, { kind: "suggestion", id: "x" }, all) })).toBe(true);
    expect(aiWritten({ ai: stampAi(written, { kind: "kaizen-ai", messageId: "m", card: 0 }, all) })).toBe(true);
    // Opened from a suggested brief (a winner, the market, a promise all become one) even before its stamp
    expect(aiWritten({ ai: null, origin: { kind: "winner", label: "A winner", suggestionId: "s1" } })).toBe(true);
  });

  it("stays AI-written after small automatic edits (a fix, an answered fact, a revise correction, a reference line)", () => {
    const ai = stampAi(written, { kind: "talk", seal: "" }, all);
    const edited = { ...written, ai, brief: `${written.brief}\n\nConfirm with client:\n- Which seat? Answer: row 3 (the team)`, sizes: ["4x5"] as Draft["sizes"] };
    expect(aiWritten(edited)).toBe(true);
    expect(sendAction({ pendingRevise: false, aiOn: true, aiWritten: aiWritten(edited), review: "idle" })).toBe("send");
  });

  it("a hand-typed brief is not AI-written (a restarted ticket, Asana, a copy line)", () => {
    expect(aiWritten({ ai: null, origin: null })).toBe(false);
    expect(aiWritten({ origin: { kind: "brief", label: "Started again from deleted ticket #12" } })).toBe(false);
  });
});

describe("the review never blocks sending", () => {
  const base = { pendingRevise: false, aiOn: true, aiWritten: false };
  it("a hand-typed brief: the review first, then send whatever it found", () => {
    expect(sendAction({ ...base, review: "idle" })).toBe("review");
    // While it runs: "Send now" skips it
    expect(sendAction({ ...base, review: "running" })).toBe("send");
    // Notes open: "Send anyway" in one click
    expect(sendAction({ ...base, review: "done" })).toBe("send");
    expect(sendAction({ ...base, review: "error" })).toBe("send");
  });

  it("the AI off: straight out", () => {
    expect(sendAction({ ...base, aiOn: false, review: "idle" })).toBe("send");
  });

  it("a correction typed and not sent goes in first", () => {
    expect(sendAction({ ...base, aiWritten: true, pendingRevise: true, review: "idle" })).toBe("apply-pending");
  });

  it("says what it does", () => {
    const l = { pending: false, openItems: 0, tickets: 2, aiOn: true, aiWritten: false } as const;
    expect(sendLabel({ ...l, aiWritten: true, review: "idle" })).toBe("Send to the team · 2 tickets");
    expect(sendLabel({ ...l, review: "running" })).toBe("Send now");
    expect(sendLabel({ ...l, review: "done", openItems: 3 })).toBe("Send anyway · 3 notes open");
    expect(sendLabel({ ...l, review: "done", openItems: 1 })).toBe("Send anyway · 1 note open");
    expect(sendLabel({ ...l, pending: true, review: "idle" })).toBe("Sending…");
  });
});

describe("the brief-ready link opens the newest writing", () => {
  const at = Date.parse("2026-11-10T15:00:00Z");
  it("a copy saved from another writing gives way", () => {
    expect(savedGivesWay({ at, draft: { origin: { kind: "brief", label: "x", writtenAt: "2026-11-10T14:00:00Z" } } }, "2026-11-10T16:00:00Z")).toBe(true);
  });
  it("a copy of this same writing is kept (the person's edits stay)", () => {
    expect(savedGivesWay({ at, draft: { origin: { kind: "brief", label: "x", writtenAt: "2026-11-10T16:00:00Z" } } }, "2026-11-10T16:00:00Z")).toBe(false);
  });
  it("an older copy with no writing on it gives way to a later writing, not an earlier one", () => {
    expect(savedGivesWay({ at, draft: { origin: null } }, "2026-11-10T16:00:00Z")).toBe(true);
    expect(savedGivesWay({ at, draft: { origin: null } }, "2026-11-10T14:00:00Z")).toBe(false);
  });
  it("nothing saved, or no writing to compare: nothing to do", () => {
    expect(savedGivesWay(null, "2026-11-10T16:00:00Z")).toBe(false);
    expect(savedGivesWay({ at, draft: { origin: null } }, null)).toBe(false);
  });
});
