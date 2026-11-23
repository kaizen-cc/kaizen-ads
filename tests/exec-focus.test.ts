import { describe, expect, it } from "vitest";
import { classifyNotice, cleanFocus, clientLines, execKeeps, isPersonal, itemInFocus, lineInFocus, lineOf, splitForExec, type FocusLine } from "@/lib/exec-focus/core";
import { BIG_ACCOUNT_30D, fireKey, fireOf, fireTitle, kpiWorse, messageFire, topSpenders } from "@/lib/exec-focus/fire";
import { countLooks, topicGroups } from "@/lib/today-counts";

// The focus the owner set for each exec (roles here, the people live in the data)
const CEO: FocusLine[] = ["meta", "google", "tiktok", "creative_performance"];
const COO: FocusLine[] = ["email"];
const THIRD: FocusLine[] = ["social", "creative"];

describe("lines", () => {
  it("reads a line from services, platforms and focus names", () => {
    expect(lineOf("facebook-ads")).toBe("meta");
    expect(lineOf("google")).toBe("google");
    expect(lineOf("email-marketing")).toBe("email");
    expect(lineOf("social-media")).toBe("social");
    expect(lineOf("klaviyo")).toBe("email");
    expect(lineOf("creative_performance")).toBe("creative_performance");
    expect(lineOf("seo")).toBeNull();
    expect(lineOf(null)).toBeNull();
  });
  it("keeps only real lines, in order", () => {
    expect(cleanFocus(["email", "nope", "meta", "email"])).toEqual(["meta", "email"]);
    expect(clientLines(["email-marketing", "facebook-ads", "seo"])).toEqual(["meta", "email"]);
  });
  it("creative covers its performance, creative_performance never covers production", () => {
    expect(lineInFocus("creative_performance", ["creative"])).toBe(true);
    expect(lineInFocus("creative", ["creative_performance"])).toBe(false);
    expect(lineInFocus(null, CEO)).toBe(false);
  });
});

describe("classifyNotice", () => {
  it("uses the writer's line first", () => {
    expect(classifyNotice({ kind: "kpi", key: "watch:abc", line: "google-ads" })).toBe("google");
  });
  it("reads the line from the key or kind", () => {
    expect(classifyNotice({ kind: "client", key: "email-sprint:1" })).toBe("email");
    expect(classifyNotice({ kind: "client", key: "social-audit:1" })).toBe("social");
    expect(classifyNotice({ kind: "fatigue", key: "tired:c:a:2026-11-18" })).toBe("creative_performance");
    expect(classifyNotice({ kind: "client", key: "client-wait:r:1" })).toBe("creative");
    expect(classifyNotice({ kind: "connection", key: "connection:meta-token:bm:2026-11-18" })).toBe("meta");
    expect(classifyNotice({ kind: "client", key: "ba:audit:google" })).toBe("google");
    expect(classifyNotice({ kind: "onboarding", key: "kickoff:c" })).toBeNull();
  });
  it("knows what's personal", () => {
    expect(isPersonal({ kind: "reply", key: "owed:1" })).toBe(true);
    expect(isPersonal({ kind: "reply", key: "owed-lead:1" })).toBe(false);
    expect(isPersonal({ kind: "assigned", key: "assign:r:p:copy" })).toBe(true);
    expect(isPersonal({ kind: "feedback", key: "feedback-review:approve:1:2" })).toBe(true);
    expect(isPersonal({ kind: "client", key: "review-todo:1" })).toBe(true);
    expect(isPersonal({ kind: "kpi", key: "watch:1" })).toBe(false);
  });
});

describe("execKeeps", () => {
  const metaIdle = { kind: "kpi", key: "watch:1", line: "facebook-ads" };
  const emailSprint = { kind: "client", key: "email-sprint:1" };
  const socialAudit = { kind: "client", key: "social-audit:1" };
  const fatigue = { kind: "fatigue", key: "tired:c:a:d" };
  const ticketLate = { kind: "client", key: "client-wait:r:1" };

  it("the paid ads exec: ads lines and creative performance, not email, social or production", () => {
    expect(execKeeps(metaIdle, CEO).keep).toBe(true);
    expect(execKeeps(fatigue, CEO).keep).toBe(true);
    expect(execKeeps(emailSprint, CEO).keep).toBe(false);
    expect(execKeeps(socialAudit, CEO).keep).toBe(false);
    expect(execKeeps(ticketLate, CEO).keep).toBe(false);
  });
  it("the email exec: email only", () => {
    expect(execKeeps(emailSprint, COO).keep).toBe(true);
    expect(execKeeps(metaIdle, COO).keep).toBe(false);
    expect(execKeeps(fatigue, COO).keep).toBe(false);
  });
  it("the social and creative exec: social, creative production and its performance", () => {
    expect(execKeeps(socialAudit, THIRD).keep).toBe(true);
    expect(execKeeps(ticketLate, THIRD).keep).toBe(true);
    expect(execKeeps(fatigue, THIRD).keep).toBe(true);
    expect(execKeeps(metaIdle, THIRD).keep).toBe(false);
  });
  it("personal always reaches them", () => {
    for (const f of [CEO, COO, THIRD]) {
      expect(execKeeps({ kind: "reply", key: "owed:1" }, f)).toEqual({ keep: true, why: "personal" });
      expect(execKeeps({ kind: "agent", key: "agent-ask:1" }, f).keep).toBe(true);
      expect(execKeeps({ kind: "client", key: "review-todo:1" }, f).keep).toBe(true);
    }
  });
  it("a client on fire reaches every exec", () => {
    for (const f of [CEO, COO, THIRD]) expect(execKeeps({ kind: "fire", key: "fire:c:2026-11-18", line: "email", fire: true }, f)).toEqual({ keep: true, why: "fire" });
  });
  it("an escalated client message matches by the client's lines", () => {
    const n = { kind: "reply", key: "owed-lead:1", clientLines: ["email-marketing"] };
    expect(execKeeps(n, COO)).toEqual({ keep: true, why: "client" });
    expect(execKeeps(n, CEO).keep).toBe(false);
  });
  it("no focus set: everything, as before", () => {
    expect(execKeeps(emailSprint, []).keep).toBe(true);
  });
  it("nothing with no line and nothing personal", () => {
    expect(execKeeps({ kind: "onboarding", key: "kickoff:c" }, CEO).keep).toBe(false);
  });
});

describe("an exec's recap", () => {
  const items = [
    { key: "mine:ticket:1", topic: "mine", title: "#1 Thing", clientId: "a" },
    { key: "kpi:1", topic: "accounts", title: "Acme · Google is off target", clientId: "a" },
    { key: "email-score:1", topic: "email", title: "Email score", clientId: "b" },
    { key: "fatigue:a:1", topic: "ads", title: "Tired ad", clientId: "a" },
    { key: "brief:1", topic: "briefs", title: "Brief", clientId: "a" },
    { key: "owed-lead:1", topic: "promises", title: "Someone hasn't replied", clientId: "b" },
    { key: "social-quiet:1", topic: "social", title: "No posts", clientId: "c" },
  ];
  const lines = new Map<string, FocusLine[]>([
    ["a", ["meta", "google", "creative"]],
    ["b", ["email"]],
    ["c", ["social"]],
  ]);
  it("splits each exec's day by focus", () => {
    const keys = (f: FocusLine[], onFire = new Set<string>()) => splitForExec(items, f, { clientLines: lines, onFire }).mine.map((i) => i.key);
    expect(keys(CEO)).toEqual(["mine:ticket:1", "kpi:1", "fatigue:a:1"]);
    expect(keys(COO)).toEqual(["mine:ticket:1", "email-score:1", "owed-lead:1"]);
    expect(keys(THIRD)).toEqual(["mine:ticket:1", "fatigue:a:1", "brief:1", "social-quiet:1"]);
    // A client on fire comes along whatever the line
    expect(keys(COO, new Set(["c"]))).toContain("social-quiet:1");
  });
  it("keeps everything when no focus is set", () => {
    expect(itemInFocus(items[2], [])).toBe(true);
  });
  it("leaves Everything else out of the totals and plays it last", () => {
    const rows = [
      { client: "A", tier: "critical" as const, score: 95, topic: "elsewhere" as const },
      { client: "B", tier: "high" as const, score: 70, topic: "accounts" as const },
    ];
    const looks = countLooks(rows);
    expect(looks.total).toBe(1);
    expect(looks.byTier.critical).toBe(0);
    expect(looks.byTopic.elsewhere.n).toBe(1);
    expect(topicGroups(rows).map((g) => g.topic)).toEqual(["accounts", "elsewhere"]);
  });
});

describe("fire rules", () => {
  it("a client saying they're leaving or furious", () => {
    expect(messageFire("Honestly we're going to cancel at the end of the month")).toMatch(/cancel or leave/);
    expect(messageFire("This is completely unacceptable, we're furious")).toMatch(/furious/);
    expect(messageFire("We missed the launch date again, this is not ok")).toMatch(/missed launch/);
    expect(messageFire("Can you send the March invoice?")).toBeNull();
    expect(messageFire("Still waiting on the report, no rush")).toBeNull();
    expect(fireOf({ kind: "client_message", text: "we want to cancel", fromClient: true }).fire).toBe(true);
    // A teammate saying it isn't the client
    expect(fireOf({ kind: "client_message", text: "we want to cancel", fromClient: false }).fire).toBe(false);
  });
  it("only the owner's four: a client leaving is a fire at once; furious alone waits a business day", () => {
    expect(fireOf({ kind: "risk_flag" })).toEqual({ fire: true, why: "said they may cancel or leave" });
    expect(fireOf({ kind: "client_message", text: "This is completely unacceptable, we're furious", fromClient: true }).fire).toBe(false);
  });
  it("an angry client message unanswered for more than one business day", () => {
    expect(fireOf({ kind: "angry_unanswered", text: "This is completely unacceptable", businessHours: 11 }).fire).toBe(true);
    expect(fireOf({ kind: "angry_unanswered", text: "This is completely unacceptable", businessHours: 6 }).fire).toBe(false);
    expect(fireOf({ kind: "angry_unanswered", text: "Can you send the invoice?", businessHours: 40 }).fire).toBe(false);
  });
  it("an ad account disabled, its payment failed or its spend stopped", () => {
    expect(fireOf({ kind: "watch", watchKind: "payment_issue", severity: "critical", line: "facebook-ads" })).toEqual({ fire: true, why: "Meta ad account payment failed" });
    expect(fireOf({ kind: "watch", watchKind: "delivery_issue", severity: "critical", accountStatus: 2, line: "facebook-ads" })).toEqual({ fire: true, why: "Meta ad account disabled" });
    // Risk review or disapproved ads: not a fire
    expect(fireOf({ kind: "watch", watchKind: "delivery_issue", severity: "critical", accountStatus: 7, line: "facebook-ads" }).fire).toBe(false);
    expect(fireOf({ kind: "watch", watchKind: "delivery_issue", severity: "critical", line: "facebook-ads" }).fire).toBe(false);
    expect(fireOf({ kind: "watch", watchKind: "spend_stopped", severity: "critical", spend30: BIG_ACCOUNT_30D, line: "google-ads" })).toEqual({ fire: true, why: "Google spend stopped" });
    // A tiny account going quiet isn't a fire
    expect(fireOf({ kind: "watch", watchKind: "spend_stopped", severity: "critical", dailyAverage: 10, line: "google-ads" }).fire).toBe(false);
    // Nothing else the watch finds is a fire any more
    expect(fireOf({ kind: "watch", watchKind: "idle", severity: "critical", billed: true, line: "facebook-ads" }).fire).toBe(false);
    expect(fireOf({ kind: "watch", watchKind: "overspend", severity: "warn", spend30: 50_000 }).fire).toBe(false);
  });
  it("tracking on its own is no longer a fire", () => {
    expect(fireOf({ kind: "tracking", spend7: 1_500, results7: 0, tracksConversions: true }).fire).toBe(false);
  });
  it("an account off target is never a fire: the lead first, the execs' Accounts later", () => {
    expect(fireOf({ kind: "kpi", deviation: 0.9, days: 30 }).fire).toBe(false);
  });
  it("how far worse a KPI is", () => {
    expect(kpiWorse({ value: 60, target: 40, roas: false })).toBeCloseTo(0.5);
    expect(kpiWorse({ value: 1, target: 4, roas: true })).toBeCloseTo(0.75);
    expect(kpiWorse({ value: null, target: 40, roas: false, results: 0 })).toBe(1);
    expect(kpiWorse({ value: 30, target: 40, roas: false })).toBe(0);
    expect(kpiWorse({ value: 30, target: null, roas: false })).toBeNull();
  });
  it("top spenders: the top fifth and anything big", () => {
    const m = new Map([
      ["a", 50_000],
      ["b", 12_000],
      ["c", 3_000],
      ["d", 2_000],
      ["e", 1_000],
      ["f", 0],
    ]);
    expect([...topSpenders(m)].sort()).toEqual(["a", "b"]);
  });
  it("one line, once per client per day", () => {
    expect(fireTitle("Acme", "said they may cancel or leave")).toBe("Acme is on fire: said they may cancel or leave");
    expect(fireKey("c1", new Date("2026-11-18T15:00:00Z"))).toBe("fire:c1:2026-11-18");
    expect(fireKey("c1", new Date("2026-11-18T23:00:00Z"))).toBe(fireKey("c1", new Date("2026-11-18T14:00:00Z")));
  });
});
