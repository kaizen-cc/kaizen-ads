import { describe, expect, it } from "vitest";
import { endMarkerFilter, isQuietReply, QUIET_MARKER, QUIET_RULE, stripEndMarker } from "@/lib/agent-call/core";

// Lawrence's Nov 24 call: the Email Strategist, brought onto his assistant's call, answered every scrap of side talk
// ("That sounds like side conversation again…", eight times in three minutes). A reply of only [[QUIET]] says nothing.
describe("saying nothing to side talk", () => {
  it("speaks nothing for a quiet reply, even when the marker arrives in pieces", () => {
    const f = endMarkerFilter();
    const out = ["[[QU", "IET", "]]"].map((d) => f.feed(d)).join("") + f.flush();
    expect(out).toBe("");
    expect(f.quiet).toBe(true);
    expect(f.ended).toBe(false);
  });
  it("still speaks ordinary text and still ends a call on the end marker", () => {
    const f = endMarkerFilter();
    expect(f.feed("Sure, [[ ") + f.feed("looking.") + f.flush()).toBe("Sure, [[ looking.");
    expect(f.quiet).toBe(false);
    const g = endMarkerFilter();
    expect(g.feed("Bye for now.[[END_CALL]]") + g.flush()).toBe("Bye for now.");
    expect(g.ended).toBe(true);
  });
  it("keeps nothing in the transcript for a quiet reply", () => {
    expect(stripEndMarker(QUIET_MARKER).text).toBe("");
    expect(isQuietReply(` ${QUIET_MARKER} `)).toBe(true);
    expect(isQuietReply(`${QUIET_MARKER} Sure, pulling it up.`)).toBe(false);
  });
  it("tells agents on a shared call never to comment on side talk or repeat a goodbye", () => {
    expect(QUIET_RULE).toContain(QUIET_MARKER);
    expect(QUIET_RULE).toMatch(/never comment on it/i);
    expect(QUIET_RULE).toMatch(/never repeat a goodbye/i);
  });
});
