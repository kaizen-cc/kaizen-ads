import { describe, expect, it } from "vitest";
import { conversionNounFor, isBookingMetric, nounOf } from "@/lib/channel-reports/core";
import { autoRank, isOrderMetric } from "@/lib/klaviyo/sources";

// Remedy Place sells booked appointments through Zenoti: the report read Shopify's Placed Order and showed zeros. A
// booking metric is found as a revenue source like any order system, and when it's the sale the report calls its
// conversions booked appointments.
describe("a client whose sale is a booking", () => {
  it("finds the booking metric as an order system, never a reminder or a cancellation", () => {
    expect(isOrderMetric("Booked Appointment")).toBe(true);
    expect(isOrderMetric("Appointment Reminder Sent")).toBe(false);
    expect(isOrderMetric("Cancelled Appointment")).toBe(false);
  });
  it("ranks Zenoti first when email earns more on it than on the store", () => {
    const next = autoRank([{ id: "RkJmZK", name: "Placed Order", integration: "Shopify" }], [{ id: "ZEN", name: "Booked Appointment", integration: "Zenoti", revenue: 26652.59, orders: 140 }], 1200, new Map([["RkJmZK", "Shopify"]]));
    expect(next?.map((m) => m.id)).toEqual(["ZEN", "RkJmZK"]);
  });
  it("names its conversions booked appointments", () => {
    expect(isBookingMetric("Booked Appointment")).toBe(true);
    expect(isBookingMetric("No Show Appointment")).toBe(false);
    expect(conversionNounFor("Booked Appointment").title).toBe("Booked appointments");
    expect(conversionNounFor("Placed Order").title).toBe("Orders");
    expect(nounOf({}).many).toBe("orders");
  });
});

describe("every count says booked appointments, and sends are dated in the account's time zone", () => {
  it("the campaign card names the count", async () => {
    const { cardStats } = await import("@/lib/channel-reports/email-cards");
    const { conversionNounFor } = await import("@/lib/channel-reports/core");
    const row = { channel: "email" as const, recipients: 1000, openRate: 0.4, clickRate: 0.02, orders: 36, orderRate: 0.036, revenue: 2933.09 };
    const stat = cardStats(row, "USD", true, conversionNounFor("Booked Appointments")).find((x) => x.key === "orders");
    expect(stat).toMatchObject({ label: "Booked appointments", value: "36", sub: "3.60% booked" });
    expect(cardStats(row, "USD", true).find((x) => x.key === "orders")?.label).toBe("Orders");
  });
  it("a campaign at 4 pm Pacific on Nov 15 stays in Nov 15, and the report says how Klaviyo may date it", async () => {
    const { campaignsIn, edgeSends, edgeLine } = await import("@/lib/channel-reports/core");
    const send = { name: "Gen Pop | Annual Reserve", sendTime: "2026-11-16T00:00:00+00:00", sendDay: "2026-11-15", revenue: 2933.09, recipients: 9000 };
    const mid = { name: "Quarterly Calibrations", sendTime: "2026-11-17T17:00:00+00:00", sendDay: "2026-11-17", revenue: 3986.64, recipients: 9000 };
    const w = { start: "2026-11-16", end: "2026-11-22" };
    expect(campaignsIn([send, mid], w.start, w.end).map((c) => c.name)).toEqual(["Quarterly Calibrations"]);
    const edge = edgeSends([send, mid], w);
    expect(edge).toEqual([{ name: "Gen Pop | Annual Reserve", day: "2026-11-15", utcDay: "2026-11-16", revenue: 2933.09, inWindow: false }]);
    expect(edgeLine({ edgeSends: edge, timezone: "US/Pacific", currency: "USD" })).toBe("Dated in Pacific time: “Gen Pop | Annual Reserve” went out Nov 15 (Nov 16 in UTC), so it's left out of these dates ($2,933); Klaviyo's summary may count it here.");
    expect(edgeLine({ edgeSends: [], timezone: "US/Pacific", currency: "USD" })).toBeNull();
  });
});
