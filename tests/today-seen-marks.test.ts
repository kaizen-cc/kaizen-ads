import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// /today marks every card it shows as seen in the background. A mark the server can't take (an expired sign in sent to
// /login, a tab from before an update) used to reject with nobody listening and surface as "An unexpected response was
// received from the server." (issue #33). Each background mark must handle its own failure.

const story = readFileSync(join(__dirname, "../src/app/today/story.tsx"), "utf8");

describe("/today background seen marks", () => {
  it("never fires a seen mark or an acknowledgement without catching its failure", () => {
    expect(story).not.toMatch(/void setItem\(/);
    expect(story).not.toMatch(/void acknowledge\(/);
    expect(story).toMatch(/setItem\(i\.key, "seen", [^\n]*\)\.catch\(/);
    expect(story).toMatch(/acknowledge\(r\.key\)\.catch\(/);
  });
});
