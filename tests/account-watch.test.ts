import { describe, expect, it } from "vitest";
import { billedServices, creativeBehind, idleState, idleTitle, matchActor, neglectDays, neglectState, normName, overspend, overtouched, serviceMismatches, serviceOfLine, spendAnomaly } from "@/lib/account-watch/core";

describe("serviceOfLine (Stripe lines as Track keeps them)", () => {
  it("maps each product to its service", () => {
    expect(serviceOfLine("1 × Google Advertising (at $875.00 / month)")).toBe("google-ads");
    expect(serviceOfLine("Meta Advertising")).toBe("facebook-ads");
    expect(serviceOfLine("Meta Ads Spend")).toBe("facebook-ads");
    expect(serviceOfLine("1 × TikTok Advertising (at $500.00 / month)")).toBe("tiktok-ads");
    expect(serviceOfLine("Creative Package")).toBe("creative");
    expect(serviceOfLine("Organic Social Media Management")).toBe("social-media");
    expect(serviceOfLine("Content Creation")).toBe("social-media");
    expect(serviceOfLine("SMS Marketing")).toBe("email-marketing");
    expect(serviceOfLine("1 × Email Marketing (at $1,750.00 / month)")).toBe("email-marketing");
    expect(serviceOfLine("1 × Website Development (at $1,500.00 / month)")).toBe("web-design");
    expect(serviceOfLine("Time on Google Advertising after 23 Oct 2026")).toBe("google-ads");
  });
  it("ignores credits and what isn't a line we run", () => {
    expect(serviceOfLine("Unused time on Meta Advertising after 30 Oct 2026")).toBeNull();
    expect(serviceOfLine("1 × SEO (at $500.00 / month)")).toBeNull();
    expect(serviceOfLine("")).toBeNull();
  });
});

describe("billedServices", () => {
  const now = new Date("2026-11-18T15:00:00Z");
  it("collects each service with its latest bill, skipping old, refunded, ignored and credit lines", () => {
    const b = billedServices(
      [
        { at: "2026-11-01T10:00:00Z", line_items: [{ a: 875, d: "1 × Meta Advertising (at $875.00 / month)" }, { a: 875, d: "1 × Google Advertising (at $875.00 / month)" }], amount: 1750 },
        { at: "2026-10-01T10:00:00Z", line_items: [{ a: 875, d: "Google Advertising" }], amount: 875 },
        { at: "2026-11-05T10:00:00Z", line_items: [{ a: 500, d: "TikTok Advertising" }], amount: 500, refunded: 500 },
        { at: "2026-11-06T10:00:00Z", line_items: [{ a: 300, d: "Email Marketing" }], amount: 300, ignored: true },
        { at: "2026-11-07T10:00:00Z", line_items: [{ a: -120, d: "Unused time on Creative Package" }], amount: -120 },
        { at: "2026-08-01T10:00:00Z", line_items: [{ a: 900, d: "Creative Package" }], amount: 900 },
      ],
      now,
    );
    expect(Object.keys(b).sort()).toEqual(["facebook-ads", "google-ads"]);
    expect(b["google-ads"]).toEqual({ last: "2026-11-01T10:00:00.000Z", amount: 875 });
  });
  it("reads the summary line when there are no items, and a creative package named in the memo", () => {
    const b = billedServices([{ at: "2026-11-10T00:00:00Z", lines: "Meta Advertising · Email Marketing", memo: "Creative Package for Acme · terms" }], now);
    expect(Object.keys(b).sort()).toEqual(["creative", "email-marketing", "facebook-ads"]);
  });
});

describe("idleState (billed but idle, 7 days)", () => {
  it("flags 7 or more days without activity", () => {
    expect(idleState({ line: "google", lastActivity: "2026-06-06", today: "2026-11-18" })).toMatchObject({ idle: true, daysIdle: 165 });
    expect(idleState({ line: "meta", lastActivity: "2026-11-11", today: "2026-11-18" }).idle).toBe(true);
    expect(idleState({ line: "meta", lastActivity: "2026-11-12", today: "2026-11-18" }).idle).toBe(false);
  });
  it("leaves a paused line alone until its day, then flags it again", () => {
    expect(idleState({ line: "meta", lastActivity: "2026-09-01", today: "2026-11-18", pausedUntil: "2027-03-01" })).toMatchObject({ idle: false, paused: true });
    expect(idleState({ line: "meta", lastActivity: "2026-09-01", today: "2026-11-18", pausedUntil: "2026-11-18" }).idle).toBe(false);
    expect(idleState({ line: "meta", lastActivity: "2026-09-01", today: "2026-11-18", pausedUntil: "2026-11-17" }).idle).toBe(true);
  });
  it("gives a new client the window before nothing-on-record counts", () => {
    expect(idleState({ line: "email", lastActivity: null, today: "2026-11-18", startedAt: "2026-11-15T10:00:00Z" }).idle).toBe(false);
    expect(idleState({ line: "email", lastActivity: null, today: "2026-11-18", startedAt: "2026-10-01T10:00:00Z" })).toMatchObject({ idle: true, daysIdle: null });
  });
  it("words the alert", () => {
    expect(idleTitle("google", true, "2026-06-06")).toBe("Billed for Google, no spend since Jun 6");
    expect(idleTitle("email", false, null)).toBe("On Email, no campaign sent on record");
  });
});

describe("neglect thresholds", () => {
  it("gives bigger accounts a shorter window", () => {
    expect(neglectDays(2_000)).toBe(7);
    expect(neglectDays(12_000)).toBe(5);
    expect(neglectDays(45_000)).toBe(3);
  });
  it("flags a spending account untouched past its window, and escalates three days later", () => {
    expect(neglectState({ lastTeamChange: "2026-11-12T10:00:00Z", spend7: 500, spend30: 2_000, today: "2026-11-18" })).toMatchObject({ neglected: false, days: 6 });
    expect(neglectState({ lastTeamChange: "2026-11-11T10:00:00Z", spend7: 500, spend30: 2_000, today: "2026-11-18" })).toMatchObject({ neglected: true, escalate: false, days: 7 });
    expect(neglectState({ lastTeamChange: "2026-11-08T10:00:00Z", spend7: 500, spend30: 2_000, today: "2026-11-18" })).toMatchObject({ neglected: true, escalate: true });
    expect(neglectState({ lastTeamChange: "2026-11-14T10:00:00Z", spend7: 9_000, spend30: 40_000, today: "2026-11-18" })).toMatchObject({ neglected: true, threshold: 3 });
  });
  it("never flags an account that isn't spending", () => {
    expect(neglectState({ lastTeamChange: "2026-09-01T10:00:00Z", spend7: 0, spend30: 0, today: "2026-11-18" }).neglected).toBe(false);
  });
});

describe("overtouched", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  it("flags three learning-reset edits on one ad set within 72 hours", () => {
    const r = overtouched([{ at: at(2), what: "Ad set budget updated", object: "Prospecting" }, { at: at(20), what: "Ad set targeting updated", object: "Prospecting" }, { at: at(50), what: "Ad set bid strategy updated", object: "Prospecting" }], now);
    expect(r).toMatchObject({ hit: true, object: "Prospecting", objectCount: 3 });
  });
  it("ignores names, statuses, budget scheduling and older edits", () => {
    const r = overtouched([{ at: at(2), what: "Ad name updated", object: "A" }, { at: at(3), what: "Ad status updated", object: "A" }, { at: at(4), what: "Ad set budget scheduling enabled", object: "A" }, { at: at(100), what: "Ad set budget updated", object: "A" }], now);
    expect(r.hit).toBe(false);
  });
});

describe("spend anomalies and overspend", () => {
  const days = (n: number, spend: number, end = "2026-11-16") => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${end}T12:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10), spend }));
  it("spots a spike, a drop and a stop against the 14-day average", () => {
    expect(spendAnomaly([...days(14, 100), { date: "2026-11-17", spend: 400 }], "2026-11-17")?.kind).toBe("spike");
    expect(spendAnomaly([...days(14, 100), { date: "2026-11-17", spend: 20 }], "2026-11-17")?.kind).toBe("drop");
    expect(spendAnomaly(days(14, 100), "2026-11-17")?.kind).toBe("stopped");
    expect(spendAnomaly([...days(14, 100), { date: "2026-11-17", spend: 110 }], "2026-11-17")).toBeNull();
  });
  it("projects the month against its budget", () => {
    expect(overspend({ mtd: 6_500, budget: 9_000, dayOfMonth: 17, daysInMonth: 30 }).over).toBe(true);
    // On course for 17.6% over: inside the 20% the owner set
    expect(overspend({ mtd: 6_000, budget: 9_000, dayOfMonth: 17, daysInMonth: 30 }).over).toBe(false);
    expect(overspend({ mtd: 4_500, budget: 9_000, dayOfMonth: 17, daysInMonth: 30 }).over).toBe(false);
    expect(overspend({ mtd: 4_500, budget: null, dayOfMonth: 17, daysInMonth: 30 }).over).toBe(false);
  });
  it("calls creative behind only near the end of the cycle", () => {
    expect(creativeBehind({ cap: 10, used: 2, elapsed: 0.85, daysLeft: 4 })).toBe(true);
    expect(creativeBehind({ cap: 10, used: 2, elapsed: 0.5, daysLeft: 15 })).toBe(false);
    expect(creativeBehind({ cap: 10, used: 7, elapsed: 0.85, daysLeft: 4 })).toBe(false);
  });
});

describe("names in ad platforms", () => {
  const team = [
    { id: "a", full_name: "Fábio Vinícius", email: "fabio@kaizenmarketing.agency" },
    { id: "b", full_name: "Kyle Barry", email: "kyle@kaizenmarketing.agency" },
    { id: "c", full_name: "Luriel Rodriguez", platform_aliases: ["Luriel Rt"] },
  ];
  it("folds accents, case and spaces", () => {
    expect(normName("  FÁBIO  Vinícius ")).toBe("fabio vinicius");
  });
  it("matches by name, email or alias, whatever the accents or case", () => {
    expect(matchActor("fabio vinicius", team)?.id).toBe("a");
    expect(matchActor("Fábio Vinícius", team)?.id).toBe("a");
    expect(matchActor("KYLE@kaizenmarketing.agency", team)?.id).toBe("b");
    expect(matchActor("luriel rt", team)?.id).toBe("c");
    expect(matchActor("Kyle J Barry", team)?.id).toBe("b");
  });
  it("matches nobody it shouldn't", () => {
    expect(matchActor("Juan Chaves", team)).toBeNull();
    expect(matchActor("justin@justwavy.com", team)).toBeNull();
    expect(matchActor("Kyle", team)).toBeNull();
    expect(matchActor(null, team)).toBeNull();
  });
});

describe("services vs Stripe", () => {
  it("lists billed-not-listed, listed-not-billed and a package that isn't billed", () => {
    const m = serviceMismatches({ services: ["facebook-ads", "email-marketing"], billed_services: { "facebook-ads": { last: "2026-11-01", amount: 875 }, "google-ads": { last: "2026-11-01", amount: 875 } }, billed_synced_at: "2026-11-18", creative_package: true });
    expect(m.map((x) => [x.kind, x.service, x.fix])).toEqual([
      ["billed_not_listed", "google-ads", "add"],
      ["listed_not_billed", "email-marketing", "remove"],
      ["package_not_billed", "creative", "clear_package"],
    ]);
  });
  it("says nothing before Stripe was read, or when they match", () => {
    expect(serviceMismatches({ services: ["facebook-ads"], billed_services: {}, billed_synced_at: null })).toEqual([]);
    expect(serviceMismatches({ services: ["facebook-ads"], billed_services: { "facebook-ads": { last: "2026-11-01", amount: 1 } }, billed_synced_at: "2026-11-18" })).toEqual([]);
  });
});
