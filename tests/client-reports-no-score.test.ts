import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChannelDocument } from "@/lib/channel-reports/channel-doc";
import { emailMetrics, socialMetrics } from "@/lib/channel-reports/core";
import { channelMetricsText } from "@/lib/channel-reports/text";
import { SOCIAL_TAKEAWAY_RULES } from "@/lib/channel-reports/social-write";
import type { Sections } from "@/lib/reports/write";

// Kaizen's own scores (the social score, the email health score, the deliverability score) and its internal bars (revenue
// per recipient against $0.15) are for the team: the KPI board, Overview and audits. Nothing a client reads shows them.

const main = { start: "2026-11-09", end: "2026-11-15", label: "Nov 9 - Nov 15" };
const compare = { start: "2026-11-02", end: "2026-11-08", label: "Nov 2 - Nov 8" };
const sections: Sections = { headline: "Reach grew", summary: "", did: [], doing: [], next: [], highlights: [], takeaways: [{ title: "Reach grew", text: "Reach was 38,410.", next: "Keep posting." }] };
const range = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.push(d);
  return out;
};
const social = () =>
  socialMetrics({
    kind: "weekly",
    main,
    compare,
    days: range("2026-10-01", "2026-11-15").flatMap((date) => [
      { platform: "facebook" as const, date, followers: 6300, gained: 1, lost: 0, reach: 3000, views: 5000, profileViews: 40, engaged: null, interactions: 150 },
      { platform: "instagram" as const, date, followers: 14000, gained: 6, lost: null, reach: 2000, views: 3000, profileViews: 50, engaged: 60, interactions: 90 },
    ]),
    posts: [{ id: "a", platform: "instagram", format: "carousel", caption: "Come celebrate", permalink: null, thumbnail: null, postedAt: "2026-11-13T15:00:00Z", likes: 10, comments: 1, shares: 5, saves: 1, reach: 1700, views: 3000, interactions: 164, insightsOk: true }],
    names: {},
  });
const email = () =>
  emailMetrics({
    kind: "weekly",
    main,
    compare,
    today: "2026-11-17",
    days: range("2026-10-01", "2026-11-15").map((date) => ({ date, revenue: 100, campaignRevenue: 60, flowRevenue: 40, smsRevenue: 0, sends: 500, campaignsSent: 0, storeRevenue: null, storeOrders: null, subscribed: 10, unsubscribed: 2 })),
    campaigns: [{ id: "a", name: "Fall sale", channel: "email", sendTime: "2026-11-10T15:00:00Z", subject: "Last chance", recipients: 1000, delivered: 980, opensUnique: 400, clicksUnique: 50, unsubscribes: 2, bounced: 5, spamComplaints: 0, revenue: 90, conversions: 10, openRate: 0.4, clickRate: 0.05 }],
    flows: [],
    keyFlows: [],
    profiles: 5000,
    currency: "USD",
    account: "Acme",
  });

async function pdfText(m: ReturnType<typeof social> | ReturnType<typeof email>): Promise<string> {
  const pdf = new Uint8Array(await renderToBuffer(createElement(ChannelDocument, { input: { client: "Acme", metrics: m, sections }, images: {} }) as unknown as Parameters<typeof renderToBuffer>[0]));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const fonts = `${path.resolve(__dirname, "../node_modules/pdfjs-dist/standard_fonts").split(path.sep).join("/")}/`;
  const doc = await pdfjs.getDocument({ data: pdf.slice(), standardFontDataUrl: fonts }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) out += ` ${(await (await doc.getPage(i)).getTextContent()).items.map((x) => ("str" in x ? x.str : "")).join(" ")}`;
  return out;
}

const SCORE_WORDS = /score|weighing it down|lifting it|fewer posts|health score/i;

describe("client-facing reports never show Kaizen's internal scores", () => {
  it("social: the PDF, the writer's numbers and the writer's rules carry no score", async () => {
    const m = social();
    // A stored report from before this rule still carries a score: it is never drawn or quoted
    (m as unknown as Record<string, unknown>).score = { score: 71, band: "watch", lifting: [{ text: "Engagement at 3.1%" }], weighing: [{ text: "Fewer posts so far this month than the plan" }], platforms: [] };
    expect(await pdfText(m)).not.toMatch(SCORE_WORDS);
    // (the PDF render is slow under a loaded machine: see the timeout below)
    expect(channelMetricsText(m)).not.toMatch(SCORE_WORDS);
    expect(SOCIAL_TAKEAWAY_RULES).not.toMatch(SCORE_WORDS);
    expect(Object.keys(social())).not.toContain("score");
  }, 60_000);

  it("social: engagement is still held to the 5% target", async () => {
    expect(await pdfText(social())).toMatch(/5% target/);
  }, 60_000);

  it("email: no email score, no deliverability score, and revenue per recipient is not graded against a bar", async () => {
    const m = email();
    const text = await pdfText(m);
    expect(text).not.toMatch(/email score|health score|deliverability score|account score|of 100/i);
    expect(text).not.toMatch(/\$0\.15|bar \$/i);
    const lines = channelMetricsText(m);
    expect(lines).not.toMatch(/health score|deliverability score|of 100|0\.15|Kaizen's bar is/i);
    expect(Object.keys(m)).not.toContain("score");
  }, 60_000);
});
