import { describe, expect, it } from "vitest";
import { ICONS, iconFor, iconForImage, type BriefIcon } from "@/lib/brief-icons";
import { assetRow, clientDriveOf, dashTime, driveRows, fitSize, sourceLabel } from "@/lib/brief-cards";

// The brief's cards, as the lead video editor draws them: a line pictogram per beat or slide picked from its name (then
// what we see), the source as the quote box label, asset lines as rows, the client's Drive as the first two rows, and
// long text a step smaller rather than cut.

describe("brief pictograms", () => {
  it("picks the icon from the beat's name, the way his brief does", () => {
    const his: [string, string, BriefIcon][] = [
      ["Hook", "Dan on camera. Hook text + logo from frame 1.", "person"],
      ["The team", "B-roll of the staff at work.", "group"],
      ["Your way", "Dan on camera, then a seat view with BestTickets.com on screen.", "store"],
      ["Start to finish", "B-roll: arena entrance, aisle, seat view, crowd.", "gauge"],
      ["The difference", "Crowd B-roll, then Dan on camera for the last line.", "speech"],
      ["End card", "Seat view + logo, BestTickets.com and the tagline", "phone"],
    ];
    for (const [name, see, icon] of his) expect(iconFor(name, see), name).toBe(icon);
  });

  it("reads what we see when the name says nothing, and has a default", () => {
    expect(iconFor("Beat 2", "A packed arena, fans on their feet")).toBe("crowd");
    expect(iconFor("Beat 3", "The view from section 112")).toBe("ticket");
    expect(iconFor("Beat 4", "Unboxing the kit on a kitchen table")).toBe("box");
    expect(iconFor("Beat 5", "The launch offer on screen")).toBe("megaphone");
    expect(iconFor("Payoff", "")).toBe("check");
    expect(iconFor("Proof", "")).toBe("speech");
    expect(iconFor("CTA", "")).toBe("phone");
    expect(iconFor("Beat 6", "Montage of the footage")).toBe("play");
    expect(iconFor("Something", "nothing to go on")).toBe("play");
    expect(iconFor("Something", "", "check")).toBe("check");
  });

  it("picks a single image's pictogram from what's in the frame, never a group because a headline says people", () => {
    expect(iconForImage("Seat photo A", "The seat most people skip.")).toBe("seat");
    expect(iconForImage("", "The seat most people skip.")).toBe("seat");
    expect(iconForImage("The bottle on white", "Cold brew, done right")).toBe("box");
    expect(iconForImage("A real phone photo of the crowd", "")).toBe("photo");
    expect(iconForImage("", "Nothing to go on")).toBe("photo");
  });

  it("has fourteen drawn icons, each with shapes", () => {
    expect(Object.keys(ICONS)).toHaveLength(14);
    for (const parts of Object.values(ICONS)) expect(parts.length).toBeGreaterThan(0);
  });
});

describe("brief card text", () => {
  it("labels the quote box by speaker and source time, with en dashes", () => {
    expect(sourceLabel("Dan 0:12-0:16")).toBe("Dan · Source 0:12–0:16");
    expect(sourceLabel("Owner interview 0:00-0:04")).toBe("Owner interview · Source 0:00–0:04");
    expect(sourceLabel("0:44-0:50")).toBe("Source 0:44–0:50");
    expect(sourceLabel("Brand Bible")).toBe("Source · Brand Bible");
    expect(sourceLabel("")).toBe("Says");
    expect(dashTime("0:00-0:05")).toBe("0:00–0:05");
  });

  it("splits an asset line into his row: label, what it is, link", () => {
    expect(assetRow("Dan interview, full interview video https://drive.google.com/file/d/a/view")).toEqual({ label: "Dan interview", what: "Full interview video", url: "https://drive.google.com/file/d/a/view", need: null });
    expect(assetRow("Owner interview (Drive: Interviews / Owner), the full answer")).toMatchObject({ label: "Owner interview", what: "The full answer" });
    expect(assetRow("Need: Seat views without dates or scoreboards")).toMatchObject({ label: "Need", what: "Seat views without dates or scoreboards", url: null });
  });

  it("steps long text down a size instead of cutting it", () => {
    expect(fitSize("short", 9, 50)).toBe(9);
    expect(fitSize("x".repeat(60), 9, 50)).toBeCloseTo(8.2);
    expect(fitSize("x".repeat(200), 9, 50)).toBeCloseTo(7.4);
  });
});

describe("the client's Drive on every brief", () => {
  it("gives the headquarters and Ad Creatives folder as the first Open in Drive rows", () => {
    const d = clientDriveOf({ drive_folder_id: "1AbCdEfGhIjKlMnOp", ad_creative_folder_id: "1ZyXwVuTsRqPoNm" });
    expect(d).toEqual({ headquarters: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp", adCreatives: "https://drive.google.com/drive/folders/1ZyXwVuTsRqPoNm" });
    expect(driveRows(d).map((r) => [r.label, r.url])).toEqual([
      ["Client Drive (headquarters)", "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp"],
      ["Ad Creatives folder", "https://drive.google.com/drive/folders/1ZyXwVuTsRqPoNm"],
    ]);
  });

  it("skips a row when its folder id is missing", () => {
    expect(driveRows(clientDriveOf({ drive_folder_id: null, ad_creative_folder_id: "1ZyXwVuTsRqPoNm" })).map((r) => r.label)).toEqual(["Ad Creatives folder"]);
    expect(driveRows(clientDriveOf({ drive_folder_id: "1AbCdEfGhIjKlMnOp" })).map((r) => r.label)).toEqual(["Client Drive (headquarters)"]);
    expect(driveRows(clientDriveOf(null))).toEqual([]);
    expect(driveRows(null)).toEqual([]);
  });
});
