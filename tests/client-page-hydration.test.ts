import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The client page's browser components are first drawn on the server (UTC) and then again in the
// browser (the viewer's own timezone). A date printed without a fixed timezone can land on a
// different day in each, and React then throws error #418 (hydration mismatch). Every timestamp
// shown by these components is printed in New York time; plain YYYY-MM-DD days pinned to noon are fine.
const DIR = join(__dirname, "../src/app/(team)/clients/[slug]");
const DATE_FORMAT = /(toLocale(?:Date)?String|DateTimeFormat)\("en-US", \{([^}]*)\}/g;

describe("client page dates", () => {
  it("print timestamps in a fixed timezone so server and browser agree", () => {
    const loose: string[] = [];
    for (const f of readdirSync(DIR).filter((x) => x.endsWith(".tsx"))) {
      const src = readFileSync(join(DIR, f), "utf8");
      if (!src.startsWith('"use client"')) continue;
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(DATE_FORMAT)) {
          const opts = m[2];
          if (!/\b(month|weekday|hour|day)\b/.test(opts) || /timeZone/.test(opts)) continue;
          if (/T12:00:00/.test(line)) continue;
          loose.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(loose).toEqual([]);
  });
});
