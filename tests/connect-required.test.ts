import { describe, expect, it } from "vitest";
import { asanaGap, buttonLabel, connectHref, helloLine, itemTitle, missingOf, slackGap, snoozedToday } from "@/lib/connect-required-core";
import { SLACK_POST_NEEDS, SLACK_READ_NEEDS } from "@/lib/personal-connections-core";

const ALL = [...SLACK_POST_NEEDS, ...SLACK_READ_NEEDS].join(",");

describe("everyone connects their own Slack and Asana", () => {
  it("Slack: connected with every required scope, else Reconnect (a scope added to the list counts on its own); the wrong workspace is Switch", () => {
    expect(slackGap(null, null)).toBe("missing");
    expect(slackGap({ scopes: ALL, team_id: "T1" }, "T1")).toBe("ok");
    expect(slackGap({ scopes: "chat:write", team_id: "T1" }, "T1")).toBe("reconnect");
    expect(slackGap({ scopes: ALL, team_id: "T9" }, "T1")).toBe("wrong");
  });

  it("Asana: their own account in Kaizen's workspace; not theirs or another workspace is the wrong account; expired is Reconnect", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(asanaGap(null, "W1", now)).toBe("missing");
    expect(asanaGap({ confirmed: true, expires_at: null, refresh_token: "r", workspaces: [{ gid: "W1" }] }, "W1", now)).toBe("ok");
    expect(asanaGap({ confirmed: false, expires_at: null, refresh_token: "r", workspaces: [{ gid: "W1" }] }, "W1", now)).toBe("wrong");
    expect(asanaGap({ confirmed: true, expires_at: null, refresh_token: "r", workspaces: [{ gid: "W2" }] }, "W1", now)).toBe("wrong");
    expect(asanaGap({ confirmed: true, expires_at: "2026-11-01T00:00:00Z", refresh_token: null, workspaces: [] }, "W1", now)).toBe("reconnect");
  });

  it("says it plainly with one tap each, and the assistant raises it first", () => {
    const gaps = { slack: "reconnect" as const, asana: "missing" as const };
    expect(missingOf(gaps)).toEqual(["slack", "asana"]);
    expect(itemTitle(missingOf(gaps))).toBe("Connect your Slack and Asana so Kaizen OS can work for you");
    expect(buttonLabel("slack", "reconnect")).toBe("Reconnect Slack");
    expect(buttonLabel("asana", "wrong")).toBe("Switch Asana");
    expect(connectHref("asana", "missing", "/pipeline")).toEqual({ href: "/api/asana/connect?next=%2Fpipeline", post: false });
    expect(connectHref("asana", "wrong", "/pipeline")).toEqual({ href: "/api/asana/disconnect?switch=1&next=%2Fpipeline", post: true });
    expect(connectHref("slack", "missing", "/pipeline").href).toContain("/api/slack/connect?read=1");
    expect(helloLine(gaps)).toMatch(/^Before anything else: I still need your Slack \(needs reconnecting\) and Asana \(not connected\)/);
    expect(helloLine({ slack: "ok", asana: "ok" })).toBeNull();
  });

  it("Remind me tomorrow holds for the rest of that day only", () => {
    expect(snoozedToday("2026-11-24", "2026-11-24")).toBe(true);
    expect(snoozedToday("2026-11-24", "2026-11-25")).toBe(false);
    expect(snoozedToday(null, "2026-11-24")).toBe(false);
  });
});
