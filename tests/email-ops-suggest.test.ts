import { describe, expect, it } from "vitest";
import { excerpt, performanceFacts, pickMentions, toRows, upcomingMoments, type ContextItem, type Draft, type SentCampaign } from "@/lib/email-ops/suggest-core";

const send = (subject: string, day: string, recipients: number, openRate: number, revenue: number, audiences = ["Engaged"]): SentCampaign => ({ subject, name: subject, channel: "email", sendTime: `${day}T15:00:00Z`, recipients, openRate, clickRate: 0.01, revenue, audiences });

describe("calendar moments", () => {
  it("finds Black Friday from Thanksgiving, four weeks ahead", () => {
    const m = upcomingMoments("2026-11-02");
    expect(m.find((x) => x.key === "black_friday")?.date).toBe("2026-11-27");
    expect(m.find((x) => x.key === "cyber_monday")?.date).toBe("2026-11-30");
  });
  it("computes Mother's Day (second Sunday of May) and leaves out what is far away", () => {
    const m = upcomingMoments("2026-04-20");
    expect(m.find((x) => x.key === "mothers_day")?.date).toBe("2026-05-10");
    expect(m.find((x) => x.key === "black_friday")).toBeUndefined();
  });
  it("rolls into next year and drops what has passed", () => {
    const m = upcomingMoments("2026-12-20");
    expect(m.find((x) => x.key === "new_year")?.date).toBe("2027-01-01");
    expect(m.find((x) => x.key === "black_friday")).toBeUndefined();
  });
});

describe("past performance", () => {
  const rows = [
    send("Is this you?", "2026-10-05", 1000, 0.4, 900),
    send("Why wait?", "2026-10-12", 1000, 0.38, 700),
    send("Ready for fall?", "2026-10-19", 1000, 0.36, 800),
    send("New arrivals", "2026-10-26", 1000, 0.25, 200, ["Everyone"]),
    send("20% off everything", "2026-11-02", 1000, 0.3, 300, ["Everyone"]),
    send("Free shipping today", "2026-11-09", 1000, 0.28, 250, ["Everyone"]),
  ];
  it("groups by send day, offer and audience, dropping groups under three sends", () => {
    const f = performanceFacts(rows);
    expect(f.sends).toBe(6);
    expect(f.byWeekday.map((g) => g.label)).toEqual(["Monday"]);
    expect(f.audiences.map((g) => g.label)).toEqual(["Engaged", "Everyone"]);
    expect(f.audiences[0].revenue_per_recipient).toBeGreaterThan(f.audiences[1].revenue_per_recipient ?? 0);
    expect(f.offers).toEqual([]);
    expect(f.subjects.find((s) => s.trait === "a question")?.campaigns).toBe(3);
  });
  it("says there is not enough to read with fewer than three sends", () => {
    expect(performanceFacts(rows.slice(0, 2)).baseline).toBeNull();
  });
});

describe("what the client mentioned", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const item = (id: string, source: string, day: string, body: string): ContextItem => ({ id, source, occurred_at: `${day}T10:00:00Z`, author: "Client", title: null, body, url: `https://example.com/${id}` });
  it("keeps recent posts that talk about a promo or launch, numbered, and drops chatter and old news", () => {
    const m = pickMentions([item("a", "slack_external", "2026-11-10", "We are launching the new winter collection on Dec 1"), item("b", "slack_external", "2026-11-12", "thanks, sounds good"), item("c", "gmail", "2026-09-01", "big sale coming"), item("d", "call", "2026-11-14", "They want a 20% off weekend")], now);
    expect(m.map((x) => [x.n, x.origin, x.id])).toEqual([
      [1, "call", "d"],
      [2, "slack", "a"],
    ]);
  });
  it("centres a long quote on the promotion word", () => {
    const long = `${"filler ".repeat(80)}Black Friday is the big one for us ${"more ".repeat(80)}`;
    const e = excerpt(long);
    expect(e).toContain("Black Friday");
    expect(e.length).toBeLessThan(300);
  });
});

describe("drafts become rows", () => {
  const mentions = pickMentions([{ id: "m1", source: "slack_external", occurred_at: "2026-11-12T10:00:00Z", author: "Client", title: null, body: "We launch the winter collection on Dec 1", url: "https://slack.example/m1" }], Date.parse("2026-11-17T12:00:00Z"));
  const moments = upcomingMoments("2026-11-02");
  const draft = (o: Partial<Draft>): Draft => ({ title: "T", idea: "Idea", why: "Why", origin: "performance", evidence: ["e"], sendOn: "", momentKey: "", mention: 0, ...o });

  it("takes the quote and link from the cited mention, never from the draft", () => {
    const [r] = toRows([draft({ title: "Winter launch", origin: "mention", mention: 1, sendOn: "2026-12-01" })], mentions, moments, "2026-11-17");
    expect(r.origin).toBe("slack");
    expect(r.source_quote).toContain("winter collection");
    expect(r.source_url).toBe("https://slack.example/m1");
    expect(r.send_on).toBe("2026-12-01");
    expect(r.dedupe_key).toBe("mention:m1");
  });
  it("ties a calendar idea to its moment and its year", () => {
    const [r] = toRows([draft({ title: "BFCM teaser", origin: "calendar", momentKey: "black_friday" })], mentions, moments, "2026-11-17");
    expect(r.origin).toBe("calendar");
    expect(r.dedupe_key).toBe("moment:black_friday:2026");
    expect(r.source_quote).toContain("Black Friday");
  });
  it("falls back to a performance idea when the cited mention does not exist, and drops past or malformed send days", () => {
    const rows = toRows([draft({ title: "Ghost", origin: "mention", mention: 9, sendOn: "2026-01-01" }), draft({ title: "Soon", sendOn: "next week" })], mentions, moments, "2026-11-17");
    expect(rows.map((r) => [r.origin, r.send_on])).toEqual([
      ["performance", null],
      ["performance", null],
    ]);
  });
  it("never suggests the same moment, mention or idea twice, even against what exists", () => {
    const rows = toRows([draft({ title: "A", origin: "calendar", momentKey: "black_friday" }), draft({ title: "B", origin: "calendar", momentKey: "black_friday" }), draft({ title: "Repeat" })], mentions, moments, "2026-11-17", new Set(["perf:repeat"]));
    expect(rows.map((r) => r.title)).toEqual(["A"]);
  });
});
