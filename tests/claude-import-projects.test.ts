import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { importSummary, ownChats, parseConversation, parseConversations, parseProjects, projectItem, stubProjects, STUB_PROJECT_NOTE } from "@/lib/kaizen-ai/claude-import";
import { attachProjectFiles, classifyExportJson, isProjectDocEntry, isWantedEntry, mergeProject, readClaudeExportFiles } from "@/lib/kaizen-ai/claude-import-file";

// Claude exports' projects, wherever they sit in the files (projects.json, one file per project in projects-000.zip,
// docs as their own files, a metadata-only copy in light_metadata), and whole conversations: the branch the chat
// ended on, every message of a long one, attachments' text and artifacts.

const ROOT = "00000000-0000-4000-8000-000000000000";
const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 12, min)).toISOString();
const msg = (uuid: string, parent: string, sender: "human" | "assistant", text: string, min: number, extra: Record<string, unknown> = {}) => ({ uuid, parent_message_uuid: parent, sender, content: [{ type: "text", text }], created_at: t(min), ...extra });
const zip = (name: string, files: Record<string, unknown>) => new File([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(typeof v === "string" ? v : JSON.stringify(v))])))], name);

const P1 = "019917aa-a255-72a6-b38a-64884ef06c58";
const P2 = "019fc95f-03aa-747d-8dde-da310f529f8a";

const branched = {
  uuid: "c-branch",
  name: "Angry Chickz launch",
  created_at: t(0),
  updated_at: t(20),
  project_uuid: P1,
  current_leaf_message_uuid: "a4",
  chat_messages: [
    msg("h1", ROOT, "human", "Plan the launch", 0, { attachments: [{ file_name: "brief.pdf", extracted_content: "Grand opening May 3" }] }),
    msg("a1", "h1", "assistant", "Here's a plan", 1),
    // Edited follow-up: h2a abandoned (and a retry under it), h2b is the branch it ended on
    msg("h2a", "a1", "human", "Old question", 2),
    msg("a2a", "h2a", "assistant", "Old answer", 3),
    msg("h2b", "a1", "human", "Make the menu ad", 4),
    {
      uuid: "a3",
      parent_message_uuid: "h2b",
      sender: "assistant",
      content: [
        { type: "text", text: "Here it is." },
        { type: "tool_use", name: "artifacts", input: { command: "create", id: "menu", title: "Menu ad copy", type: "text/markdown", content: "# Menu\nSpicy tenders" } },
        { type: "tool_use", name: "artifacts", input: { command: "update", id: "menu", old_str: "Spicy", new_str: "Hot" } },
      ],
      created_at: t(5),
    },
    msg("h4", "a3", "human", "Thanks", 6),
    msg("a4", "h4", "assistant", "Anytime", 7),
    // A later retry on the abandoned branch: newer, but not where the chat ended
    msg("a2b", "h2a", "assistant", "Retry on the old branch", 30),
  ],
};

describe("whole conversations", () => {
  it("follows the branch the chat ended on, with attachments' text and artifacts", () => {
    const c = parseConversation(branched)!;
    expect(c.messages.map((m) => m.text.split("\n")[0])).toEqual(["Plan the launch", "Here's a plan", "Make the menu ad", "Here it is.", "Thanks", "Anytime"]);
    expect(c.messages[0].files).toEqual([{ name: "brief.pdf", text: "Grand opening May 3" }]);
    expect(c.messages[3].files).toEqual([{ name: "Artifact: Menu ad copy", text: "# Menu\nSpicy tenders" }]);
    expect(c.projectUuid).toBe(P1);
  });

  it("without a leaf, ends on the newest message nothing follows", () => {
    const c = parseConversation({ ...branched, current_leaf_message_uuid: undefined })!;
    expect(c.messages.at(-1)!.text).toBe("Retry on the old branch");
    expect(c.messages.map((m) => m.text)).toContain("Old question");
  });

  it("never cuts a long chat, and keeps what came before a missing link", () => {
    const list = [msg("m0", ROOT, "human", "start", 0)];
    for (let i = 1; i < 1200; i++) list.push(msg(`m${i}`, `m${i - 1}`, i % 2 ? "assistant" : "human", `turn ${i} ${"x".repeat(500)}`, i));
    const long = parseConversation({ uuid: "long", name: "Long", created_at: t(0), current_leaf_message_uuid: "m1199", chat_messages: list })!;
    expect(long.messages).toHaveLength(1200);
    // m600's parent isn't in the file: the chain from the leaf stops there, but the first 600 still come
    const broken = list.map((m) => (m.uuid === "m600" ? { ...m, parent_message_uuid: "gone" } : m));
    expect(parseConversation({ uuid: "b", name: "B", created_at: t(0), current_leaf_message_uuid: "m1199", chat_messages: broken })!.messages).toHaveLength(1200);
    // A huge message is kept whole up to its cap
    const big = parseConversation({ uuid: "big", created_at: t(0), chat_messages: [msg("x", ROOT, "human", "y".repeat(300_000), 0)] })!;
    expect(big.messages[0].text).toHaveLength(300_000);
  });
});

describe("finding projects in the export", () => {
  it("reads any JSON and doc file in a projects part or folder", () => {
    expect(isWantedEntry(`projects/${P1}.json`, "projects-000.zip")).toBe(true);
    expect(isWantedEntry(`${P1}.json`, "projects-000.zip")).toBe(true);
    expect(isWantedEntry(`${P1}.json`, "conversations-000.zip")).toBe(false);
    expect(isProjectDocEntry(`projects/Kaizen/docs/brief.md`, "export.zip")).toBe(true);
    expect(isProjectDocEntry(`brief.md`, "conversations-000.zip")).toBe(false);
    // In a projects part, a named thing with an id is a project; elsewhere it isn't
    expect(classifyExportJson({ uuid: P1, name: "Kaizen" }, true).projects).toHaveLength(1);
    expect(classifyExportJson({ uuid: P1, name: "Kaizen" }).projects).toHaveLength(0);
    // One project per file, wrapped
    expect(classifyExportJson({ project: { uuid: P1, name: "Kaizen" }, docs: [{ filename: "a.md", content: "A" }] }, true).projects[0]).toMatchObject({ uuid: P1, docs: [{ filename: "a.md" }] });
  });

  it("merges a metadata-only copy with the full one, and attaches docs kept as files", () => {
    const merged = mergeProject({ uuid: P1, name: "Kaizen", is_private: true }, { uuid: P1, name: "", prompt_template: "Be brief", docs: [{ filename: "a.md", content: "A" }] }) as Record<string, unknown>;
    expect(merged).toMatchObject({ name: "Kaizen", prompt_template: "Be brief", docs: [{ filename: "a.md", content: "A" }] });
    const [p] = attachProjectFiles([{ uuid: P1, name: "Angry Chickz" }], [
      { path: `projects/${P1}/docs/menu.md`, text: "Menu" },
      { path: "projects/Angry Chickz/prompt_template.md", text: "Write like a chef" },
      { path: "projects/Someone else/x.md", text: "nope" },
    ]) as Record<string, unknown>[];
    expect(p).toMatchObject({ prompt_template: "Write like a chef", docs: [{ filename: "menu.md", content: "Menu" }] });
  });

  it("reads zipped parts end to end: projects with docs and instructions, their chats, a stub for one not described", async () => {
    const other = { uuid: "c-other", name: "Second", created_at: t(40), updated_at: t(41), project: { uuid: P2 }, chat_messages: [msg("o1", ROOT, "human", "Hi", 40), msg("o2", "o1", "assistant", "Hello", 41)] };
    const loose = { uuid: "c-loose", name: "Loose", created_at: t(50), chat_messages: [msg("l1", ROOT, "human", "No project", 50, { attachments: [{ file_name: "a.csv", extracted_content: "x,y" }] })] };
    const files = [
      zip("conversations-000.zip", { "conversations.json": [branched, loose] }),
      zip("conversations-001.zip", { "data/conversations.jsonl": JSON.stringify(other) }),
      zip("light_metadata-000.zip", { "projects.json": [{ uuid: P1, name: "Angry Chickz", is_private: true }] }),
      zip("projects-000.zip", {
        [`projects/${P1}/project.json`]: { uuid: P1, name: "Angry Chickz", description: "Launch work", docs: [{ filename: "voice.md", content: "Loud and proud" }] },
        [`projects/${P1}/prompt_template.md`]: "Always mention the sauce",
        [`projects/${P1}/docs/menu.md`]: "Tenders, sliders",
      }),
    ];
    const read = await readClaudeExportFiles(files);
    expect(read.files.find((f) => f.name === "projects-000.zip")!.projects).toBe(1);
    const own = ownChats(read, "me@kaizen.test");
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const convs = parseConversations(own.conversations);
    const projects = parseProjects(own.projects);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ uuid: P1, name: "Angry Chickz", description: "Launch work", instructions: "Always mention the sauce" });
    expect(projects[0].docs.map((d) => d.name).sort()).toEqual(["menu.md", "voice.md"]);
    const stubs = stubProjects(convs, projects);
    expect(stubs).toEqual([expect.objectContaining({ uuid: P2, name: "Claude project: Second", description: STUB_PROJECT_NOTE, stub: true })]);
    expect(importSummary(convs, projects.length + stubs.length)).toBe("3 chats, 2 projects, 2 had attachments");
    const item = projectItem(stubs[0], ["c-other"], null, t(0));
    expect(item.project).toMatchObject({ stub: true, chatUuids: ["c-other"] });
  });

  it("says what was inside a projects part it couldn't read projects from", async () => {
    const read = await readClaudeExportFiles([zip("projects-000.zip", { "README.txt": "hi", "projects/notes.bin": "x" })]);
    expect(read.files[0]).toMatchObject({ name: "projects-000.zip", projects: 0, inside: ["README.txt", "projects/notes.bin"] });
  });
});
