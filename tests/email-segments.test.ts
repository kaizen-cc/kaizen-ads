import { describe, expect, it } from "vitest";
import { aggregateSegments, baselineOf, buildSegmentReport, peerPatterns, segCampaignOf, segmentAdvice, segmentDigest, segmentPattern, type AudienceInfo, type SegCampaign, type SegmentStat } from "@/lib/klaviyo/segments-core";

const ref = (name: string, type: "list" | "segment" = "segment") => ({ id: name.toLowerCase().replace(/\W+/g, "-"), name, type });
const camp = (day: string, included: string[], o: Partial<SegCampaign> = {}, excluded: string[] = []): SegCampaign => ({
  id: `${day}-${included.join("+")}`,
  sendTime: `${day}T15:00:00Z`,
  recipients: 1000,
  delivered: 980,
  opens: 300,
  clicks: 30,
  unsubscribes: 1,
  bounced: 5,
  spam: 0,
  revenue: 500,
  included: included.map((n) => ref(n)),
  excluded: excluded.map((n) => ref(n)),
  ...o,
});
const TODAY = "2026-11-18";

describe("segmentPattern", () => {
  it("reads the usual names", () => {
    expect(segmentPattern("Engaged 30 days")).toBe("engaged30");
    expect(segmentPattern("Engaged - Last 60 Days")).toBe("engaged60");
    expect(segmentPattern("90 day engaged")).toBe("engaged90");
    expect(segmentPattern("VIP customers")).toBe("vip");
    expect(segmentPattern("Winback 120d")).toBe("winback");
    expect(segmentPattern("Zero-time purchasers")).toBe("zero_purchase");
    expect(segmentPattern("0 time buyers")).toBe("zero_purchase");
    expect(segmentPattern("Never purchased")).toBe("zero_purchase");
    expect(segmentPattern("Purchased in last 30 days")).toBe("recent_buyers");
    expect(segmentPattern("Repeat customers")).toBe("repeat_buyers");
    expect(segmentPattern("New subscribers")).toBe("new_subscribers");
  });
  it("does not take unengaged for engaged", () => {
    expect(segmentPattern("Unengaged 90 days")).toBe("unengaged");
    expect(segmentPattern("Not engaged 120d")).toBe("unengaged");
    expect(segmentPattern("Sunset")).toBe("unengaged");
  });
  it("calls a plain list the whole list and an unknown segment other", () => {
    expect(segmentPattern("Newsletter", "list")).toBe("all");
    expect(segmentPattern("Spring giveaway entrants", "segment")).toBe("other");
  });
});

describe("segCampaignOf", () => {
  it("prefers audiences_detail and falls back to the older names", () => {
    const row = { campaign_id: "c1", channel: "email", send_time: "2026-11-01T12:00:00Z", recipients: 10, delivered: 9, opens_unique: 3, clicks_unique: 1, revenue: 20 };
    const a = segCampaignOf({ ...row, audiences_detail: { included: [{ id: "S1", name: "Engaged 30", type: "segment" }], excluded: [{ id: "S2", name: "Unengaged", type: "segment" }] }, audiences: ["old name"] });
    expect(a?.included.map((r) => r.name)).toEqual(["Engaged 30"]);
    expect(a?.excluded.map((r) => r.name)).toEqual(["Unengaged"]);
    const b = segCampaignOf({ ...row, audiences: ["Newsletter"] }, new Map([["Newsletter", "list" as const]]));
    expect(b?.included).toEqual([{ id: "Newsletter", name: "Newsletter", type: "list" }]);
    expect(b?.excluded).toEqual([]);
  });
  it("leaves out SMS and campaigns that are not sent yet", () => {
    expect(segCampaignOf({ channel: "sms", send_time: "2026-11-01T12:00:00Z" })).toBeNull();
    expect(segCampaignOf({ channel: "email", send_time: null })).toBeNull();
    expect(segCampaignOf({ channel: "email", send_time: "2999-01-01T00:00:00Z" })).toBeNull();
  });
});

describe("aggregateSegments", () => {
  it("adds each segment's campaigns, counting a campaign for every segment it went to", () => {
    const list = [camp("2026-11-02", ["Engaged 30", "VIP"]), camp("2026-11-09", ["Engaged 30"], { revenue: 700 }), camp("2026-11-12", ["VIP"], { revenue: 100 })];
    const s = aggregateSegments(list, { days: 30, today: TODAY });
    const eng = s.find((x) => x.name === "Engaged 30")!;
    expect(eng.campaigns).toBe(2);
    expect(eng.recipients).toBe(2000);
    expect(eng.revenue).toBe(1200);
    expect(eng.rpr).toBeCloseTo(0.6, 5);
    expect(eng.openRate).toBeCloseTo(600 / 1960, 5);
    expect(s.find((x) => x.name === "VIP")?.campaigns).toBe(2);
    // Best revenue first
    expect(s[0].name).toBe("Engaged 30");
  });
  it("counts the campaigns that left a segment out", () => {
    const list = [camp("2026-11-02", ["Newsletter"], {}, ["Unengaged"]), camp("2026-11-09", ["Newsletter"], {}, ["Unengaged"]), camp("2026-11-12", ["Unengaged"])];
    const s = aggregateSegments(list, { days: 30, today: TODAY });
    expect(s.find((x) => x.name === "Unengaged")?.excludedIn).toBe(2);
  });
  it("flags a segment earning under half the account's revenue per recipient", () => {
    const list = [camp("2026-11-02", ["Engaged 30"], { revenue: 1000 }), camp("2026-11-05", ["Engaged 30"], { revenue: 1000 }), camp("2026-11-09", ["Cold list"], { revenue: 40 }), camp("2026-11-12", ["Cold list"], { revenue: 40 })];
    const s = aggregateSegments(list, { days: 30, today: TODAY });
    const cold = s.find((x) => x.name === "Cold list")!;
    expect(cold.flags.map((f) => f.kind)).toContain("underperforming");
    expect(s.find((x) => x.name === "Engaged 30")!.flags).toEqual([]);
  });
  it("does not flag a segment with too little behind it", () => {
    const list = [camp("2026-11-02", ["Engaged 30"], { revenue: 1000 }), camp("2026-11-09", ["Tiny"], { recipients: 100, delivered: 100, opens: 1, clicks: 0, revenue: 0 })];
    expect(aggregateSegments(list, { days: 30, today: TODAY }).find((x) => x.name === "Tiny")!.flags).toEqual([]);
  });
  it("flags a segment sent to twice a week or more only when it shows fatigue", () => {
    const days = ["2026-11-01", "2026-11-04", "2026-11-08", "2026-11-11", "2026-11-14", "2026-11-17"];
    const tired = days.map((d, i) => camp(d, ["Engaged 30"], { revenue: i < 3 ? 600 : 150, unsubscribes: 6 }));
    const other = [camp("2026-11-03", ["Newsletter"], { revenue: 600 }), camp("2026-11-10", ["Newsletter"], { revenue: 600 })];
    const hot = aggregateSegments([...tired, ...other], { days: 21, today: TODAY }).find((x) => x.name === "Engaged 30")!;
    expect(hot.perWeek).toBeGreaterThanOrEqual(2);
    expect(hot.flags.map((f) => f.kind)).toContain("overused");
    // The same frequency with healthy results is not overuse
    const fine = days.map((d) => camp(d, ["Engaged 30"], { revenue: 600, unsubscribes: 1 }));
    expect(aggregateSegments(fine, { days: 21, today: TODAY })[0].flags).toEqual([]);
  });
});

describe("peerPatterns", () => {
  const peer = (id: string, name: string, revenue: number) => ({ clientId: id, campaigns: [camp("2026-10-20", [name], { revenue }), camp("2026-11-02", [name], { revenue })] });
  it("groups by kind of segment and needs more than one client", () => {
    const p = peerPatterns([peer("a", "Engaged 30 days", 900), peer("b", "Engaged last 30", 700), peer("c", "VIP", 2000)]);
    expect(p.map((x) => x.pattern)).toEqual(["engaged30"]);
    expect(p[0].clients).toBe(2);
    expect(p[0].rpr).toBeCloseTo(0.8, 5);
  });
  it("names no client", () => {
    const p = peerPatterns([peer("secret-client", "Winback", 500), peer("other-client", "Win-back 90", 500)]);
    expect(JSON.stringify(p)).not.toMatch(/secret-client|other-client/);
  });
});

const stat = (name: string, o: Partial<SegmentStat> = {}): SegmentStat => ({ id: name, name, type: "segment", pattern: segmentPattern(name), campaigns: 3, recipients: 3000, openRate: 0.3, clickRate: 0.03, unsubscribeRate: 0.001, revenue: 1500, rpr: 0.5, perWeek: 0.7, excludedIn: 0, lastSent: "2026-11-10T00:00:00Z", profiles: null, rprTrend: null, flags: [], ...o });

describe("segmentAdvice", () => {
  const base = baselineOf([camp("2026-11-02", ["Newsletter"]), camp("2026-11-09", ["Newsletter"]), camp("2026-11-12", ["Newsletter"])]);
  const input = (o: Partial<Parameters<typeof segmentAdvice>[0]> = {}) => ({ own: [], campaigns: [], base, audiences: [] as AudienceInfo[], peers: [], days: 90, ...o });

  it("with low deliverability, includes the engaged 30 days and excludes the unengaged", () => {
    const bad = { ...base, bounceRate: 0.03, campaigns: 6 };
    const a = segmentAdvice(input({ base: bad, audiences: [{ name: "Engaged 30 Days", type: "segment", profiles: 4000 }, { name: "Unengaged 90+", type: "segment", profiles: 9000 }] }));
    const inc = a.find((x) => x.kind === "include")!;
    const exc = a.find((x) => x.kind === "exclude")!;
    expect(inc.segments).toEqual(["Engaged 30 Days"]);
    expect(inc.exists).toBe(true);
    expect(exc.segments).toEqual(["Unengaged 90+"]);
  });
  it("says to create the segment when the account has none", () => {
    const a = segmentAdvice(input({ base: { ...base, spamRate: 0.001, campaigns: 6 } }));
    expect(a.find((x) => x.kind === "include")?.exists).toBe(false);
  });
  it("with many zero-time purchasers barely mailed, targets them and excludes recent buyers", () => {
    const a = segmentAdvice(input({ audiences: [{ name: "Newsletter", type: "list", profiles: 10000 }, { name: "Zero-time purchasers", type: "segment", profiles: 4200 }, { name: "Purchased in last 30 days", type: "segment", profiles: 300 }] }));
    const t = a.find((x) => x.kind === "target");
    expect(t?.segments).toEqual(["Zero-time purchasers"]);
    expect(a.some((x) => x.kind === "exclude" && x.segments.includes("Purchased in last 30 days"))).toBe(true);
  });
  it("leaves the zero-time purchasers alone once they are being mailed", () => {
    const a = segmentAdvice(input({ own: [stat("Zero-time purchasers", { campaigns: 4 })], audiences: [{ name: "Newsletter", type: "list", profiles: 10000 }, { name: "Zero-time purchasers", type: "segment", profiles: 4200 }] }));
    expect(a.find((x) => x.kind === "target")).toBeUndefined();
  });
  it("tells a whole-list sender to leave people out", () => {
    const whole = ["2026-11-02", "2026-11-05", "2026-11-09"].map((d) => ({ ...camp(d, []), included: [ref("Newsletter", "list")] }));
    const a = segmentAdvice(input({ campaigns: whole }));
    expect(a.some((x) => x.kind === "exclude" && /whole list/i.test(x.title))).toBe(true);
  });
  it("suggests what earns for similar clients and is not used here, but not what earns less than the account", () => {
    const peers = [
      { pattern: "winback" as const, label: "Winback and lapsed", clients: 3, campaigns: 9, recipients: 9000, rpr: 0.9, openRate: 0.3 },
      { pattern: "vip" as const, label: "VIP and best customers", clients: 3, campaigns: 9, recipients: 9000, rpr: 0.1, openRate: 0.3 },
    ];
    const a = segmentAdvice(input({ peers, base: { ...base, rpr: 0.5 } }));
    expect(a.filter((x) => x.kind === "try").map((x) => x.title)).toEqual(["Winback and lapsed segments"]);
  });
  it("rests an overused segment and trims an underperforming one", () => {
    const over = stat("Engaged 30", { flags: [{ kind: "overused", why: "Sent to 8 times" }] });
    const weak = stat("Cold list", { flags: [{ kind: "underperforming", why: "low" }] });
    const a = segmentAdvice(input({ own: [over, weak] }));
    expect(a.map((x) => x.title)).toEqual(expect.arrayContaining(["Rest Engaged 30", "Trim Cold list"]));
  });
});

describe("buildSegmentReport and its digest", () => {
  it("reads only campaigns in the window and says when audiences are missing", () => {
    const withAud = camp("2026-11-05", ["Engaged 30"]);
    const without = { ...camp("2026-11-06", []), included: [] };
    const old = camp("2026-06-01", ["Engaged 30"]);
    const r = buildSegmentReport({ campaigns: [withAud, without, old], audiences: [], peers: [], peerScope: null, days: 30, today: TODAY });
    expect(r.campaigns).toBe(2);
    expect(r.withAudiences).toBe(1);
    const d = segmentDigest(r);
    expect(d).toContain("Engaged 30");
    expect(d).toContain("per recipient");
  });
  it("digest says nothing is recorded yet when no campaign has audiences", () => {
    const r = buildSegmentReport({ campaigns: [{ ...camp("2026-11-06", []), included: [] }], audiences: [], peers: [], peerScope: null, days: 30, today: TODAY });
    expect(segmentDigest(r)).toMatch(/no campaign/i);
    expect(segmentDigest(null)).toBe("");
  });
});
