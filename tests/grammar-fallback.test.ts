import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { formatInstruction, grammarTooLarge, jsonOf } from "@/lib/ai";
import { proposalFrom, rawPlanOf } from "@/lib/google-launch/runs";

const badRequest = (message: string) => new Anthropic.BadRequestError(400, { error: { type: "invalid_request_error", message } }, message, new Headers());

describe("an answer format too large for the API", () => {
  it("is recognised from the API's refusal", () => {
    expect(grammarTooLarge(badRequest("The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."))).toBe(true);
    expect(grammarTooLarge(badRequest("prompt is too long"))).toBe(false);
    expect(grammarTooLarge(new Error("The compiled grammar is too large"))).toBe(false);
  });

  it("is told as an instruction instead", () => {
    expect(formatInstruction({ type: "object", properties: { note: { type: "string" } } })).toContain('"note"');
  });

  it("reads the JSON as is, in code fences or inside words", () => {
    expect(jsonOf('{"a":1}')).toEqual({ a: 1 });
    expect(jsonOf('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(jsonOf('Here it is: {"a":{"b":[1]}} done')).toEqual({ a: { b: [1] } });
    expect(() => jsonOf("no json here")).toThrow();
  });
});

describe("the Google plan read leniently", () => {
  it("fills every key an unenforced answer left out", () => {
    const raw = rawPlanOf({ campaigns: [{ key: "c1", mode: "existing", existingId: 123, locations: ["United States"] }], adGroups: [{ key: "g1", campaignKey: "c1", keywords: ['"box themes"'], rsas: [{ headlines: ["Party Boxes (pin 1)"] }] }] });
    expect(raw.note).toBe("");
    expect(raw.campaigns[0]).toMatchObject({ existingId: "123", excludedLocations: [], sitelinks: [], budget: 0 });
    expect(raw.adGroups[0]).toMatchObject({ fromRead: -1, negatives: [], rsas: [{ descriptions: [], path1: "" }] });
    expect(raw.assetGroups).toEqual([]);
    const p = proposalFrom(raw);
    expect(p.campaigns[0].mode).toBe("existing");
    expect(p.adGroups[0].rsas[0].headlines[0]).toEqual({ text: "Party Boxes", pin: 1 });
  });

  it("splits the places left out (\"-Hawaii\") from the places shown", () => {
    const raw = rawPlanOf({ campaigns: [{ key: "c1", locations: ["United States", "-Alaska", " - Hawaii"] }] });
    expect(raw.campaigns[0].locations).toEqual(["United States"]);
    expect(raw.campaigns[0].excludedLocations).toEqual(["Alaska", "Hawaii"]);
  });

  it("takes nothing from an answer that isn't an object", () => {
    expect(rawPlanOf(null)).toEqual({ note: "", campaigns: [], adGroups: [], assetGroups: [] });
  });
});
