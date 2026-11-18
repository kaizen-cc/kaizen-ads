import { describe, expect, it } from "vitest";
import { findHq, isClientFolder, isHqFolder, lineFolderStep, type HqDrive } from "@/lib/copy-docs/hq-path";
import { requestSection } from "@/lib/copy-docs/core";

// Clients root > "<ID>-<Name>" > "<Name>-Headquarters" > "Email Marketing": found, never made (only the last level is)

type Tree = Record<string, { name: string; kids: string[] }>;
const driveOf = (tree: Tree): HqDrive => ({
  folderName: async (id) => {
    if (!tree[id]) throw new Error("Drive GET: 404");
    return tree[id].name;
  },
  listFolders: async (id) => (tree[id]?.kids ?? []).map((k) => ({ id: k, name: tree[k].name })),
});

const ID = (n: string) => `${n}`.padEnd(20, "x");
const tree: Tree = {
  [ID("root")]: { name: "Clients", kids: [ID("acre"), ID("ocean")] },
  [ID("acre")]: { name: "1200-Ocean & Acre", kids: [ID("acrehq")] },
  [ID("acrehq")]: { name: "Ocean & Acre - Headquarters", kids: [] },
  [ID("ocean")]: { name: "1234 - OceanBox", kids: [ID("reports"), ID("oceanhq")] },
  [ID("reports")]: { name: "30 - Reports", kids: [] },
  [ID("oceanhq")]: { name: "OceanBox - Headquarters", kids: [ID("em")] },
  [ID("em")]: { name: "Email Marketing", kids: [] },
};
const ocean = { name: "Ocean Box", kaizenId: 1234 };

describe("folder names", () => {
  it("knows the client's folder by ID and name, however written", () => {
    expect(isClientFolder("1234-OceanBox", ocean)).toBe(true);
    expect(isClientFolder("1234 - Ocean Box", ocean)).toBe(true);
    expect(isClientFolder("1234_oceanbox", ocean)).toBe(true);
    expect(isClientFolder("1200-Ocean & Acre", ocean)).toBe(false);
    expect(isClientFolder("999-OceanBox", ocean)).toBe(false);
    expect(isClientFolder("OceanBox", ocean)).toBe(false);
  });
  it("knows the Headquarters folder", () => {
    expect(isHqFolder("OceanBox - Headquarters", ocean)).toBe(true);
    expect(isHqFolder("Ocean Box-Headquarters", ocean)).toBe(true);
    expect(isHqFolder("Headquarters", ocean)).toBe(true);
    expect(isHqFolder("OceanBox HQ", ocean)).toBe(true);
    expect(isHqFolder("Ocean & Acre - Headquarters", ocean)).toBe(false);
    expect(isHqFolder("OceanBox - Reports", ocean)).toBe(false);
  });
  it("the line's folder under the HQ: email exactly, social the team's own name", () => {
    expect(lineFolderStep("email", "Email Marketing").match("40 - email marketing")).toBe(true);
    const social = lineFolderStep("social", "Social Media");
    expect(social.match("Organic Social")).toBe(true);
    expect(social.match("Social Media")).toBe(true);
    expect(social.name()).toBe("Organic Social");
  });
});

describe("finding the Headquarters", () => {
  const drive = driveOf(tree);
  it("walks Clients root > client folder > Headquarters", async () => {
    expect(await findHq(drive, { client: ocean, root: ID("root") })).toMatchObject({ ok: true, id: ID("oceanhq"), via: "root" });
  });
  it("from the client's folder (drive_folder_id)", async () => {
    expect(await findHq(drive, { client: ocean, clientFolder: ID("ocean") })).toMatchObject({ ok: true, id: ID("oceanhq"), via: "client_folder" });
  });
  it("a stored HQ link is used once it's checked as the Headquarters", async () => {
    expect(await findHq(drive, { client: ocean, stored: [`https://drive.google.com/drive/folders/${ID("oceanhq")}`], root: ID("root") })).toMatchObject({ ok: true, id: ID("oceanhq"), via: "stored" });
  });
  it("a stored link to another folder (the Reports) is not taken as the HQ", async () => {
    expect(await findHq(drive, { client: ocean, stored: [`https://drive.google.com/drive/folders/${ID("reports")}`], root: ID("root") })).toMatchObject({ ok: true, id: ID("oceanhq"), via: "root" });
  });
  it("a pasted link comes first", async () => {
    expect(await findHq(drive, { client: ocean, pasted: `https://drive.google.com/drive/folders/${ID("ocean")}?usp=sharing`, root: ID("root") })).toMatchObject({ ok: true, id: ID("oceanhq"), via: "pasted" });
  });
  it("never another client's folder, and asks for the link when it can't be found", async () => {
    const r = await findHq(drive, { client: { name: "Sierra Dreams", kaizenId: 77 }, root: ID("root"), clientFolder: ID("acre") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.askForLink).toBe(true);
      expect(r.error).toMatch(/Paste the link/);
    }
  });
});

describe("the requests column", () => {
  const sections = [
    { gid: "1", name: "Untitled section" },
    { gid: "2", name: "1 - Email Requests" },
    { gid: "3", name: "Ready for Design" },
  ];
  it("finds Email Requests by name", () => {
    expect(requestSection(sections, "Email Requests")).toMatchObject({ ok: true, section: { gid: "2" } });
  });
  it("names the columns it found when it's missing", () => {
    const r = requestSection(sections.filter((s) => s.gid !== "2"), "Email Requests");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Untitled section, Ready for Design/);
  });
});
