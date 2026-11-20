import { describe, expect, it } from "vitest";
import { DEFAULT_VOICES, voiceForLine } from "@/lib/agent-call/core";

// A person's own assistant voice (Deadpool, say) on an assistant call
const DEADPOOL = "dpVoice0000Deadpool1";

describe("the voice each line of a call is spoken in", () => {
  it("the assistant's own lines are always the person's chosen voice", () => {
    const call = { callRole: "assistant", callVoice: DEADPOOL };
    expect(voiceForLine({ ...call })).toBe(DEADPOOL);
    expect(voiceForLine({ ...call, lineRole: "assistant" })).toBe(DEADPOOL);
    // A line tagged with a role that isn't a specialist on the call is still the assistant: never a random default
    expect(voiceForLine({ ...call, lineRole: "social_strategist", specialist: false })).toBe(DEADPOOL);
    expect(voiceForLine({ ...call, lineRole: "something_else" })).toBe(DEADPOOL);
  });

  it("a specialist on the call speaks in its own, different voice", () => {
    const call = { callRole: "assistant", callVoice: DEADPOOL };
    expect(voiceForLine({ ...call, lineRole: "social_strategist", specialist: true })).toBe(DEFAULT_VOICES.social_strategist.id);
    expect(voiceForLine({ ...call, lineRole: "social_strategist", specialist: true, specialistVoice: "customSocial0001" })).toBe("customSocial0001");
  });

  it("a specialist never sounds like the person's assistant", () => {
    // Their assistant uses the social strategist's voice: the specialist must take another
    const same = DEFAULT_VOICES.social_strategist.id;
    const v = voiceForLine({ callRole: "assistant", callVoice: same, lineRole: "social_strategist", specialist: true });
    expect(v).not.toBe(same);
    // Picked the same voice on purpose for the specialist: still a different one on this call
    expect(voiceForLine({ callRole: "assistant", callVoice: DEADPOOL, lineRole: "social_strategist", specialist: true, specialistVoice: DEADPOOL })).not.toBe(DEADPOOL);
  });

  it("an agent called directly speaks in its own voice", () => {
    expect(voiceForLine({ callRole: "media_buyer", callVoice: null })).toBe(DEFAULT_VOICES.media_buyer.id);
  });
});
