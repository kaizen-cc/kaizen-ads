import { describe, expect, it } from "vitest";
import { channelSeatsOf, isBlankName, sheetRows, socialDetailsBrief, socialDetailsOf, splitNames } from "@/lib/account-sheet-channels-core";

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

import { matchKey } from "@/lib/account-sheet-channels-core";
describe("matching", () => {
  it("ignores accents and broken formulas", () => {
    expect(matchKey("Café Diario")).toBe(matchKey("Cafe Diario"));
    expect(isBlankName("#REF!")).toBe(true);
  });
});

describe("socialDetailsOf (the Organic Social tab)", () => {
  const tab = [
    ["Account Overview"],
    ["client name", "SOCIAL MEDIA CALENDAR", "Ad Creative Folder", "Client Headquarters Link", "Website", "Instagram Handle", "Strategist Assigned", "Graphic Designer", "Posting Cadence", "Notes"],
    ["Tejas Brewery", "https://docs.google.com/spreadsheets/d/abc", "https://drive.google.com/drive/folders/zzz", "https://drive.google.com/drive/folders/hq1", "tejas.com", "@tejasbrew", "Camila", "Hillary", "4 posts a week", "Loves local events"],
  ];
  const row = sheetRows(tab)[0];
  it("finds the header row whatever the case and keeps the quick links under the keys the deliverable line reads", () => {
    const d = socialDetailsOf(row);
    expect(d.calendar).toBe("https://docs.google.com/spreadsheets/d/abc");
    expect(d.creativeFolder).toBe("https://drive.google.com/drive/folders/zzz");
    expect(d.hq).toBe("https://drive.google.com/drive/folders/hq1");
    expect(d.website).toBe("tejas.com");
    expect(d.handles).toBe("@tejasbrew");
    expect(d.cadence).toBe("4 posts a week");
    expect(d.team).toEqual({ "Strategist Assigned": "Camila", "Graphic Designer": "Hillary" });
  });
  it("keeps every column as key and value and drops blanks", () => {
    const d = socialDetailsOf({ ...row, Empty: "", Gone: "#N/A" });
    expect(d.all.Notes).toBe("Loves local events");
    expect(d.all.Empty).toBeUndefined();
    expect(d.all.Gone).toBeUndefined();
  });
  it("writes a brief for agents with the extra columns too", () => {
    const text = socialDetailsBrief(socialDetailsOf(row));
    expect(text).toContain("Social Media Calendar: https://docs.google.com/spreadsheets/d/abc");
    expect(text).toContain("Notes: Loves local events");
    expect(socialDetailsBrief(null)).toBe("");
  });
});
