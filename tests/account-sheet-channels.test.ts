import { describe, expect, it } from "vitest";
import { channelSeatsOf, isBlankName, sheetRows, splitNames } from "@/lib/account-sheet-channels-core";

describe("sheetRows", () => {
  it("finds the header row and reads the rows under it", () => {
    const rows = sheetRows([["Account Overview"], ["Client Name", "Designer", "Strategist", "Builder"], ["Atomic Wings", "Dani", "Mel", "Andres"]]);
    expect(rows).toEqual([{ "Client Name": "Atomic Wings", Designer: "Dani", Strategist: "Mel", Builder: "Andres" }]);
  });
  it("is empty without a Client Name column", () => {
    expect(sheetRows([["Name", "x"]])).toEqual([]);
  });
});

describe("channelSeatsOf", () => {
  it("reads the Email tab's three seats", () => {
    expect(channelSeatsOf("email", { "Client Name": "Kore", Designer: "Eunhye", Strategist: "Mel", Builder: "Irene" }).map((s) => [s.role, s.value])).toEqual([
      ["email_strategist", "Mel"],
      ["email_designer", "Eunhye"],
      ["email_builder", "Irene"],
    ]);
  });
  it("puts the video editor beside the graphic designer on Organic Social", () => {
    const seats = channelSeatsOf("social", { "Client Name": "Tejas", "Strategist Assigned": "Camila", "Graphic Designer": "Hillary", "Video Editor": "Jazem" });
    expect(seats.map((s) => [s.role, s.value, s.primary])).toEqual([
      ["social_manager", "Camila", true],
      ["social_creative", "Hillary", true],
      ["social_creative", "Jazem", false],
    ]);
  });
  it("skips blank cells", () => {
    expect(channelSeatsOf("email", { "Client Name": "X", Designer: "", Strategist: "Mel" }).map((s) => s.role)).toEqual(["email_strategist"]);
  });
});

describe("names", () => {
  it("splits several people and ignores placeholders", () => {
    expect(splitNames("Ana / Luis")).toEqual(["Ana", "Luis"]);
    expect(["#N/A", "n/a", "TBD", ""].every(isBlankName)).toBe(true);
    expect(isBlankName("Mel")).toBe(false);
  });
});
