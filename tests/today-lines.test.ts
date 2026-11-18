import { describe, expect, it } from "vitest";
import type { ChannelRow } from "@/lib/channel-kpis/types";
import {
  byRetention,
  contactIsMine,
  contactItem,
  emailOpsItems,
  emailRowItems,
  ideaItem,
  lineScopes,
  needsMe,
  opensBoard,
  reportItem,
  scopeIds,
  socialRowItems,
  type ReportIn,
} from "@/lib/today-lines-core";
import { countLooks, lookChip, lookHeadline, TOPIC_KEYS } from "@/lib/today-counts";

// The email and social side of the daily recap: who gets which line and which clients, which items each seat gets,
// and the day ordered by retention risk.

const person = (role: string, extra: Partial<{ isExec: boolean; isCoordinator: boolean; id: string }> = {}) => ({ id: extra.id ?? "me", role, isExec: false, ...extra });

const row = (over: Partial<ChannelRow>): ChannelRow =>
  ({
    line: "email",
    clientId: "c1",
    name: "Acme",
    slug: "acme",
    kaizenId: null,
    data: "connected",
    problem: null,
    warning: null,
    lastSyncedAt: null,
    account: null,
    currency: "USD",
    target: null,
    targetNote: null,
    targetBy: null,
    targetAt: null,
    canEdit: false,
    canConnect: false,
    mine: true,
    status: "good",
    ratio: null,
    value: null,
    projected: null,
    prev: null,
    basis: "month",
    series: [],
    span: 30,
    quietDays: 2,
    team: [],
    email: null,
    social: null,
    score: null,
    ...over,
  }) as ChannelRow;

describe("who gets which line", () => {
  it("gives an exec both lines on every client", () => {
    const s = lineScopes(person("executive", { isExec: true }), []);
    expect(s.map((x) => x.line)).toEqual(["email", "social"]);
    expect(s.every((x) => x.all)).toBe(true);
    expect(scopeIds(s[0])).toBeNull();
  });

  it("gives each head their own line across every client, and nothing of the other", () => {
    expect(lineScopes(person("head_of_email"), []).map((x) => [x.line, x.all])).toEqual([["email", true]]);
    expect(lineScopes(person("head_of_social"), []).map((x) => [x.line, x.all])).toEqual([["social", true]]);
  });

  it("gives seated people only the clients they hold a seat of that line on", () => {
    const s = lineScopes(person("email_strategist"), [
      { client_id: "a", role: "email_strategist" },
      { client_id: "b", role: "email_designer" },
      { client_id: "c", role: "meta_buyer" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].line).toBe("email");
    expect(s[0].all).toBe(false);
    expect(scopeIds(s[0])?.sort()).toEqual(["a", "b"]);
  });

  it("gives ads people no line unless they hold one of its seats", () => {
    expect(lineScopes(person("media_buyer"), [{ client_id: "a", role: "meta_buyer" }])).toEqual([]);
    expect(lineScopes(person("head_of_meta"), [])).toEqual([]);
    const seated = lineScopes(person("media_buyer"), [{ client_id: "a", role: "email_strategist" }]);
    expect(seated.map((x) => x.line)).toEqual(["email"]);
    // A creative on a client's organic social (also_social) gets that client's social line
    expect(lineScopes(person("graphic_designer"), [{ client_id: "z", role: "social_creative" }]).map((x) => x.line)).toEqual(["social"]);
  });

  it("gives each seat only what it acts on", () => {
    const [s] = lineScopes(person("email_designer"), [{ client_id: "a", role: "email_designer" }]);
    expect(needsMe(s, "email-score", "a")).toBe(false);
    expect(needsMe(s, "email-sprint", "a")).toBe(true);
    expect(needsMe(s, "email-idea", "a")).toBe(true);
    expect(needsMe(s, "email-sprint", "other")).toBe(false);
    const [builder] = lineScopes(person("email_builder"), [{ client_id: "a", role: "email_builder" }]);
    expect(needsMe(builder, "email-quiet", "a")).toBe(true);
    expect(needsMe(builder, "email-connect", "a")).toBe(false);
    const [creative] = lineScopes(person("video_editor"), [{ client_id: "a", role: "social_creative" }]);
    expect(needsMe(creative, "social-quiet", "a")).toBe(true);
    expect(needsMe(creative, "social-target", "a")).toBe(false);
    const [head] = lineScopes(person("head_of_email"), []);
    expect(needsMe(head, "email-score", "anything")).toBe(true);
  });

  it("sends people to the board only on a line they can open it on", () => {
    expect(opensBoard({ role: "email_strategist", isExec: false }, "email")).toBe(true);
    expect(opensBoard({ role: "email_strategist", isExec: false }, "social")).toBe(false);
    expect(opensBoard({ role: "media_buyer", isExec: false }, "email")).toBe(false);
    expect(opensBoard({ role: "executive", isExec: true }, "social")).toBe(true);
  });

  it("puts a contact change on the people who look after the client", () => {
    expect(contactIsMine(person("email_strategist"), ["email_strategist"], false)).toBe(true);
    expect(contactIsMine(person("email_designer"), ["email_designer"], false)).toBe(false);
    expect(contactIsMine(person("head_of_social"), [], true)).toBe(true);
    expect(contactIsMine(person("customer_success", { isCoordinator: true }), [], false)).toBe(true);
    expect(contactIsMine(person("graphic_designer"), ["graphic_designer"], false)).toBe(false);
  });
});

describe("email and social items", () => {
  const ctx = { dayOfMonth: 17, board: true };

  it("flags a red email account as critical and a yellow one below it", () => {
    const red = emailRowItems(row({ score: { score: 31, band: "bad", weighingDown: [{ label: "Flow revenue" }], checks: [], unmeasured: [] } as unknown as ChannelRow["score"] }), ctx);
    expect(red.map((i) => i.kind)).toEqual(["email-score"]);
    expect(red[0].score).toBeGreaterThanOrEqual(80);
    expect(red[0].topic).toBe("email");
    expect(red[0].action.href).toBe("/kpis?p=email&open=c1");
    const yellow = emailRowItems(row({ score: { score: 72, band: "watch", weighingDown: [], checks: [], unmeasured: [] } as unknown as ChannelRow["score"] }), ctx);
    expect(yellow[0].score).toBeLessThan(80);
  });

  it("says when revenue is behind pace, but not in the first days of the month", () => {
    const r = row({ target: 10_000, projected: 6_000, value: 3_400 });
    expect(emailRowItems(r, ctx).map((i) => i.kind)).toEqual(["email-pace"]);
    expect(emailRowItems(r, { ...ctx, dayOfMonth: 2 })).toEqual([]);
    expect(emailRowItems(row({ target: 10_000, projected: 9_500 }), ctx)).toEqual([]);
  });

  it("flags a quiet list, and a connection problem instead of anything else", () => {
    expect(emailRowItems(row({ quietDays: 20 }), ctx).map((i) => i.kind)).toEqual(["email-quiet"]);
    const failing = emailRowItems(row({ data: "failing", quietDays: 40, provider: "klaviyo" }), ctx);
    expect(failing.map((i) => i.kind)).toEqual(["email-connect"]);
    expect(failing[0].score).toBeGreaterThanOrEqual(70);
  });

  it("links someone outside the email team to the client page", () => {
    const r = emailRowItems(row({ quietDays: 20 }), { ...ctx, board: false });
    expect(r[0].action.href).toBe("/clients/acme?service=email");
  });

  it("covers social: off target, a drop, a quiet feed, and not linked", () => {
    const s = (o: Partial<ChannelRow>) => socialRowItems(row({ line: "social", ...o }), ctx).map((i) => i.kind);
    expect(s({ status: "off", ratio: 0.6, value: 0.012, target: 0.02 })).toEqual(["social-target"]);
    expect(s({ status: "good", value: 0.02, prev: 0.04 })).toEqual(["social-drop"]);
    expect(s({ quietDays: 12 })).toEqual(["social-quiet"]);
    expect(s({ data: "missing" })).toEqual(["social-connect"]);
  });

  it("brings up an audit nobody started and a sprint whose moves aren't happening", () => {
    const now = new Date("2026-11-17T15:00:00Z");
    const c = { clientId: "c1", name: "Acme", slug: "acme" };
    const audit = { id: "a1", status: "ready" as const, score: 41, band: "bad" as const, headline: "Flows are thin.", createdAt: "2026-11-10T12:00:00Z", actions: 6, done: 0 };
    expect(emailOpsItems(c, audit, null, now).map((i) => i.key)).toEqual(["email-audit:a1"]);
    // Two days in, or a move ticked: nothing to say
    expect(emailOpsItems(c, { ...audit, createdAt: "2026-11-17T12:00:00Z" }, null, now)).toEqual([]);
    expect(emailOpsItems(c, { ...audit, done: 1 }, null, now)).toEqual([]);
    const sprint = { id: "s1", moves: 5, done: 0, nextCheckAt: "2026-11-16T12:00:00Z", score: 44, baseline: 41 };
    expect(emailOpsItems(c, audit, sprint, now).map((i) => i.key)).toEqual(["email-sprint:s1"]);
    expect(emailOpsItems(c, audit, { ...sprint, nextCheckAt: "2026-11-20T12:00:00Z" }, now)).toEqual([]);
  });

  it("reads the social audits and sprints the same way, with social links", () => {
    const now = new Date("2026-11-17T15:00:00Z");
    const c = { clientId: "c1", name: "Acme", slug: "acme" };
    const audit = { id: "a1", status: "ready" as const, score: 41, band: "bad" as const, headline: "Posting stalled.", createdAt: "2026-11-10T12:00:00Z", actions: 6, done: 0 };
    const [a] = emailOpsItems(c, audit, null, now, "social");
    expect([a.kind, a.key, a.topic, a.action?.href]).toEqual(["social-audit", "social-audit:a1", "social", "/kpis/social-audit/a1"]);
    const sprint = { id: "s1", moves: 5, done: 0, nextCheckAt: "2026-11-16T12:00:00Z", score: 44, baseline: 41 };
    const [s] = emailOpsItems(c, audit, sprint, now, "social");
    expect([s.kind, s.action?.href, s.title]).toEqual(["social-sprint", "/kpis/social-sprint/s1", "Acme's social sprint is due a check with moves still open"]);
  });

  it("brings up a red or yellow social score, naming the platform that drags it", () => {
    const ctx = { dayOfMonth: 17, board: true };
    const drag = { key: "engagement" as const, label: "Engagement rate", value: 0.01, bar: 0.035, weight: 30, points: 8.6, met: false, unit: "pct" as const, platform: "instagram" as const, cost: 21 };
    const socialScore = { score: 48, band: "bad" as const, platforms: [], checks: [], weighingDown: [drag], unmeasured: [], promised: { perMonth: 12, fromPackage: false }, window: { from: "2026-10-19", to: "2026-11-17" } };
    const items = socialRowItems(row({ line: "social", socialScore }), ctx);
    expect(items.map((i) => i.kind)).toEqual(["social-score"]);
    expect(items[0].story).toContain("Instagram engagement rate");
    expect(socialRowItems(row({ line: "social", socialScore: { ...socialScore, score: 85, band: "good" } }), ctx)).toEqual([]);
  });

  it("gathers a client's campaign ideas into one calm item", () => {
    const c = { clientId: "c1", name: "Acme", slug: "acme" };
    const i = ideaItem(c, [
      { id: "1", title: "Later", idea: "x", why: null, sendOn: "2026-12-20" },
      { id: "2", title: "Soon", idea: "y", why: null, sendOn: "2026-11-20" },
    ], "2026-11-17");
    expect(i?.title).toBe("Soon");
    expect(i?.score).toBeLessThan(60);
    expect(i?.stat.value).toBe("2");
    expect(ideaItem(c, [], "2026-11-17")).toBeNull();
  });

  it("gives a report to its owner, and to the head or an exec only once it's late", () => {
    const r: ReportIn = { id: "r1", clientId: "c1", client: "Acme", slug: "acme", line: "email", kind: "weekly", status: "draft", ownerId: "owner", periodEnd: "2026-11-15", viewedAt: null };
    const [strategist] = lineScopes(person("email_strategist", { id: "owner" }), [{ client_id: "c1", role: "email_strategist" }]);
    expect(reportItem(r, person("email_strategist", { id: "owner" }), strategist, "2026-11-17")?.key).toBe("report:r1");
    const [head] = lineScopes(person("head_of_email", { id: "head" }), []);
    expect(reportItem(r, person("head_of_email", { id: "head" }), head, "2026-11-17")).toBeNull();
    expect(reportItem(r, person("head_of_email", { id: "head" }), head, "2026-11-22")?.why).toBe("Not sent by its owner");
    const [designer] = lineScopes(person("email_designer", { id: "d" }), [{ client_id: "c1", role: "email_designer" }]);
    expect(reportItem(r, person("email_designer", { id: "d" }), designer, "2026-11-30")).toBeNull();
  });

  it("puts a contact change in Waiting on us", () => {
    const i = contactItem({ id: "x", clientId: "c1", client: "Acme", slug: "acme", fromName: "Pat", fromEmail: "pat@acme.com", receivedAt: "2026-11-15T12:00:00Z", quote: "Please take Sam off", why: null, pending: 1 }, new Date("2026-11-17T12:00:00Z"));
    expect(i.topic).toBe("promises");
    expect(i.key).toBe("contact:x");
    expect(i.score).toBeGreaterThanOrEqual(70);
  });
});

describe("ordering by retention risk", () => {
  const item = (key: string, topic: "accounts" | "email" | "social" | "briefs" | "promises", score: number, clientId: string | null, client = clientId ?? "Team") => ({ key, topic, score, clientId, client });

  it("moves a client in trouble on several fronts above one in trouble on one", () => {
    const out = byRetention([item("kpi:1", "accounts", 70, "solo"), item("kpi:2", "accounts", 68, "multi"), item("email-score:multi", "email", 68, "multi"), item("social-quiet:multi", "social", 62, "multi")]);
    expect(out[0].clientId).toBe("multi");
    // Three fronts: +6 at most
    expect(out.find((i) => i.key === "kpi:2")?.score).toBe(74);
    expect(out.find((i) => i.key === "kpi:1")?.score).toBe(70);
  });

  it("leaves ideas and teammates' items where they are, and sorts most pressing first", () => {
    const out = byRetention([item("brief:1", "briefs", 52, "multi"), item("kpi:2", "accounts", 66, "multi"), item("email-score:multi", "email", 72, "multi"), item("owed:1", "promises", 80, null)]);
    expect(out.find((i) => i.key === "brief:1")?.score).toBe(52);
    expect(out.find((i) => i.key === "owed:1")?.score).toBe(80);
    expect(out.map((i) => i.score)).toEqual([...out.map((i) => i.score)].sort((a, b) => b - a));
  });

  it("never pushes past 98", () => {
    const out = byRetention([item("a", "accounts", 97, "x"), item("b", "email", 97, "x")]);
    expect(Math.max(...out.map((i) => i.score))).toBe(98);
  });
});

describe("the recap's counts know the new topics", () => {
  it("counts email and social like any topic", () => {
    expect(TOPIC_KEYS).toContain("email");
    expect(TOPIC_KEYS).toContain("social");
    const looks = countLooks([
      { client: "Acme", tier: "critical", score: 82, topic: "email" },
      { client: "Acme", tier: "high", score: 64, topic: "email" },
      { client: "Bolt", tier: "normal", score: 52, topic: "social" },
    ]);
    expect(looks.byTopic.email).toEqual({ n: 1, critical: 1 });
    expect(looks.byTopic.social).toEqual({ n: 1, critical: 0 });
    expect(lookChip("email", 2)).toBe("2 email clients to look at");
    expect(lookHeadline("social", 1)).toMatch(/^1 social client needs a look/);
  });
});
