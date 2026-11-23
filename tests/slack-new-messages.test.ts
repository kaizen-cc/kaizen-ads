import { describe, expect, it } from "vitest";
import { channelKey, groupDmIds, isJustMe, slackChannelPlace, slackGroupPlace, slackSelfText, tagMentions } from "@/lib/assistant/platform-drafts-core";

describe("a new group DM", () => {
  it("needs two or more people in Slack, and reads naturally", () => {
    const p = slackGroupPlace([{ id: "U0AAAAAAA1", name: "Jesus" }, { id: "U0BBBBBBB2", name: "Dana" }])!;
    expect(p).toEqual({ channel: "mpim:U0AAAAAAA1,U0BBBBBBB2", thread: null, where: "a group DM with Jesus and Dana" });
    expect(groupDmIds(p.channel)).toEqual(["U0AAAAAAA1", "U0BBBBBBB2"]);
    expect(slackGroupPlace([{ id: "U0AAAAAAA1", name: "Jesus" }])).toBeNull();
    expect(slackGroupPlace([{ id: "U0AAAAAAA1", name: "A" }, { id: "U0BBBBBBB2", name: "B" }, { id: "U0CCCCCCC3", name: "C" }])!.where).toBe("a group DM with A, B and C");
  });
  it("only a stored group DM opens one", () => {
    expect(groupDmIds("U0AAAAAAA1")).toBeNull();
    expect(groupDmIds("C0123")).toBeNull();
  });
  it("its self-DM copy says where it goes, with no thread link", () => {
    expect(slackSelfText({ channel: "mpim:U1AAAAAAA,U2BBBBBBB", thread: null, where: "a group DM with Jesus and Dana" }, "hi")).toMatch(/^Draft for a group DM with Jesus and Dana/);
  });
});

describe("a new message in a channel", () => {
  it("matches how people say channel names", () => {
    expect(channelKey("the OO channel")).toBe("oo");
    expect(channelKey("#email-team")).toBe("email-team");
    expect(channelKey("Email Team")).toBe("email-team");
    expect(slackChannelPlace("C123", "#email-team")).toEqual({ channel: "C123", thread: null, where: "#email-team" });
  });
  it("'me' is a copy for themselves, not a channel", () => {
    expect(isJustMe("me")).toBe(true);
    expect(isJustMe("my Slack")).toBe(true);
    expect(isJustMe("the OO channel")).toBe(false);
  });
});

describe("tagging teammates", () => {
  const team = [
    { name: "Dana Kim", slackId: "U0DANA0001" },
    { name: "Jesus Ortega", slackId: "U0JESU0001" },
    { name: "Dana Lopez", slackId: "U0DANB0001" },
  ];
  it("@Full Name and an unambiguous @First become real mentions", () => {
    expect(tagMentions("@Jesus can you check? cc @Dana Kim", team)).toBe("<@U0JESU0001> can you check? cc <@U0DANA0001>");
  });
  it("a first name two people share stays as typed", () => {
    expect(tagMentions("thanks @Dana", team)).toBe("thanks @Dana");
  });
  it("emails and existing mentions are left alone", () => {
    expect(tagMentions("mail jesus@kaizen.test or <@U0JESU0001>", team)).toBe("mail jesus@kaizen.test or <@U0JESU0001>");
  });
});
