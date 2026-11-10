import { describe, expect, it } from "vitest";
import { inlineAsks, talkStep, wantsWrite } from "@/lib/talk-flow";

describe("talk it through: from the conversation to Ready to send", () => {
  it("asks in the chat, writes the moment it's clear, and lands once written", () => {
    expect(talkStep({ patch: null })).toBe("ask");
    expect(talkStep({ patch: null, previewReady: true })).toBe("write");
    expect(talkStep({ patch: { title: "A brief" } })).toBe("land");
    // Written beats anything else said in the same turn
    expect(talkStep({ patch: { title: "A brief" }, previewReady: true })).toBe("land");
  });

  it("hears 'write it' in plain words", () => {
    for (const t of ["write it", "Write it now.", "ok, write it", "Looks good, write it", "go ahead", "just draft it", "Go ahead and write the brief", "yes write it please", "do it"]) expect(wantsWrite(t), t).toBe(true);
    for (const t of ["write a UGC video about the price objection", "make it a carousel", "it should go ahead of the launch", "3 statics for the new offer"]) expect(wantsWrite(t), t).toBe(false);
  });

  it("shows the questions inside the strategist's message, never twice", () => {
    const reply = "Two quick things before I write it. Which offer is this for?";
    const a = inlineAsks(reply, { questions: ["Which offer is this for?", "How many videos?"], conflicts: ["The Bible says no discounts, and you said 20% off."] });
    expect(a.questions).toEqual(["How many videos?"]);
    expect(a.conflicts).toEqual(["The Bible says no discounts, and you said 20% off."]);
    expect(inlineAsks("Writing it now.", { questions: [], conflicts: [] })).toEqual({ questions: [], conflicts: [] });
  });
});
