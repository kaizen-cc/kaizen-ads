import { describe, expect, it } from "vitest";
import { baseTasks, dropCycles, mergeTasks, nextStatuses, relations, type TaskRow } from "@/lib/task-graph";

const rows = (specs: ReturnType<typeof baseTasks>): TaskRow[] => specs.map((t) => ({ key: t.key, title: t.title, status: "blocked", depends_on: t.depends_on, owner_role: t.owner_role, owner_id: null, auto: t.auto, due_on: null }));

describe("task graph", () => {
  it("builds the setup steps for the services a client has", () => {
    const meta = baseTasks({ meta: true, google: false, creative: true, video: false }).map((t) => t.key);
    expect(meta).toContain("launch_meta");
    expect(meta).not.toContain("launch_google");
    const launch = baseTasks({ meta: true, google: false, creative: true, video: false }).find((t) => t.key === "launch_meta")!;
    expect(launch.depends_on).toEqual(["build_meta", "creative_approved", "tracking"]);
  });

  it("unblocks a task when what it waits on is done, and completes tasks from real events", () => {
    const t = rows(baseTasks({ meta: true, google: false, creative: false, video: false }));
    const first = nextStatuses(t, new Set(["plan_approved", "plan_final", "meta_access"]));
    const s = new Map(first.map((c) => [c.key, c.status]));
    expect(s.get("meta_access")).toBe("done");
    expect(s.get("build_meta")).toBe("ready");
    expect(s.get("launch_meta")).toBeUndefined(); // still blocked (unchanged)
  });

  it("says what a task waits on and what it holds up", () => {
    const t = rows(baseTasks({ meta: true, google: false, creative: true, video: false }));
    const r = relations(t, "creative_approved");
    expect(r.waitingOn.map((x) => x.key)).toEqual(["first_round"]);
    expect(r.holdingUp.map((x) => x.key)).toEqual(["launch_meta"]);
  });

  it("keeps plan steps safe: known roles, real dependencies, no loops", () => {
    const base = baseTasks({ meta: true, google: false, creative: false, video: false });
    const out = mergeTasks(base, [
      { key: "retargeting", title: "Retargeting test", detail: "", platform: "meta", phase: "d60", owner_role: "wizard", due_in_business_days: 25, depends_on: ["launch_meta", "nope"] },
      { key: "review", title: "Day 30 review", detail: "", platform: "all", phase: "d30", owner_role: "lead", due_in_business_days: 20, depends_on: ["retargeting"] },
    ]);
    const rt = out.find((t) => t.key === "p_retargeting")!;
    expect(rt.owner_role).toBe("lead");
    expect(rt.depends_on).toEqual(["launch_meta"]);
    expect(out.find((t) => t.key === "p_review")!.depends_on).toEqual(["p_retargeting"]);
    const loop = dropCycles([
      { key: "a", depends_on: ["b"] },
      { key: "b", depends_on: ["a"] },
    ]);
    expect(loop.some((t) => t.depends_on.length === 0)).toBe(true);
  });
});
