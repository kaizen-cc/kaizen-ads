import { describe, expect, it } from "vitest";
import { boardBreakdown } from "@/lib/kpi/format";
import type { Status } from "@/lib/kpi/calc";

describe("boardBreakdown", () => {
  it("accounts for every account: judged + no KPI + not reporting = total", () => {
    const statuses: Status[] = ["excellent", "good", "close", "off", "off", "unset", "unset", "setup", "idle"];
    const b = boardBreakdown(statuses);
    expect(b).toEqual({ total: 9, judged: 5, unset: 2, notReporting: 2 });
    expect(b.judged + b.unset + b.notReporting).toBe(b.total);
  });

  it("is all zeros on an empty board", () => {
    expect(boardBreakdown([])).toEqual({ total: 0, judged: 0, unset: 0, notReporting: 0 });
  });
});
