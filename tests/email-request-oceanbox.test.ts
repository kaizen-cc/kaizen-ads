import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAsanaProject } from "@/lib/asana-project";
import { isEmailMarketing, planLines, planTree, type FolderInfo } from "@/lib/copy-docs/tree-check-core";

// #139 (OceanBox December email requests): the Asana project is always found and passed, and the copy Docs live in
// Clients › "<ID> - <Client>" › "<Client> - Headquarters" › Email Marketing; a folder made elsewhere by an older run is
// listed and moved only on a yes.

const admin = (settings: Record<string, unknown>, sync: Record<string, unknown>) =>
  ({
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, key: string) => ({
          maybeSingle: async () => ({ data: table === "app_settings" ? (settings[key] !== undefined ? { value: settings[key] } : null) : sync[key] !== undefined ? { last_result: sync[key] } : null }),
        }),
      }),
    }),
  }) as never;

describe("the email requests' Asana project", () => {
  it("is the env var, else the setting, else the project the email mirror last synced", async () => {
    const src = { env: "TEST_EMAIL_PROJECT", setting: "asana_email_project", syncSource: "asana_email" };
    expect(await resolveAsanaProject(admin({}, { asana_email: { project: "1204478934966655" } }), src)).toEqual({ gid: "1204478934966655", from: "sync" });
    expect(await resolveAsanaProject(admin({ asana_email_project: { gid: "1111111111" } }, { asana_email: { project: "1204478934966655" } }), src)).toEqual({ gid: "1111111111", from: "setting" });
    expect(await resolveAsanaProject(admin({}, {}), src)).toBeNull();
  });

  it("every request path stops without a project and puts every task in it", () => {
    const code = readFileSync("src/lib/deliverables/server.ts", "utf8");
    const resolves = code.match(/const project = await projectFor\(admin, cfg\);\s*if \(!project\) return/g) ?? [];
    expect(resolves.length).toBeGreaterThanOrEqual(3);
    const creates = code.match(/asanaWrite[^;]*"\/tasks\?opt_fields=permalink_url"/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const base of code.match(/const base: Record<string, unknown> = \{[^}]*\}/g) ?? []) expect(base).toContain("projects: [project]");
    // A send date written as a day reaches the task (the check once missed its backslashes)
    expect(code).toContain("/^\\d{4}-\\d{2}-\\d{2}$/");
  });
});

const f = (id: string, path: string[], ancestors: string[]): FolderInfo => ({ id, name: path.at(-1)!, path, link: `https://drive.google.com/drive/folders/${id}`, ancestors });
const HQ = f("hq", ["Shared drives", "Clients", "341 - OceanBox", "OceanBox - Headquarters"], ["client", "clients"]);
const EM = f("em", [...HQ.path, "Email Marketing"], ["hq", "client", "clients"]);
const STRAY = f("stray", ["Shared drives", "Clients", "Email Marketing"], ["clients"]);

describe("OceanBox's copy Docs in Drive", () => {
  it("knows the Email Marketing folder however it's numbered", () => {
    expect(isEmailMarketing("Email Marketing")).toBe(true);
    expect(isEmailMarketing("03 - Email Marketing")).toBe(true);
    expect(isEmailMarketing("Email Marketing Archive")).toBe(false);
  });

  it("lists the folder made outside the Headquarters, and moves its Docs into the right one (on a yes)", () => {
    const plan = planTree({ hq: HQ, email: EM, docFolders: [{ folderId: "em", docs: 5 }, { folderId: "stray", docs: 1 }, { folderId: "gone", docs: 1 }], info: { em: EM, stray: STRAY, gone: null } });
    expect(plan.right).toBe(5);
    expect(plan.misplaced).toEqual([{ folder: STRAY, docs: 1, action: "move_docs" }]);
    expect(plan.unreadable).toEqual(["gone"]);
    expect(planLines(plan)).toEqual(['"Shared drives › Clients › Email Marketing" (1 Doc): move its files into Shared drives › Clients › 341 - OceanBox › OceanBox - Headquarters › Email Marketing']);
  });

  it("with no Email Marketing in the Headquarters yet, the folder itself moves under it", () => {
    const plan = planTree({ hq: HQ, email: null, docFolders: [{ folderId: "stray", docs: 2 }], info: { stray: STRAY } });
    expect(plan.misplaced[0].action).toBe("move_folder");
    expect(planLines(planTree({ hq: HQ, email: EM, docFolders: [{ folderId: "em", docs: 3 }], info: { em: EM } }))[0]).toMatch(/Nothing to move/);
  });
});
