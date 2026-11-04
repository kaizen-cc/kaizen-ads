import { describe, expect, it } from "vitest";
import { quotesOf, reviewBankOf, splitBible, statsOf } from "@/lib/bible-sections";
import { detectApps, initialed, placeReviewBank, renderReviewBank, type ReviewBank } from "@/lib/review-bank";

const BANK: ReviewBank = {
  collectedAt: "2026-11-04T15:00:00Z",
  read: 84,
  sources: [
    { source: "Judge.me (store)", found: true, count: 61, rating: 4.8, note: "" },
    { source: "Google", found: false, count: null, rating: null, note: "Needs a Places key; read on the web instead." },
  ],
  picks: [
    { text: "The snaps keep everything in place | even after washing.", stars: "5", who: "Alana C.", source: "Judge.me", date: "Oct 2026", link: "https://example.com/r/1", profile: "B · Made-Bed Perfectionist", angle: "Stays put", use: "OK" },
    { text: "Best sheets I've owned.", stars: "", who: "Sam R.", source: "Instagram comment", date: "", link: "", profile: "", angle: "Quality", use: "Needs client sign-off" },
  ],
  critical: [{ text: "Too warm for summer.", stars: "2", who: "Lukas B.", source: "Trustpilot", date: "Sep 2026", link: "", theme: "Runs warm" }],
};

const BIBLE = `# X — Brand Bible

## 4. Proof and voice

### 4a. Claims

Claims.

### 4b. Review bank

Old thin bank.

### 4c. Voice

Voice rules.

## 5. Look and feel

Colors.
`;

describe("the collected review bank", () => {
  it("replaces the 4b subsection and is read back as cards", () => {
    const md = placeReviewBank(BIBLE, renderReviewBank(BANK));
    expect(md).not.toContain("Old thin bank");
    expect(md).toContain("Voice rules");
    const sections = splitBible(md);
    expect(statsOf(sections).reviews).toBe(2);
    const bank = reviewBankOf(sections)!;
    const [main, critics] = bank.body.split(/\*\*What critics say\*\*[^\n]*/i);
    const q = quotesOf(main);
    // A pipe in the words doesn't break the table
    expect(q[0]).toMatchObject({ who: "Alana C. · Judge.me", stars: "5", link: "https://example.com/r/1", profile: "B · Made-Bed Perfectionist", angle: "Stays put", use: "ok" });
    expect(q[0].quote).toContain("in place");
    expect(q[1]).toMatchObject({ stars: "", use: "check" });
    expect(quotesOf(critics)[0]).toMatchObject({ quote: "Too warm for summer.", stars: "2", angle: "Runs warm" });
  });

  it("goes after section 4 when there's no bank yet", () => {
    const md = placeReviewBank("## 4. Proof\n\nText.\n\n## 5. Look\n\nColors.", renderReviewBank(BANK));
    expect(md.indexOf("Review bank")).toBeGreaterThan(md.indexOf("## 4. Proof"));
    expect(md.indexOf("Review bank")).toBeLessThan(md.indexOf("## 5. Look"));
  });

  it("shows people by first name and initial", () => {
    expect(initialed("Alana Christensen")).toBe("Alana C.");
    expect(initialed("  ")).toBe("Customer");
  });

  it("spots the store's review apps", () => {
    const apps = detectApps(`<script>Shopify.shop = "sierra-dreams.myshopify.com";</script><div class="jdgm-widget"></div><div data-oke-reviews-subscriber-id="0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"></div>`);
    expect(apps.shop).toBe("sierra-dreams.myshopify.com");
    expect(apps.judgeme).toBe(true);
    expect(apps.okendo).toBe("0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
    expect(apps.yotpo).toBeNull();
  });
});
