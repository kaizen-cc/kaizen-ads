import { describe, expect, it } from "vitest";
import { aiContentRule } from "@/lib/ai-content";
import { summarizeGate } from "@/lib/brief-gate";
import { lintBrief } from "@/lib/brief-lint";

const base = { sizes: ["4x5", "9x16"], formats: ["video"] };
const avatarBrief = `A barista explains the new roast as an AI avatar of the customer from the March testimonial.

Hook: "The roast our regulars switched to"

Constraints:
- Sizes 4:5 and 9:16`;

const coffee = aiContentRule({ notes: ["No AI generated video or AI narration voices, no AI slop."] });

describe("likeness and voice consent (soft)", () => {
  it("warns when an altered likeness has no consent line or disclaimer, with an AI fix", () => {
    const issues = lintBrief({ ...base, text: avatarBrief });
    const c = issues.find((x) => x.id === "likeness-consent");
    expect(c?.severity).toBe("soft");
    expect(c?.message).toMatch(/written consent/);
    expect(c?.message).toMatch(/disclaimer/);
    expect(c?.fixes[0]).toMatchObject({ kind: "ai" });
    // Never a block: nothing optional holds a brief
    expect(summarizeGate({ openFacts: [], lint: issues, assets: null }).status).toBe("ready");
  });

  it("is quiet once consent and disclaimer are there", () => {
    const text = `${avatarBrief}
- Disclaimer: AI-generated likeness, used with permission

Confirm with client:
- Get the client's written consent for the March testimonial customer's likeness/voice`;
    expect(lintBrief({ ...base, text }).some((x) => x.id === "likeness-consent")).toBe(false);
  });

  it("asks only for what's missing", () => {
    const text = `${avatarBrief}\n- Disclaimer: Voice altered`;
    expect(lintBrief({ ...base, text }).find((x) => x.id === "likeness-consent")?.message).not.toMatch(/disclaimer/);
  });

  it("catches a pitch-shifted voice and a voice clone", () => {
    expect(lintBrief({ ...base, text: "Use the review clip with the reviewer's voice pitch-shifted." }).some((x) => x.id === "likeness-consent")).toBe(true);
    expect(lintBrief({ ...base, text: "Voice clone the owner for the VO." }).some((x) => x.id === "likeness-consent")).toBe(true);
    expect(lintBrief({ ...base, text: "Real customer testimonial, shot on a phone, their own voice." }).some((x) => x.id === "likeness-consent")).toBe(false);
  });
});

describe("a client who said no to AI content (hard, for that client only)", () => {
  it("the coffee client's rule is found", () => {
    expect(coffee.allowed).toBe(false);
  });

  it("holds a brief with AI media for that client, as a contradiction a lead can send anyway", () => {
    const issues = lintBrief({ ...base, text: "Hook: AI narration over a Higgsfield pour shot.", noAiRule: coffee.rule });
    const hard = issues.find((x) => x.id === "no-ai-content");
    expect(hard?.severity).toBe("hard");
    expect(hard?.fixes[0]).toMatchObject({ kind: "ai" });
    const g = summarizeGate({ openFacts: [], lint: issues, assets: null });
    expect(g.status).toBe("has_conflicts");
    const sent = summarizeGate({ openFacts: [], lint: issues, assets: null, override: { gates: ["conflicts"], reason: "Sent anyway", by: "A lead", at: "2026-11-10" } });
    expect(sent.status).toBe("ready");
  });

  it("the same brief for any other client is not held", () => {
    const issues = lintBrief({ ...base, text: "Hook: AI narration over a Higgsfield pour shot." });
    expect(issues.some((x) => x.id === "no-ai-content")).toBe(false);
    expect(summarizeGate({ openFacts: [], lint: issues, assets: null }).status).toBe("ready");
  });

  it("a brief that repeats the rule (Don't, or no AI in Constraints) isn't held", () => {
    const text = `Real baristas pouring in the cafe.

Constraints:
- No AI video, AI voices or avatars (client rule)

Don't:
- AI-generated footage`;
    expect(lintBrief({ ...base, text, noAiRule: coffee.rule }).some((x) => x.id === "no-ai-content")).toBe(false);
  });

  it("an AI avatar for that client is the hard conflict, not a second consent warning", () => {
    const issues = lintBrief({ ...base, text: avatarBrief, noAiRule: coffee.rule });
    expect(issues.map((x) => x.id)).toContain("no-ai-content");
    expect(issues.map((x) => x.id)).not.toContain("likeness-consent");
  });
});
