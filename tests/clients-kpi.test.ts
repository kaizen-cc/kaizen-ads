import { describe, expect, it } from "vitest";
import { emailScore } from "@/lib/email-score";
import {
  adChip,
  adHealth,
  adReasons,
  allowedKpiLines,
  criticality,
  dataReasons,
  emailReasons,
  overallHealth,
  passesKpiFilter,
  scoreChip,
  socialReasons,
  sortClients,
  summarize,
  summaryText,
  toneOf,
  topReasons,
  type DayNumbers,
  type LineKpi,
} from "@/lib/clients-kpi/core";
import { socialScore } from "@/lib/social-score";

const line = (l: LineKpi["line"], health: number | null, extra: Partial<LineKpi> = {}): LineKpi => ({ line: l, label: l, shown: String(health), tone: toneOf(health), health, spend: null, reasons: [], href: "/kpis", ...extra });
const client = (name: string, kpis: LineKpi[], atRisk = false) => ({ id: name, name, kpis, atRisk });

describe("ad health follows the KPI bands", () => {
  it("maps deviation onto the bands: 100 at 20% under, 80 on target, 60 where off target starts", () => {
    expect(adHealth(-0.3)).toBe(100);
    expect(adHealth(0)).toBe(80);
    expect(adHealth(0.15)).toBe(60);
    expect(adHealth(1)).toBe(0);
    expect(adHealth(0.5)).toBe(15);
    expect(adHealth(null)).toBeNull();
  });
  it("colours by the status the board shows", () => {
    const base = { line: "meta" as const, conversion: "purchases", roas: false, target: 35, d14: { spend: 1000, results: 24, value: 42 }, href: "/kpis?target=1", reasons: [] };
    expect(adChip({ ...base, status: "off", deviation: 0.2 })).toMatchObject({ tone: "bad", shown: "$42 / $35", label: "CPA" });
    expect(adChip({ ...base, status: "close", deviation: 0.05 }).tone).toBe("watch");
    expect(adChip({ ...base, status: "good", deviation: -0.1 }).tone).toBe("good");
    expect(adChip({ ...base, status: "unset", deviation: null })).toMatchObject({ tone: "none", health: null });
    expect(adChip({ ...base, status: "idle", deviation: null }).health).toBeNull();
  });
  it("shows a ROAS KPI as a multiple", () => {
    const c = adChip({ line: "meta", conversion: "roas", roas: true, target: 3, status: "off", deviation: 0.3, d14: { spend: 1000, results: 10, value: 2.1 }, href: "/x", reasons: [] });
    expect(c.shown).toBe("2.10x / 3.00x");
    expect(c.label).toBe("ROAS");
  });
  it("never judges a Google ROAS whose conversion value is a default of 1 per conversion", () => {
    const c = adChip({ line: "google", conversion: "google_roas", roas: true, target: 4, status: "off", deviation: 0.5, d14: { spend: 1000, results: 600, value: 0.6, revenue: 600 }, href: "/x", reasons: [] });
    expect(c.health).toBeNull();
    expect(c.tone).toBe("none");
    expect(c.shown).toContain("value not tracked");
    const real = adChip({ line: "google", conversion: "google_roas", roas: true, target: 4, status: "off", deviation: 0.5, d14: { spend: 1000, results: 20, value: 2, revenue: 2000 }, href: "/x", reasons: [] });
    expect(real.tone).toBe("bad");
  });
});

describe("cross-line criticality", () => {
  it("is nothing for healthy lines and null when nothing can be judged", () => {
    expect(criticality([line("meta", 90), line("email", 85)])).toBe(0);
    expect(criticality([line("meta", null)])).toBeNull();
    expect(criticality([])).toBeNull();
  });
  it("grows with how far off, and the worst line leads", () => {
    const a = criticality([line("meta", 50)])!;
    const b = criticality([line("meta", 10)])!;
    expect(b).toBeGreaterThan(a);
    expect(criticality([line("meta", 50), line("email", 90)])).toBe(a);
  });
  it("counts a second line off target, at less weight than the first", () => {
    const one = criticality([line("meta", 30)])!;
    const two = criticality([line("meta", 30), line("email", 30)])!;
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(one * 2);
  });
  it("is lifted by retention risk and by the spend at stake", () => {
    const base = criticality([line("meta", 30)])!;
    expect(criticality([line("meta", 30)], { atRisk: true })!).toBeGreaterThan(base);
    expect(criticality([line("meta", 30, { spend: 50_000 })])!).toBeGreaterThan(base);
    // Risk with nothing off target adds nothing
    expect(criticality([line("meta", 95)], { atRisk: true })).toBe(0);
  });
  it("looks at one line alone when a service tab asks", () => {
    const ks = [line("meta", 90), line("email", 20)];
    expect(criticality(ks, { only: "meta" })).toBe(0);
    expect(criticality(ks, { only: "email" })!).toBeGreaterThan(50);
    expect(criticality(ks, { only: "google" })).toBeNull();
  });
});

describe("sorting the list", () => {
  const cards = [
    client("Delta", []),
    client("Bravo", [line("meta", 55)]),
    client("Alpha", [line("meta", 95), line("email", 90)]),
    client("Charlie", [line("meta", 20), line("email", 40)]),
    client("Echo", [line("email", null)]),
  ];
  it("most critical first, clients with no KPI data last by name", () => {
    expect(sortClients(cards, "critical").map((c) => c.name)).toEqual(["Charlie", "Bravo", "Alpha", "Delta", "Echo"]);
  });
  it("best performing first, no data still last", () => {
    expect(sortClients(cards, "best").map((c) => c.name)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  });
  it("by name, ignoring case and numbers in order", () => {
    expect(sortClients([client("Club 76", []), client("club 9", []), client("Apex", [])], "name").map((c) => c.name)).toEqual(["Apex", "club 9", "Club 76"]);
  });
  it("on a line's tab sorts by that line's KPI only", () => {
    const tab = [client("A", [line("meta", 10), line("email", 95)]), client("B", [line("meta", 90), line("email", 20)]), client("C", [line("email", 70)])];
    expect(sortClients(tab, "critical", "meta").map((c) => c.name)).toEqual(["A", "B", "C"]);
    expect(sortClients(tab, "critical", "email").map((c) => c.name)).toEqual(["B", "C", "A"]);
    expect(overallHealth(tab[0].kpis, "meta")).toBe(10);
  });
  it("breaks ties by name and puts an at-risk client above an equal one", () => {
    expect(sortClients([client("Zed", [line("meta", 40)]), client("Abe", [line("meta", 40)])], "critical").map((c) => c.name)).toEqual(["Abe", "Zed"]);
    expect(sortClients([client("Abe", [line("meta", 40)]), client("Zed", [line("meta", 40)], true)], "critical").map((c) => c.name)).toEqual(["Zed", "Abe"]);
  });
});

describe("the summary line", () => {
  const cards = [
    client("A", [line("meta", 10), line("email", 30)]),
    client("B", [line("google", 50)]),
    client("C", [line("meta", 75)]),
    client("D", [line("meta", 95)]),
    client("E", []),
  ];
  it("counts clients off target, the lines they're off on, and the critical ones", () => {
    const s = summarize(cards);
    expect(s).toMatchObject({ offTarget: 2, lines: ["meta", "google", "email"], judged: 4 });
    expect(s.critical).toBe(1);
    expect(summaryText(s)).toBe("2 clients off target across 3 lines: 1 critical");
  });
  it("counts one line alone on a tab", () => {
    expect(summarize(cards, "meta")).toMatchObject({ offTarget: 1, lines: ["meta"], judged: 3 });
  });
  it("says so when everything is on target or nothing is read", () => {
    expect(summaryText(summarize([client("A", [line("meta", 90)])]))).toBe("All 1 clients with a KPI are on target");
    expect(summaryText(summarize([client("A", [])]))).toBe("No KPI numbers read yet");
  });
  it("filters to off target or critical clients", () => {
    expect(cards.filter((c) => passesKpiFilter(c, "off")).map((c) => c.name)).toEqual(["A", "B"]);
    expect(cards.filter((c) => passesKpiFilter(c, "critical", "email")).map((c) => c.name)).toEqual(["A"]);
  });
});

describe("reasons", () => {
  it("email: the score's checks weighing it down, worst first, in plain words", () => {
    const s = emailScore({ attributed: 0.1, rpr: 0.05, deliverability: 90, campaignOpen: 0.4, campaignClick: 0.02, flowOpen: 0.4, flowClick: 0.02 });
    expect(s.band).not.toBe("good");
    const r = emailReasons(s);
    expect(r.length).toBeLessThanOrEqual(3);
    expect(r.every((x) => x.tone === "down")).toBe(true);
    expect(r[0].text).toMatch(/Attributed revenue|Revenue per recipient/);
    expect(r[0].text).toContain("against a");
  });
  it("email: a healthy score says what carries it", () => {
    const s = emailScore({ attributed: 0.5, rpr: 0.3, deliverability: 90, campaignOpen: 0.4, campaignClick: 0.02, flowOpen: 0.4, flowClick: 0.02 });
    expect(s.band).toBe("good");
    expect(emailReasons(s).every((x) => x.tone === "up")).toBe(true);
  });
  it("social: the checks under their bars", () => {
    const s = socialScore({ engagement: 0.01, growth: 0.02, reach: 1.1, cadence: 1, quality: 0.01, videoShare: 0.5, videoLift: 1.2, profile: 0.05 });
    const r = socialReasons(s);
    expect(r[0]).toMatchObject({ tone: "down" });
    expect(r[0].text).toContain("Engagement rate");
  });

  const day = (date: string, campaign: string, spend: number, impressions: number, linkClicks: number, results: number): DayNumbers => ({ date, campaign, spend, impressions, linkClicks, results });
  const days = (from: number, to: number, f: (n: number) => Omit<DayNumbers, "date">): DayNumbers[] => Array.from({ length: to - from + 1 }, (_, i) => ({ date: `2026-11-${String(from + i).padStart(2, "0")}`, ...f(from + i) }));
  it("ads: simple data driven reasons from the synced days (CPM up, CTR down, cost per result up)", () => {
    // today 2026-11-18: the last 14 complete days are Nov 4 to 17, the 14 before Oct 21 to Nov 3
    const before = Array.from({ length: 14 }, (_, i) => day(new Date(Date.UTC(2026, 9, 21 + i, 12)).toISOString().slice(0, 10), "Main", 100, 10000, 200, 5));
    const now = days(4, 17, () => ({ campaign: "Main", spend: 130, impressions: 8000, linkClicks: 110, results: 4 }));
    const r = dataReasons([...before, ...now], "2026-11-18");
    const text = r.map((x) => x.text).join(" | ");
    expect(text).toMatch(/CPM up/);
    expect(text).toMatch(/Click-through down/);
    expect(text).toMatch(/Cost per result up/);
  });
  it("ads: flags spend sitting on a weak campaign", () => {
    const now = days(4, 17, () => ({ campaign: "Strong", spend: 50, impressions: 5000, linkClicks: 100, results: 5 })).concat(days(4, 17, () => ({ campaign: "Weak", spend: 60, impressions: 5000, linkClicks: 100, results: 1 })));
    const r = dataReasons(now, "2026-11-18");
    expect(r.some((x) => /"Weak"/.test(x.text))).toBe(true);
  });
  it("ads: nothing invented when there are no days or no spend", () => {
    expect(dataReasons([], "2026-11-18")).toEqual([]);
    expect(dataReasons(days(4, 17, () => ({ campaign: "A", spend: 0, impressions: 0, linkClicks: 0, results: 0 })), "2026-11-18")).toEqual([]);
  });
  const sig = { status: "off" as const, deviation: 0.3, trend: null, vsMonth: null, budget: null, roas: false, audit: null, tiredAds: 0, days: [], today: "2026-11-18" };
  it("ads: the stored audit headline leads, then the stored flags, at most three", () => {
    const r = adReasons({ ...sig, audit: { headline: "Creative fatigue is eating the account", status: "off" }, tiredAds: 4, trend: "slipping", vsMonth: 0.25, budget: { status: "under", pace: 0.7 } });
    expect(r).toHaveLength(3);
    expect(r[0].text).toBe("Audit: Creative fatigue is eating the account");
    expect(r[1].text).toContain("4 ads are wearing out");
  });
  it("ads: an audit that says on track isn't quoted for an account that's off", () => {
    expect(adReasons({ ...sig, audit: { headline: "All good", status: "on_track" } }).some((x) => x.text.startsWith("Audit"))).toBe(false);
  });
  it("ads: says why it's going well when on target", () => {
    const r = adReasons({ ...sig, status: "good", deviation: -0.15, trend: "improving" });
    expect(r.every((x) => x.tone === "up")).toBe(true);
    expect(r[0].text).toContain("15% under target");
  });
  it("ads: falls back to one honest line when nothing stands out", () => {
    expect(adReasons(sig)).toEqual([{ tone: "info", text: "30% over target over the last 14 days; no single cause stands out yet" }]);
  });

  it("top reasons across lines take the worst line first and don't let one line crowd the rest", () => {
    const meta = line("meta", 20, { reasons: [{ tone: "down", text: "CPM up 30%" }, { tone: "down", text: "CTR down 20%" }, { tone: "down", text: "2 ads wearing out" }] });
    const email = line("email", 45, { reasons: [{ tone: "down", text: "Open rate 20% against a 30% bar" }] });
    const social = line("social", 90, { reasons: [{ tone: "up", text: "Engagement 6%" }] });
    expect(topReasons([social, email, meta], 3)).toEqual(["Meta: CPM up 30%", "Email: Open rate 20% against a 30% bar", "Meta: CTR down 20%"]);
    expect(topReasons([social, email, meta], 3, "up")).toEqual(["Social: Engagement 6%"]);
  });
});

describe("which lines a person sees", () => {
  it("follows the boards: execs and leads all, a channel team its own line, a buyer their platform", () => {
    expect(allowedKpiLines({ isExec: true }, null, null)).toHaveLength(6);
    expect(allowedKpiLines({}, "email", null)).toEqual(["email"]);
    expect(allowedKpiLines({}, null, "google")).toEqual(["google"]);
    expect(allowedKpiLines({}, null, null)).toEqual(["meta", "google", "tiktok", "creative"]);
  });
  it("scoreChip says why there's no number", () => {
    expect(scoreChip({ line: "email", score: null, band: null, reasons: [], href: "/k", note: "Email · not connected" })).toMatchObject({ tone: "none", health: null });
    expect(scoreChip({ line: "social", score: 72, band: "watch", reasons: [], href: "/k", note: "" })).toMatchObject({ tone: "watch", health: 72, shown: "72" });
  });
});
