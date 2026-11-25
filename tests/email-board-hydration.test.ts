import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #157: /board/email threw React #418 (hydration mismatch). Its client components printed dates such as a
// fix's "Nov 24" with no time zone: the server (UTC) and the browser (the person's own zone) read a late-evening
// moment as different days. Every date on the Email Board now names its time zone.
const dir = join(__dirname, "../src/app/(team)/board/email");
const clientFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ f, src: readFileSync(join(dir, f), "utf8") }))
  .filter(({ src }) => src.trimStart().startsWith('"use client"'));

describe("the Email Board renders the same on server and browser", () => {
  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(2);
  });

  it.each(clientFiles.map(({ f, src }) => [f, src]))("%s formats with a fixed locale", (_f, src) => {
    expect(src).not.toMatch(/\.toLocale(?:Date|Time)?String\(\s*(?:undefined\s*)?[,)]/);
  });

  it.each(clientFiles.map(({ f, src }) => [f, src]))("%s formats dates with a fixed time zone", (_f, src) => {
    const dateCalls = src.match(/\.toLocale(?:Date|Time)?String\("en-US",\s*\{[^}]*\}/g) ?? [];
    for (const call of dateCalls) {
      if (/\b(month|day|hour|minute|year)\b/.test(call)) expect(call).toMatch(/timeZone:/);
    }
  });

  it("prints a late-evening New York moment as that day, whatever zone renders it", () => {
    const at = "2026-11-25T02:30:00Z"; // 9:30pm Nov 24 in New York, already Nov 25 in UTC
    expect(new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })).toBe("Nov 24");
  });
});
