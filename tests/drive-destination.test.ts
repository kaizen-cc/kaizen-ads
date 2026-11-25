import { describe, expect, it } from "vitest";
import { candidatesLine, confirmLine, destinationClientKey, nextStep, sameFolderName, pathText, savedLine, subPath, type Destination } from "@/lib/drive-destination-core";
import { parseFolderRef } from "@/lib/drive-push-core";

const hq: Destination = { id: "f1", path: ["Shared drives", "Kaizen HQ", "Case Studies"], link: "https://drive.google.com/drive/folders/f1" };

describe("the Drive destination rule: never a guess", () => {
  it("uses the folder named in this conversation first, without a second yes", () => {
    expect(nextStep({ named: "https://drive.google.com/drive/folders/abc", remembered: hq, confirmed: false })).toEqual({ step: "resolve_named" });
  });
  it("proposes the remembered folder as one quick confirm, and saves there only on the yes", () => {
    expect(nextStep({ named: "", remembered: hq, confirmed: false })).toEqual({ step: "confirm_remembered", dest: hq });
    expect(nextStep({ named: null, remembered: hq, confirmed: true })).toEqual({ step: "use_remembered", dest: hq });
  });
  it("asks which folder when nothing was named or remembered (never My Drive's root)", () => {
    expect(nextStep({ named: "  ", remembered: null, confirmed: true })).toEqual({ step: "ask_folder" });
  });
});

describe("what the person hears", () => {
  it("says the full path and link before saving, and the file and path after", () => {
    expect(pathText(hq.path)).toBe("Shared drives › Kaizen HQ › Case Studies");
    expect(confirmLine(hq)).toBe("Saving to Shared drives › Kaizen HQ › Case Studies (https://drive.google.com/drive/folders/f1), OK?");
    expect(savedLine("https://docs.google.com/x", hq)).toBe("Saved: https://docs.google.com/x in Shared drives › Kaizen HQ › Case Studies.");
    expect(savedLine(null, { ...hq, made: true })).toBe("Saved in Shared drives › Kaizen HQ › Case Studies (a new folder).");
  });
  it("lists every candidate with its whole path when several match", () => {
    const other: Destination = { id: "f2", path: ["My Drive", "Case Studies"], link: null };
    expect(candidatesLine([hq, other])).toBe("More than one folder matches: 1) Shared drives › Kaizen HQ › Case Studies (https://drive.google.com/drive/folders/f1); 2) My Drive › Case Studies. Which one?");
  });
  it("reads a subfolder path the way people say it", () => {
    expect(subPath("08-Kaizen Content/Case Studies")).toEqual(["08-Kaizen Content", "Case Studies"]);
    expect(subPath("08-Kaizen Content › Case Studies")).toEqual(["08-Kaizen Content", "Case Studies"]);
    expect(subPath("")).toEqual([]);
  });
});

describe("Kaizen documents' filing", () => {
  it("says a folder that will be made is new, before anything is made", () => {
    const d: Destination = { id: "", path: ["Shared drives", "Kaizen", "Clients", "Acme", "Proposals & SOWs"], link: "https://drive.google.com/drive/folders/hq", willCreate: { parentId: "hq", name: "Proposals & SOWs" } };
    expect(confirmLine(d)).toBe("Saving to Shared drives › Kaizen › Clients › Acme › Proposals & SOWs (new folder) (https://drive.google.com/drive/folders/hq), OK?");
  });
  it("remembers per client, or per prospect by name before they're a client", () => {
    expect(destinationClientKey({ clientId: "c1", prospect: "Acme" })).toBe("c1");
    expect(destinationClientKey({ clientId: null, prospect: " Acme Co " })).toBe("p:acme co");
    expect(destinationClientKey({ clientId: null })).toBe("");
  });
  it("takes a folder or shared drive by its id from code", () => {
    expect(parseFolderRef("id:0AFxYz123456789Uk9PVA")).toEqual({ id: "0AFxYz123456789Uk9PVA" });
  });
});

describe("folder names written differently", () => {
  it("matches the same name with other spacing, dashes or case, never a nearby name", () => {
    expect(sameFolderName("08 - Kaizen Content", "08-Kaizen Content")).toBe(true);
    expect(sameFolderName("Case_Studies", "case studies")).toBe(true);
    expect(sameFolderName("08 - Kaizen Content", "07-Kaizen Content")).toBe(false);
    expect(sameFolderName("Kaizen Contents", "Kaizen Content")).toBe(false);
  });
});

describe("My Drive's top level, when they ask for it (Nov 25)", () => {
  it("reads 'my drive', 'main drive', 'root' and the Drive home links as the top level", () => {
    for (const s of ["my drive", "My Drive", "main drive", "root", "the root", "root of my drive", "my drive root", "top level", "https://drive.google.com/drive/u/0/home", "https://drive.google.com/drive/my-drive", "https://drive.google.com/drive/u/1/my-drive?usp=sharing"]) expect(parseFolderRef(s)).toEqual({ root: true });
  });
  it("still reads folders inside it, other links and paths as before", () => {
    expect(parseFolderRef("My Drive/Clients")).toEqual({ path: ["Clients"] });
    expect(parseFolderRef("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStU")).toEqual({ id: "1AbCdEfGhIjKlMnOpQrStU" });
    expect(parseFolderRef("Root Beer Campaign")).toEqual({ path: ["Root Beer Campaign"] });
  });
  it("is said plainly and confirmed like any folder", () => {
    const top = { id: "0AAbc", path: ["My Drive"], link: "https://drive.google.com/drive/my-drive", root: true };
    expect(confirmLine(top)).toBe("Saving to My Drive (top level) (https://drive.google.com/drive/my-drive), OK?");
    expect(savedLine("https://docs.google.com/d/1", top)).toBe("Saved: https://docs.google.com/d/1 in My Drive (top level).");
  });
  it("is never the fallback: nothing named and nothing remembered still asks", () => {
    expect(nextStep({ named: "", remembered: null, confirmed: true })).toEqual({ step: "ask_folder" });
  });
});
