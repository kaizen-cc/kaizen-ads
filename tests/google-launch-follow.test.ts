import { describe, expect, it } from "vitest";
import { followCampaign, NEW_AD_GROUP, type AccountAdGroup, type AccountCampaign } from "@/lib/google-launch/core";
import type { LaunchQuestion } from "@/lib/launch-sheet/types";

const camps = [
  { id: "1", name: "CORE | Search | Brand | Kaizen", status: "ENABLED", type: "SEARCH" },
  { id: "2", name: "Search | Non Brand | Kaizen", status: "ENABLED", type: "SEARCH" },
  { id: "3", name: "Traffic - New OceanBox - Generic", status: "ENABLED", type: "SEARCH" },
] as unknown as AccountCampaign[];
const groups = [
  { id: "a", name: "Brand", status: "ENABLED", campaignId: "1", campaign: camps[0].name, rsas: 2, strength: null },
  { id: "b", name: "Brand Black Friday", status: "PAUSED", campaignId: "1", campaign: camps[0].name, rsas: 1, strength: null },
  { id: "c", name: "Generic KeyWords", status: "ENABLED", campaignId: "3", campaign: camps[2].name, rsas: 3, strength: null },
] as AccountAdGroup[];
const q = (key: string, answer: string | null, options: string[] = [], proposal = ""): LaunchQuestion => ({ key, question: key, why: "", proposal, options, required: true, answer });

describe("the ad group question follows the campaign", () => {
  it("only lists ad groups inside the chosen campaign", () => {
    const out = followCampaign([q("campaign", camps[0].name), q("ad_group", null, ["Generic KeyWords (in Traffic)"], "Generic KeyWords")], camps, groups);
    const ag = out.find((x) => x.key === "ad_group")!;
    expect(ag.options.some((o) => o.startsWith("Brand"))).toBe(true);
    expect(ag.options.some((o) => o.includes("Generic"))).toBe(false);
    expect(ag.options).toContain(NEW_AD_GROUP);
    expect(ag.proposal).toBe(NEW_AD_GROUP);
  });
  it("clears an ad group answer from another campaign", () => {
    const out = followCampaign([q("campaign", camps[0].name), q("ad_group", "Generic KeyWords")], camps, groups);
    expect(out.find((x) => x.key === "ad_group")!.answer).toBeNull();
  });
  it("asks the campaign again when the answer names two", () => {
    const out = followCampaign([q("campaign", `If brand, ${camps[0].name}. If non-brand, ${camps[1].name}.`, [camps[0].name]), q("ad_group", null)], camps, groups);
    expect(out.find((x) => x.key === "campaign")!.answer).toBeNull();
    const ag = out.find((x) => x.key === "ad_group")!;
    expect(ag.options).toEqual([]);
    expect(ag.answer).toBeNull();
  });
  it("offers only a new ad group in a new campaign", () => {
    const out = followCampaign([q("campaign", "A new Search campaign"), q("ad_group", null)], camps, groups);
    expect(out.find((x) => x.key === "ad_group")!.options).toEqual([NEW_AD_GROUP]);
  });
});

import { followStructure } from "@/lib/launch-sheet/questions";

describe("Meta: the structure answer is one place", () => {
  const existing = [{ name: "BOF | Retargeting" }, { name: "TOF | Prospecting" }];
  it("clears an answer naming two places and keeps the proposal an option", () => {
    const out = followStructure([q("structure", "If warm, BOF | Retargeting; if cold, TOF | Prospecting", ['Add to the campaign "TOF | Prospecting", a new ad set per Page'], "something else")], existing);
    expect(out[0].answer).toBeNull();
    expect(out[0].proposal).toBe('Add to the campaign "TOF | Prospecting", a new ad set per Page');
  });
  it("keeps a single place", () => {
    const out = followStructure([q("structure", 'Into the ad set "BOF | Retargeting" as it is', [])], existing);
    expect(out[0].answer).toContain("BOF");
  });
});
