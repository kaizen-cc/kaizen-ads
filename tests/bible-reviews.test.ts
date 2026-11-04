import { describe, expect, it } from "vitest";
import { quotesOf, reviewBankOf, splitBible, statsOf } from "@/lib/bible-sections";

// The v3 Brand Bible puts the review bank under section 4 as "### 4b. Review bank", as Sierra Dreams' Bible came back
const BIBLE = `# Sierra Dreams — Brand Bible

## 1. The engagement

Scope and goals.

## 4. Proof and voice

### 4a. Claims

Claims table.

### 4b. Review bank

**Sources and counts**
- The store's review app shows product ratings: Lustre Sheets 4.8.
- Google and Trustpilot: no Sierra Dreams page found.

| RV# | Review (word for word) | Stars | Shown as | Source, date, link | Profile | Angle | Use in ads |
|---|---|---|---|---|---|---|---|
| RV#1 | “I love how the snaps keep the sheets and duvet in perfect symmetry when you make the bed.” | Not shown | Alana C. · website | Site testimonial, read Nov 4 | B · Made-Bed Perfectionist | Sheets that stay together | Needs client sign-off |
| RV#2 | “WHY DIDN'T I THINK OF THIS?!?! Genius.” | 5 | John A. · website | [Align System page](https://sierradreams.com/pages/the-align-system), read Nov 4 | C · Thoughtful Gifter | Snap discovery | OK |
| RV#3 | “Too warm for me in summer.” | 2 | Lukas B. · Google | Google, Oct 2 | D · Temperature-First Sleeper | Objection | Can't use: a complaint |

### 4c. Voice

Voice rules.

## 5. Look and feel

Colors.
`;

describe("the v3 review bank", () => {
  const sections = splitBible(BIBLE);

  it("finds the bank inside section 4", () => {
    const bank = reviewBankOf(sections);
    expect(bank?.section.title).toBe("Proof and voice");
    expect(bank?.body.startsWith("**Sources and counts**")).toBe(true);
    // The next subsection isn't part of it
    expect(bank?.body.includes("Voice rules")).toBe(false);
  });

  it("counts its reviews on the cover", () => {
    expect(statsOf(sections).reviews).toBe(3);
  });

  it("reads each row into a card", () => {
    const q = quotesOf(reviewBankOf(sections)!.body);
    expect(q).toHaveLength(3);
    expect(q[0]).toMatchObject({ who: "Alana C. · website", stars: "", profile: "B · Made-Bed Perfectionist", angle: "Sheets that stay together", use: "check" });
    expect(q[0].quote.startsWith("I love how the snaps")).toBe(true);
    expect(q[1]).toMatchObject({ stars: "5", use: "ok", link: "https://sierradreams.com/pages/the-align-system", source: "Align System page, read Nov 4" });
    expect(q[2].use).toBe("no");
  });

  it("still reads an older bank that had its own section", () => {
    const old = splitBible(`## 6. Review bank\n\n| Quote | Who | OK for ads |\n|---|---|---|\n| "Great sheets" | Ann B. | Yes |\n`);
    expect(statsOf(old).reviews).toBe(1);
    expect(quotesOf(reviewBankOf(old)!.body)[0]).toMatchObject({ quote: "Great sheets", who: "Ann B.", use: "ok" });
  });
});
