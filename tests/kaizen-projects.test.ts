import { describe, expect, it } from "vitest";
import { batches, parseProjects, projectItem } from "@/lib/kaizen-ai/claude-import";
import { canDeleteProject, canEditProject, canUseProject, chunksOf, cleanConnectors, connectorKey, connectorLabel, fitKnowledge, projectBlock, projectRole, sharingOf, type ProjectAccess } from "@/lib/kaizen-ai/projects";

// Kaizen AI projects, like Claude's: who may see and change one (the same rules as private.ai_project_role), how
// its knowledge is fitted into what a chat reads, and how Claude's projects.json becomes a project on import.

const owner = { id: "owner", isExec: false };
const alice = { id: "alice", isExec: false };
const bob = { id: "bob", isExec: false };
const exec = { id: "exec", isExec: true };
const base: ProjectAccess = { created_by: "owner", visibility: "private", everyone_can_edit: false, members: [] };

describe("who can do what in a project", () => {
  it("private: only the owner (and execs, who can see every project, read only)", () => {
    const p = { ...base, members: [{ profile_id: "alice", role: "editor" as const }] };
    expect(projectRole(p, owner)).toBe("owner");
    // People left on the list don't count while it's private
    expect(projectRole(p, alice)).toBeNull();
    expect(projectRole(p, bob)).toBeNull();
    expect(projectRole(p, exec)).toBe("viewer");
  });

  it("specific people: each as a viewer or an editor", () => {
    const p: ProjectAccess = { ...base, visibility: "people", members: [{ profile_id: "alice", role: "editor" }, { profile_id: "bob", role: "viewer" }] };
    expect(projectRole(p, alice)).toBe("editor");
    expect(projectRole(p, bob)).toBe("viewer");
    expect(projectRole(p, { id: "carol", isExec: false })).toBeNull();
    expect(projectRole(p, exec)).toBe("viewer");
  });

  it("everyone at Kaizen: view, or edit when the owner lets everyone edit; people added keep edit", () => {
    const view: ProjectAccess = { ...base, visibility: "everyone", members: [{ profile_id: "alice", role: "editor" }] };
    expect(projectRole(view, bob)).toBe("viewer");
    expect(projectRole(view, alice)).toBe("editor");
    expect(projectRole({ ...view, everyone_can_edit: true }, bob)).toBe("editor");
    expect(projectRole({ ...view, everyone_can_edit: true }, owner)).toBe("owner");
  });

  it("viewers start chats and read; editors change; only the owner deletes", () => {
    expect([canUseProject("viewer"), canEditProject("viewer"), canDeleteProject("viewer")]).toEqual([true, false, false]);
    expect([canUseProject("editor"), canEditProject("editor"), canDeleteProject("editor")]).toEqual([true, true, false]);
    expect([canUseProject("owner"), canEditProject("owner"), canDeleteProject("owner")]).toEqual([true, true, true]);
    expect([canUseProject(null), canEditProject(null)]).toEqual([false, false]);
  });
});

describe("fitting the knowledge into a chat", () => {
  it("sends every doc whole when it all fits", () => {
    const fit = fitKnowledge([{ name: "voice.md", text: "Warm, direct." }, { name: "empty", text: "" }, { name: "offer.txt", text: "20% off" }], "write a hook");
    expect(fit.mode).toBe("all");
    expect(fit.included).toBe(2);
    expect(fit.text).toContain('<doc name="voice.md">\nWarm, direct.\n</doc>');
    expect(fit.text).toContain("20% off");
  });

  it("says when there's nothing to read", () => {
    expect(fitKnowledge([{ name: "scan.pdf", text: null }], "x").mode).toBe("none");
  });

  it("past the budget, takes the parts that matter to the message and names what was left out", () => {
    const filler = (word: string) => Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about ${word} and general agency matters that go on for a while.`).join("\n\n");
    const docs = [
      { name: "Shipping policy", text: `${filler("logistics")}\n\nFree shipping threshold is $75 on every order to the lower 48 states.\n\n${filler("logistics")}` },
      { name: "Brand voice", text: filler("tone") },
      { name: "Old notes", text: filler("history") },
    ];
    const fit = fitKnowledge(docs, "What's the free shipping threshold?", 5_000, 3_000);
    expect(fit.mode).toBe("retrieved");
    expect(fit.text).toContain("Free shipping threshold is $75");
    expect(fit.text).toContain('note="excerpts');
    expect(fit.text.length).toBeLessThan(3_000 + 1_500);
    expect(fit.text).toMatch(/more than fits in one message/);
  });

  it("cuts docs at paragraph breaks", () => {
    const text = Array.from({ length: 10 }, (_, i) => `${"word ".repeat(80)}${i}`).join("\n\n");
    const parts = chunksOf(text, 1000);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("wraps instructions and knowledge in one project block, empty when there's nothing", () => {
    const fit = fitKnowledge([{ name: "a", text: "Alpha" }], "q");
    const block = projectBlock({ name: 'Box "Themes"', description: "Spring push", instructions: "Lead with numbers" }, fit);
    expect(block).toContain("<project name=\"Box 'Themes'\"");
    expect(block).toContain("<project_instructions");
    expect(block).toContain("Lead with numbers");
    expect(block).toContain("<project_knowledge");
    expect(projectBlock({ name: "x", description: "", instructions: "" }, fitKnowledge([], "q"))).toBe("");
  });
});

describe("connectors a project expects", () => {
  it("keeps clean, unique keys", () => {
    expect(connectorKey(" Google Drive ")).toBe("google_drive");
    expect(cleanConnectors(["Shopify", "shopify", "", "Google Drive", 5])).toEqual(["shopify", "google_drive", "5"]);
    expect(connectorLabel("shopify")).toBe("Shopify");
    expect(connectorLabel("big_commerce")).toBe("Big Commerce");
  });
});

describe("Claude's projects.json, read into projects", () => {
  it("reads the name, description, instructions and docs, whatever the instructions field is called", () => {
    const [a, b] = parseProjects({
      projects: [
        { uuid: "p1", name: "OceanBox", description: "Q1 ads", prompt_template: "Be concise", docs: [{ uuid: "d1", filename: "voice.md", content: "Our voice" }], creator: { uuid: "acc-1" }, is_private: true },
        { id: "p2", name: "", custom_instructions: "Use bullets", docs: [{ title: "Notes", content: "n" }] },
      ],
    });
    expect(a).toMatchObject({ uuid: "p1", name: "OceanBox", description: "Q1 ads", instructions: "Be concise", docs: [{ name: "voice.md", text: "Our voice" }], creator: "acc-1", sharing: { visibility: "private" } });
    expect(b).toMatchObject({ uuid: "p2", name: "Claude project", instructions: "Use bullets", docs: [{ name: "Notes", text: "n" }] });
  });

  it("brings the sharing the export states: org-wide, editable, or people by email", () => {
    expect(sharingOf({ is_private: false })).toEqual({ visibility: "everyone", everyoneCanEdit: false, people: [] });
    expect(sharingOf({ is_private: false, org_permission: "can_edit" }).everyoneCanEdit).toBe(true);
    const people = sharingOf({ members: [{ user: { email_address: "Alice@KaizenMarketing.agency", uuid: "u1" }, role: "editor" }, { email: "bob@kaizenmarketing.agency", permission: "view" }, { nothing: true }] });
    expect(people.visibility).toBe("people");
    expect(people.people).toEqual([
      { email: "alice@kaizenmarketing.agency", account: "u1", role: "editor" },
      { email: "bob@kaizenmarketing.agency", account: null, role: "viewer" },
    ]);
    expect(sharingOf({}).visibility).toBe("private");
  });

  it("makes a project item that carries its chats and goes first in its batch", () => {
    const [p] = parseProjects([{ uuid: "p1", name: "OceanBox", prompt_template: "Be concise", docs: [{ filename: "v.md", content: "x".repeat(100) }] }]);
    const item = projectItem(p, ["c1", "c2"], "client-1", "2026-11-10T00:00:00Z");
    expect(item).toMatchObject({ uuid: "project:p1", kind: "project", clientId: "client-1", last: true, project: { name: "OceanBox", instructions: "Be concise", chatUuids: ["c1", "c2"] } });
    const chat = { uuid: "c1", kind: "chat" as const, title: "t", createdAt: "", updatedAt: "", clientId: null, notes: [], part: 0, last: true, messages: [{ role: "user" as const, text: "hi", at: "", files: [] }], projectUuid: "p1" };
    expect(batches([item, chat])[0].map((i) => i.uuid)).toEqual(["project:p1", "c1"]);
    // A project's size counts toward the request limit
    expect(batches([item, chat], 150)).toHaveLength(2);
  });
});
