import { describe, expect, it } from "vitest";
import { accountKey, domainOf, domainRoot, matchProspect, nameKey, sameProspect } from "@/lib/prospect-match";

describe("prospect matching", () => {
  it("normalizes names, domains and accounts", () => {
    expect(nameKey("The Dump Daddy, LLC")).toBe("dumpdaddy");
    expect(domainOf("https://www.DumpDaddy.com/quote?x=1")).toBe("dumpdaddy.com");
    expect(domainOf("not a site")).toBeNull();
    expect(domainRoot("shop.feetje.co.uk")).toBe("feetje");
    expect(accountKey("act_1234567890")).toBe("1234567890");
    expect(accountKey("12")).toBeNull();
  });

  const clients = [
    { id: "a", name: "Dump Daddy", website: "dumpdaddy.com", accounts: ["act_998877"] },
    { id: "b", name: "Harris Water Main and Sewers", website: null, accounts: [] },
    { id: "c", name: "Cypress Aesthetics", website: "https://cypressmedspa.com", accounts: ["123-456-7890"] },
  ];

  it("matches by name, website or ad account", () => {
    expect(matchProspect({ name: "Dump Daddy LLC", domain: null, adAccount: null }, clients)?.id).toBe("a");
    expect(matchProspect({ name: "Some Dumpsters", domain: "www.dumpdaddy.com", adAccount: null }, clients)?.id).toBe("a");
    expect(matchProspect({ name: null, domain: null, adAccount: "1234567890" }, clients)?.id).toBe("c");
    expect(matchProspect({ name: "Harris Water Main & Sewers", domain: null, adAccount: null }, clients)?.id).toBe("b");
    expect(matchProspect({ name: "DumpDaddy", domain: null, adAccount: null }, clients)?.id).toBe("a");
  });

  it("doesn't match on nothing, or on several", () => {
    expect(matchProspect({ name: null, domain: null, adAccount: null }, clients)).toBeNull();
    expect(matchProspect({ name: "Unknown Roofing", domain: null, adAccount: null }, clients)).toBeNull();
    const twins = [...clients, { id: "d", name: "Dump Daddy", website: null, accounts: [] }];
    expect(matchProspect({ name: "Dump Daddy", domain: null, adAccount: null }, twins)).toBeNull();
  });

  it("knows two Looms are about the same prospect", () => {
    expect(sameProspect({ name: "Feetje Baby", domain: null, adAccount: null }, { name: "feetje baby", domain: "feetje.com", adAccount: null })).toBe(true);
    expect(sameProspect({ name: "Feetje Baby", domain: null, adAccount: null }, { name: "Other Co", domain: null, adAccount: null })).toBe(false);
  });
});
