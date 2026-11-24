import { describe, expect, it } from "vitest";
import { closestClients, pickClientByName } from "@/lib/client-name-match";

const clients = ["Aldecoa Coffee", "Crust Pizza - Gleannloch Farms", "Crust Pizza Co.", "Aesthetic Edge", "Atomic Wings", "Alelaluna", "Goodmellow", "Granite-Plus", "Holland Law Group", "Rose Gold", "E11EVEN MIAMI", "Dental Team of Ocala", "First City Dental", "X Factor Paintball", "BKI/Boston Paintball", "7th Dimension Aesthetics", "Mama Betty's", "OceanBox", "Seaspice", "Sierra Dreams"].map((name) => ({ name }));

describe("client names said aloud or misspelled", () => {
  it("suggests the closest client instead of finding nothing", () => {
    expect(pickClientByName("Alucova", clients).hit).toBeNull();
    expect(closestClients("Alucova", clients)[0]?.name).toBe("Aldecoa Coffee");
    expect(closestClients("the COA", clients)[0]?.name).toBe("Aldecoa Coffee");
    expect(closestClients("Glen Hook", clients)[0]?.name).toBe("Crust Pizza - Gleannloch Farms");
    expect(closestClients("Glenmark", clients)[0]?.name).toBe("Crust Pizza - Gleannloch Farms");
  });

  it("offers nothing for a name that isn't close to any client", () => {
    expect(closestClients("Zebra Plumbing", clients)).toEqual([]);
    expect(closestClients("ok", clients)).toEqual([]);
  });
});

describe("the person's own clients come first", () => {
  it("a near tie goes to the client they're seated on", () => {
    const list = [
      { id: "a", name: "Crust Pizza - Gleannloch Farms" },
      { id: "b", name: "Crust Pizza Co." },
    ];
    expect(closestClients("Crust Pizzas", list, 3, new Set(["b"]))[0].id).toBe("b");
  });
});
