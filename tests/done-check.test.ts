import { describe, expect, it } from "vitest";
import { closedNote, guard, type Evidence } from "@/lib/done-check-core";

const since = "2026-11-10T12:00:00Z";
const ev: Evidence[] = [
  { n: 1, at: "2026-11-18T15:00:00Z", source: "slack_internal", author: "Tracking", text: "Acme: tracking is set up and verified, purchases flowing into Meta and GA4", url: "https://slack.example/1" },
  { n: 2, at: "2026-11-05T15:00:00Z", source: "gmail", author: "Client", text: "The pixel is fixed now", url: null },
  { n: 3, at: "2026-11-19T15:00:00Z", source: "slack_external", author: "Client", text: "pixel should be live tomorrow once dev pushes", url: null },
];

describe("the done-check's guardrails", () => {
  it("closes on a sure quote that's really there, said after the item opened", () => {
    expect(guard({ state: "done", quote: "tracking is set up and verified", evidence: 1, sure: true }, ev, since).state).toBe("done");
  });
  it("never closes on a quote that isn't in the message", () => {
    expect(guard({ state: "done", quote: "tracking is fully working everywhere", evidence: 1, sure: true }, ev, since).state).toBe("nothing");
  });
  it("never closes on something said before the item opened", () => {
    expect(guard({ state: "done", quote: "The pixel is fixed now", evidence: 2, sure: true }, ev, since).state).toBe("moving");
  });
  it("treats a hedge as moving", () => {
    expect(guard({ state: "done", quote: "pixel should be live tomorrow", evidence: 3, sure: true }, ev, since).state).toBe("moving");
  });
  it("treats an unsure model as moving", () => {
    expect(guard({ state: "done", quote: "tracking is set up and verified", evidence: 1, sure: false }, ev, since).state).toBe("moving");
  });
  it("keeps moving and nothing as they are", () => {
    expect(guard({ state: "moving", quote: "", evidence: null, sure: true }, ev, since).state).toBe("moving");
    expect(guard({ state: "nothing", quote: "", evidence: null, sure: true }, ev, since).state).toBe("nothing");
  });
});

describe("the closed note", () => {
  it("quotes where and when", () => {
    expect(closedNote("tracking is set up and verified", "slack_internal", "2026-11-18T15:00:00Z")).toBe('Closed automatically: "tracking is set up and verified" (Slack, Nov 18)');
  });
});

import { subjectOf } from "@/lib/done-check-core";
describe("what an item's messages are about", () => {
  it("reads tracking messages first for a tracking item", () => {
    const re = subjectOf("notrack", "Tracking not set up")!;
    expect(re.test("CAPI is live and purchases are flowing")).toBe(true);
    expect(re.test("love the new creatives")).toBe(false);
  });
  it("uses the item's own words otherwise", () => {
    const re = subjectOf("ask", "Send the November report to Acme")!;
    expect(re.test("sent the november report this morning")).toBe(true);
  });
});

import { BROKEN, norm } from "@/lib/done-check-core";
describe("the Tracking Specialist's real confirmations", () => {
  const since2 = "2026-06-01T00:00:00Z";
  const one = (text: string, at = "2026-11-11T15:00:00Z"): Evidence[] => [{ n: 1, at, source: "slack_internal", author: "Tracking", text, url: null }];
  const done = (quote: string, text = quote) => guard({ state: "done", quote, evidence: 1, sure: true }, one(text), since2, { latestWins: true }).state;
  it("closes on each of these", () => {
    expect(done("Tracking fixed", "Tracking fixed <@U07ABC123>")).toBe("done");
    expect(done("tracking is ready", "tracking is ready for checkpilot.co")).toBe("done");
    expect(done("the pixel is now working")).toBe("done");
    expect(done("tracking is working fine")).toBe("done");
    expect(done("tracking is not broken, we tested it and it's ok")).toBe("done");
    expect(done("the tracking was done a while ago")).toBe("done");
  });
  it("never closes on a report that it's broken", () => {
    expect(done("Tracking is broken in two places")).toBe("moving");
    expect(BROKEN.test("tracking is not broken, we tested it")).toBe(false);
  });
  it("lets a newer breakage win over an older 'ready'", () => {
    const ev: Evidence[] = [
      { n: 1, at: "2026-11-16T15:00:00Z", source: "slack_external", author: "Buyer", text: "The site isn't sending landing page views back to the pixel", url: null },
      { n: 2, at: "2026-10-28T15:00:00Z", source: "slack_internal", author: "Tracking", text: "tracking is ready for checkpilot.co", url: null },
    ];
    expect(guard({ state: "done", quote: "tracking is ready", evidence: 2, sure: true }, ev, since2, { latestWins: true }).state).toBe("moving");
  });
  it("matches a quote with the Slack mention and punctuation normalised away", () => {
    expect(norm("Tracking fixed <@U07ABC123>!")).toBe("tracking fixed");
    expect(done("Tracking fixed!", "tracking   fixed <@U1> thanks")).toBe("done");
  });
});

import { stateConfirmed } from "@/lib/done-check-core";
describe("tracking as a state: the newest word decides", () => {
  const e = (n: number, at: string, text: string): Evidence => ({ n, at, source: "slack_internal", author: "Tracking", text, url: null });
  it("closes on the newest confirmation", () => {
    for (const t of ["Tracking fixed <@U07ABC>", "tracking is ready for checkpilot.co", "the pixel is now working", "tracking is working fine", "<!here> After a very long and HARD meeting with the client, tracking is not broken, we tested it and it’s ok. My theory is, they're receiving traffic", "the tracking was done a while ago. Did something change?"])
      expect(stateConfirmed([e(1, "2026-11-18T12:00:00Z", t)])?.quote).toBeTruthy();
  });
  it("stays open when a later message says it broke", () => {
    expect(stateConfirmed([e(1, "2026-11-12T12:00:00Z", "Complete Registration still isn't showing in Ads Manager"), e(2, "2026-11-11T12:00:00Z", "Tracking fixed")])).toBeNull();
    expect(stateConfirmed([e(1, "2026-11-16T12:00:00Z", "The site isn't sending landing page views back to the pixel"), e(2, "2026-10-28T12:00:00Z", "tracking is ready")])).toBeNull();
  });
  it("never closes on breakage, plans or work in progress", () => {
    for (const t of ["Tracking is broken in two places:", "We're fixing that tracking now.", "we're setting up conversion tracking on your intake form", "Is the pixel working?", "tracking should be live tomorrow", "Tracking is the #1 priority, and it's stalled"])
      expect(stateConfirmed([e(1, "2026-11-18T12:00:00Z", t)])).toBeNull();
  });
  it("never closes on the phrasings that falsely closed on Nov 20 (conditions, plans, negations, curly apostrophes)", () => {
    for (const t of [
      "Meta’s peer data shows *0% checkout-entry rate* on both campaigns, so the checkout event isn’t firing.",
      "Lead flow and call tracking are working, but no revenue is visible yet from the campaign.",
      "Kyle promised the client fixed tracking plus a report and Loom by Wednesday.",
      "Tracking: the web team fixed the homepage buttons and waiver links on Nov 10.",
      "Mark’s plan is $5 → $6.50/day until tracking and offers are fixed.",
      "The team walked through the 90-day agreement, Slack updates and tracking setup.",
      "We’re preparing the tracking setup for the upcoming VIP early access offer campaign.",
      "They were asked to share all the pages they are pushing so tracking can be set up.",
      "Kyle proposed a separate ad account and pixel for apparel while keeping the existing setup for bedding.",
      "This allows our team to manage and verify the > tracking setup needed to monitor your campaigns effectively.",
      "This is the pixel: <https://business.facebook.com/latest/settings/events_dataset_and_pixel/?business_id=1>",
      "We can also look into retargeting website visitors, provided the tracking is properly set up.",
      "There's just no Meta Pixel set up yet.",
      "Before we reactivate the campaign, I'll wait for to implement the tracking setup in WordPress.",
      "Please ping me once the pixel is setup on all the posh pages.",
      "I have access to the Ad account but I do not see tracking set up for the website.",
      "Richard updated the tracking today, but Complete Registration still isn’t showing in Ads Manager",
      "Confirm pixel and conversion tracking is firing on BestTicketsVIP",
      "The client is ready to move into lead generation with roughly $1,000 of remaining budget over about two weeks, after the video creative is aligned and the pixel fixed.",
      "Clare Inyang notifies the client that Meta tracking is ready and ask",
      "We'll relaunch as soon as the pixel is verified",
      "Tracking needs to be set up on the new booking page",
      "The pixel will be live once the developer pushes the update",
      "Launch waits until tracking is set up",
      "Get the Zombie event campaign back up with tracking verified on the Zombie landing page",
      "hey <@U06QNJD9DG8> is tracking ready here",
      "That's on us, and getting tracking done this week is how we close the gap",
      "_Must happen by Fri 10/23_ • <@U0C2WQW7Q02> get lead tracking working on the private-events pages",
      "On the email side, revenue tracking is now live, showing $5,300 in the last 30 days",
      "Clare tested the funnels end to end and tracking is ready, pending confirmation that the client has launched",
      "We moved to Toast in August and need to make sure all tracking is working",
    ])
      expect(stateConfirmed([e(1, "2026-11-18T12:00:00Z", t)])).toBeNull();
  });
  it("closes on plain confirmations inside longer messages", () => {
    for (const t of ["tracking is ready. Form submissions are tracked as \"Lead\" Pixel ID: 1669620706647924", "Launch is pending: access and tracking are done, but the client has not shared content", "Tracking is set up.", "team, the pixel is now working.", "Yes tracking is done <@U06Q1MF678U>", "FYI Tracking is done", "Fabi says tracking was done a while ago.", "<!here> tracking ready for the new website :)", "<@U06PZPLGX4J> I’m lost here, the tracking was done a while ago. Did something change?"])
      expect(stateConfirmed([e(1, "2026-11-18T12:00:00Z", t)])?.quote).toBeTruthy();
  });
});
