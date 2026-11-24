import { describe, expect, it } from "vitest";
import { forcedTurn } from "@/lib/agent-call/turns";

// "Answer now" (the owner's Nov 24 call with the execs): when the call seems stuck listening or thinking, one tap makes
// the agent answer from what it has.
describe("Answer now", () => {
  it("sends what was heard like Send when there are words", () => {
    expect(forcedTurn({ phase: "listening", heard: "pull the Ocean Box numbers", carry: "", last: null })).toBeNull();
  });
  it("asks it to answer what was last said when nothing new was caught, or while it's still thinking", () => {
    const listening = forcedTurn({ phase: "listening", heard: "", carry: "", last: { said: "Audit Ocean Box", frame: null } });
    expect(listening).toContain('Answer what I last said ("Audit Ocean Box") now');
    expect(forcedTurn({ phase: "thinking", heard: "", carry: "", last: { said: "Audit Ocean Box", frame: null } })).toContain("Audit Ocean Box");
    expect(forcedTurn({ phase: "listening", heard: " ", carry: "", last: null })).toBe("[Answer now] I'm waiting on you. Answer from what you've heard so far, or ask me one short question.");
  });
  it("does nothing while it's speaking or still connecting", () => {
    expect(forcedTurn({ phase: "speaking", heard: "", carry: "", last: null })).toBeNull();
    expect(forcedTurn({ phase: "connecting", heard: "", carry: "", last: null })).toBeNull();
  });
});
