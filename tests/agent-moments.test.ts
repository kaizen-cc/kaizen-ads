import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_MOMENTS, momentOf } from "@/lib/agent-moments";

// Settings › AI agents shows where each agent runs from AGENT_MOMENTS. These keep that list honest: every agent has
// its places, and every run label in the code belongs to one of them, so a new AI call can't ship without its place.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const files = (dir: string): string[] =>
  readdirSync(join(process.cwd(), dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(join(process.cwd(), p)).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("where each AI agent runs", () => {
  it("lists every agent", () => {
    const union = read("src/lib/ai.ts").match(/export type AgentKey = ([^;]+);/)?.[1] ?? "";
    const keys = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(AGENT_MOMENTS[k]?.length ?? 0, `${k} has no places listed in src/lib/agent-moments.ts`).toBeGreaterThan(0);
  });

  it("places every run label the code logs", () => {
    const missing: string[] = [];
    for (const f of files("src")) {
      const src = read(f);
      // agent: "x" (or a choice between two) followed closely by its label: "…" or label: `…`
      for (const m of src.matchAll(/agent:\s*([^,\n]+),[\s\S]{0,200}?label:\s*[`"]([^`"$]+)/g)) {
        const agents = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).filter((a) => a in AGENT_MOMENTS);
        for (const a of agents) if (!momentOf(a, m[2])) missing.push(`${a}: "${m[2]}" (${f})`);
      }
    }
    expect(missing, `run labels with no place in src/lib/agent-moments.ts:\n${missing.join("\n")}`).toEqual([]);
  });
});
