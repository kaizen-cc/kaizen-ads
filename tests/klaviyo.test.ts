import { describe, expect, it } from "vitest";
import { cleanKey, dayIn, emailContextLine, emptyStats, errorText, keyLast4, keyProblem, parseAccount, parseAudiences, parseCampaigns, parseSeriesReport, parseValuesReport, placedOrderId, rates, redactKey, reportWait, retryDecision, rollupDays, sumSince, type EmailWindow } from "@/lib/klaviyo/core";

// Klaviyo (read only): the pasted key, the Accounts answer, Reporting API answers in the shapes Klaviyo uses, waiting
// and retrying on refusals, the daily rollup, and the line every agent reads.

const KEY = "pk_0123456789abcdef0123456789abcdef01";

describe("the private API key", () => {
  it("takes a real private key, trimmed and without a header prefix", () => {
    expect(keyProblem(KEY)).toBeNull();
    expect(cleanKey(`  Klaviyo-API-Key ${KEY} `)).toBe(KEY);
    expect(keyProblem(`"${KEY}"`)).toBeNull();
    expect(keyLast4(KEY)).toBe("ef01");
  });
  it("refuses the public key, other tokens and fragments with a reason", () => {
    expect(keyProblem("")).toMatch(/Paste/);
    expect(keyProblem("AbC123")).toMatch(/public key/);
    expect(keyProblem("sk_live_1234567890abcdefgh")).toMatch(/starts with pk_/);
    expect(keyProblem("pk_123")).toMatch(/whole/);
  });
  it("never lets a key through in a message", () => {
    expect(redactKey(`failed for ${KEY} at /api/accounts`)).not.toContain(KEY);
    expect(redactKey("Authorization: Klaviyo-API-Key pk_abcdefghijklmnop")).toBe("Authorization: Klaviyo-API-Key pk_[redacted]");
  });
});

describe("the Accounts answer", () => {
  it("reads the account name, time zone and currency", () => {
    const json = { data: [{ type: "account", id: "XyZ123", attributes: { test_account: false, contact_information: { organization_name: "Crust Pizza", default_sender_name: "Crust" }, timezone: "US/Eastern", preferred_currency: "USD", public_api_key: "XyZ123", locale: "en-US" } }] };
    expect(parseAccount(json)).toEqual({ id: "XyZ123", name: "Crust Pizza", timezone: "US/Eastern", currency: "USD", testAccount: false });
  });
  it("reads a single object too, and nothing from an empty answer", () => {
    expect(parseAccount({ data: { id: "A1", attributes: { contact_information: { default_sender_name: "Ocean Box" } } } })?.name).toBe("Ocean Box");
    expect(parseAccount({ data: [] })).toBeNull();
    expect(parseAccount(null)).toBeNull();
  });
  it("says what a refusal means without echoing the key", () => {
    expect(errorText(401, { errors: [{ detail: "Incorrect authentication credentials." }] })).toMatch(/refused/);
    expect(errorText(403, {})).toMatch(/campaigns:read/);
    expect(errorText(429, {})).toMatch(/rate limiting/);
  });
});

describe("Reporting API answers", () => {
  const values = {
    data: {
      type: "campaign-values-report",
      attributes: {
        results: [
          { groupings: { send_channel: "email", campaign_id: "C1", campaign_message_id: "M1" }, statistics: { recipients: 1000, delivered: 980, opens_unique: 400, open_rate: 0.408, clicks_unique: 40, click_rate: 0.0408, unsubscribes: 3, bounced: 20, spam_complaints: 1, conversions: 12, conversion_value: 840.5 } },
          // An A/B test's second message: added to the same campaign
          { groupings: { send_channel: "email", campaign_id: "C1", campaign_message_id: "M2" }, statistics: { recipients: 1000, delivered: 1000, opens_unique: 500, clicks_unique: 60, conversions: 8, conversion_value: 600 } },
          { groupings: { send_channel: "sms", campaign_id: "C2", campaign_message_id: "M3" }, statistics: { recipients: "500", delivered: "490", conversions: "4", conversion_value: "120.25" } },
          { groupings: { send_channel: "email" }, statistics: { recipients: 5 } },
        ],
      },
    },
    links: { self: "https://a.klaviyo.com/api/campaign-values-reports/" },
  };

  it("adds a campaign's messages up, numbers as strings included, rows without an id dropped", () => {
    const rows = parseValuesReport(values, "campaign");
    expect(rows).toHaveLength(2);
    const c1 = rows.find((r) => r.id === "C1")!;
    expect(c1.messages).toBe(2);
    expect(c1.stats).toMatchObject({ recipients: 2000, delivered: 1980, opensUnique: 900, clicksUnique: 100, conversions: 20, revenue: 1440.5, unsubscribes: 3, spamComplaints: 1 });
    expect(rates(c1.stats).openRate).toBeCloseTo(900 / 1980);
    expect(rows.find((r) => r.id === "C2")).toMatchObject({ channel: "sms", stats: { recipients: 500, revenue: 120.25 } });
  });

  it("reads the list wherever it sits: data as a list, or results at the top", () => {
    expect(parseValuesReport({ data: [{ attributes: { results: [{ groupings: { flow_id: "F1" }, statistics: { conversion_value: 10 } }] } }] }, "flow")[0]).toMatchObject({ id: "F1", stats: { revenue: 10 } });
    expect(parseValuesReport({ results: [{ flow_id: "F2", statistics: { recipients: 7 } }] }, "flow")[0]).toMatchObject({ id: "F2", stats: { recipients: 7 } });
    expect(parseValuesReport({}, "flow")).toEqual([]);
  });

  it("turns a rate back into a count when only the rate came", () => {
    const [r] = parseValuesReport({ data: { attributes: { results: [{ groupings: { campaign_id: "C9" }, statistics: { delivered: 200, open_rate: 0.5, click_rate: 0.05 } }] } } }, "campaign");
    expect(r.stats.opensUnique).toBe(100);
    expect(r.stats.clicksUnique).toBe(10);
  });

  it("reads a daily flow series, per flow and day, messages added up", () => {
    const series = {
      data: {
        type: "flow-series-report",
        attributes: {
          date_times: ["2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", "2026-11-03T00:00:00-05:00"],
          results: [
            { groupings: { flow_id: "F1", flow_message_id: "a", send_channel: "email" }, statistics: { recipients: [10, 20, 30], conversion_value: [5, 0, 15.5], opens_unique: [4, 8, 12] } },
            { groupings: { flow_id: "F1", flow_message_id: "b", send_channel: "email" }, statistics: { recipients: [1, 1, 1], conversion_value: [1, 1, 1] } },
            { groupings: { flow_id: "F2", flow_message_id: "c", send_channel: "sms" }, statistics: { recipients: [0, 5, 0], conversion_value: [0, 50, 0] } },
          ],
        },
      },
    };
    const rows = parseSeriesReport(series);
    const f1 = rows.find((r) => r.id === "F1")!;
    expect(f1.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(f1.days[0].stats).toMatchObject({ recipients: 11, revenue: 6, opensUnique: 4 });
    expect(sumSince(f1, "2026-11-02")).toMatchObject({ recipients: 52, revenue: 17.5 });
    expect(rows.find((r) => r.id === "F2")!.days[1].stats.revenue).toBe(50);
  });
});

describe("campaigns, flows, lists and metrics as listed", () => {
  it("reads a campaign with its audiences and its message's subject (either revision's shape)", () => {
    const json = {
      data: [
        { type: "campaign", id: "C1", attributes: { name: "Black Friday", status: "Sent", archived: false, audiences: { included: ["L1", "S1"], excluded: [] }, send_time: "2026-11-02T15:00:00+00:00", scheduled_at: null }, relationships: { "campaign-messages": { data: [{ type: "campaign-message", id: "M1" }] } } },
        { type: "campaign", id: "C2", attributes: { name: "Draft", status: "Draft", audiences: { included: [] } }, relationships: { "campaign-messages": { data: [{ type: "campaign-message", id: "M2" }] } } },
      ],
      included: [
        { type: "campaign-message", id: "M1", attributes: { channel: "email", content: { subject: "40% off ends tonight", preview_text: "Last call" } } },
        { type: "campaign-message", id: "M2", attributes: { definition: { channel: "email", content: { subject: "Hello", preview_text: null } } } },
      ],
    };
    const [a, b] = parseCampaigns(json, "email");
    expect(a).toMatchObject({ id: "C1", name: "Black Friday", status: "Sent", sendTime: "2026-11-02T15:00:00+00:00", audienceIds: ["L1", "S1"], subject: "40% off ends tonight", previewText: "Last call", channel: "email" });
    expect(b).toMatchObject({ id: "C2", sendTime: null, subject: "Hello", previewText: null });
  });
  it("finds the Placed Order metric, Shopify's first", () => {
    const json = { data: [{ id: "a", attributes: { name: "Opened Email" } }, { id: "b", attributes: { name: "Placed Order", integration: { name: "API" } } }, { id: "c", attributes: { name: "Placed Order", integration: { name: "Shopify" } } }] };
    expect(placedOrderId(json)).toBe("c");
    expect(placedOrderId({ data: [{ id: "x", attributes: { name: "Viewed Product" } }] })).toBeNull();
  });
  it("reads lists with or without a profile count", () => {
    expect(parseAudiences({ data: { id: "L1", attributes: { name: "Newsletter", profile_count: 1520 } } }, "list")[0]).toMatchObject({ id: "L1", kind: "list", profileCount: 1520 });
    expect(parseAudiences({ data: [{ id: "S1", attributes: { name: "Engaged 90d" } }] }, "segment")[0].profileCount).toBeNull();
  });
});

describe("waiting and retrying", () => {
  it("waits what Retry-After says on a 429, a little more", () => {
    expect(retryDecision({ status: 429, retryAfter: "12", attempt: 0 })).toEqual({ retry: true, waitMs: 12_250 });
  });
  it("stops when the wait is longer than a run can hold, or after the last attempt", () => {
    expect(retryDecision({ status: 429, retryAfter: "3600", attempt: 0 })).toMatchObject({ retry: false });
    expect(retryDecision({ status: 503, attempt: 4 })).toMatchObject({ retry: false });
  });
  it("backs off exponentially on 5xx and network failures, with jitter", () => {
    expect(retryDecision({ status: 503, attempt: 0, random: () => 0 })).toEqual({ retry: true, waitMs: 1000 });
    expect(retryDecision({ status: 500, attempt: 2, random: () => 1 })).toEqual({ retry: true, waitMs: 4500 });
    expect(retryDecision({ status: null, attempt: 1, random: () => 0 })).toEqual({ retry: true, waitMs: 2000 });
    expect(retryDecision({ status: 503, retryAfter: "5", attempt: 0, random: () => 0 })).toEqual({ retry: true, waitMs: 5000 });
  });
  it("never retries a refusal of the key or a bad request", () => {
    for (const status of [400, 401, 403, 404]) expect(retryDecision({ status, attempt: 0 })).toMatchObject({ retry: false });
  });
  it("spaces Reporting API queries 31 seconds apart", () => {
    expect(reportWait(null, 1000)).toBe(0);
    expect(reportWait(1000, 11_000)).toBe(21_000);
    expect(reportWait(1000, 40_000)).toBe(0);
  });
});

describe("the daily rollup", () => {
  const stats = (o: Partial<ReturnType<typeof emptyStats>>) => ({ ...emptyStats(), ...o });
  it("puts campaigns on their send day in the account's time zone and flows on their day, quiet days at zero", () => {
    const days = rollupDays({
      // 02:00 UTC on the 3rd is still the 2nd in New York
      campaigns: [
        { sendTime: "2026-11-03T02:00:00Z", stats: stats({ revenue: 100, recipients: 1000, conversions: 2 }) },
        { sendTime: "2026-11-03T15:00:00Z", stats: stats({ revenue: 50.555, recipients: 500, conversions: 1 }) },
        { sendTime: null, stats: stats({ revenue: 999 }) },
        { sendTime: "2026-10-01T15:00:00Z", stats: stats({ revenue: 999 }) },
      ],
      flows: [{ id: "F1", days: [{ date: "2026-11-02", stats: stats({ revenue: 20, recipients: 40, conversions: 1 }) }, { date: "2026-11-05", stats: stats({ revenue: 7 }) }] }],
      tz: "America/New_York",
      from: "2026-11-01",
      to: "2026-11-04",
    });
    expect(days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(days[0]).toMatchObject({ revenue: 0, sends: 0, campaignsSent: 0 });
    expect(days[1]).toMatchObject({ campaignRevenue: 100, flowRevenue: 20, revenue: 120, campaignRecipients: 1000, flowRecipients: 40, sends: 1040, campaignsSent: 1, conversions: 3 });
    expect(days[2]).toMatchObject({ campaignRevenue: 50.56, revenue: 50.56, campaignsSent: 1 });
    expect(days[3].revenue).toBe(0);
  });
  it("reads a day in any time zone, New York when unknown", () => {
    expect(dayIn("2026-11-03T02:00:00Z", "UTC")).toBe("2026-11-03");
    expect(dayIn("2026-11-03T02:00:00Z", "US/Eastern")).toBe("2026-11-02");
    expect(dayIn("2026-11-03T02:00:00Z", "Not/AZone")).toBe("2026-11-02");
  });
});

describe("the line every agent reads", () => {
  const now: EmailWindow = { revenue: 12500, campaignRevenue: 5000, flowRevenue: 7500, sends: 42000, campaignsSent: 9, openRate: 0.412, clickRate: 0.021 };
  const before: EmailWindow = { ...now, revenue: 10000 };
  it("says revenue against the 30 days before, the share of the store, rates and the last 3 campaigns", () => {
    const line = emailContextLine({
      account: "Crust Pizza",
      currency: "USD",
      now,
      before,
      storeRevenue: 50000,
      through: "2026-11-10",
      recent: [1, 2, 3, 4].map((i) => ({ name: `Campaign ${i}`, channel: i === 2 ? "sms" : "email", sendTime: `2026-11-0${i}T15:00:00Z`, subject: i === 2 ? null : `Subject ${i}`, recipients: 1000 * i, openRate: 0.4, clickRate: 0.02, revenue: 300 * i, conversions: i })),
    });
    expect(line).toContain("Klaviyo, Crust Pizza; read only, data through 2026-11-10");
    expect(line).toContain("$12,500 attributed revenue (+25% vs the 30 days before), 25% of the store's revenue");
    expect(line).toContain("open rate 41.2%, click rate 2.1%");
    expect(line).toContain('email "Campaign 1", subject "Subject 1": 1,000 recipients, open 40.0%, click 2.0%, $300 from 1 orders');
    expect(line).toContain('SMS "Campaign 2": 2,000 recipients');
    expect(line).not.toContain("Campaign 4");
    expect(line).not.toMatch(/—/);
  });
  it("is empty with nothing sent and nothing earned", () => {
    expect(emailContextLine({ account: null, currency: null, now: { ...now, revenue: 0, sends: 0 }, before: null, recent: [] })).toBe("");
  });
  it("leaves the change out without a before, and names other currencies", () => {
    const line = emailContextLine({ account: null, currency: "EUR", now, before: null, recent: [] });
    expect(line).toContain("EUR 12,500 attributed revenue (campaigns");
    expect(line).not.toContain("vs the 30 days before");
  });
  it("rates are null with nothing delivered", () => {
    expect(rates(emptyStats())).toEqual({ openRate: null, clickRate: null });
  });
});
