import { describe, expect, it } from "vitest";
import { isTrackingRequest, trackingTaskTitle } from "@/lib/tracking-requests-core";
import { supportRoleIn } from "@/lib/assistant/routing-server";

describe("tracking requests", () => {
  it("finds asks about tracking or a landing page", () => {
    expect(isTrackingRequest("Can you check why the Meta pixel isn't firing on checkout?")).toBe(true);
    expect(isTrackingRequest("We need a landing page for the Black Friday offer")).toBe(true);
    expect(isTrackingRequest("Please set up GA4 for the new site")).toBe(true);
  });
  it("leaves the rest alone", () => {
    expect(isTrackingRequest("Tracking along nicely, thanks!")).toBe(false);
    expect(isTrackingRequest("Can you send the new creatives?")).toBe(false);
  });
  it("titles the task by what's asked", () => {
    expect(trackingTaskTitle("The purchase event stopped firing yesterday")).toMatch(/^Fix tracking: /);
    expect(trackingTaskTitle("Need a landing page for the spring sale")).toMatch(/^Landing page: /);
  });
});

describe("support roles by word", () => {
  it("routes to the support positions", () => {
    expect(supportRoleIn("the tracking specialist")).toBe("tracking_specialist");
    expect(supportRoleIn("onboarding specialist")).toBe("onboarding_specialist");
    expect(supportRoleIn("client success")).toBe("customer_success");
    expect(supportRoleIn("the Meta buyer")).toBeNull();
  });
});
