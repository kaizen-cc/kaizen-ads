import { createElement, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ReportDocument, type ReportPdfInput } from "@/lib/reports/report-doc";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { Sections } from "@/lib/reports/write";
import { buildReportEmail } from "@/lib/reports/delivery-core";
import { forClient, isWhiteLabel, scrubAgency, scrubSections, whiteLabelFileName } from "@/lib/reports/white-label";
import { emailHtml, emailText } from "@/lib/email-layout";
import { fromWithName } from "@/lib/email";

// White label clients (an agency partner's): their reports go out generic, so the partner can pass them on as their
// own. Nothing in the PDF (text, links, the file's own properties), its file name, the Slack message or the email names
// Kaizen or links to its site, and the red brand marks turn a neutral slate. Everyone else's report is as it was.

const period = (start: string, end: string, label: string, x: Partial<ReportMetrics["main"]>) => ({ label, start, end, days: 7, spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null, results: 0, costPerResult: null, revenue: 0, roas: null, ...x });
const metrics = (platform: "meta" | "google") =>
  ({
    platform,
    kind: "weekly",
    conversion: "Leads",
    roasKpi: false,
    target: 50,
    monthlyBudget: 6000,
    main: period("2026-11-02", "2026-11-08", "Nov 2 to Nov 8", { spend: 1200, results: 30, costPerResult: 40, ctr: 1.5, clicks: 300, impressions: 20000 }),
    compare: period("2026-10-26", "2026-11-01", "Oct 26 to Nov 1", { spend: 1000, results: 20, costPerResult: 50, ctr: 1.2, clicks: 250, impressions: 18000 }),
    mtd: period("2026-11-01", "2026-11-08", "November to date", { spend: 1400, results: 34, costPerResult: 41.18 }),
    mtdCompare: null,
    campaigns: [
      { name: "Prospecting", spend: 800, results: 20, costPerResult: 40, roas: null, ctr: 1.4 },
      { name: "Retargeting", spend: 400, results: 10, costPerResult: 40, roas: null, ctr: 1.8 },
    ],
    topAds: [
      { id: "a1", name: "Smile video", campaign: "Prospecting", spend: 300, results: 9, costPerResult: 33.33, ctr: 1.9, clicks: 90, link: "https://fb.me/abc", image: null, copy: { body: "Book your visit", headline: null, cta: null, url: null } },
      { id: "a2", name: "Portal card", campaign: "Prospecting", spend: 200, results: 5, costPerResult: 40, ctr: 1.1, clicks: 40, link: "https://ads.kaizenmarketing.agency/r/tok/ad/a2", image: null },
    ],
    dataThrough: "2026-11-08",
    gaps: [],
  }) as unknown as ReportMetrics;

// What the AI or the buyer might have written, Kaizen and all: the document must clean it
const sections: Sections = {
  headline: "Leads up 50% with the team at Kaizen tightening budgets",
  summary: "30 leads at $40 each. Kaizen Marketing moved spend to the best ads. See ads.kaizenmarketing.agency/c/propr for more.",
  did: ["Kaizen's creative team shipped two new videos", "Paused the weakest ad set"],
  doing: ["Testing a new offer"],
  next: ["Launch the holiday campaign", "Kaizen Ads will watch frequency"],
  highlights: ["30 leads at $40"],
  stories: [{ title: "Cost per lead, 3 weeks", metric: "cost_per_result", grain: "week", periods: 3, see: "Down every week", why: "Kaizen refreshed creative", next: "Keep going", points: [{ label: "Oct 19", value: 55 }, { label: "Oct 26", value: 50 }, { label: "Nov 2", value: 40 }] }],
} as Sections;

const part = (platform: "meta" | "google") => ({ platform, buyer: "Sam Rivera", metrics: metrics(platform), sections, extras: "Kaizen also set up call tracking.", layout: null });
const input = (kind: ReportPdfInput["kind"], whiteLabel: boolean): ReportPdfInput => ({
  client: "Propr Dental",
  kind,
  periodLabel: kind === "monthly" ? "October 2026" : "Nov 2 to Nov 8",
  parts: kind === "weekly" ? [part("meta")] : [part("meta"), part("google")],
  dashboard: "https://ads.kaizenmarketing.agency/c/propr-dental/dashboard",
  shots: kind === "monthly" ? { month: "December", items: ["A team photo"], url: "https://ads.kaizenmarketing.agency/c/propr-dental/shots" } : null,
  whiteLabel,
});

/** Every string the document carries: text, the page number line, links, colors, the file's own properties */
function strings(node: ReactNode, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) strings(n, out);
    return out;
  }
  if (isValidElement(node)) {
    const { type, props } = node as { type: unknown; props: Record<string, unknown> };
    if (typeof type === "function") return strings((type as (p: unknown) => ReactNode)(props), out);
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") continue;
      if (k === "render" && typeof v === "function") strings((v as (x: { pageNumber: number; totalPages: number }) => ReactNode)({ pageNumber: 2, totalPages: 9 }), out);
      else values(v, out);
    }
    strings(props.children as ReactNode, out);
  }
  return out;
}
function values(v: unknown, out: string[]) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => values(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => values(x, out));
}
const docStrings = (i: ReportPdfInput) => strings(createElement(ReportDocument, { input: i, images: i.parts.map(() => []) }));

describe("a white label client's PDF", () => {
  for (const kind of ["weekly", "monthly", "built"] as const) {
    it(`${kind}: no Kaizen anywhere, no agency link, no Kaizen red marks`, () => {
      const all = docStrings(input(kind, true));
      expect(all.filter((x) => /kaizen/i.test(x))).toEqual([]);
      expect(all.some((x) => x.includes("Propr Dental"))).toBe(true);
      // The weekly's footer is the client's alone; the monthly and built reports keep their own line
      expect(all.join(" ")).toContain(kind === "weekly" ? "Prepared for Propr Dental " : "Performance report · Propr Dental");
      // The neutral accent stands where the red was
      expect(all).toContain("#475569");
      expect(all.join(" ")).not.toMatch(/Prepared by Sam/);
    });

    it(`${kind}: everyone else's still carries Kaizen's name and red`, () => {
      const all = docStrings(input(kind, false));
      expect(all.join(" ")).toContain(kind === "weekly" ? "Prepared for Propr Dental · Kaizen" : "Kaizen Marketing · Propr Dental");
      expect(all).toContain("#c8102e");
      expect(all).not.toContain("#475569");
    });
  }

  it("draws as a real PDF, with no agency in the file's own properties", async () => {
    const { renderToBuffer } = await import("@react-pdf/renderer");
    for (const kind of ["weekly", "monthly", "built"] as const) {
      const i = input(kind, true);
      const pdf = await renderToBuffer(createElement(ReportDocument, { input: i, images: i.parts.map(() => []) }) as Parameters<typeof renderToBuffer>[0]);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      // The info dictionary (title, author, creator, producer) is plain text in the file
      expect(pdf.toString("latin1")).not.toMatch(/kaizen/i);
    }
    // (The same check finds it in everyone else's)
    const normal = await renderToBuffer(createElement(ReportDocument, { input: input("weekly", false), images: [[]] }) as Parameters<typeof renderToBuffer>[0]);
    expect(normal.toString("latin1")).toMatch(/Kaizen Marketing/);
  }, 60_000);

  it("keeps the meta ad link that isn't the agency's", () => {
    const all = docStrings(input("weekly", true));
    expect(all).toContain("https://fb.me/abc");
  });
});

describe("white label helpers", () => {
  it("knows the client type", () => {
    expect(isWhiteLabel("whitelabel")).toBe(true);
    expect(isWhiteLabel("white_label")).toBe(true);
    expect(isWhiteLabel("White label")).toBe(true);
    expect(isWhiteLabel("retainer")).toBe(false);
    expect(isWhiteLabel(null)).toBe(false);
  });

  it("names the file without the agency", () => {
    expect(whiteLabelFileName("Propr Dental", "weekly", "Nov 2 to Nov 8", "Meta Ads")).toBe("Propr Dental Meta weekly report Nov 2 to Nov 8.pdf");
    expect(whiteLabelFileName("Propr Dental", "monthly", "October 2026")).toBe("Propr Dental monthly report October 2026.pdf");
    expect(whiteLabelFileName("Propr/Dental", "built", "Last 7 days + November 2026")).toBe("Propr-Dental performance report Last 7 days + November 2026.pdf");
  });

  it("takes Kaizen out of a message, links and all", () => {
    const msg = "Hi team! Here's the week from all of us at Kaizen.\n\n*Leads:* 30 (up 50%)\nKaizen Marketing moved spend to the best ads.\n\n<https://ads.kaizenmarketing.agency/c/propr/dashboard|See every number on your live dashboard>\n\nSam, Kaizen Marketing";
    const out = scrubAgency(msg);
    expect(out).not.toMatch(/kaizen/i);
    expect(out).toContain("*Leads:* 30 (up 50%)");
    expect(out).toContain("our team moved spend");
    expect(out.trim().endsWith("Sam")).toBe(true);
    expect(scrubAgency("The full report: https://ads.kaizenmarketing.agency/r/abc123")).toBe("The full report:");
  });

  it("leaves everyone else's message exactly as it was", () => {
    const msg = "From Kaizen Marketing: <https://ads.kaizenmarketing.agency/c/x|dashboard>";
    expect(forClient(msg, false)).toBe(msg);
    expect(forClient(msg, true)).not.toMatch(/kaizen/i);
  });

  it("cleans every written section", () => {
    const s = scrubSections(sections);
    expect(JSON.stringify(s)).not.toMatch(/kaizen/i);
    expect(s.stories?.[0].points).toHaveLength(3);
  });
});

describe("a white label client's email", () => {
  const mail = buildReportEmail({
    client: "Propr Dental",
    kind: "weekly",
    periodLabel: "Nov 2 to Nov 8",
    parts: [{ platform: "meta", metrics: metrics("meta"), sections }],
    from: { name: "Sam Rivera", email: "sam@kaizenmarketing.agency" },
    first: "Ana",
    dashboard: "https://ads.kaizenmarketing.agency/c/propr-dental/dashboard",
    note: "Kaizen is on it.",
    whiteLabel: true,
  });

  it("never names the agency or links its portal, and replies still go to the buyer", () => {
    const { replyTo, ...shown } = mail;
    expect(JSON.stringify(shown)).not.toMatch(/kaizen/i);
    expect(mail.cta).toBeNull();
    expect(mail.text.trim().endsWith("Sam")).toBe(true);
    expect(replyTo).toBe("sam@kaizenmarketing.agency");
  });

  it("is drawn without the Kaizen logo, footer or sign-off", () => {
    const parts = { preheader: mail.preheader, kicker: mail.kicker, title: mail.title, highlight: mail.highlight, hello: mail.hello, lines: mail.lines, bullets: mail.bullets, note: mail.note, whiteLabel: true };
    expect(emailHtml(parts)).not.toMatch(/kaizen/i);
    expect(emailText(parts)).not.toMatch(/kaizen/i);
    // Everyone else's keeps them
    expect(emailHtml({ ...parts, whiteLabel: false })).toContain("kaizen-logo.png");
  });

  it("comes from a neutral name at the same address", () => {
    expect(fromWithName("Kaizen Ads <ads@contact.kaizenmarketing.agency>", "Performance Report")).toBe("Performance Report <ads@contact.kaizenmarketing.agency>");
    expect(fromWithName("ads@contact.kaizenmarketing.agency", "Performance Report")).toBe("Performance Report <ads@contact.kaizenmarketing.agency>");
    expect(fromWithName("Kaizen Ads <ads@x.y>")).toBe("Kaizen Ads <ads@x.y>");
  });
});
