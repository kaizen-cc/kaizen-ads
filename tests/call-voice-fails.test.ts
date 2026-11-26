import { describe, expect, it } from "vitest";
import { showWithoutVoice } from "@/lib/agent-call/turns";

// #163: the voice service failing (POST /api/agent-call/speak 502 on every sentence) dropped every sentence, so the
// assistant looked like it wasn't answering at all. A sentence whose voice failed is still shown as the agent's line.
describe("a call when the voice service fails", () => {
  it("shows the sentence in writing when its voice couldn't be had", () => {
    expect(showWithoutVoice({ voiceFailed: true, closed: false, current: true })).toBe(true);
  });

  it("drops a sentence they cut off, one from an older turn, or one after the call closed", () => {
    expect(showWithoutVoice({ voiceFailed: false, closed: false, current: true })).toBe(false);
    expect(showWithoutVoice({ voiceFailed: true, closed: false, current: false })).toBe(false);
    expect(showWithoutVoice({ voiceFailed: true, closed: true, current: true })).toBe(false);
  });
});
