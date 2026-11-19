import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A lint for the assistants' and Kaizen AI's tools: a file that reads client data with the server's rights (admin,
// which skips the database's access rules) must also check access the way the app does: the shared helpers in
// src/lib/ai-access.ts, or the client resolved through the person's own session first (clientOf, clientNamed,
// clientNamedForTools, channelMaySeeClient), or an exec-only gate. A new tool that forgets fails here. Files that read
// only the person's own records, or the call's own row, are listed below with why.

const ROOT = join(__dirname, "..", "src", "lib");
const DIRS = ["assistant", "kaizen-ai", "ai-tools", "agent-call"];

/** Tables that hold a client's data (or another person's) */
const CLIENT_TABLES = [
  "clients",
  "client_assignments",
  "kpi_targets",
  "kpi_snapshots",
  "context_items",
  "client_calls",
  "client_memory",
  "requests",
  "email_tickets",
  "reports",
  "optimization_sprints",
  "message_promises",
  "owed_replies",
  "client_direction_changes",
  "asana_tasks",
  "loom_videos",
  "review_comments",
  "channel_targets",
  "account_handoffs",
  "ad_changes",
  "google_policy_checks",
  "watch_flags",
];

/** Signs a file checks access before it reads */
const GATES = [/@\/lib\/ai-access/, /channelMaySeeClient/, /clientNamedForTools/, /\bclientOf\(/, /\bclientNamed\(/, /\baccessFor\(/, /\.isExec\b/, /mayTransferAny/, /canSeeReports/];

/** Files that read these tables with admin for the person's own records or the call's own state, and why */
const ALLOWED: Record<string, string> = {
  "agent-call/safety.ts": "the exec-only review sweep; it notifies execs and never returns data to the caller",
  "assistant/notes.ts": "files the call's own follow-ups; it reads clients only to match names in what the person said",
  "assistant/heads-up-server.ts": "the person's own heads-ups, written for them by the system",
  "assistant/handoff-server.ts": "handoffs addressed to the person themselves",
  "kaizen-ai/channel-access.ts": "the channel rule itself",
};

function files(): string[] {
  const out: string[] = [];
  for (const d of DIRS)
    for (const f of readdirSync(join(ROOT, d)))
      if (/\.ts$/.test(f) && (d !== "kaizen-ai" || /tools|chat\.ts$/.test(f))) out.push(`${d}/${f}`);
  return out;
}

const ADMIN_READ = new RegExp(`admin\\)?\\s*\\.from\\(\\s*"(${CLIENT_TABLES.join("|")})"\\s*\\)\\s*\\.select\\(`, "g");

describe("tools read client data only after an access check", () => {
  it("every tool file that reads client tables with admin checks access first (or says why it needn't)", () => {
    const missing: string[] = [];
    let reading = 0;
    for (const f of files()) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const tables = [...src.matchAll(ADMIN_READ)].map((m) => m[1]);
      if (tables.length) reading++;
      if (!tables.length || ALLOWED[f] || GATES.some((g) => g.test(src))) continue;
      missing.push(`${f} (${[...new Set(tables)].join(", ")})`);
    }
    // The scan itself still finds the reads (a pattern that matches nothing would pass every file)
    expect(reading).toBeGreaterThan(5);
    expect(missing, `These read client data with admin and no access check: use assertMaySee / keepVisible / visibleClientIds from src/lib/ai-access.ts, or list the file in ALLOWED with why.`).toEqual([]);
  });

  it("flags a tool that reads with admin and checks nothing", () => {
    const bad = `run: async (input) => { const { data } = await ctx.admin.from("kpi_targets").select("target").eq("client_id", input.id); return data; }`;
    const good = `import { assertMaySee } from "@/lib/ai-access"; ${bad}`;
    expect([...bad.matchAll(ADMIN_READ)].length).toBe(1);
    expect(GATES.some((g) => g.test(bad))).toBe(false);
    expect(GATES.some((g) => g.test(good))).toBe(true);
  });

  it("every file it allows still exists", () => {
    const all = new Set(files());
    for (const f of Object.keys(ALLOWED)) expect(all.has(f) || f === "kaizen-ai/channel-access.ts", f).toBe(true);
  });
});
