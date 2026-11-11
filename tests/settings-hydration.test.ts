import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #21: /settings threw React #418 (hydration text mismatch). Client components render on the
// server (en-US, UTC) and again in the browser (the user's locale and time zone), so any number or
// date they format must name its locale, and a date its time zone, or the two disagree.
const dir = join(__dirname, "../src/app/(team)/settings");
const clientFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ f, src: readFileSync(join(dir, f), "utf8") }))
  .filter(({ src }) => src.trimStart().startsWith('"use client"'));

describe("Settings client components render the same on server and browser", () => {
  it("finds the client components", () => {
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it.each(clientFiles.map(({ f, src }) => [f, src]))("%s formats numbers with a fixed locale", (_f, src) => {
    expect(src).not.toMatch(/\.toLocale(?:Date|Time)?String\(\s*\)/);
  });

  it.each(clientFiles.map(({ f, src }) => [f, src]))("%s formats dates with a fixed time zone", (_f, src) => {
    const dateCalls = src.match(/\.toLocale(?:Date|Time)?String\("en-US",\s*\{[^}]*\}/g) ?? [];
    for (const call of dateCalls) {
      if (/\b(month|day|hour|minute|year)\b/.test(call)) expect(call).toMatch(/timeZone:/);
    }
  });
});
