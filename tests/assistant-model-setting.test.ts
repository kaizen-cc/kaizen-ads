import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every assistant answer (the personal assistant and any agent on a call or in its chat) runs on the model and effort
// set in Settings > AI agents > Assistant: Sonnet at medium effort until an exec changes it, and the next answer uses
// the new setting.

let row: { model: string; effort: string } | null = null;
const query = (data: unknown) => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "or", "order"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data, error: null });
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
};
const admin = { from: (t: string) => query(t === "ai_agents" && row ? { ...row, instructions: "", sources: {}, ai_roles: null } : null) };
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ adminConfigured: () => true, createAdminClient: () => admin }));

const { getAgent, forgetAgent } = await import("@/lib/ai");

describe("the assistant's model and effort", () => {
  beforeEach(() => {
    row = null;
    forgetAgent();
  });

  it("is Sonnet at medium effort by default", async () => {
    const a = await getAgent("assistant_talk");
    expect([a.model, a.effort]).toEqual(["sonnet", "medium"]);
  });

  it("follows what an exec sets in Settings, on the next answer", async () => {
    row = { model: "haiku", effort: "low" };
    forgetAgent(); // what saving in Settings does
    const a = await getAgent("assistant_talk");
    expect([a.model, a.effort]).toEqual(["haiku", "low"]);
  });

  it("is what every spoken and chat answer reads, not a fixed model", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/agent-call/server.ts"), "utf8");
    expect(src).toContain('getAgent("assistant_talk")');
    expect(src).not.toMatch(/const model = "sonnet" as const/);
  });

  it("is in Settings for execs to change (the migration adds it as Sonnet, medium)", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readFileSync(join(dir, "20261123020000_assistant_model_setting.sql"), "utf8");
    expect(sql).toMatch(/'assistant_talk'[\s\S]*'sonnet', 'medium'/);
    expect(sql).toContain("where not exists");
  });
});
