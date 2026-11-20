import { describe, expect, it } from "vitest";
import {
  actorOf,
  budgetPace,
  combineConversions,
  composeMessage,
  mention,
  mentionIssues,
  moneyIssues,
  needsSignoff,
  redactMoney,
  reviewLinesFor,
  riskScore,
  routeTo,
  slackIssues,
  statusIssues,
  todosFor,
  unapprovedChanges,
  weekStartOf,
  isHumanAuthor,
  type Review,
  type Teammate,
} from "@/lib/line-review/core";

const team: Teammate[] = [
  { id: "a", full_name: "Ana Active", is_active: true, slack_user_id: "U0ACTIVE1" },
  { id: "b", full_name: "Ben Gone", is_active: false, slack_user_id: "U0GONE001" },
  { id: "c", full_name: "Cam Noslack", is_active: true, slack_user_id: null },
];

describe("which reviews run", () => {
  it("skips archived, paused and offboarded clients", () => {
    expect(reviewLinesFor({ status: "active", archived_at: "2026-11-01", services: ["facebook-ads"] })).toEqual([]);
    expect(reviewLinesFor({ status: "paused", services: ["facebook-ads"] })).toEqual([]);
    expect(reviewLinesFor({ status: "offboarded", services: ["facebook-ads"] })).toEqual([]);
  });
  it("one review per line bought, TikTok under Meta, a removed service skipped", () => {
    const lines = reviewLinesFor({ status: "active", services: ["tiktok-ads", "google-ads", "email-marketing"], services_removed: ["google-ads"] });
    expect(lines.map((l) => l.line)).toEqual(["meta", "email"]);
  });
  it("email-only clients still get their (internal) email review; strategy only is marked", () => {
    expect(reviewLinesFor({ status: "onboarding", services: ["email-marketing"], strategy_only: ["email-marketing"] })).toEqual([{ line: "email", strategyOnly: true }]);
  });
  it("weeks start on Monday", () => {
    expect(weekStartOf("2026-11-23")).toBe("2026-11-23");
    expect(weekStartOf("2026-11-22")).toBe("2026-11-16");
    expect(weekStartOf("2026-11-20")).toBe("2026-11-16");
  });
});

describe("money never reaches Slack", () => {
  it("flags fees, retainer, invoices and Stripe", () => {
    expect(moneyIssues("Their retainer is $3,500 a month")).toHaveLength(1);
    expect(moneyIssues("Invoice #1024 is unpaid")).toHaveLength(1);
    expect(moneyIssues("Stripe shows a failed charge")).toHaveLength(1);
    expect(moneyIssues("They pay us a $2k fee for Google")).toHaveLength(1);
    expect(moneyIssues("Billed $1,200 for email this month")).toHaveLength(1);
  });
  it("keeps ad spend and budgets", () => {
    expect(moneyIssues("Meta: $4,200 spent of $5,000 budget")).toEqual([]);
    expect(moneyIssues("CPA $42 vs target $35")).toEqual([]);
    expect(moneyIssues("Ad account payment method failing, $300 spend stuck at the billing threshold")).toEqual([]);
  });
  it("redacts the offending lines only", () => {
    expect(redactMoney("Spend $900 of $1,000\nRetainer $3k overdue\nCall them")).toBe("Spend $900 of $1,000\nCall them");
  });
});

describe("people", () => {
  it("mentions only active teammates with a real Slack id", () => {
    expect(mention(team[0])).toBe("<@U0ACTIVE1>");
    expect(mention(team[1])).toBeNull();
    expect(mention(team[2])).toBe("Cam");
    expect(mention({ id: "x", full_name: "X", is_active: true, slack_user_id: "@cam" })).toBe("X");
  });
  it("a departed owner's items go to the current seat holder", () => {
    expect(routeTo(team[1], [team[1], team[0]])?.id).toBe("a");
    expect(routeTo(team[1], [team[1]])).toBeNull();
    expect(routeTo(team[2], [team[0]])?.id).toBe("c");
  });
  it("catches departed and unknown mentions", () => {
    expect(mentionIssues("<@U0GONE001> please fix", team)[0]).toMatch(/left the team/);
    expect(mentionIssues("<@U0NOBODY1> hi", team)[0]).toMatch(/isn't anyone/);
    expect(mentionIssues("@Ben can you", team)[0]).toMatch(/left the team/);
    expect(mentionIssues("<@U0ACTIVE1> on it", team)).toEqual([]);
  });
});

describe("status", () => {
  it("never calls a live client cancelled or churned", () => {
    expect(statusIssues("They cancelled last week", "active")).toHaveLength(1);
    expect(statusIssues("churning risk", "onboarding")).toHaveLength(1);
    expect(statusIssues("They cancelled", "offboarded")).toEqual([]);
    expect(statusIssues("Cancel the Halloween ads", "active")).toEqual([]);
  });
  it("slackIssues adds every rule", () => {
    expect(slackIssues("<@U0GONE001> they churned, retainer $2k", { status: "active", team })).toHaveLength(3);
  });
});

describe("budget pace", () => {
  it("over by more than 20% on projection", () => {
    const p = budgetPace({ spent: 750, budget: 1000, day: 15, daysInMonth: 30 })!;
    expect(p.projected).toBe(1500);
    expect(p.over).toBe(true);
    expect(Math.round(p.pacePct * 100)).toBe(50);
  });
  it("on pace is not over", () => {
    expect(budgetPace({ spent: 500, budget: 1000, day: 15, daysInMonth: 30 })!.over).toBe(false);
    expect(budgetPace({ spent: 590, budget: 1000, day: 15, daysInMonth: 30 })!.over).toBe(false);
  });
  it("no budget on file: nothing", () => {
    expect(budgetPace({ spent: 500, budget: null, day: 15, daysInMonth: 30 })).toBeNull();
  });
});

describe("conversions never double count", () => {
  it("does not add Meta and Google purchases", () => {
    const c = combineConversions(
      [
        { platform: "meta", conversion: "purchase", results: 40 },
        { platform: "google", conversion: "purchases", results: 30 },
      ],
      null,
    );
    expect(c.total).toBeNull();
    expect(c.confidence).toBe("guessing");
    expect(c.note).toMatch(/not added together/);
  });
  it("the store wins when connected", () => {
    expect(combineConversions([{ platform: "meta", conversion: "purchase", results: 40 }], { orders: 52 })).toMatchObject({ total: 52, confidence: "certain", from: "store" });
  });
  it("one platform is likely", () => {
    expect(combineConversions([{ platform: "meta", conversion: "purchase", results: 40 }], null)).toMatchObject({ total: 40, confidence: "likely" });
  });
});

describe("change history", () => {
  const ctx = { team: [{ id: "a", full_name: "Ana Active" }], contactNames: new Set(["pat client"]), contactDomains: new Set(["shop.com"]), clientName: "Shop" };
  it("tells us from the client", () => {
    expect(actorOf("Ana Active", ctx)).toBe("us");
    expect(actorOf("x@kaizenmarketing.agency", ctx)).toBe("us");
    expect(actorOf("Pat Client", ctx)).toBe("client");
    expect(actorOf("owner@shop.com", ctx)).toBe("client");
    expect(actorOf("Some Stranger", ctx)).toBe("unknown");
    expect(actorOf("Automated rule", ctx)).toBe("automated");
  });
  it("our budget moves without the client's yes, when they need sign-off", () => {
    const changes = [
      { at: "2026-11-18T15:00:00Z", who: "Ana", what: "Daily budget changed", object: "AS1", actor: "us" as const },
      { at: "2026-11-19T15:00:00Z", who: "Ana", what: "Ad name changed", object: "A1", actor: "us" as const },
      { at: "2026-11-20T15:00:00Z", who: "Ana", what: "Targeting updated", object: "AS2", actor: "us" as const },
    ];
    const notes = ["Client wants to approve budget changes before we make them"];
    expect(needsSignoff(notes)).toBe(true);
    const out = unapprovedChanges(changes, { needsSignoff: true, clientMessages: [{ at: "2026-11-20T12:00:00Z", text: "Sounds good, go ahead" }] });
    expect(out.map((c) => c.object)).toEqual(["AS1"]);
    expect(unapprovedChanges(changes, { needsSignoff: false, clientMessages: [] })).toEqual([]);
  });
  it("bots aren't human updates", () => {
    expect(isHumanAuthor("Kaizen OS")).toBe(false);
    expect(isHumanAuthor("Mali Palazzi")).toBe(true);
  });
});

describe("the message", () => {
  const base: Review = {
    v: 1,
    client: { id: "c", name: "Shop", slug: "shop", status: "active" },
    line: "meta",
    strategyOnly: false,
    period: { from: "2026-11-16", to: "2026-11-22" },
    owner: { id: "a", name: "Ana Active", slackMention: "<@U0ACTIVE1>" },
    scope: { services: ["Meta Ads"], tiers: [], delivered: [{ text: "2 launches", confidence: "certain" }], promised: [] },
    budget: [{ ...budgetPace({ spent: 750, budget: 1000, day: 15, daysInMonth: 30 })!, account: "1", platform: "meta", confidence: "certain" }],
    changes: { total: 3, ours: 2, client: 1, unknown: 0, clientPauses: [{ text: "Client: paused Campaign X", confidence: "certain" }], unapproved: [], notable: [], readable: true },
    commitments: [{ text: "Send the new audiences", confidence: "certain", who: "<@U0ACTIVE1>", due: "Nov 18" }],
    results: [],
    conversions: null,
    health: { internalSilent: 1, clientSilent: 6, atRisk: null, blockers: [], hasInternalChannel: true },
    todos: [],
    risk: 0,
  };
  it("is clean by every rule and tags confidence", () => {
    const r = { ...base, todos: todosFor(base) };
    const text = composeMessage(r);
    expect(slackIssues(text, { status: "active", team })).toEqual([]);
    expect(text).toMatch(/_\(certain\)_/);
    expect(text).toMatch(/on course for \$1,500/);
    expect(r.todos.some((t) => /client channel/.test(t))).toBe(true);
  });
  it("worse accounts score higher", () => {
    expect(riskScore({ ...base, health: { ...base.health, atRisk: "said Nov 18" } })).toBeGreaterThan(riskScore(base));
  });
});
