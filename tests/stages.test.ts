import { describe, expect, it } from "vitest";
import { BOARD_ORDER, STAGES, businessDuration, health } from "@/lib/stages";

describe("ticket timing colors", () => {
  it("is green within turnaround", () => {
    expect(health(0, "in_production")).toBe("ok");
    expect(health(-30, "copy")).toBe("ok");
  });
  it("is amber up to 12 business hours over", () => {
    expect(health(1, "in_production")).toBe("warn");
    expect(health(12 * 60, "client_review")).toBe("warn");
  });
  it("is red beyond 12 business hours over", () => {
    expect(health(12 * 60 + 1, "client_review")).toBe("bad");
  });
  it("never flags launched work", () => {
    expect(health(99999, "launched")).toBe("ok");
  });
});

describe("business durations", () => {
  it("reads naturally", () => {
    expect(businessDuration(45)).toBe("45m");
    expect(businessDuration(5 * 60 + 20)).toBe("5h");
    expect(businessDuration(600)).toBe("1d");
    expect(businessDuration(2 * 600 + 180)).toBe("2d 3h");
  });
});

describe("stages", () => {
  it("every stage is on the board exactly once", () => {
    expect([...BOARD_ORDER].sort()).toEqual(STAGES.filter((s) => !s.retired && !s.offBoard).map((s) => s.key).sort());
  });
});
