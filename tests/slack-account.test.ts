import { describe, expect, it } from "vitest";
import { slackAccountState, slackConnectHref, slackFlash, YOUR_ACCOUNTS } from "@/lib/slack-account-core";

// Issue #126: Slack had no row under Settings › Connections › Your accounts (only Kaizen AI connectors were listed)
describe("their own Slack on Your accounts", () => {
  it("reads not connected, posting only, or connected for reading", () => {
    expect(slackAccountState(null)).toBe("not_connected");
    expect(slackAccountState({ scopes: "chat:write,files:write,files:read" })).toBe("posting");
    expect(slackAccountState({ scopes: null })).toBe("posting");
    expect(slackAccountState({ scopes: "chat:write,files:write,files:read,search:read,channels:history,groups:history,im:history,mpim:history" })).toBe("reading");
  });

  it("connecting asks for reading and comes back to Your accounts", () => {
    const href = slackConnectHref();
    expect(href.startsWith("/api/slack/connect?")).toBe(true);
    const q = new URLSearchParams(href.split("?")[1]);
    expect(q.get("read")).toBe("1");
    expect(q.get("next")).toBe(YOUR_ACCOUNTS);
  });

  it("says how connecting went", () => {
    expect(slackFlash("connected", null)?.bad).toBe(false);
    expect(slackFlash("error", "access_denied")?.bad).toBe(true);
    expect(slackFlash("not_configured", null)?.bad).toBe(true);
    expect(slackFlash(null, null)).toBeNull();
  });
});
