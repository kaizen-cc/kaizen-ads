import { describe, expect, it } from "vitest";
import { lineDelivery, normalizeDelivery, pastRecipients } from "@/lib/reports/delivery-core";

// "Eddie usually likes seeing the report, so I always send to Juan, Eddie and Lino": the report's email has To and Cc
// the sender picks, remembered per client and service line, and the people past report emails went to are offered.

describe("To and Cc", () => {
  it("keeps the copies apart from To, nobody twice", () => {
    const d = normalizeDelivery({ channels: ["email"], recipients: ["Juan@11miami.com", "eddie@11miami.com"], cc: ["lino@11miami.com", "juan@11miami.com", "not an email"] });
    expect(d.recipients.map((r) => r.email)).toEqual(["juan@11miami.com", "eddie@11miami.com"]);
    expect(d.cc?.map((r) => r.email)).toEqual(["lino@11miami.com"]);
  });
  it("no copies: no cc at all (older choices read the same)", () => {
    expect(normalizeDelivery({ channels: ["email"], recipients: ["juan@11miami.com"] })).toEqual({ channels: ["email"], recipients: [{ email: "juan@11miami.com", name: null }] });
  });
});

describe("remembered per service line", () => {
  const byLine = { email: { channels: ["email"], recipients: ["juan@11miami.com", "eddie@11miami.com"], cc: ["lino@11miami.com"] } };
  it("the email team's choice for the email line", () => {
    const d = lineDelivery(byLine, "email");
    expect(d?.recipients.map((r) => r.email)).toEqual(["juan@11miami.com", "eddie@11miami.com"]);
    expect(d?.cc?.map((r) => r.email)).toEqual(["lino@11miami.com"]);
  });
  it("another line without its own choice falls back (null here)", () => {
    expect(lineDelivery(byLine, "ads")).toBeNull();
    expect(lineDelivery(null, "email")).toBeNull();
  });
});

describe("who it went to before", () => {
  const sends = [
    { to: ["juan@11miami.com", "eddie@11miami.com"], cc: ["sam@kaizenmarketing.agency", "lino@11miami.com"] },
    { to: ["juan@11miami.com", "eddie@11miami.com"] },
    { to: ["juan@11miami.com"] },
  ];
  it("offers the people missing from this one, most often first, never the team", () => {
    const now = normalizeDelivery({ channels: ["email"], recipients: ["juan@11miami.com"] });
    expect(pastRecipients(sends, now, new Set(["sam@kaizenmarketing.agency"])).map((r) => r.email)).toEqual(["eddie@11miami.com", "lino@11miami.com"]);
  });
  it("nobody already on it", () => {
    const now = normalizeDelivery({ channels: ["email"], recipients: ["juan@11miami.com", "eddie@11miami.com"], cc: ["lino@11miami.com"] });
    expect(pastRecipients(sends, now, new Set())).toEqual([{ email: "sam@kaizenmarketing.agency", name: null }]);
  });
});

describe("where in Slack: a standing thread", () => {
  it("reads a thread's link, and a reply's link as its thread", async () => {
    const { parseSlackLink } = await import("@/lib/reports/delivery-core");
    expect(parseSlackLink("https://kaizen.slack.com/archives/C07JZ87E1N2/p1795460770177329")).toEqual({ channel: "C07JZ87E1N2", thread: "1795460770.177329" });
    expect(parseSlackLink("https://kaizen.slack.com/archives/C07JZ87E1N2/p1795460999000100?thread_ts=1795460770.177329&cid=C07JZ87E1N2")).toEqual({ channel: "C07JZ87E1N2", thread: "1795460770.177329" });
    expect(parseSlackLink("https://example.com/not-slack")).toBeNull();
  });
  it("keeps only a real channel and thread, and says where it posts", async () => {
    const { normalizeDelivery, slackTargetOf, slackWhere } = await import("@/lib/reports/delivery-core");
    const d = normalizeDelivery({ channels: ["slack"], recipients: [], slack: { channel: "C07JZ87E1N2", channelName: "aldecoa-kaizen", thread: "1795460770.177329", threadLabel: "Weekly email reports", broadcast: true } });
    expect(d.slack).toEqual({ channel: "C07JZ87E1N2", channelName: "aldecoa-kaizen", thread: "1795460770.177329", threadLabel: "Weekly email reports", broadcast: true });
    expect(slackWhere(d.slack, null)).toBe("Posting in #aldecoa-kaizen › thread: Weekly email reports (also sent to the channel)");
    expect(slackTargetOf({ channel: "not a channel", thread: "abc" })).toBeNull();
    expect(slackTargetOf({ channel: "C07JZ87E1N2" })).toMatchObject({ channel: "C07JZ87E1N2", thread: null, broadcast: false });
    expect(slackWhere(null, "aldecoa")).toBe("Posting in #aldecoa");
  });
  it("is remembered per line with the rest", async () => {
    const { lineDelivery } = await import("@/lib/reports/delivery-core");
    const byLine = { email: { channels: ["slack"], recipients: [], slack: { channel: "C07JZ87E1N2", thread: "1795460770.177329" } } };
    expect(lineDelivery(byLine, "email")?.slack).toMatchObject({ channel: "C07JZ87E1N2", thread: "1795460770.177329" });
    expect(lineDelivery(byLine, "ads")).toBeNull();
  });
});
