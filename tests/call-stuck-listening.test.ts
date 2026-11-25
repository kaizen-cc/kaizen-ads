import { describe, expect, it } from "vitest";
import { initialTurns, stepTurns, TURN_HARD_CAP_MS, TURN_SOFT_CAP_MS, turnCapped, wordsStalled, type TurnState } from "@/lib/agent-call/turns";

// Kyle and others, Nov 25 2026: the assistant sat "listening" after they'd finished talking and never answered.
const listening = (o: Partial<TurnState> = {}): TurnState => ({ ...initialTurns(), phase: "listening", ...o });

describe("the stuck-listening fix", () => {
  it("the words on screen are sent when the transcriber's final words come back empty (the cause)", () => {
    // They spoke, the turn ended and committed, and the final transcript came back empty (late, lost)
    let s = listening({ heard: "pull the OceanBox numbers for last week" });
    s = stepTurns(s, { t: "turn_end" }).state;
    expect(s.phase).toBe("committing");
    const out = stepTurns(s, { t: "heard", commit: s.commit!, text: "" });
    expect(out.state.phase).toBe("thinking");
    expect(out.effects).toContainEqual(expect.objectContaining({ do: "ask", said: "pull the OceanBox numbers for last week" }));
  });
  it("Done talking ends the turn even before any words show, and sends what the transcriber still held", () => {
    let s = listening();
    const sent = stepTurns(s, { t: "send" });
    expect(sent.effects).toContainEqual(expect.objectContaining({ do: "commit" }));
    s = sent.state;
    const out = stepTurns(s, { t: "heard", commit: s.commit!, text: "audit Ocean Box" });
    expect(out.effects).toContainEqual(expect.objectContaining({ do: "ask", said: "audit Ocean Box" }));
  });
  it("Done talking with nothing heard at all says so, and goes back to listening", () => {
    let s = stepTurns(listening(), { t: "send" }).state;
    const out = stepTurns(s, { t: "heard", commit: s.commit!, text: "" });
    expect(out.effects).toContainEqual({ do: "nothing_heard" });
    expect(out.state.phase).toBe("listening");
    expect(out.state.manual).toBe(false);
    // A pause that ends with nothing (not a tap) stays quiet
    s = stepTurns(listening(), { t: "turn_end" }).state;
    expect(stepTurns(s, { t: "heard", commit: s.commit!, text: "" }).effects).not.toContainEqual({ do: "nothing_heard" });
  });
  it("does nothing while muted or while it's answering", () => {
    expect(stepTurns(listening({ muted: true }), { t: "send" }).effects).toEqual([]);
    expect(stepTurns(listening({ phase: "speaking" }), { t: "send" }).effects).toEqual([]);
  });
  it("sends on its own after about 2.5s without new words, once there are words", () => {
    expect(wordsStalled({ heard: "hello", sinceWordsMs: 2400, speaking: false })).toBe(false);
    expect(wordsStalled({ heard: "hello", sinceWordsMs: 2500, speaking: false })).toBe(true);
    expect(wordsStalled({ heard: "", sinceWordsMs: 60_000, speaking: false })).toBe(false);
  });
  it("never sits listening forever with words captured, even with noise around them", () => {
    expect(turnCapped({ heard: "words", sinceFirstWordsMs: TURN_SOFT_CAP_MS - 1, sinceWordsMs: 5000 })).toBe(false);
    expect(turnCapped({ heard: "words", sinceFirstWordsMs: TURN_SOFT_CAP_MS, sinceWordsMs: 1000 })).toBe(true);
    expect(turnCapped({ heard: "words", sinceFirstWordsMs: TURN_SOFT_CAP_MS + 5000, sinceWordsMs: 200 })).toBe(false);
    expect(turnCapped({ heard: "words", sinceFirstWordsMs: TURN_HARD_CAP_MS, sinceWordsMs: 0 })).toBe(true);
    expect(turnCapped({ heard: "", sinceFirstWordsMs: TURN_HARD_CAP_MS, sinceWordsMs: 0 })).toBe(false);
  });
});
