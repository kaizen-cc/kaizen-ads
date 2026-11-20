import { describe, expect, it } from "vitest";
import { addedLines, changeLine, currentVersion, lineOfPlatform, mergeRules, nextVersion, rulesBlock, sameRule, sectionsDiff, styleBanner, topicOf, type StyleRule } from "@/lib/reports/style-core";

const rule = (text: string, at = "2026-11-01T12:00:00Z"): StyleRule => ({ text, topic: topicOf(text), by: "A buyer", at, source: "studio_ask" });

describe("topicOf", () => {
  it("gives one-value topics to metrics, length, tone, format and tiles", () => {
    expect(topicOf("No CPM, they don't care")).toBe("metric:cpm");
    expect(topicOf("Always show CPM")).toBe("metric:cpm");
    expect(topicOf("Keep it short, 5 bullets at most")).toBe("length");
    expect(topicOf("Warm, casual tone")).toBe("tone");
    expect(topicOf("Hand it over as an editable PowerPoint")).toBe("format");
    expect(topicOf("Tiles: Spend, Purchases, Cost per purchase")).toBe("layout:tiles");
    expect(topicOf("Meta tiles: Spend, Purchases")).toBe("layout:meta tiles");
  });
  it("leaves comparisons, creatives and structure to add up", () => {
    expect(topicOf("Compare cost per purchase across the $99, $89, $49 and $7 offers")).toBeNull();
    expect(topicOf("Show the top creatives with previews")).toBeNull();
    expect(topicOf("Show the worst creatives too")).toBeNull();
    expect(topicOf("Lead with the month to date")).toBeNull();
  });
});

describe("mergeRules", () => {
  it("adds new rules, newest last", () => {
    const m = mergeRules([rule("Show the top creatives with previews")], [{ text: "Show the worst creatives too", by: "B", source: "kaizen_ai" }]);
    expect(m.changed).toBe(true);
    expect(m.added).toEqual(["Show the worst creatives too"]);
    expect(m.rules.map((r) => r.text)).toEqual(["Show the top creatives with previews", "Show the worst creatives too"]);
    expect(m.rules[1]).toMatchObject({ by: "B", source: "kaizen_ai", topic: null });
  });
  it("replaces an older rule on the same one-value topic", () => {
    const m = mergeRules([rule("No CPM, they don't care"), rule("Keep it to 5 bullets")], [{ text: "Show CPM again, the client asked", by: "B", source: "studio_ask" }]);
    expect(m.replaced).toEqual([{ was: "No CPM, they don't care", now: "Show CPM again, the client asked" }]);
    expect(m.rules.map((r) => r.text)).toEqual(["Keep it to 5 bullets", "Show CPM again, the client asked"]);
  });
  it("keeps the same rule once and reports no change when it's said again in the same words", () => {
    const m = mergeRules([rule("Compare the offers every month")], [{ text: "compare the offers every month.", by: "B", source: "hand_edit" }]);
    expect(m.changed).toBe(false);
    expect(m.rules).toHaveLength(1);
  });
  it("takes out rules asked to be forgotten", () => {
    const m = mergeRules([rule("No CPM"), rule("Show the worst creatives")], [], ["worst creatives"]);
    expect(m.removed).toEqual(["Show the worst creatives"]);
    expect(m.rules.map((r) => r.text)).toEqual(["No CPM"]);
  });
  it("ignores empty lessons and cleans bullets off the front", () => {
    const m = mergeRules([], [{ text: "  ", by: null, source: "assistant" }, { text: "- Lead with revenue", by: null, source: "assistant" }]);
    expect(m.rules.map((r) => r.text)).toEqual(["Lead with revenue"]);
  });
  it("keeps at most 30 rules, dropping the oldest", () => {
    const many = Array.from({ length: 30 }, (_, i) => rule(`Rule number ${i} about section ${i}`));
    const m = mergeRules(many, [{ text: "A brand new thing to include", by: null, source: "assistant" }]);
    expect(m.rules).toHaveLength(30);
    expect(m.rules[0].text).toBe("Rule number 1 about section 1");
    expect(m.rules.at(-1)?.text).toBe("A brand new thing to include");
  });
  it("says what changed in a line", () => {
    expect(changeLine({ added: ["A"], replaced: [{ was: "B", now: "C" }], removed: ["D"] })).toBe("Added: A. Changed: C. Dropped: D");
    expect(changeLine({ added: [], replaced: [], removed: [] })).toBe("No change");
  });
});

describe("versions", () => {
  const v = (version: number, undone: string | null = null) => ({ version, undone_at: undone });
  it("uses the newest version not undone", () => {
    expect(currentVersion([v(1), v(2), v(3, "2026-11-20")])?.version).toBe(2);
    expect(currentVersion([v(1, "x")])).toBeNull();
    expect(currentVersion([])).toBeNull();
  });
  it("never reuses a number, undone or not", () => {
    expect(nextVersion([v(1), v(2), v(3, "x")])).toBe(4);
    expect(nextVersion([])).toBe(1);
  });
  it("shows who taught it and when, only when there are rules", () => {
    expect(styleBanner({ created_at: "2026-11-20T15:00:00Z", taught_by_name: "Priscila Gomez", rules: [rule("x")] })).toBe("Using this client's report style (updated Nov 20 by Priscila)");
    expect(styleBanner({ created_at: "2026-11-20T15:00:00Z", taught_by_name: null, rules: [] })).toBeNull();
  });
  it("tells the writer every rule, newest wins", () => {
    expect(rulesBlock([])).toBe("");
    const block = rulesBlock([rule("No CPM"), rule("Compare the offers")]);
    expect(block).toContain("- No CPM\n- Compare the offers");
    expect(block).toContain("A later rule wins");
  });
});

describe("lineOfPlatform", () => {
  it("files each platform under its line", () => {
    expect(lineOfPlatform("meta")).toBe("ads");
    expect(lineOfPlatform("tiktok")).toBe("ads");
    expect(lineOfPlatform("google")).toBe("ads");
    expect(lineOfPlatform("klaviyo")).toBe("email");
    expect(lineOfPlatform("social")).toBe("social");
  });
});

describe("what a hand edit changed", () => {
  const before = { headline: "Strong week", summary: "Purchases rose and cost per purchase fell across the account this week, led by the new hooks and the retargeting refresh that went live on Monday.", did: ["a", "b", "c", "d"], doing: ["x"], next: ["n"], highlights: ["CPM down 12%"], stories: [{ title: "Cost per purchase, 5 weeks" }] };
  it("lists sections removed or added, items cut, and charts", () => {
    const after = { ...before, highlights: [], did: ["a", "b"], next: ["n", "m"], stories: [{ title: "Purchases by offer" }] };
    const d = sectionsDiff(before, after);
    expect(d).toContain('Removed the whole "highlights" section.');
    expect(d).toContain('"did" went from 4 items to 2.');
    expect(d).toContain('Added a trend chart: "Purchases by offer".');
    expect(d).toContain('Removed the trend chart "Cost per purchase, 5 weeks".');
    expect(d.some((x) => x.startsWith('"next"'))).toBe(false);
  });
  it("notices a section cut way down", () => {
    const d = sectionsDiff(before, { ...before, summary: "Purchases up, cost down." });
    expect(d[0]).toMatch(/^Cut "summary" from about \d+ words to 4\.$/);
  });
  it("says nothing for a light rewording", () => {
    expect(sectionsDiff(before, { ...before, headline: "A strong week" })).toEqual([]);
    expect(sectionsDiff(null, null)).toEqual([]);
  });
  it("finds the sentences the buyer typed in", () => {
    expect(addedLines(before, { ...before, next: ["n", "We will compare the $99 and $49 offers next week."] })).toEqual(["We will compare the $99 and $49 offers next week."]);
  });
});

describe("sameRule", () => {
  it("matches the same words, or one inside the other and nearly as long", () => {
    expect(sameRule("No CPM", "no cpm!")).toBe(true);
    expect(sameRule("Compare offers monthly", "Compare offers monthly please")).toBe(true);
    expect(sameRule("No CPM", "No CPM and no CTR and no reach")).toBe(false);
  });
});
