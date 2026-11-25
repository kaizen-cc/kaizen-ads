import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #147: /ai threw React #418 (hydration mismatch). The "Welcome back" card (and whether it shows at all) was
// worked out from the clock each render read: the server's when it rendered the page, the browser's a moment later
// when it hydrated. A chat right at the 7-day edge, or an "x min ago" crossing a minute, made the two disagree. The
// server's clock is now handed to the browser, and dates and numbers name their locale and time zone.
const dir = join(__dirname, "../src/app/(team)/ai");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const clientFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ f, src: read(f) }))
  .filter(({ src }) => src.trimStart().startsWith('"use client"'));

describe("Kaizen AI renders the same on server and browser", () => {
  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(3);
  });

  it("works out the Welcome back card from the server's clock, not the browser's", () => {
    const ui = read("kaizen-ai.tsx");
    expect(ui).not.toMatch(/useState\(\(\) => Date\.now\(\)\)/);
    expect(ui).toMatch(/const \[now\] = useState\(serverNow\)/);
    expect(read("page.tsx")).toMatch(/now=\{clock\(\)\}/);
  });

  it.each(clientFiles.map(({ f, src }) => [f, src]))("%s formats numbers with a fixed locale", (_f, src) => {
    expect(src).not.toMatch(/\.toLocale(?:Date|Time)?String\(\s*(?:undefined\s*)?[,)]/);
  });

  it.each(clientFiles.map(({ f, src }) => [f, src]))("%s formats dates with a fixed time zone", (_f, src) => {
    const dateCalls = src.match(/\.toLocale(?:Date|Time)?String\("en-US",\s*\{[^}]*\}/g) ?? [];
    for (const call of dateCalls) {
      if (/\b(month|day|hour|minute|year)\b/.test(call)) expect(call).toMatch(/timeZone:/);
    }
  });
});
