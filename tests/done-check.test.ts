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
