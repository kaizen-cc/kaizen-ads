import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { PRICE_PLACEHOLDER, cleanDocument, docFileName, guardPrice, hasBody, noDashes, packageKnowledge, parseAmount, plainText, scrubPrices, storedPrices, toLoose, type StoredPrice } from "@/lib/documents/core";
import { KaizenDocument } from "@/lib/documents/doc";

const BASIC: StoredPrice = { label: "Basic", amount: 1500, cadence: "month", source: "package" };
const opts = { stored: [BASIC], client: "Sierra Dreams", preparedBy: "Kaizen" };

describe("prices", () => {
  it("reads amounts the way people write them", () => {
    expect(parseAmount("$1,500")).toBe(1500);
    expect(parseAmount("1500/mo")).toBe(1500);
    expect(parseAmount("$1.5k")).toBe(1500);
    expect(parseAmount("USD 2,000.00")).toBe(2000);
    expect(parseAmount("call us")).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it("keeps a stored price and marks anything else to confirm", () => {
    expect(guardPrice({ item: "Email Basic", price: "$1,500" }, [BASIC])).toMatchObject({ price: "$1,500", placeholder: false, source: "package", cadence: "per month" });
    expect(guardPrice({ item: "Email Basic", price: "$1,200" }, [BASIC])).toMatchObject({ price: PRICE_PLACEHOLDER, placeholder: true, source: null });
    expect(guardPrice({ item: "Setup" }, [])).toMatchObject({ price: PRICE_PLACEHOLDER, placeholder: true });
    expect(guardPrice({ item: "" }, [BASIC])).toBeNull();
  });

  it("fills a line that names a stored package but gives no price", () => {
    expect(guardPrice({ item: "Basic package" }, [BASIC])).toMatchObject({ price: "$1,500", placeholder: false });
  });

  it("scrubs dollar amounts from text unless they're allowed", () => {
    const out = scrubPrices("Basic is $1,500 a month, Gold is $4,000.", [1500]);
    expect(out.text).toBe(`Basic is $1,500 a month, Gold is [${PRICE_PLACEHOLDER.toLowerCase()}].`);
    expect(out.scrubbed).toBe(1);
  });

  it("collects stored prices from package records and Stripe billing", () => {
    const got = storedPrices(
      [
        { label: "Basic", price_monthly: 1500, price_one_time: null },
        { label: "Sprint", price_monthly: null, price_one_time: 3000 },
        { label: "Gold", price_monthly: null, price_one_time: null },
      ],
      { amount: 1200 },
      "Email Marketing",
    );
    expect(got.map((p) => [p.label, p.amount, p.cadence, p.source])).toEqual([
      ["Basic", 1500, "month", "package"],
      ["Sprint", 3000, "one_time", "package"],
      ["Email Marketing (current billing)", 1200, "month", "stripe"],
    ]);
  });
});

describe("cleanDocument", () => {
  it("makes a Scope of Work strict: limits, dashes out, prices guarded, placeholders listed", () => {
    const { doc, placeholders } = cleanDocument(
      {
        kind: "sow",
        title: "Scope of Work — Email Basic",
        summary: "Monthly email for Sierra Dreams. Basic is $1,500; SMS add-on is $300.",
        sections: [{ heading: "What we do", body: "Two campaigns a week", bullets: ["a", "b"] }, { heading: "", body: "", bullets: [] }],
        deliverables: Array.from({ length: 30 }, (_, i) => ({ item: `Item ${i}`, qty: "1" })),
        pricing: [
          { item: "Email Basic", price: "$1,500", cadence: "per month" },
          { item: "SMS add-on", price: "$300" },
        ],
        stats: [{ value: "12", label: "flows" }, { value: "", label: "x" }],
      },
      opts,
    );
    expect(doc.kind).toBe("sow");
    expect(doc.title).toBe("Scope of Work, Email Basic");
    expect(doc.sections).toHaveLength(1);
    expect(doc.deliverables).toHaveLength(16);
    expect(doc.stats).toHaveLength(1);
    expect(doc.summary).toContain("$1,500");
    expect(doc.summary).not.toContain("$300");
    expect(doc.pricing.map((p) => p.price)).toEqual(["$1,500", PRICE_PLACEHOLDER]);
    expect(placeholders).toEqual(["SMS add-on", "1 price in the text"]);
    expect(hasBody(doc)).toBe(true);
  });

  it("lets a handoff quote the client's own figures, never a made-up price", () => {
    const { doc } = cleanDocument({ kind: "handoff", title: "Sprint handoff", summary: "Email made $12,400 this month. Basic would be $999." }, { ...opts, dataFigures: [12400] });
    expect(doc.summary).toContain("$12,400");
    expect(doc.summary).not.toContain("$999");
  });

  it("falls back to a one-pager and knows an empty document", () => {
    const { doc } = cleanDocument({ kind: "memo", title: "" }, opts);
    expect(doc.kind).toBe("one_pager");
    expect(doc.title).toBe("One-pager");
    expect(hasBody(doc)).toBe(false);
  });

  it("goes back to editable text and is drawn the same again (a stored price matched again)", () => {
    const { doc } = cleanDocument({ kind: "sow", title: "SOW", summary: "s", pricing: [{ item: "Email Basic", price: "$1,500" }, { item: "Extra" }] }, opts);
    const again = cleanDocument(toLoose(doc), opts).doc;
    expect(again.pricing).toEqual(doc.pricing);
    expect(again.title).toBe(doc.title);
  });

  it("names files and plain text people can read", () => {
    const { doc } = cleanDocument({ kind: "sow", title: "Scope of Work: Email Basic", summary: "Hello", next_steps: ["Sign"] }, opts);
    expect(docFileName(doc)).toBe("Kaizen - Sierra Dreams - Scope of Work Email Basic.pdf");
    expect(plainText(doc)).toContain("Scope of Work: Scope of Work: Email Basic");
    expect(plainText(doc)).toContain("- Sign");
  });

  it("turns dashes into commas but keeps ranges", () => {
    expect(noDashes("Flows — welcome, cart")).toBe("Flows, welcome, cart");
    expect(noDashes("2–3 emails")).toBe("2-3 emails");
  });
});

describe("packageKnowledge", () => {
  it("picks the package items, the tier asked for first", () => {
    const items = [
      { title: "Brand voice", body: "Warm and plain." },
      { title: "Email packages: Silver", body: "Silver: 3 campaigns a week." },
      { title: "Email packages: Basic", body: "Basic: 2 campaigns a week, 4 flows." },
      { title: "Sprint Package", body: "A 6-week setup sprint." },
    ];
    const got = packageKnowledge(items, "Basic");
    expect(got[0].title).toBe("Email packages: Basic");
    expect(got.map((k) => k.title)).not.toContain("Brand voice");
  });
});

describe("the PDF", () => {
  it("draws a document with tables and a placeholder price", async () => {
    const { doc } = cleanDocument(
      {
        kind: "sow",
        title: "Scope of Work: Email Basic",
        period: "December 2026 onward",
        summary: "What we'll do each month.",
        stats: [{ value: "$12,400", label: "Email revenue" }],
        sections: [{ heading: "Approach", body: "Campaigns and flows.", bullets: ["Two campaigns a week"] }],
        deliverables: [{ item: "Campaigns", qty: "8 a month", detail: "Designed and built" }],
        cadence: [{ what: "Report", when: "Monthly" }],
        pricing: [{ item: "Email Basic", price: "$1,500" }, { item: "SMS" }],
        inclusions: ["Design"],
        exclusions: ["Paid ads"],
        next_steps: ["Reply to confirm"],
      },
      opts,
    );
    const pdf = await renderToBuffer(createElement(KaizenDocument, { input: { doc, brand: null } }) as Parameters<typeof renderToBuffer>[0]);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(2000);
  });
});
