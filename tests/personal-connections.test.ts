import { describe, expect, it } from "vitest";
import { connectCard, connectHref, helloConnectionLine, needsConnection, resumeLine, scopesOf, slackState, SLACK_READ_NEEDS } from "@/lib/personal-connections-core";

describe("a person's Slack", () => {
  it("connected for posting only (every token before Nov 23) is a missing permission, not 'not connected'", () => {
    const s = slackState({ scopes: "files:read,chat:write,files:write" });
    expect(s.state).toBe("missing_scope");
    expect(s.missing).toEqual([...SLACK_READ_NEEDS]);
  });

  it("with reading allowed it's connected", () => {
    expect(slackState({ scopes: `chat:write files:write ${SLACK_READ_NEEDS.join(" ")}` }).state).toBe("connected");
  });

  it("a token Slack rejects needs a reconnect; no row is not connected", () => {
    expect(slackState({ scopes: "chat:write" }, "token_revoked").state).toBe("reconnect");
    expect(slackState({ scopes: "chat:write" }, "invalid_auth").state).toBe("reconnect");
    expect(slackState(null).state).toBe("missing");
    // A blip (rate limit) isn't a dead token
    expect(slackState({ scopes: `chat:write,${SLACK_READ_NEEDS.join(",")}` }, "ratelimited").state).toBe("connected");
  });

  it("reads scopes stored either way", () => {
    expect(scopesOf("a,b c")).toEqual(["a", "b", "c"]);
    expect(scopesOf(null)).toEqual([]);
  });
});

describe("needs_connection", () => {
  it("Slack: a reconnect card that asks for reading and comes back to the conversation", () => {
    const n = needsConnection("slack", "missing_scope", { missing: ["search:read"] });
    expect(n.needs_connection).toMatchObject({ service: "slack", state: "missing_scope", fix: "reconnect", missing: ["search:read"] });
    expect(n.needs_connection.link).toBe(`/api/slack/connect?read=1&next=${encodeURIComponent("/connected?service=slack")}`);
    expect(n.say).toMatch(/posting only/);
    const card = connectCard(n)!;
    expect(card).toMatchObject({ id: "connect-slack", title: "Reconnect your Slack", cta: "Reconnect", external: true, connect: { service: "slack" } });
  });

  it("never connected: Connect", () => {
    const card = connectCard(needsConnection("slack", "missing"))!;
    expect(card.title).toBe("Connect your Slack");
    expect(card.cta).toBe("Connect");
  });

  it("Google: an admin setting, no card and nothing for them to connect", () => {
    const n = needsConnection("gmail", "admin", { forAdmin: "Add gmail.readonly" });
    expect(n.needs_connection).toMatchObject({ fix: "admin", link: null, for_the_admin: "Add gmail.readonly" });
    expect(connectCard(n)).toBeNull();
    expect(n.say).toMatch(/nothing for you to connect/);
  });

  it("Slack and Asana have sign-in links, Google doesn't", () => {
    expect(connectHref("calendar")).toBeNull();
    expect(connectHref("asana")).toBe(`/api/asana/connect?next=${encodeURIComponent("/connected?service=asana")}`);
    expect(connectHref("slack", "/settings?tab=connections")).toBe("/api/slack/connect?read=1&next=%2Fsettings%3Ftab%3Dconnections");
  });
});

describe("the hello and picking the ask back up", () => {
  it("mentions a broken connection, never one that was never set up", () => {
    expect(helloConnectionLine("slack", "missing_scope")).toMatch(/posting only/);
    expect(helloConnectionLine("slack", "reconnect")).toMatch(/stopped working/);
    expect(helloConnectionLine("slack", "missing")).toBeNull();
    expect(helloConnectionLine("slack", "connected")).toBeNull();
  });

  it("says they've connected, so the assistant carries on", () => {
    expect(resumeLine("slack")).toBe("I've connected my Slack. Go ahead with what I asked.");
  });
});

import { dmOwed, isDmKey } from "@/lib/owed-dms-core";

describe("DMs waiting on a reply", () => {
  const me = "UME";
  it("the newest human message is theirs: owed", () => {
    const m = dmOwed([{ ts: "3", user: "UDANA", text: "can you send the deck?" }, { ts: "2", user: me, text: "hey" }], me);
    expect(m?.ts).toBe("3");
  });
  it("they answered last: nothing owed", () => {
    expect(dmOwed([{ ts: "4", user: me, text: "sent!" }, { ts: "3", user: "UDANA", text: "can you send the deck?" }], me)).toBeNull();
  });
  it("bots, join notices and a plain thanks don't count", () => {
    expect(dmOwed([{ ts: "5", user: "UBOT", bot_id: "B1", text: "reminder" }, { ts: "4", user: me, text: "done" }], me)).toBeNull();
    expect(dmOwed([{ ts: "5", user: "UDANA", subtype: "channel_join", text: "joined" }], me)).toBeNull();
    expect(dmOwed([{ ts: "5", user: "UDANA", text: "thanks! 🙏" }, { ts: "4", user: me, text: "here you go" }], me)).toBeNull();
  });
  it("knows a DM's owed reply by its key", () => {
    expect(isDmKey("dm:D123:1.2")).toBe(true);
    expect(isDmKey("C123:1.2")).toBe(false);
  });
});
