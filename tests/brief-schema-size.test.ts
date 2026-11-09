import { describe, expect, it } from "vitest";
import { BRIEF_SCHEMAS } from "@/lib/suggestions";
import { PATCH_SCHEMA } from "@/lib/brief-patch";
import { LINT_SCHEMA } from "@/lib/brief-lint";
import { structureBrief } from "@/lib/brief-spec";
import { withDetectedFacts } from "@/lib/brief-facts";

// The API refuses a structured-output schema whose compiled grammar is too large (it happened to the Google launch
// plan). The brief's sections come back inside one `brief` string under fixed headings (src/lib/brief-spec.ts parses
// them), so the brief writers' schemas stay the size they were before the brief got its sections, and the new ones
// (the revise patch, the consistency pass) are flat: strings, no enums, no arrays of objects inside arrays of objects.

type N = Record<string, unknown>;
function measure(s: unknown) {
  let nodes = 0;
  let enums = 0;
  let depth = 0;
  const walk = (x: unknown, d: number) => {
    if (!x || typeof x !== "object") return;
    const o = x as N;
    if ("type" in o || "enum" in o) nodes++;
    if (Array.isArray(o.enum)) enums++;
    let nd = d;
    if (o.type === "array" && (o.items as N | undefined)?.type === "object") depth = Math.max(depth, (nd = d + 1));
    if (o.properties) for (const v of Object.values(o.properties as N)) walk(v, nd);
    if (o.items) walk(o.items, nd);
  };
  walk(s, 0);
  return { nodes, enums, depth };
}

describe("brief schemas stay small", () => {
  // Measured on main before the brief got its sections (Nov 9 2026): never larger than this
  const BEFORE = { brief: { nodes: 43, enums: 4, depth: 1 }, repair: { nodes: 37, enums: 3, depth: 1 }, round: { nodes: 40, enums: 3, depth: 2 }, talk: { nodes: 39, enums: 3, depth: 1 }, summary: { nodes: 20, enums: 2, depth: 1 } };

  it("keeps every brief writer's schema at or below its old size", () => {
    for (const k of Object.keys(BEFORE) as (keyof typeof BEFORE)[]) {
      const m = measure(BRIEF_SCHEMAS[k]);
      expect(m.nodes, k).toBeLessThanOrEqual(BEFORE[k].nodes);
      expect(m.enums, k).toBeLessThanOrEqual(BEFORE[k].enums);
      expect(m.depth, k).toBeLessThanOrEqual(BEFORE[k].depth);
    }
  });

  it("keeps the revise patch and the consistency pass flat", () => {
    expect(measure(PATCH_SCHEMA)).toEqual({ nodes: 11, enums: 0, depth: 1 });
    expect(measure(LINT_SCHEMA)).toEqual({ nodes: 6, enums: 0, depth: 1 });
  });
});

describe("a brief is never lost", () => {
  it("structures a brief written under the headings, adding what to confirm", () => {
    const out = structureBrief("A carousel that reveals the seat.\n\nHook: The seat most fans miss\n\nKPI: Cost per purchase", "The Seat Most Fans Miss", withDetectedFacts);
    expect(out).toContain("Hook: The seat most fans miss");
    expect(out).toContain("Your call:");
    expect(out).toContain("Confirm with client:\n- Which seat, at which venue, and why?");
  });

  it("keeps free text exactly as written", () => {
    const free = "Show the patio at sunset.\nWarm, bright, people laughing.";
    expect(structureBrief(free, "Patio Fridays", withDetectedFacts)).toBe(free);
    expect(structureBrief("Hook: x\n\nInsight: y", "t", () => {
      throw new Error("boom");
    })).toBe("Hook: x\n\nInsight: y");
  });
});
