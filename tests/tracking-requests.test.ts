import { describe, expect, it } from "vitest";
import { clientFor, isTrackingRequest, trackingTaskTitle } from "@/lib/tracking-requests-core";
import { supportRoleIn } from "@/lib/assistant/routing-server";

describe("tracking requests", () => {
  it("finds asks about tracking or a landing page", () => {
    expect(isTrackingRequest("Can you check why the Meta pixel isn't firing on checkout?")).toBe(true);
    expect(isTrackingRequest("We need a landing page for the Black Friday offer")).toBe(true);
    expect(isTrackingRequest("Please set up GA4 for the new site")).toBe(true);
    // From the Nov 25 backlog: a real one
    expect(isTrackingRequest("Hello, Happy Monday! I need your help with two things. Could you please help me with a 100% discount coupon to test tracking? And I also need to implement this tracking code on the web head: <script async src=\"https://www.googletagmanager.com/gtm.js\"></script>")).toBe(true);
    expect(isTrackingRequest("The purchase event stopped firing after the theme update")).toBe(true);
  });

  it("leaves the rest alone", () => {
    expect(isTrackingRequest("Tracking along nicely, thanks!")).toBe(false);
    expect(isTrackingRequest("Can you send the new creatives?")).toBe(false);
  });

  // The Nov 25 safety check's junk tasks, as they came in
  it("never makes a task from a report, a recap, an update or a note", () => {
    const junk = [
      // A weekly Google report became "Fix tracking"
      "Hi Team, Good day! Here is a quick update on the weekly performance of the Google Ads campaigns (Nov 16 – Nov 22). This was another softer week. The campaigns generated 2,041 conversions at a cost per conversion of $0.39. Please let us know if you have questions about the conversion tracking numbers.",
      // A creative-shoot note became "Tracking setup"
      "I just spoke to Philip. He is going to come next week and we will shoot several creatives. He will edit them and then we can get those out. I think that will make a huge difference, especially now that the site is on point with the ad branding. Shoot me anything needed to add to the site for tracking purposes. Thanks",
      // "We're behind" email (filed under two clients)
      "Hi looping the rest of you in since you weren't on copy. My spidey sense was right this morning...we're behind and she's pissed. Please check the landing page notes.",
      // A BFCM note
      "Gleannloch is unblocked: it's corporate-owned, so Meta launches in the existing corporate ad account. Pilot = $1,000/mo, target 3x blended ROAS over 60 days. Launch one CBO conversion campaign in the corporate account.",
      // A weekly report that mentions landing page views
      "Hi team, here's this week's Meta update (Nov 16 – Nov 22). Traffic to the site was strong: 3,593 link clicks and 2,063 landing page views. Please reply with any questions.",
      // A recap
      "Hi, here's your Meta Ads recap for November 16 – 22. CAMPAIGN BREAKDOWN: Black Friday $632 spend, 24 scheduled calls. Could you please confirm the landing page for December?",
      // A status update and an email ready to preview
      "7th Dimension update on your points: lead texts answered; pixel needs her web team. Can you also push our Meta rep to review the restriction?",
      "Hi team, We have implemented the updates to the email and it is ready for your final preview. Please check the landing page link too.",
      // An email thread about a creative
      "The hero image looks extremely blurry on my end. Is that the same for you all? Please change the photo for the warm up email.",
    ];
    for (const t of junk) expect(isTrackingRequest(t), t.slice(0, 60)).toBe(false);
  });

  it("titles the task by the sentence that asks", () => {
    expect(trackingTaskTitle("The purchase event stopped firing yesterday")).toMatch(/^Fix tracking: /);
    expect(trackingTaskTitle("Need a landing page for the spring sale")).toMatch(/^Landing page: /);
    expect(trackingTaskTitle("Thanks for the call today. Could you please install the Meta pixel on the new booking site? Talk soon.")).toBe("Tracking setup: Could you please install the Meta pixel on the new booking site?");
  });

  it("files a message seen under several clients under the one it names, else none", () => {
    const cs = [
      { id: "a", name: "Alelaluna" },
      { id: "s", name: "Shupe Legal" },
    ];
    expect(clientFor("Shupe Legal needs the pixel on the seminar page, please", cs)).toBe("s");
    expect(clientFor("we're behind and she's pissed", cs)).toBeNull();
    expect(clientFor("anything", [{ id: "x", name: "X Co" }])).toBe("x");
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
