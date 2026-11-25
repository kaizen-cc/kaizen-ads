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
