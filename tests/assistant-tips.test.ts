import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assistantGreeting } from "@/lib/assistant/core";
import { NO_TIP, RETIP_DAYS, STALE_DAYS, TIPS, pickTip, tipOfTool, tipsFor, type TipRow } from "@/lib/assistant/tips";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const row = (tip: string, over: Partial<TipRow> = {}): TipRow => ({ tip, seen_at: daysAgo(0), used_at: null, tipped_at: null, ...over });
const EVEN = 32; // shows a tip (even) and no casual question (not a multiple of 3)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("every assistant capability has a tip", () => {
  it("each tool the assistant can carry is covered by a tip or listed as behind the scenes", () => {
    const dirs = ["src/lib/assistant", "src/lib/agent-call", "src/lib/deliverables", "src/lib/kaizen-ai"];
    const names = new Set(dirs.flatMap(files).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/^\s*name: "([a-z_]+)",/gm)].map((m) => m[1])));
    expect(names.size).toBeGreaterThan(80);
    const missing = [...names].filter((n) => !tipOfTool(n) && !NO_TIP.has(n));
    expect(missing, "add these tools to a tip in src/lib/assistant/tips.ts (or NO_TIP)").toEqual([]);
  });
  it("no tool sits in two tips", () => {
    const all = TIPS.flatMap((t) => t.tools);
    expect(all.length).toBe(new Set(all).size);
  });
  it("maps a call's tools to the tips they make possible", () => {
    expect(tipsFor(["draft_message", "save_draft", "remind_me", "some_outside_tool"]).sort()).toEqual(["drafts", "remind"]);
  });
});

describe("picking a tip", () => {
  it("only about half of hellos carry one", () => {
    expect(pickTip([row("drafts")], 1, NOW)).toBeNull();
    expect(pickTip([row("drafts")], 2, NOW)?.key).toBe("drafts");
  });
  it("prefers things they've never done over things they haven't done in a while", () => {
    const rows = [row("drafts", { used_at: daysAgo(STALE_DAYS + 5) }), row("search")];
    for (let s = 0; s < 64; s += 2) expect(pickTip(rows, s, NOW)?.key).toBe("search");
  });
  it("brings back something not used in a while once nothing is untried", () => {
    expect(pickTip([row("drafts", { used_at: daysAgo(STALE_DAYS + 1) })], 2, NOW)?.key).toBe("drafts");
  });
  it("never suggests what they did recently, what they were just told, or tools they no longer have", () => {
    expect(pickTip([row("drafts", { used_at: daysAgo(3) })], 2, NOW)).toBeNull();
    expect(pickTip([row("drafts", { tipped_at: daysAgo(RETIP_DAYS - 1) })], 2, NOW)).toBeNull();
    expect(pickTip([row("drafts", { seen_at: daysAgo(30) })], 2, NOW)).toBeNull();
  });
  it("shuffles across what's left", () => {
    const rows = TIPS.map((t) => row(t.key));
    const keys = new Set(Array.from({ length: 200 }, (_, s) => pickTip(rows, s * 2, NOW)?.key));
    expect(keys.size).toBeGreaterThan(8);
  });
});

describe("the hello", () => {
  const memory = [{ id: "m1", kind: "style", topic: "length", body: "short answers" }] as never[];
  it("adds the tip to a plain daytime hello and says which one it told", () => {
    const hello = assistantGreeting({ name: "Dana", memory, today: "2026-11-20", seed: EVEN, hour: 14, mode: "fresh", tips: [row("search")], now: NOW });
    expect(hello.text).toContain("did you know I can dig through your Slack");
    expect(hello.tipped).toBe("search");
  });
  it("no tip on a first call or without a history", () => {
    expect(assistantGreeting({ name: "Dana", memory: [], today: "2026-11-20", seed: EVEN, hour: 14, tips: [row("search")], now: NOW }).text).not.toContain("did you know");
    expect(assistantGreeting({ name: "Dana", memory, today: "2026-11-20", seed: EVEN, hour: 14, tips: [], now: NOW }).text).not.toContain("did you know");
  });
});
