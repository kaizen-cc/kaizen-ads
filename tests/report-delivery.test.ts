import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReportEmail, deliveryProblem, keyNumbers, normalizeDelivery, reportSubject, summaryLines } from "@/lib/reports/delivery-core";
import type { ReportMetrics } from "@/lib/reports/metrics";
import { recordSend } from "@/lib/reports/send";

// Sending a report by Slack, email or both: the choice cleaned up, the email written from the report (subject
// "<Client> weekly report · <period>", a short summary, the key numbers, replies to the buyer), and every send kept in
// the history with who, when, where, to whom, the period and the PDF as it went.

const period = (start: string, end: string, label: string, x: Partial<ReportMetrics["main"]>) => ({ label, start, end, days: 7, spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, cpm: null, results: 0, costPerResult: null, revenue: 0, roas: null, ...x });
const metrics = {
  platform: "meta",
  kind: "weekly",
  conversion: "Leads",
  roasKpi: false,
  target: 50,
  monthlyBudget: null,
  main: period("2026-11-02", "2026-11-08", "Nov 2 – Nov 8", { spend: 1200, results: 30, costPerResult: 40, ctr: 1.5, clicks: 300 }),
  compare: period("2026-10-26", "2026-11-01", "Oct 26 – Nov 1", { spend: 1000, results: 20, costPerResult: 50, ctr: 1.2, clicks: 250 }),
  mtd: null,
  mtdCompare: null,
  campaigns: [],
  topAds: [],
  dataThrough: "2026-11-08",
  gaps: [],
} as unknown as ReportMetrics;

describe("the delivery choice", () => {
  it("keeps known channels and real addresses, lowercased, once each", () => {
    const d = normalizeDelivery({ channels: ["email", "fax", "email"], recipients: ["Ann@Client.com", { email: "ann@client.com" }, "nope", { email: "bo@client.com", name: " Bo " }] });
    expect(d).toEqual({ channels: ["email"], recipients: [{ email: "ann@client.com", name: null }, { email: "bo@client.com", name: "Bo" }] });
    expect(normalizeDelivery(null)).toEqual({ channels: ["slack"], recipients: [] });
    expect(normalizeDelivery({ channels: [] }).channels).toEqual(["slack"]);
  });

  it("says what's missing before it can go", () => {
    const can = { slackChannel: true, slackConnected: true, emailReady: true };
    expect(deliveryProblem({ channels: ["slack"], recipients: [] }, can)).toBeNull();
    expect(deliveryProblem({ channels: ["email"], recipients: [] }, can)).toMatch(/email address/);
    expect(deliveryProblem({ channels: ["slack", "email"], recipients: [{ email: "a@b.co" }] }, { ...can, slackChannel: false })).toMatch(/Slack channel/);
    expect(deliveryProblem({ channels: ["email"], recipients: [{ email: "a@b.co" }] }, { ...can, emailReady: false })).toMatch(/RESEND_API_KEY/);
  });
});

describe("the report email", () => {
  it("has the subject the client expects", () => {
    expect(reportSubject("Acme Dental", "weekly", "Nov 2 – Nov 8")).toBe("Acme Dental weekly report · Nov 2 – Nov 8");
    expect(reportSubject("Acme Dental", "monthly", "October 2026")).toBe("Acme Dental monthly recap · October 2026");
  });

  it("opens with two or three lines from the report", () => {
    expect(summaryLines({ summary: "Leads were up 50%. Cost per lead fell to $40. We moved budget to the winners. And more." })).toEqual(["Leads were up 50%.", "Cost per lead fell to $40.", "We moved budget to the winners."]);
    expect(summaryLines({ headline: "30 leads at $40", summary: "" })).toEqual(["30 leads at $40"]);
  });

  it("gives the key numbers against the period before", () => {
    const lines = keyNumbers(metrics);
    expect(lines[0]).toBe("Spend: $1,200, +20% vs Oct 26 – Nov 1");
    expect(lines.some((l) => l.startsWith("Leads: 30") && l.includes("+50% vs Oct 26 – Nov 1"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Cost per lead: $40") && l.includes("-20%"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Click-through"))).toBe(false);
  });

  it("is written from the report, signed by the buyer, replies to them, with the dashboard when there is one", () => {
    const e = buildReportEmail({
      client: "Acme Dental",
      kind: "weekly",
      periodLabel: "Nov 2 – Nov 8",
      parts: [{ platform: "meta", metrics, sections: { headline: "30 leads at $40", summary: "Leads were up 50% on the week before. Cost per lead fell to $40." } }],
      from: { name: "Sam Rivera", email: "sam@kaizenmarketing.agency" },
      first: "Ann",
      dashboard: "https://ads.kaizenmarketing.agency/c/acme/dashboard",
    });
    expect(e.subject).toBe("Acme Dental weekly report · Nov 2 – Nov 8");
    expect(e.replyTo).toBe("sam@kaizenmarketing.agency");
    expect(e.hello).toBe("Hi Ann,");
    expect(e.lines[0]).toMatch(/attached as a PDF/);
    expect(e.lines.slice(1)).toEqual(["Leads were up 50% on the week before.", "Cost per lead fell to $40."]);
    expect(e.bullets.length).toBe(3);
    expect(e.cta?.url).toContain("/c/acme/dashboard");
    expect(e.text).toContain("Sam\nKaizen Marketing");
    // No em dashes anywhere the client reads
    expect(`${e.subject}${e.text}${e.note}${e.lines.join("")}${e.bullets.join("")}`).not.toContain("—");
  });

  it("covers each service of a joint report", () => {
    const e = buildReportEmail({ client: "Acme", kind: "built", periodLabel: "Last 7 days", parts: [{ platform: "meta", metrics, sections: { summary: "Meta did well." } }, { platform: "google", metrics, sections: { summary: "Google held steady." } }], from: { name: "Sam", email: null } });
    expect(e.subject).toBe("Acme report · Last 7 days");
    expect(e.replyTo).toBeNull();
    expect(e.lines).toContain("Meta Ads: Meta did well.");
    expect(e.lines).toContain("Google Ads: Google held steady.");
    expect(e.bullets.some((b) => b.startsWith("Google · Spend"))).toBe(true);
  });
});

describe("the send history", () => {
  afterEach(() => vi.restoreAllMocks());

  const fakeAdmin = () => {
    const inserted: Record<string, unknown>[] = [];
    const uploads: string[] = [];
    const admin = {
      storage: { from: () => ({ upload: async (path: string) => (uploads.push(path), { data: { path }, error: null }) }) },
      from: (table: string) => ({ insert: async (row: Record<string, unknown>) => (inserted.push({ table, ...row }), { error: null }) }),
    };
    return { admin, inserted, uploads };
  };

  it("keeps who sent it, when, where, to whom, the period and the PDF as it went", async () => {
    const { admin, inserted, uploads } = fakeAdmin();
    const id = await recordSend(
      admin as never,
      {
        client: { id: "c1", name: "Acme", slack_channel_id: "C1" },
        kind: "weekly",
        platform: "meta",
        period: { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 – Nov 8" },
        message: "Here's the week",
        pdf: { bytes: new Uint8Array([37, 80, 68, 70]), filename: "Acme - Meta - Nov 2 – Nov 8.pdf", title: "Acme" },
        parts: [{ platform: "meta", metrics, sections: { headline: "30 leads", summary: "Up." } }],
        by: { id: "u1", fullName: "Sam Rivera", email: "sam@kaizenmarketing.agency" },
        delivery: { channels: ["slack", "email"], recipients: [{ email: "ann@acme.com" }] },
        slackAs: "user",
        reportId: "r1",
        resendOf: "s0",
      },
      { went: ["slack", "email"], slack: { channel: "C1", ts: "1.2" }, email: { to: ["ann@acme.com"], failed: [], subject: "Acme weekly report · Nov 2 – Nov 8" }, status: "sent" },
    );
    expect(id).toBeTruthy();
    expect(uploads).toEqual([`c1/${id}.pdf`]);
    const row = inserted[0];
    expect(row).toMatchObject({
      table: "report_sends",
      id,
      client_id: "c1",
      report_id: "r1",
      kind: "weekly",
      period_start: "2026-11-02",
      period_end: "2026-11-08",
      period_label: "Nov 2 – Nov 8",
      sent_by: "u1",
      channels: ["slack", "email"],
      status: "sent",
      pdf_path: `c1/${id}.pdf`,
      resend_of: "s0",
      message: "Here's the week",
    });
    expect(row.email).toMatchObject({ to: ["ann@acme.com"], reply_to: "sam@kaizenmarketing.agency" });
    expect((row.snapshot as { parts: { main: { start: string } }[] }).parts[0].main.start).toBe("2026-11-02");
  });

  it("still sends when the history isn't there yet (its migration not applied)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = { storage: { from: () => ({ upload: async () => ({ error: { message: "no bucket" } }) }) }, from: () => ({ insert: async () => ({ error: { message: 'relation "report_sends" does not exist' } }) }) };
    const id = await recordSend(admin as never, { client: { id: "c1", name: "Acme", slack_channel_id: null }, kind: "weekly", platform: "meta", period: { start: null, end: null, label: "" }, message: "", pdf: { bytes: new Uint8Array(), filename: "x.pdf", title: "x" }, parts: [], by: { id: "u1", fullName: "Sam", email: null }, delivery: { channels: ["email"], recipients: [] }, slackAs: "user" }, { went: ["email"], slack: null, email: null, status: "sent" });
    expect(id).toBeNull();
  });
});
