import { describe, expect, it } from "vitest";
import { cleanLocation, combinedNote, detectLocationProps, isLocationLike, locationBreakdown, locationChecks, locationPropsOf, looksMultiLocation, parseEventsPage, parseLocationAggregate, resolveMessages, rollupEvents, suggestedProp, UNKNOWN_LOCATION, type LocationRow } from "@/lib/klaviyo/locations";

const row = (o: Partial<LocationRow> & Pick<LocationRow, "location" | "campaignId" | "revenue">): LocationRow => ({ metricId: "toast", date: "2026-10-05", messageId: o.campaignId ?? "m", flowId: null, conversions: 1, ...o });

describe("location properties", () => {
  it("knows location-like names whatever their case and punctuation", () => {
    for (const k of ["Location", "Location Name", "store_name", "$location", "Restaurant Name", "extra.Store"]) expect(isLocationLike(k)).toBe(true);
    for (const k of ["$value", "Order ID", "Items"]) expect(isLocationLike(k)).toBe(false);
  });

  it("finds the property with several locations and suggests it", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ "Location Name": ["Crust Fremont", "Crust Union City", "Crust Hayward"][i % 3], $value: 20 + i, "Order ID": `o${i}`, $extra: { Store: "x" } }));
    const c = detectLocationProps(events);
    expect(c[0].prop).toBe("Location Name");
    expect(c[0].distinct).toBe(3);
    expect(c[0].samples).toContain("Crust Fremont");
    expect(suggestedProp(c)?.prop).toBe("Location Name");
    expect(looksMultiLocation({ toast: c })).toBe(true);
    // One store everywhere isn't multi-location
    expect(looksMultiLocation({ x: detectLocationProps(events.map(() => ({ Store: "Only one" }))) })).toBe(false);
    // An order id is never offered
    expect(c.some((x) => x.prop === "Order ID")).toBe(false);
  });

  it("cleans locations and saved props", () => {
    expect(cleanLocation("  Crust   Fremont ")).toBe("Crust Fremont");
    expect(cleanLocation(null)).toBe(UNKNOWN_LOCATION);
    expect(locationPropsOf({ a: "Location", b: "", c: 3 })).toEqual({ a: "Location" });
    expect(locationPropsOf(null)).toEqual({});
  });
});

describe("reading Klaviyo's answers", () => {
  it("reads events with their attribution and adds them up", () => {
    const json = {
      data: [
        { type: "event", id: "e1", attributes: { datetime: "2026-10-05T18:00:00+00:00", event_properties: { Location: "Fremont", $value: 30.5 } }, relationships: { attributions: { data: [{ type: "attribution", id: "a1" }] } } },
        { type: "event", id: "e2", attributes: { datetime: "2026-10-05T19:00:00+00:00", event_properties: { Location: "Fremont", $value: 10 } }, relationships: { attributions: { data: [{ type: "attribution", id: "a2" }] } } },
        { type: "event", id: "e3", attributes: { datetime: "2026-10-05T20:00:00+00:00", event_properties: { Location: "Hayward", $value: 99 } }, relationships: { attributions: { data: [] } } },
      ],
      included: [
        { type: "attribution", id: "a1", relationships: { campaign: { data: { type: "campaign", id: "C1" } }, "campaign-message": { data: { type: "campaign-message", id: "CM1" } } } },
        { type: "attribution", id: "a2", relationships: { campaign: { data: { type: "campaign", id: "C1" } }, "campaign-message": { data: { type: "campaign-message", id: "CM1" } } } },
      ],
    };
    const ev = parseEventsPage(json, "Location", (iso) => iso.slice(0, 10));
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ location: "Fremont", value: 30.5, campaignId: "C1", messageId: "CM1" });
    expect(ev[2].messageId).toBeNull();
    const rows = rollupEvents("toast", ev);
    expect(rows).toEqual([{ metricId: "toast", date: "2026-10-05", location: "Fremont", messageId: "CM1", campaignId: "C1", flowId: null, conversions: 2, revenue: 40.5 }]);
  });

  it("reads an aggregate grouped by message and location, and refuses one grouped by message alone", () => {
    const ok = { data: { attributes: { dates: ["2026-10-05T00:00:00", "2026-10-06T00:00:00"], data: [{ dimensions: ["MSG1", "Fremont"], measurements: { sum_value: [10, 0], count: [1, 0] } }] } } };
    expect(parseLocationAggregate(ok, "toast")).toEqual([{ metricId: "toast", date: "2026-10-05", location: "Fremont", messageId: "MSG1", campaignId: null, flowId: null, conversions: 1, revenue: 10 }]);
    const one = { data: { attributes: { dates: ["2026-10-05"], data: [{ dimensions: ["MSG1"], measurements: { sum_value: [10], count: [1] } }] } } };
    expect(parseLocationAggregate(one, "toast")).toBeNull();
    // An SMS campaign's message id differs from its campaign id: both match
    const rows = resolveMessages(parseLocationAggregate(ok, "toast")!, [{ campaignId: "C9", messageId: "MSG1" }]);
    expect(rows[0].campaignId).toBe("C9");
  });
});

describe("the breakdown", () => {
  const campaigns = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `Campaign ${i}`, sendDay: `2026-10-0${i + 1}` }));
  const rows: LocationRow[] = [
    ...campaigns.map((c, i) => row({ location: "Fremont", campaignId: c.id, revenue: 100 + i * 10 })),
    row({ location: "Hayward", campaignId: "c0", revenue: 50, conversions: 2 }),
    row({ location: "Union City", campaignId: "c7", revenue: 5 }),
    row({ metricId: "pos", location: "Oakland", campaignId: "c1", revenue: 70, conversions: 3 }),
    // Not sent in the period: left out
    row({ location: "Fremont", campaignId: "zz", revenue: 999 }),
  ];
  const b = locationBreakdown({ metrics: [{ id: "toast", name: "Toast" }, { id: "pos", name: "Custom POS" }], rows, campaigns })!;

  it("totals each metric and sums them, not deduplicated", () => {
    expect(b.metrics.map((m) => m.name)).toEqual(["Toast", "Custom POS"]);
    const toast = b.metrics[0];
    expect(toast.revenue).toBe(1080 + 50 + 5);
    expect(toast.conversions).toBe(8 + 2 + 1);
    expect(b.combined).toEqual({ conversions: 11 + 3, revenue: 1135 + 70 });
    expect(b.note).toBe(combinedNote(["Toast", "Custom POS"]));
    expect(b.note).toContain("Toast + Custom POS summed, not deduplicated");
  });

  it("keeps the best six campaigns in send order and folds the rest", () => {
    const toast = b.metrics[0];
    expect(toast.columns).toHaveLength(7);
    expect(toast.columns.at(-1)).toMatchObject({ id: "other", count: 2 });
    // c1 (110) and c2 (120) earned least, so they fold into Other
    expect(toast.columns.slice(0, 6).map((c) => c.id)).toEqual(["c0", "c3", "c4", "c5", "c6", "c7"]);
    const fremont = toast.rows.find((r) => r.location === "Fremont")!;
    expect(fremont.cells.at(-1)).toBe(110 + 120);
    expect(toast.rows.find((r) => r.location === "Union City")!.cells[0]).toBeNull();
    // Rows and columns add up to the same total
    const colSum = toast.columns.reduce((s, c) => s + c.revenue, 0);
    expect(Math.round(colSum)).toBe(toast.revenue);
  });

  it("ranks locations and says it in a line", () => {
    const toast = b.metrics[0];
    expect(toast.ranked.map((x) => x.location)).toEqual(["Fremont", "Hayward", "Union City"]);
    expect(toast.ranked[0].rank).toBe(1);
    expect(toast.summary).toContain("Fremont led");
    expect(toast.summary).toContain("Union City had the least");
  });

  it("flags a breakdown that doesn't add up and orders without a location", () => {
    expect(locationChecks(b, { toast: 1135, pos: 70 }, "USD")).toEqual([]);
    expect(locationChecks(b, { toast: 2000 }, "USD")[0]).toContain("57%");
    const unknown = locationBreakdown({ metrics: [{ id: "toast", name: "Toast" }], rows: [row({ location: UNKNOWN_LOCATION, campaignId: "c0", revenue: 50 }), row({ location: "Fremont", campaignId: "c0", revenue: 50 })], campaigns });
    expect(locationChecks(unknown, {}, "USD")[0]).toContain("carries no location");
  });

  it("is null with nothing to show", () => {
    expect(locationBreakdown({ metrics: [{ id: "toast", name: "Toast" }], rows: [], campaigns })).toBeNull();
  });
});

describe("days in the account's time zone", () => {
  it("starts a day at local midnight, across clock changes too", async () => {
    const { dayStartUtc } = await import("@/lib/klaviyo/locations");
    expect(dayStartUtc("2026-10-05", "America/New_York")).toBe("2026-10-05T04:00:00+00:00");
    expect(dayStartUtc("2026-12-05", "America/New_York")).toBe("2026-12-05T05:00:00+00:00");
    expect(dayStartUtc("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00+00:00");
    expect(dayStartUtc("2026-10-05", "America/Los_Angeles")).toBe("2026-10-05T07:00:00+00:00");
    expect(dayStartUtc("2026-10-05", "UTC")).toBe("2026-10-05T00:00:00+00:00");
  });
});

describe("the board's dates", () => {
  it("covers this month, last month and rolling windows", async () => {
    const { locationWindow } = await import("@/lib/klaviyo/locations");
    expect(locationWindow("month", "2026-11-16")).toEqual({ start: "2026-11-01", end: "2026-11-16" });
    expect(locationWindow("last-month", "2026-03-05")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(locationWindow("7d", "2026-11-16")).toEqual({ start: "2026-11-10", end: "2026-11-16" });
    expect(locationWindow("30d", "2026-11-16")).toEqual({ start: "2026-10-18", end: "2026-11-16" });
  });
});
