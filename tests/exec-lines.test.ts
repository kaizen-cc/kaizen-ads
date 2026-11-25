import { describe, expect, it } from "vitest";
import { stuckLine } from "@/lib/escalation-ladder-core";
import { execSees, reasonsFor } from "@/lib/stepins/core";

// Owner, Nov 25 2026: a step-in or escalation reaches only the exec(s) whose line it is; fires reach every exec.
const EMAIL = ["email"];
const ADS = ["meta", "google", "tiktok", "creative_performance"];
const CREATIVE = ["social", "creative"];

describe("each exec sees their own lines", () => {
  it("a stuck item's line: the owner's role, else the owner's focus the client buys, else the lead's role", () => {
    expect(stuckLine({ ownerRole: "media_buyer" })).toBe("meta");
    expect(stuckLine({ ownerRole: "executive", ownerFocus: ADS, clientLines: ["creative", "meta"] })).toBe("meta");
    expect(stuckLine({ ownerRole: "executive", ownerFocus: EMAIL, clientLines: ["email"] })).toBe("email");
    expect(stuckLine({ ownerRole: "customer_success", leadRole: "head_of_meta" })).toBe("meta");
    expect(stuckLine({ ownerRole: "customer_success" })).toBeNull();
  });
  it("Meta step-ins never reach the email exec; fires reach everyone; a reason with no line reaches nobody with a focus", () => {
    const meta = [{ kind: "escalated" as const, line: "meta" }];
    expect(execSees(meta, EMAIL)).toBe(false);
    expect(execSees(meta, ADS)).toBe(true);
    expect(execSees(meta, CREATIVE)).toBe(false);
    expect(execSees([{ kind: "fire" as const, line: null }], EMAIL)).toBe(true);
    expect(execSees([{ kind: "escalated" as const, line: null }], EMAIL)).toBe(false);
    // No focus set (the owner's "All lines"): everything
    expect(execSees([{ kind: "escalated" as const, line: null }], [])).toBe(true);
  });
  it("a card shows only the exec's own lines' reasons and fires", () => {
    const rs = [
      { kind: "account" as const, line: "meta" },
      { kind: "email" as const, line: "email" },
      { kind: "fire" as const, line: null },
    ];
    expect(reasonsFor(rs, EMAIL).map((r) => r.kind)).toEqual(["email", "fire"]);
    expect(reasonsFor(rs, [])).toHaveLength(3);
  });
});
