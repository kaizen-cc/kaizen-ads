import { describe, expect, it } from "vitest";
import { isBareSlackLink, slackLink, slackLinksIn, workspaceBase } from "@/lib/slack-link";

// The owner's Nov 25 iPhone bug: "Open it" on a Slack item opened the app, then bounced to "Sign in to your workspace".
const ws = "https://kaizenmktg.slack.com/";

describe("Slack links open the app at the message", () => {
  it("gives a bare archives link the workspace's own address, thread and all", () => {
    expect(slackLink("https://slack.com/archives/C0123ABCD/p1700000000123456", ws)).toBe("https://kaizenmktg.slack.com/archives/C0123ABCD/p1700000000123456");
    expect(slackLink("https://slack.com/archives/C0123ABCD/p1700000000123456?thread_ts=1700000000.000100&cid=C0123ABCD", ws)).toBe(
      "https://kaizenmktg.slack.com/archives/C0123ABCD/p1700000000123456?thread_ts=1700000000.000100&cid=C0123ABCD",
    );
  });
  it("turns app.slack.com/client links (which force the browser) into the permalink", () => {
    expect(slackLink("https://app.slack.com/client/T01ABC/C0123ABCD", ws)).toBe("https://kaizenmktg.slack.com/archives/C0123ABCD");
    expect(slackLink("https://app.slack.com/client/T01ABC/C0123ABCD/thread/C0123ABCD-1700000000.123456", ws)).toBe(
      "https://kaizenmktg.slack.com/archives/C0123ABCD/p1700000000123456?thread_ts=1700000000.123456&cid=C0123ABCD",
    );
  });
  it("leaves links that already know the workspace, other sites, and everything when the workspace isn't known", () => {
    expect(slackLink("https://kaizenmktg.slack.com/archives/C1/p1", ws)).toBe("https://kaizenmktg.slack.com/archives/C1/p1");
    expect(slackLink("https://app.asana.com/0/1/2", ws)).toBe("https://app.asana.com/0/1/2");
    expect(slackLink("https://slack.com/archives/C1/p1", null)).toBe("https://slack.com/archives/C1/p1");
    expect(slackLink(null, ws)).toBeNull();
  });
  it("reads the workspace address however Slack gives it, never app.slack.com", () => {
    expect(workspaceBase("https://KaizenMktg.slack.com")).toBe(ws);
    expect(workspaceBase("https://app.slack.com/")).toBeNull();
    expect(workspaceBase("https://evil.com/.slack.com/")).toBeNull();
    expect(isBareSlackLink("https://slack.com/archives/C1/p1")).toBe(true);
    expect(isBareSlackLink(ws)).toBe(false);
  });
  it("fixes every Slack link inside text (an assistant's answer)", () => {
    expect(slackLinksIn("See https://slack.com/archives/C1/p1 and (https://app.slack.com/client/T1/C2).", ws)).toBe("See https://kaizenmktg.slack.com/archives/C1/p1 and (https://kaizenmktg.slack.com/archives/C2).");
  });
});
