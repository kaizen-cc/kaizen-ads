import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The client page renders on the server (UTC) and again in the browser (the viewer's own timezone). A date formatted
// without a fixed timeZone can land on a different day in each, and React then throws #418 (server and browser text
// don't match). Every date shown by a client component on the page pins its timezone (or is a plain day read at noon).

const dir = "src/app/(team)/clients/[slug]";
const clientFiles = readdirSync(join(process.cwd(), dir))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ f, src: readFileSync(join(process.cwd(), dir, f), "utf8") }))
  .filter(({ src }) => src.startsWith('"use client"'));

describe("client page dates render the same on the server and in the browser", () => {
  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it("every date format pins a timezone", () => {
    const loose: string[] = [];
    for (const { f, src } of clientFiles) {
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/toLocale(?:Date)?String\("en-US", \{([^}]*)\}/g)) {
          const opts = m[1];
          if (!/\b(month|day|weekday|hour)\b/.test(opts)) continue; // a number, not a date
          if (/timeZone/.test(opts) || /T12:00:00/.test(line)) continue;
          loose.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(loose).toEqual([]);
  });
});
