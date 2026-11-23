import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The email and social teams get a trimmed Kaizen AI tool list, but their own Figma, Gmail, Drive and Calendar are
// theirs too (Nov 23 2026: Figma links answered "there's no Figma connection in this chat" for the Head of Email).
describe("personal tools on the email and social teams", () => {
  const src = readFileSync("src/lib/kaizen-ai/tools.ts", "utf8");
  it("adds Figma, the workspace and the calendar tools to what those teams get", () => {
    expect(src).toMatch(/figmaTools\(ctx\)\) CHANNEL_EXTRA\.add/);
    expect(src).toMatch(/workspaceTools\(ctx\)\) CHANNEL_EXTRA\.add/);
    expect(src).toMatch(/calendarTools\(ctx\)\) CHANNEL_EXTRA\.add/);
  });
  it("keeps a client's Klaviyo to the email team", () => {
    expect(src).toMatch(/"klaviyo_account"\]\.includes\(t\.name\) && lineOfTeam\(me\.role\) !== "email"/);
  });
});
