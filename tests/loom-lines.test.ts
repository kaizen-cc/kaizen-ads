import { describe, expect, it } from "vitest";
import { agentsFor, cleanTopics, lineOfPlatform, lineSignal, needsApproval, settleLine } from "@/lib/loom-lines";

describe("loom lines", () => {
  it("routes email to the strategist, adding creative for design or copy and the builder for builds", () => {
    expect(agentsFor("email", ["audit"])).toEqual(["role:email_strategist"]);
    expect(agentsFor("email", ["copy"])).toEqual(["role:email_strategist", "role:email_creative"]);
    expect(agentsFor("email", ["design", "flow_build"])).toEqual(["role:email_strategist", "role:email_creative", "role:email_builder"]);
  });
  it("keeps the ad routing as it was", () => {
    expect(agentsFor("meta")).toEqual(["role:media_buyer"]);
    expect(agentsFor("none")).toEqual(["role:media_buyer"]);
    expect(agentsFor("google")).toEqual(["google_auditor"]);
    expect(agentsFor("both")).toEqual(["role:media_buyer", "google_auditor"]);
    expect(agentsFor("social")).toEqual(["role:social_strategist"]);
  });
  it("makes email and social filings wait for approval, not the buyers'", () => {
    expect(needsApproval("role:email_strategist")).toBe(true);
    expect(needsApproval("role:social_strategist")).toBe(true);
    expect(needsApproval("role:media_buyer")).toBe(false);
    expect(needsApproval("google_auditor")).toBe(false);
  });
  it("rescues an email audit the AI called other", () => {
    const s = lineSignal("Klaviyo audit for a skincare brand", "Let's look at the flows, the welcome flow, abandoned cart and the open rates in Klaviyo");
    expect(settleLine({ kind: "other", platform: "none" }, s)).toEqual({ kind: "method", platform: "email" });
    expect(settleLine({ kind: "both", platform: "none" }, s)).toEqual({ kind: "both", platform: "email" });
  });
  it("leaves a real ad audit and the AI's own email call alone", () => {
    const ads = lineSignal("Meta account audit", "the ad account, ad sets, ROAS and CPA, creative testing, advantage+ and the email list for lookalikes");
    expect(settleLine({ kind: "method", platform: "meta" }, ads)).toEqual({ kind: "method", platform: "meta" });
    expect(settleLine({ kind: "client", platform: "email" }, ads)).toEqual({ kind: "client", platform: "email" });
  });
  it("sorts organic social by its own words", () => {
    const s = lineSignal("Organic social content calendar", "the posting plan, instagram reels, the content calendar and engagement rate");
    expect(settleLine({ kind: "other", platform: "none" }, s).platform).toBe("social");
  });
  it("knows the line of a platform and cleans topics", () => {
    expect(lineOfPlatform("email")).toBe("email");
    expect(lineOfPlatform("meta")).toBeNull();
    expect(cleanTopics(["audit", "audit", "nonsense", "copy"])).toEqual(["audit", "copy"]);
    expect(cleanTopics(undefined)).toEqual([]);
  });
});
