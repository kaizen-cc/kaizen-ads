import { describe, expect, it } from "vitest";
import { cvrDrop, stepsText, trackingSteps } from "@/lib/tracking-core";
import { ROLE_SKILLS, canTalkToAgent, canTrainAgent, roleOfAgent } from "@/lib/agent-access";
import { lineOfRole } from "@/lib/agent-lines";
import { TRACKING_CHANNELS, TRACKING_PLAYBOOK } from "@/lib/tracking-playbook";
import { SCREEN_PLACES, SPECIALISTS } from "@/lib/assistant/core";
import { agentsForTakeaway, canDecide, routeTakeaway } from "@/lib/youtube-core";

describe("tracking engineer: sudden drops", () => {
  it("flags results per dollar halving in the last week", () => {
    expect(cvrDrop({ d7: { spend: 700, results: 10 }, d30: { spend: 3000, results: 100 } })).toMatch(/fell 63%/);
  });
  it("flags spend with no results in 3 days when there were results before", () => {
    expect(cvrDrop({ d3: { spend: 300, results: 0 }, d7: { spend: 700, results: 12 }, d30: { spend: 3000, results: 100 } })).toMatch(/No results tracked in 3 days on \$300/);
  });
  it("stays quiet when it's normal or too small to tell", () => {
    expect(cvrDrop({ d7: { spend: 700, results: 22 }, d30: { spend: 3000, results: 100 } })).toBeNull();
    expect(cvrDrop({ d7: { spend: 20, results: 0 }, d30: { spend: 100, results: 3 } })).toBeNull();
    expect(cvrDrop(null)).toBeNull();
  });
});

describe("tracking engineer: numbered steps", () => {
  const ctx = { client: { id: "c", name: "Acme", slug: "acme" }, signals: ["Spend with zero results"] };
  it("numbers clean steps, drops empty ones, keeps the owner to the four roles", () => {
    const c = trackingSteps(
      {
        summary: "Purchases look double counted — dedup is off.",
        likely_causes: ["Browser and server Purchase without a shared event_id"],
        steps: [
          { do: "Place a test order and watch Test Events", where: "Events Manager › Test Events", good: "One deduplicated Purchase", who: "tracking specialist" },
          { do: "", where: "x", good: "y", who: "media buyer" },
          { do: "Remove the hard-coded pixel from theme.liquid", where: "Shopify › Themes › Edit code", good: "One pixel on the page", who: "the intern" },
        ],
      },
      ctx,
    );
    expect(c.summary).toBe("Purchases look double counted, dedup is off.");
    expect(c.steps.map((s) => [s.n, s.who])).toEqual([
      [1, "tracking specialist"],
      [2, "tracking specialist"],
    ]);
    expect(c.signals).toEqual(["Spend with zero results"]);
    expect(stepsText(c)).toContain("1. Place a test order and watch Test Events (Events Manager › Test Events). Good looks like: One deduplicated Purchase [tracking specialist]");
  });
});

describe("tracking engineer: a role agent with skills", () => {
  it("is a role with two skills in the whole-team line", () => {
    expect(ROLE_SKILLS.tracking_engineer).toEqual(["tracking_audit", "tracking_desk"]);
    expect(roleOfAgent("tracking_audit")).toBe("tracking_engineer");
    expect(lineOfRole("tracking_engineer")).toBe("strategy");
  });
  it("execs and the Heads of Meta and Google teach it; everyone talks to it", () => {
    expect(canTrainAgent({ role: "executive", isExec: true }, "tracking_engineer")).toBe(true);
    expect(canTrainAgent({ role: "head_of_meta" }, "tracking_audit")).toBe(true);
    expect(canTrainAgent({ role: "head_of_google" }, "tracking_engineer")).toBe(true);
    expect(canTrainAgent({ role: "tracking_specialist" }, "tracking_engineer")).toBe(false);
    expect(canTrainAgent({ role: "media_buyer" }, "tracking_engineer")).toBe(false);
    expect(canTalkToAgent({ role: "tracking_specialist" }, "tracking_engineer")).toBe(true);
    expect(canTalkToAgent({ role: "media_buyer" }, "tracking_engineer")).toBe(true);
  });
  it("the assistant calls it in on tracking words and can open it", () => {
    const t = SPECIALISTS.find((s) => s.key === "tracking_engineer");
    expect(t?.words.test("Meta shows double the purchases, is the CAPI dedup broken?")).toBe(true);
    expect(t?.words.test("set up enhanced conversions in GTM")).toBe(true);
    expect(SCREEN_PLACES["tracking engineer"]).toBe("/settings?tab=agents&role=tracking_engineer#talk");
  });
});

describe("tracking engineer: knowledge", () => {
  it("covers every area, each with official sources", () => {
    const all = TRACKING_PLAYBOOK.map((d) => `${d.title} ${d.text}`).join(" ");
    for (const w of ["event_id", "Event Match Quality", "server container", "consent mode", "enhanced conversions", "offline", "checkout extensibility", "GoHighLevel", "Events API", "UTM", "attribution windows", "double", "thank-you"])
      expect(all.toLowerCase()).toContain(w.toLowerCase());
    for (const d of TRACKING_PLAYBOOK) expect(d.sources.length).toBeGreaterThan(0);
    expect(new Set(TRACKING_PLAYBOOK.map((d) => d.name)).size).toBe(TRACKING_PLAYBOOK.length);
    expect(TRACKING_CHANNELS.length).toBeGreaterThanOrEqual(3);
  });
  it("YouTube tracking takeaways reach the tracking specialist and teach the Tracking Engineer", () => {
    const people = [
      { id: "ts", role: "tracking_specialist", isExec: false },
      { id: "hm", role: "head_of_meta", isExec: false },
      { id: "hg", role: "head_of_google", isExec: false },
      { id: "mb", role: "media_buyer", isExec: false },
      { id: "x", role: "executive", isExec: true, execFocus: ["google"] },
    ];
    expect(routeTakeaway({ lines: ["tracking"], roles: [] }, people)).toEqual({ team: ["ts", "hm", "hg"], execs: ["x"] });
    expect(agentsForTakeaway({ lines: ["tracking"], roles: [] })).toEqual(["tracking_engineer"]);
    expect(canDecide({ role: "head_of_google" }, ["tracking"])).toBe(true);
    expect(canDecide({ role: "tracking_specialist" }, ["tracking"])).toBe(false);
  });
});
