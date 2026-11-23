import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanSafetyText, isCallId, safetyAlertKey, SAFETY_COMMENT_MAX, SAFETY_RESOLUTION_MAX } from "@/lib/agent-call/safety-alert";

// Shared safety alerts: one dismissal clears every exec's alert, comments every exec sees, execs only.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const actions = read("src/app/(team)/safety/[callId]/actions.ts");

describe("a safety alert's comments and resolution note", () => {
  it("trims and caps the text, and is empty when there's nothing to say", () => {
    expect(cleanSafetyText("  Spoke with them, all good.\r\n ")).toBe("Spoke with them, all good.");
    expect(cleanSafetyText("   ")).toBe("");
    expect(cleanSafetyText(undefined)).toBe("");
    expect(cleanSafetyText(42)).toBe("");
    expect(cleanSafetyText("x".repeat(SAFETY_COMMENT_MAX + 50))).toHaveLength(SAFETY_COMMENT_MAX);
    expect(cleanSafetyText("x".repeat(2000), SAFETY_RESOLUTION_MAX)).toHaveLength(SAFETY_RESOLUTION_MAX);
  });
  it("only takes a call id", () => {
    expect(isCallId("4410f0da-6b2f-410f-b282-8801236d473d")).toBe(true);
    expect(isCallId("../etc")).toBe(false);
    expect(isCallId(null)).toBe(false);
  });
});

describe("dismissing a safety alert", () => {
  it("uses the same key every exec's alert was sent under", () => {
    expect(safetyAlertKey("4410f0da-6b2f-410f-b282-8801236d473d")).toBe("call-safety:4410f0da-6b2f-410f-b282-8801236d473d");
    expect(read("src/lib/agent-call/safety.ts")).toContain("key: safetyAlertKey(callId)");
  });
  it("clears it for every exec, not just the one who dismissed it", () => {
    const dismiss = actions.slice(actions.indexOf("export async function dismissSafetyAlert"), actions.indexOf("export async function reopenSafetyAlert"));
    expect(dismiss).toMatch(/from\("notifications"\)\.update\(\{ read_at: now \}\)\.eq\("key", key\)/);
    expect(dismiss).toMatch(/from\("notifications"\)\.update\(\{ cleared_at: now \}\)\.eq\("key", key\)/);
    expect(dismiss).not.toContain('eq("profile_id"');
    expect(dismiss).toContain("assistant_heads_up_items");
  });
  it("is for executives only", () => {
    expect(actions).toContain("if (!me.isExec || !isCallId(callId)) return null;");
    for (const fn of ["dismissSafetyAlert", "reopenSafetyAlert", "commentOnSafetyAlert"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}`));
      expect(body.slice(0, 300)).toContain("await execOnly(callId)");
    }
  });
  it("has an idempotent migration with exec-only reading", () => {
    const sql = read("supabase/migrations/20261125090000_safety_alert_shared.sql");
    expect(sql).toMatch(/add column if not exists resolved_at/);
    expect(sql).toMatch(/create table if not exists public\.call_safety_comments/);
    expect(sql).toMatch(/drop policy if exists "call safety comments: execs read"/);
    expect(sql).toMatch(/private\.is_exec\(\)/);
  });
  it("is applied again by a new migration (the first one's database step couldn't connect)", () => {
    const first = read("supabase/migrations/20261125090000_safety_alert_shared.sql");
    const again = read("supabase/migrations/20261127090000_safety_alert_shared_apply.sql");
    const statements = (sql: string) => sql.split("\n").filter((l) => l.trim() && !l.startsWith("--") && !l.startsWith("notify")).join("\n");
    expect(statements(again)).toBe(statements(first));
  });
});
