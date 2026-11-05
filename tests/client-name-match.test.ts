import { describe, expect, it } from "vitest";
import { matchClientName, sameWord, scoreClient, skeleton, splitName } from "@/lib/client-name-match";

const clients = [
  { id: "glen", name: "Crust Pizza - Gleannloch Farms" },
  { id: "crust", name: "Crust Pizza Co." },
  { id: "woof", name: "Woof Gang - Glenrock" },
  { id: "woofc", name: "Woof Gang Bakery - Cranford" },
  { id: "dump", name: "Dump Daddy", website: "https://www.dumpdaddy.com" },
  { id: "elev", name: "Elevate" },
];

describe("client name matching", () => {
  it("hears names the way people spell them", () => {
    expect(skeleton("Gleannloch")).toBe(skeleton("Glenlock"));
    expect(sameWord("glenlock", "gleannloch")).toBe(true);
    expect(sameWord("glenlock", "glenrock")).toBe(false);
    expect(sameWord("farm", "farms")).toBe(true);
    expect(sameWord("cranford", "crawford")).toBe(false);
    expect(sameWord("phoenix", "fenix")).toBe(true);
    expect(sameWord("crust", "trust")).toBe(false);
  });

  it("splits a brand from its location", () => {
    expect(splitName("Crust Pizza - Gleannloch Farms")).toEqual({ brand: "Crust Pizza", location: "Gleannloch Farms" });
    expect(splitName("Gypsy Kitchen (DC)")).toEqual({ brand: "Gypsy Kitchen", location: "DC" });
    expect(splitName("Dump Daddy")).toEqual({ brand: "Dump Daddy", location: "" });
  });

  it("finds the Crust Gleannloch pilot from the promise as written", () => {
    const text = `keep the pilot to Glenlock Farms only and get onboarding going. run the initial proof of concept with just Glenlock Farms. (email "Re: Kaizen X Crust - Follow Up: Fees, Budgets, Tracking & Pilot Plan") Yes we can do this for this pilot!`;
    expect(scoreClient(text, clients[0])).toBe(3);
    expect(scoreClient(text, clients[1])).toBe(1);
    expect(scoreClient(text, clients[2])).toBe(0);
    expect(matchClientName(text, clients).sure?.id).toBe("glen");
  });

  it("is sure of a whole name, a website, or brand and location", () => {
    expect(matchClientName("I'll send Dump Daddy the new ads", clients).sure?.id).toBe("dump");
    expect(matchClientName("updating dumpdaddy.com landing page", clients).sure?.id).toBe("dump");
    expect(matchClientName("Woof Gang Cranford budget goes up tomorrow", clients).sure?.id).toBe("woofc");
  });

  it("doesn't take a chain's shared website for one location", () => {
    const chain = [
      { id: "co", name: "Crust Pizza Co.", website: "https://www.crustpizzaco.com/home" },
      { id: "gl", name: "Crust Pizza - Gleannloch Farms", website: "https://www.crustpizzaco.com/locations/TX/gleannloch-farms" },
    ];
    const text = `get the graphics updated with the actual gift card. (email "Re: Kaizen x Crust Pizza Co. - New Ad for Your Approval") On Wed Tammy Kravitz <tammy@crustpizzaco.com> wrote`;
    expect(matchClientName(text, chain).sure?.id).toBe("co");
    expect(matchClientName("updated the menu for tammy@crustpizzaco.com", chain).sure).toBeNull();
  });

  it("reads real promises the way they come in", () => {
    const list = [
      { id: "cal", name: "Caloosahatchee Marine", website: "https://caloosahatcheemarine.com/" },
      { id: "mann", name: "Mann Construction Co", website: "https://manncco.com/" },
      { id: "proj", name: "Project", website: "https://prjctpaintball.com/" },
      { id: "m1320", name: "1320 Motorsports", website: "https://www.1320motors.com/" },
      { id: "nectr", name: "Nectr", website: "https://www.nectr.energy/" },
    ];
    expect(matchClientName(`move the old website to a new URL. (email "Re: Kaizen X Charlie Mann - Next Steps To Owning Caloosahatchee Marine") Charlie, Excited to be moving forward!`, list).sure?.id).toBe("cal");
    expect(matchClientName(`launch the campaigns. (email "Re: Kaizen x 1320 Motorsports - New Ad for Your Approval") Hi Matt`, list).sure?.id).toBe("m1320");
    expect(matchClientName(`email the creative. (email "Re: Nectr Energy Inc. sent you a payment") Project timelines are tight. Hey Guys`, list).sure?.id).toBe("nectr");
    expect(matchClientName(`pause the Meta ads. Liz, All campaigns are off`, list)).toEqual({ sure: null, maybe: [] });
  });

  it("isn't sure of a chain's brand alone, a location alone, or a plain word", () => {
    const chain = matchClientName("Woof Gang wants new creative", clients);
    expect(chain.sure).toBeNull();
    expect(chain.maybe.map((c) => c.id).sort()).toEqual(["woof", "woofc"]);
    expect(matchClientName("pilot in Glenrock only", clients).sure).toBeNull();
    expect(matchClientName("we'll elevate the creative this week", clients).sure).toBeNull();
    expect(matchClientName("Elevate the creative this week, I'll do it", clients).sure).toBeNull();
    expect(matchClientName("We told Elevate we'd send a new offer", clients).sure?.id).toBe("elev");
    expect(matchClientName("nothing about anyone", clients)).toEqual({ sure: null, maybe: [] });
  });
});
