import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Making a project through the person's own session must not read the new row back (insert(...).select()): the
// read rule, private.ai_project_role, looks the project up in the insert's own snapshot, where the new row isn't
// there yet, so the row-level security check failed every new project. The id is made in the code instead.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("new Kaizen AI projects", () => {
  for (const file of ["src/app/(team)/ai/project-actions.ts", "src/lib/ai-tools/team-ops.ts"]) {
    it(`${file} inserts a project without reading it back`, () => {
      const src = read(file);
      const inserts = [...src.matchAll(/from\("ai_projects"\)\s*\.insert\(([\s\S]*?)\);/g)];
      expect(inserts.length).toBeGreaterThan(0);
      for (const m of inserts) {
        expect(m[0]).not.toMatch(/\.select\(/);
        expect(m[1]).toMatch(/\bid\b/);
      }
    });
  }
});
