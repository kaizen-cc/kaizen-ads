import { describe, expect, it } from "vitest";
import { checkAgainstSetup, coverageLines, type SetupFacts } from "@/lib/setup-check";
import { audienceKind } from "@/lib/meta-setup-snapshot";

const CAMPS = ["Search | Brand", "Search | Services", "PMax | All"];
const google: SetupFacts = {
  platform: "google",
  facts: [
    { key: "customer_match", label: "Customer match list", unit: "campaigns", of: CAMPS, on: CAMPS, detail: "observation on 3, targeting on 0" },
    { key: "remarketing", label: "Remarketing (website visitors) list", unit: "campaigns", of: CAMPS, on: ["Search | Brand"] },
    { key: "sitelinks", label: "Sitelinks (4+)", unit: "Search campaigns", of: CAMPS.slice(0, 2), on: CAMPS.slice(0, 2) },
    { key: "negative_list", label: "Negative keyword list", unit: "Search campaigns", of: CAMPS.slice(0, 2), on: [] },
    { key: "auto_tagging", label: "Auto-tagging", of: ["the account"], on: ["the account"] },
  ],
};
const act = (title: string, extra: Partial<{ short: string; objects: { type: string; name: string }[] }> = {}) => ({ title, why: "Because.", ...extra });

describe("the plan never asks for what's already in place", () => {
  it("drops adding a customer match list when one is attached to every campaign, and logs it", () => {
    const { actions, log } = checkAgainstSetup([act("Add a customer match list to all campaigns in observation"), act("Raise the Brand budget to $80/day")], google);
    expect(actions.map((a) => a.title)).toEqual(["Raise the Brand budget to $80/day"]);
    expect(log.dropped).toEqual([{ title: "Add a customer match list to all campaigns in observation", reason: "Customer match list is already in place on all 3 campaigns (observation on 3, targeting on 0)" }]);
  });

  it("keeps a fix to something that exists but is set up poorly", () => {
    const { actions, log } = checkAgainstSetup([act("Switch the customer list from observation to targeting on PMax")], google);
    expect(actions).toHaveLength(1);
    expect(log.dropped).toHaveLength(0);
  });

  it("keeps an action where it's only partly in place, with a note saying where", () => {
    const { actions, log } = checkAgainstSetup([act("Layer a remarketing list on the Search campaigns")], google);
    expect(actions[0].why).toMatch(/Setup check: Remarketing \(website visitors\) list is already in place on 1 of 3 campaigns \(Search \| Brand\); not on Search \| Services, PMax \| All/);
    expect(log.noted).toHaveLength(1);
  });

  it("checks only the campaigns the action names", () => {
    const named = checkAgainstSetup([act("Add remarketing list", { objects: [{ type: "campaign", name: "search | brand" }] })], google);
    expect(named.log.dropped[0].reason).toBe("Remarketing (website visitors) list is already in place on Search | Brand");
  });

  it("drops account settings already on and keeps what's missing", () => {
    const { actions, log } = checkAgainstSetup([act("Enable auto-tagging"), act("Create a shared negative keyword list"), act("Add 4 sitelinks to Search")], google);
    expect(actions.map((a) => a.title)).toEqual(["Create a shared negative keyword list"]);
    expect(log.dropped.map((d) => d.reason)).toEqual(["Auto-tagging is already in place on the account", "Sitelinks (4+) is already in place on all 2 Search campaigns"]);
  });

  it("leaves the plan alone when the setup couldn't be read", () => {
    const list = [act("Add a customer match list")];
    expect(checkAgainstSetup(list, null).actions).toBe(list);
    expect(checkAgainstSetup(list, { platform: "google", facts: [] }).actions).toBe(list);
  });

  it("checks Meta ad sets by their campaign, and Advantage+ and exclusions", () => {
    const meta: SetupFacts = {
      platform: "meta",
      facts: [
        { key: "exclude_customers", label: "Customers or purchasers excluded", unit: "live ad sets", of: ["Broad", "LAL 1%", "Retargeting"], on: ["Broad", "LAL 1%"], parents: { Broad: "Prospecting", "LAL 1%": "Prospecting", Retargeting: "Retargeting" } },
        { key: "advantage_audience", label: "Advantage+ audience", unit: "live ad sets", of: ["Broad"], on: ["Broad"] },
      ],
    };
    const { actions, log } = checkAgainstSetup([act("Exclude past purchasers from prospecting", { objects: [{ type: "campaign", name: "Prospecting" }] }), act("Turn on Advantage+ audience"), act("Turn off Advantage+ audience on Broad")], meta);
    expect(log.dropped.map((d) => d.title)).toEqual(["Exclude past purchasers from prospecting", "Turn on Advantage+ audience"]);
    expect(actions.map((a) => a.title)).toEqual(["Turn off Advantage+ audience on Broad"]);
  });

  it("writes coverage lines for the snapshot", () => {
    expect(coverageLines(google)).toEqual([
      "- Customer match list: on 3 of 3 (observation on 3, targeting on 0)",
      "- Remarketing (website visitors) list: on 1 of 3; missing on Search | Services, PMax | All",
      "- Sitelinks (4+): on 2 of 2",
      "- Negative keyword list: on 0 of 2",
      "- Auto-tagging: yes",
    ]);
  });

  it("names Meta's audience kinds", () => {
    expect(["CUSTOM", "WEBSITE", "LOOKALIKE", "IG_BUSINESS", "VIDEO", "ENGAGEMENT", "APP", "OFFLINE_CONVERSION", "WHATEVER"].map(audienceKind)).toEqual(["customer list", "website", "lookalike", "engagement", "engagement", "engagement", "app", "offline", "other"]);
  });
});
