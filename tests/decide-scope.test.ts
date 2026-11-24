import { describe, expect, it } from "vitest";
import { AGENT_LINES, decidesScoped, linesOverseen } from "@/lib/youtube-core";

// Each exec and line head decides only what's on lines they oversee; unassigned and cross-line items go to the owner
const paid = ["meta", "google", "tiktok", "creative_performance"];
const socialCreative = ["social", "creative"];
const email = ["email"];
const foci = [paid, socialCreative, email];
const exec = (execFocus: string[], isOwner = false) => ({ role: "executive", isExec: true, execFocus, isOwner });

describe("decisions scoped by line", () => {
  it("the lines each exec oversees, from their focus", () => {
    expect(linesOverseen(exec(paid))).toEqual(["meta", "google", "creative", "tracking", "strategy"]);
    expect(linesOverseen(exec(socialCreative))).toEqual(["creative", "social", "strategy"]);
    // Every exec also oversees Marketing & strategy (full-funnel and offer thinking)
    expect(linesOverseen(exec(email))).toEqual(["email", "strategy"]);
    expect(linesOverseen({ role: "head_of_meta" })).toEqual(["meta", "tracking"]);
  });
  it("an item reaches an exec only when every line it touches is theirs", () => {
    expect(decidesScoped(exec(paid), ["meta", "tracking"], foci)).toBe(true);
    expect(decidesScoped(exec(socialCreative), ["meta", "tracking"], foci)).toBe(false);
    expect(decidesScoped(exec(socialCreative), ["creative", "social"], foci)).toBe(true);
    expect(decidesScoped(exec(email, true), ["meta"], foci)).toBe(false);
  });
  it("cross-line and unassigned items go to the owner only", () => {
    expect(decidesScoped(exec(email, true), ["meta", "social"], foci)).toBe(true);
    expect(decidesScoped(exec(paid), ["meta", "social"], foci)).toBe(false);
    expect(decidesScoped(exec(socialCreative), ["meta", "social"], foci)).toBe(false);
    expect(decidesScoped(exec(email, true), [], foci)).toBe(true);
    expect(decidesScoped(exec(paid), [], foci)).toBe(false);
  });
  it("an agent's learnings follow its role's lines", () => {
    expect(decidesScoped(exec(paid), [...AGENT_LINES.strategist], foci)).toBe(true);
    expect(decidesScoped(exec(socialCreative), [...AGENT_LINES.strategist], foci)).toBe(false);
    expect(decidesScoped(exec(email, true), [...AGENT_LINES.email_strategist], foci)).toBe(true);
  });
});
