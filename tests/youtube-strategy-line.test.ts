import { describe, expect, it } from "vitest";
import { agentsForTakeaway, cleanLines, decidesScoped, lineOfChannel, routeTakeaway, YT_LINE_LABEL } from "@/lib/youtube-core";

describe("the Marketing & strategy line", () => {
  it("is its own line, from the AI's or a person's words", () => {
    expect(YT_LINE_LABEL.strategy).toBe("Marketing & strategy");
    expect(cleanLines(["offer", "funnel", "marketing"])).toEqual(["strategy"]);
    expect(lineOfChannel("marketing-strategy")).toBe("strategy");
    expect(lineOfChannel("email-marketing")).toBe("email");
  });
  it("teaches the Strategist and goes to every exec, not a platform team", () => {
    expect(agentsForTakeaway({ lines: ["strategy"], roles: [] })).toEqual(["strategist"]);
    const people = [
      { id: "mb", role: "media_buyer", isExec: false },
      { id: "hm", role: "head_of_meta", isExec: false },
      { id: "x-ads", role: "executive", isExec: true, execFocus: ["meta", "google"] },
      { id: "x-email", role: "executive", isExec: true, execFocus: ["email"] },
    ];
    expect(routeTakeaway({ lines: ["strategy"], roles: [] }, people)).toEqual({ team: [], execs: ["x-ads", "x-email"] });
  });
  it("any exec decides a strategy takeaway; a line head doesn't", () => {
    expect(decidesScoped({ role: "executive", isExec: true, execFocus: ["email"] }, ["strategy"], [["email"]])).toBe(true);
    expect(decidesScoped({ role: "head_of_meta" }, ["strategy"], [["email"]])).toBe(false);
  });
});
