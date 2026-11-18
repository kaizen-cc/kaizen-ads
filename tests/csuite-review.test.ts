import { describe, expect, it } from "vitest";
import { criticality, creativeChip, diagnose, packageWeight, portfolioOf, scorecard, sizeWeight, sortClients, toneOf, type DayNumbers, type LineKpi } from "@/lib/clients-kpi/core";
import { foldMatch, foldText } from "@/lib/search-fold";
import { askedAbout, billingGaps, mark, progress, shortReason, upsellsFor, type UpsellInput } from "@/lib/csuite/core";
import { cleanDraftText, composeLinks, draftKey, parseDraftItems, pickOwner } from "@/lib/email-drafts/core";

const line = (l: LineKpi["line"], health: number | null, extra: Partial<LineKpi> = {}): LineKpi => ({ line: l, label: l, shown: String(health), tone: toneOf(health), health, spend: null, reasons: [], href: "/kpis", ...extra });
const client = (name: string, kpis: LineKpi[], atRisk = false) => ({ id: name, name, kpis, atRisk });

describe("criticality weighs business size", () => {
  // Health 0 is a 100% swing; health ~67 is about 10% over target
  const tiny = client("Tiny", [line("meta", 0, { spend: 300 })]);
  const big = client("Big", [line("meta", 67, { spend: 40_000, revenue: 160_000 })]);
  const mid = client("Mid", [line("meta", 50, { spend: 4_000 })]);
  const book = portfolioOf([tiny, big, mid]);

  it("a 10% miss on a big account outranks a 100% miss on a tiny one", () => {
    expect(sortClients([tiny, big, mid], "critical", null, book).map((c) => c.name).indexOf("Big")).toBeLessThan(sortClients([tiny, big, mid], "critical", null, book).map((c) => c.name).indexOf("Tiny"));
    const t = criticality(tiny.kpis, { size: sizeWeight({ spend: 300, revenue: 0 }, book) })!;
    const b = criticality(big.kpis, { size: sizeWeight({ spend: 40_000, revenue: 160_000 }, book) })!;
    expect(b).toBeGreaterThan(t);
  });
  it("the typical client keeps its weight, sizes are bounded, unknown size is typical", () => {
    expect(sizeWeight({ spend: 4_000, revenue: 0 }, book)).toBe(1);
    expect(sizeWeight({ spend: 1, revenue: 0 }, book)).toBe(0.25);
    expect(sizeWeight({ spend: 10_000_000, revenue: 0 }, book)).toBe(3);
    expect(sizeWeight({ spend: 0, revenue: 0 }, book)).toBe(1);
    expect(sizeWeight({ spend: 100, revenue: 0 }, null)).toBe(1);
  });
  it("revenue counts as size too", () => {
    const p = { spend: 1000, revenue: 10_000 };
    expect(sizeWeight({ spend: 100, revenue: 90_000 }, p)).toBe(3);
  });
  it("inside a client, a line with a sliver of the spend counts less", () => {
    const heavyOff = criticality([line("meta", 20, { spend: 9_000 }), line("google", 90, { spend: 1_000 })])!;
    const lightOff = criticality([line("meta", 90, { spend: 9_000 }), line("google", 20, { spend: 1_000 })])!;
    expect(heavyOff).toBeGreaterThan(lightOff);
  });
  it("a line's weight (creative package size) scales its severity", () => {
    expect(criticality([line("creative", 30, { weight: 1.5 })])!).toBeGreaterThan(criticality([line("creative", 30, { weight: 0.5 })])!);
  });
});

describe("the scorecard", () => {
  it("counts the success ratio, the red and each line", () => {
    const cards = [client("A", [line("meta", 90, { trend: "improving" }), line("email", 85)]), client("B", [line("meta", 30, { trend: "slipping" })]), client("C", [line("google", 70)]), client("D", [])];
    const s = scorecard(cards);
    expect(s.linesOn).toBe(2);
    expect(s.linesJudged).toBe(4);
    expect(s.lineRatio).toBe(0.5);
    expect(s.clientsOn).toBe(1);
    expect(s.clientsJudged).toBe(3);
    expect(s.inRed).toBe(1);
    expect(s.lines.find((l) => l.line === "meta")).toMatchObject({ on: 1, off: 1, improving: 1, slipping: 1 });
    expect(s.highPriority.map((h) => h.name)).toEqual(["B"]);
  });
  it("reads pace as the typical account, so a mistyped budget can't swing the line", () => {
    const cards = [client("A", [line("meta", 90, { pace: 0.95, spend: 100 })]), client("B", [line("meta", 80, { pace: 1.05, spend: 200 })]), client("C", [line("meta", 70, { pace: 1.0, spend: 50 })]), client("Typo", [line("meta", 60, { pace: 82, spend: 90_000 })])];
    const meta = scorecard(cards).lines.find((l) => l.line === "meta")!;
    expect(meta.pace).toBe(1);
    expect(meta.paced).toBe(3);
    expect(meta).toMatchObject({ paceOver: 0, paceUnder: 0 });
  });
  it("leaves pace out when nothing paces", () => {
    expect(scorecard([client("A", [line("tiktok", null)])]).lines[0]).toMatchObject({ judged: 0, pace: null, paced: 0 });
  });
});

describe("a high-priority reason on one line", () => {
  it("drops the Audit prefix and keeps the first sentence", () => {
    expect(shortReason("Meta: Audit: Spend rose 40% while purchases fell. The new campaign is eating the budget and needs cutting back")).toBe("Meta: Spend rose 40% while purchases fell");
  });
  it("cuts a long clause at a word", () => {
    const r = shortReason("Email: revenue per recipient is well under the bar across every campaign sent in the last thirty days and the flows too", 60);
    expect(r.length).toBeLessThanOrEqual(61);
    expect(r.endsWith("…")).toBe(true);
    expect(r.startsWith("Email: Revenue per recipient")).toBe(true);
  });
  it("leaves a short reason alone", () => {
    expect(shortReason("Google: Spend is pacing 30% under budget")).toBe("Google: Spend is pacing 30% under budget");
  });
});

describe("search ignores accents and punctuation", () => {
  it("folds names", () => {
    expect(foldText("Café Diario")).toBe("cafe diario");
    expect(foldText("J.J.'s Pizzería & Co")).toBe("j j s pizzeria and co");
  });
  it("matches what people type", () => {
    expect(foldMatch("Café Diario", "cafe")).toBe(true);
    expect(foldMatch("Café Diario", "CAFÉ di")).toBe(true);
    expect(foldMatch("Ocean Box", "oceanbox")).toBe(true);
    expect(foldMatch("J.J.'s Pizzería", "jjs pizz")).toBe(true);
    expect(foldMatch("Müller Haus", "muller")).toBe(true);
    expect(foldMatch("Café Diario", "tea")).toBe(false);
    expect(foldMatch("Anything", "  ")).toBe(true);
  });
});

describe("upsell rules", () => {
  const base: UpsellInput = { clientId: "c1", name: "Sierra", services: ["facebook-ads"], industry: "ecommerce", kpis: [line("meta", 92, { shown: "$30 / $40" })] };
  it("beating Meta without Google offers Google, with why", () => {
    const u = upsellsFor(base);
    expect(u.map((x) => x.service)).toContain("google-ads");
    expect(u.find((x) => x.service === "google-ads")!.why[0]).toContain("Meta is beating its target");
  });
  it("industry fit: e-commerce gets email and TikTok, a law firm doesn't", () => {
    expect(upsellsFor(base).map((x) => x.service)).toEqual(expect.arrayContaining(["email-marketing", "tiktok-ads"]));
    const legal = upsellsFor({ ...base, industry: "legal" }).map((x) => x.service);
    expect(legal).not.toContain("email-marketing");
    expect(legal).not.toContain("tiktok-ads");
  });
  it("never offers what they buy, and nothing when no line wins", () => {
    expect(upsellsFor({ ...base, services: ["facebook-ads", "google-ads", "email-marketing", "tiktok-ads", "creative"] })).toEqual([]);
    expect(upsellsFor({ ...base, kpis: [line("meta", 40)] })).toEqual([]);
  });
  it("growing spend suggests creative", () => {
    expect(upsellsFor({ ...base, services: ["facebook-ads", "google-ads", "email-marketing", "tiktok-ads"], spendGrowth: 0.4 }).find((x) => x.service === "creative")!.why.some((w) => /up 40%/.test(w))).toBe(true);
  });
  it("a question from the client is the strongest case and leads the reasons", () => {
    const u = upsellsFor({ ...base, kpis: [], industry: "legal", said: [{ text: "They said they'd love help with email marketing next quarter.", source: "the Nov 12 call" }] });
    expect(u[0].service).toBe("email-marketing");
    expect(u[0].why[0]).toMatch(/They asked about it \(the Nov 12 call\)/);
  });
  it("a passing mention without interest isn't a question", () => {
    expect(askedAbout([{ text: "Google changed its algorithm last week.", source: "x" }])).toEqual([]);
    expect(askedAbout([{ text: "Are you able to run TikTok for us?", source: "x" }]).map((a) => a.service)).toEqual(["tiktok-ads"]);
  });
  it("conversion rate down with good traffic offers the landing page", () => {
    const k = [line("meta", 40, { reasons: [{ tone: "down", text: "Core issue: conversion rate down 30% while click-through holds. The traffic looks good, so the fix is a website or landing page update" }] })];
    expect(upsellsFor({ ...base, kpis: k }).map((x) => x.service)).toContain("web-design");
  });
  it("billing gaps", () => {
    expect(billingGaps(["facebook-ads", "creative"], [{ service: "google-ads", amount: 875, last: null }, { service: "facebook-ads", amount: 1000, last: null }])).toEqual({ unlisted: ["google-ads"], unbilled: ["creative"] });
    expect(billingGaps(["facebook-ads"], null)).toEqual({ unlisted: [], unbilled: [] });
  });
  it("meeting marks and progress", () => {
    let m = mark({}, "critical:a", "done");
    m = mark(m, "critical:b", "discuss", "check budget");
    expect(m["critical:b"].note).toBe("check budget");
    const p = progress({ scorecard: [], critical: ["critical:a", "critical:b"], issues: [], upsell: [], financial: [], todos: [] }, m);
    expect(p).toMatchObject({ done: 1, total: 2 });
    expect(mark(m, "critical:a", null)["critical:a"]).toBeUndefined();
  });
});

describe("email draft extraction", () => {
  it("parses the AI's answer in its shapes and drops what's incomplete", () => {
    const raw = { items: [{ kind: "promise", subject: "Your new landing page", body: "Hi Sam — the new page is live.\n\nTake a look and tell us what you think.", reason: "Promised on the Nov 12 call", source_kind: "commitment", source_id: "abc", line: "ads" }, { kind: "upsell", subject: "", body: "x" }, { kind: "weird", subject: "Quick note", body: "A body that is long enough to keep.", line: "nope" }] };
    const items = parseDraftItems(raw);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "promise", sourceKind: "commitment", sourceId: "abc", line: "ads" });
    expect(items[0].body).not.toMatch(/[—–]/);
    expect(items[1]).toMatchObject({ kind: "other", sourceKind: "call", line: "account" });
    expect(parseDraftItems("```json\n" + JSON.stringify(raw) + "\n```")).toHaveLength(2);
    expect(parseDraftItems(JSON.stringify(raw.items))).toHaveLength(2);
    expect(parseDraftItems("not json at all")).toEqual([]);
    expect(parseDraftItems(null)).toEqual([]);
  });
  it("cleans dashes and markdown", () => {
    expect(cleanDraftText("**Hi** — there\n\n\n\nbye")).toBe("Hi, there\n\nbye");
  });
  it("the same item keys the same, so it isn't drafted twice", () => {
    const d = { kind: "promise" as const, sourceKind: "commitment" as const, sourceId: "abc", subject: "Your page" };
    expect(draftKey("c1", d)).toBe(draftKey("c1", { ...d, subject: "Different words" }));
    expect(draftKey("c1", { ...d, sourceId: null })).not.toBe(draftKey("c1", { ...d, sourceId: null, subject: "Another thing entirely" }));
  });
  it("picks who sends it", () => {
    expect(pickOwner({ line: "email", speakerId: "host", seats: { email_strategist: "es" } })).toBe("host");
    expect(pickOwner({ line: "email", seats: { email_strategist: "es", meta_buyer: "mb" } })).toBe("es");
    expect(pickOwner({ line: "google", seats: { meta_buyer: "mb" } })).toBe("mb");
    expect(pickOwner({ line: "social", seats: {}, fallbackId: "me" })).toBe("me");
  });
  it("compose links carry the draft", () => {
    const l = composeLinks({ to: ["a@b.co", "bad"], subject: "Hi there", body: "Line one" });
    expect(l.mailto).toContain("mailto:a@b.co?");
    expect(l.gmail).toContain("su=Hi%20there");
  });
});

describe("the diagnosis tree", () => {
  const span = (from: string, n: number, f: () => Omit<DayNumbers, "date" | "campaign">): DayNumbers[] =>
    Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(`${from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), campaign: "Main", ...f() }));
  const before = span("2026-10-21", 14, () => ({ spend: 100, impressions: 10_000, linkClicks: 200, results: 10 }));
  it("conversion rate down with click-through holding: fix the site", () => {
    const d = diagnose([...before, ...span("2026-11-04", 14, () => ({ spend: 100, impressions: 10_000, linkClicks: 200, results: 5 }))], "2026-11-18")!;
    expect(d.issue).toBe("cvr");
    expect(d.trafficGood).toBe(true);
    expect(d.text).toMatch(/website or landing page update/);
  });
  it("conversion rate down with click-through down too: check traffic first", () => {
    const d = diagnose([...before, ...span("2026-11-04", 14, () => ({ spend: 100, impressions: 10_000, linkClicks: 170, results: 4 }))], "2026-11-18")!;
    expect(d.issue).toBe("cvr");
    expect(d.text).toMatch(/Confirm traffic quality first/);
  });
  it("click-through down: competitive analysis", () => {
    expect(diagnose([...before, ...span("2026-11-04", 14, () => ({ spend: 100, impressions: 10_000, linkClicks: 120, results: 6 }))], "2026-11-18")!.text).toMatch(/competitive analysis/);
  });
  it("CPM up: audience, frequency, seasonality, creative", () => {
    const d = diagnose([...before, ...span("2026-11-04", 14, () => ({ spend: 140, impressions: 10_000, linkClicks: 200, results: 10 }))], "2026-11-18")!;
    expect(d.issue).toBe("cpm");
    expect(d.text).toMatch(/audience size, frequency, seasonality and creative quality/);
  });
  it("nothing to say when nothing moved or there's no before", () => {
    expect(diagnose([...before, ...span("2026-11-04", 14, () => ({ spend: 100, impressions: 10_000, linkClicks: 200, results: 10 }))], "2026-11-18")).toBeNull();
    expect(diagnose(span("2026-11-04", 14, () => ({ spend: 100, impressions: 10_000, linkClicks: 200, results: 10 })), "2026-11-18")).toBeNull();
  });
});

describe("the creative chip", () => {
  const base = { images: { cap: 4, used: 0 }, videos: { cap: 2, used: 0 }, cycle: { start: "2026-11-01", end: "2026-12-01" }, oldestOpenDays: 12, lastDelivered: "2026-11-10", href: "/clients/x?service=creative" };
  it("on pace is green", () => {
    const c = creativeChip({ ...base, images: { cap: 4, used: 3 }, videos: { cap: 2, used: 1 }, today: "2026-11-16" })!;
    expect(c).toMatchObject({ line: "creative", tone: "good" });
    expect(c.shown).toBe("Creative · 4/6 on pace");
  });
  it("a little behind mid-cycle is yellow", () => {
    expect(creativeChip({ ...base, images: { cap: 4, used: 2 }, today: "2026-11-16" })!).toMatchObject({ tone: "watch", shown: "Creative · 2/6 behind" });
  });
  it("well behind with few days left is red, and says why", () => {
    const c = creativeChip({ ...base, images: { cap: 4, used: 1 }, today: "2026-11-26" })!;
    expect(c.tone).toBe("bad");
    const text = c.reasons.map((r) => r.text).join(" | ");
    expect(text).toMatch(/1 delivered against 5 due by today/);
    expect(text).toMatch(/5 days left in the cycle/);
    expect(text).toMatch(/Oldest open request has waited 12 days/);
    expect(text).toMatch(/Last delivery Nov 10/);
  });
  it("over the allotment is amber and not judged", () => {
    expect(creativeChip({ ...base, images: { cap: 4, used: 6 }, videos: { cap: 2, used: 2 }, today: "2026-11-16" })!).toMatchObject({ tone: "watch", health: null, shown: "Creative · 8/6 over" });
  });
  it("early in the cycle nobody is behind; no package, no chip; weight follows package size", () => {
    expect(creativeChip({ ...base, today: "2026-11-02" })!.tone).toBe("good");
    expect(creativeChip({ ...base, images: { cap: null, used: 0 }, videos: { cap: 0, used: 0 }, today: "2026-11-16" })).toBeNull();
    expect(packageWeight(6)).toBe(1);
    expect(packageWeight(24)).toBe(1.5);
    expect(packageWeight(2)).toBeLessThan(1);
  });
});
