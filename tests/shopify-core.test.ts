import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { beforeAfter, channelOf, dayRanges, isFirstOrder, mer, monthly, nextBackfillWindow, ordersToDays, readState, shopDomain, shopifyFromHtml, signState, sourceOf, totalsFor, validQueryHmac, validWebhookHmac, windowRows, type ShopOrder, type StoreDay } from "@/lib/shopify/core";

const m = (n: number) => ({ shopMoney: { amount: String(n) } });
const order = (o: Partial<ShopOrder> & { id: string; createdAt: string }): ShopOrder => ({ subtotalPriceSet: m(100), totalPriceSet: m(110), totalDiscountsSet: m(10), totalRefundedSet: m(0), totalTaxSet: m(5), totalShippingPriceSet: m(5), ...o });

describe("shopDomain", () => {
  it("reads every way a store is written", () => {
    expect(shopDomain("Aldecoa")).toBe("aldecoa.myshopify.com");
    expect(shopDomain("https://aldecoa.myshopify.com/admin")).toBe("aldecoa.myshopify.com");
    expect(shopDomain("https://admin.shopify.com/store/sierra-dreams/orders")).toBe("sierra-dreams.myshopify.com");
    expect(shopDomain("aldecoacoffee.com")).toBeNull();
    expect(shopDomain("")).toBeNull();
  });
});

describe("OAuth checks", () => {
  const secret = "hush";
  it("accepts Shopify's signed query and refuses a changed one", () => {
    const p = new URLSearchParams({ shop: "a.myshopify.com", code: "abc", timestamp: "1700000000", state: "s" });
    const msg = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    p.set("hmac", createHmac("sha256", secret).update(msg).digest("hex"));
    expect(validQueryHmac(p, secret)).toBe(true);
    p.set("shop", "evil.myshopify.com");
    expect(validQueryHmac(p, secret)).toBe(false);
  });
  it("checks webhook signatures", () => {
    const body = '{"id":1}';
    const sig = createHmac("sha256", secret).update(body).digest("base64");
    expect(validWebhookHmac(body, sig, secret)).toBe(true);
    expect(validWebhookHmac(body + " ", sig, secret)).toBe(false);
    expect(validWebhookHmac(body, null, secret)).toBe(false);
  });
  it("signs our state, expires it and refuses tampering", () => {
    const s = signState({ client: "c1", shop: "a.myshopify.com", from: "team", nonce: "n", exp: 2000 }, secret);
    expect(readState(s, secret, 1000)?.client).toBe("c1");
    expect(readState(s, secret, 3000)).toBeNull();
    expect(readState(s, "other", 1000)).toBeNull();
    const [body, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ client: "c2", shop: "a.myshopify.com", from: "team", nonce: "n", exp: 2000 })).toString("base64url");
    expect(readState(`${forged}.${sig}`, secret, 1000)).toBeNull();
    expect(readState(`${body}.${sig}`, secret, 1000)).not.toBeNull();
  });
});

describe("orders into days", () => {
  it("sums each day in the store's time zone, skipping test and cancelled orders and duplicates", () => {
    const days = ordersToDays(
      [
        // 02:00 UTC on Mar 2 is Mar 1 in Los Angeles
        order({ id: "1", createdAt: "2026-03-02T02:00:00Z", totalRefundedSet: m(20), customerJourneySummary: { customerOrderIndex: 0, lastVisit: { utmParameters: { source: "facebook", medium: "paid" } } } }),
        order({ id: "1", createdAt: "2026-03-02T02:00:00Z" }),
        order({ id: "2", createdAt: "2026-03-02T18:00:00Z", sourceName: "pos", customerJourneySummary: { customerOrderIndex: 3 } }),
        order({ id: "3", createdAt: "2026-03-02T18:00:00Z", test: true }),
        order({ id: "4", createdAt: "2026-03-02T18:00:00Z", cancelledAt: "2026-03-03T00:00:00Z" }),
      ],
      "America/Los_Angeles",
    );
    const a = days.get("2026-03-01")!;
    expect(a.orders).toBe(1);
    expect(a.gross_sales).toBe(110);
    expect(a.net_sales).toBe(80);
    expect(a.total_sales).toBe(90);
    expect(a.new_customers).toBe(1);
    expect(a.by_channel.sources.Meta).toEqual({ orders: 1, sales: 90 });
    const b = days.get("2026-03-02")!;
    expect(b.orders).toBe(1);
    expect(b.returning_customers).toBe(1);
    expect(b.by_channel.channels["Point of sale"].orders).toBe(1);
  });
  it("tells a first order without Shopify's index", () => {
    expect(isFirstOrder(order({ id: "1", createdAt: "2026-01-01T10:00:00Z", customer: { numberOfOrders: "1", createdAt: "2024-01-01T00:00:00Z" } }))).toBe(true);
    expect(isFirstOrder(order({ id: "1", createdAt: "2026-01-01T10:00:00Z", customer: { numberOfOrders: "4", createdAt: "2024-01-01T00:00:00Z" } }))).toBe(false);
    expect(isFirstOrder(order({ id: "1", createdAt: "2026-01-01T10:00:00Z", customer: null }))).toBeNull();
  });
  it("names channels and sources", () => {
    expect(channelOf("web")).toBe("Online store");
    expect(channelOf("subscription_contract")).toBe("Subscriptions");
    expect(channelOf("580111")).toBe("Other apps");
    expect(sourceOf({ customerJourneySummary: { lastVisit: { landingPage: "/?gclid=abc" } } })).toBe("Google Ads");
    expect(sourceOf({ customerJourneySummary: { lastVisit: { utmParameters: { source: "klaviyo" } } } })).toBe("Email & SMS");
    expect(sourceOf({ customerJourneySummary: null })).toBe("Unknown");
  });
  it("writes a zero for a stored day that lost its orders, and only days inside the window", () => {
    const days = ordersToDays([order({ id: "1", createdAt: "2026-03-05T15:00:00Z" }), order({ id: "2", createdAt: "2026-04-05T15:00:00Z" })], "America/New_York");
    const rows = windowRows(days, { start: "2026-03-01", end: "2026-04-01" }, ["2026-03-04", "2026-03-05"]);
    expect(rows.map((r) => [r.date, r.totals.orders])).toEqual([
      ["2026-03-04", 0],
      ["2026-03-05", 1],
    ]);
  });
});

describe("windows", () => {
  it("walks back a month at a time to the first order", () => {
    expect(nextBackfillWindow(null, "2025-01-10", "2026-03-15")).toEqual({ start: "2026-02-13", end: "2026-03-16" });
    expect(nextBackfillWindow({ before: "2025-02-01" }, "2025-01-10", "2026-03-15")).toEqual({ start: "2025-01-10", end: "2025-02-01" });
    expect(nextBackfillWindow({ before: "2025-01-10" }, "2025-01-10", "2026-03-15")).toBeNull();
    expect(nextBackfillWindow({ before: "2026-03-01" }, "2020-01-01", "2026-03-15", 2)).toEqual({ start: "2026-02-27", end: "2026-03-01" });
  });
  it("groups days into ranges", () => {
    expect(dayRanges(["2026-03-03", "2026-03-01", "2026-03-02", "2026-03-10", "bad"])).toEqual([
      { start: "2026-03-01", end: "2026-03-04" },
      { start: "2026-03-10", end: "2026-03-11" },
    ]);
  });
});

describe("what the numbers say", () => {
  const store: StoreDay[] = [];
  for (let d = new Date("2026-01-01T12:00:00Z"); d < new Date("2026-07-01T12:00:00Z"); d = new Date(d.getTime() + 86_400_000)) {
    const date = d.toISOString().slice(0, 10);
    store.push({ date, orders: date < "2026-04-01" ? 1 : 3, revenue: date < "2026-04-01" ? 100 : 300, net_sales: 0, new_customers: 1, returning_customers: 0 });
  }
  const spend = [{ date: "2026-05-01", platform: "meta", spend: 1000 }];

  it("works out totals, AOV and MER", () => {
    const t = totalsFor(store, spend, { start: "2026-05-01", end: "2026-05-31" });
    expect(t.revenue).toBe(9300);
    expect(t.aov).toBe(100);
    expect(t.adSpend).toBe(1000);
    expect(t.mer).toBe(9.3);
    expect(mer(100, 0)).toBeNull();
  });
  it("compares before and after a date by run-rate", () => {
    const r = beforeAfter(store, spend, "2026-04-01", { today: "2026-07-01", historyFrom: "2026-01-01" });
    if ("error" in r) throw new Error(r.error);
    expect(r.before.start).toBe("2026-01-01");
    expect(r.after.end).toBe("2026-06-29"); // 90 days each side: as many as there are before
    expect(r.growthPct).toBe(200);
    expect(r.months.at(-1)?.month).toBe("2026-06");
    expect(beforeAfter(store, spend, "2026-08-01", { today: "2026-07-01", historyFrom: null })).toHaveProperty("error");
  });
  it("compares everything before with everything since", () => {
    const r = beforeAfter(store, spend, "2026-06-01", { today: "2026-07-01", historyFrom: "2026-01-01", whole: true });
    if ("error" in r) throw new Error(r.error);
    expect(r.before).toMatchObject({ start: "2026-01-01", end: "2026-05-31" });
  });
  it("sums months", () => {
    const ms = monthly(store, spend);
    expect(ms[0]).toMatchObject({ month: "2026-01", revenue: 3100, mer: null });
    expect(ms.find((x) => x.month === "2026-05")?.mer).toBe(9.3);
  });
});

describe("Shopify storefronts", () => {
  it("finds the store behind a site", () => {
    expect(shopifyFromHtml('<script>Shopify.shop = "aldecoa.myshopify.com";</script>')).toEqual({ shopify: true, shop: "aldecoa.myshopify.com" });
    expect(shopifyFromHtml('<link href="//cdn.shopify.com/s/files/x.css">')).toEqual({ shopify: true, shop: null });
    expect(shopifyFromHtml("<html>wordpress</html>")).toEqual({ shopify: false, shop: null });
  });
});
