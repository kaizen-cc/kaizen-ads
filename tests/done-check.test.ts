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
