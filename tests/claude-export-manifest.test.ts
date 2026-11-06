import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { linksExpired, looksLikeManifestName, missingFiles, parseManifest, sameFile, wantedFiles } from "@/lib/kaizen-ai/claude-export-manifest";
import { classifyExportJson, isWantedEntry, mergeExport, parseJsonOrLines, readClaudeExportFiles, readManifest } from "@/lib/kaizen-ai/claude-import-file";
import { ownChats, parseConversations } from "@/lib/kaizen-ai/claude-import";

// Claude's newer export: an emailed manifest listing the parts (chats split across several ZIPs, who's who in the
// light_metadata part), read in the browser, its links shown, then the downloaded parts read and merged.

const link = (n: number) => `https://claude.ai/export/exp-1/download/token-${n}`;
const sample = {
  instructions: "Download each file using the export_url. Each link expires 24 hours after it is created and may stop working before then once it has been used, so download...",
  created_at: "2026-10-27T19:34:10.884864+00:00",
  total_files: 9,
  data_files: [
    { batch_index: 0, export_url: link(0), category: "light_metadata", part: 0, filename: "light_metadata-000.zip" },
    { batch_index: 1, export_url: link(1), category: "projects", part: 0, filename: "projects-000.zip" },
    { batch_index: 2, export_url: link(2), category: "memories", part: 0, filename: "memories-000.zip" },
    { batch_index: 3, export_url: link(3), category: "design_chats", part: 0, filename: "design_chats-000.zip" },
    { batch_index: 4, export_url: link(4), category: "frames", part: 0, filename: "frames-000.zip" },
    { batch_index: 5, export_url: link(5), category: "artifact_data", part: 0, filename: "artifact_data-000.zip" },
    { batch_index: 7, export_url: link(7), category: "conversations", part: 1, filename: "conversations-001.zip" },
    { batch_index: 6, export_url: link(6), category: "conversations", part: 0, filename: "conversations-000.zip" },
    { batch_index: 8, export_url: link(8), category: "conversations", part: 2, filename: "conversations-002.zip" },
  ],
  version: "1.0",
};

const chat = (uuid: string, account: string, messages = 1) => ({
  uuid,
  name: `Chat ${uuid}`,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:05:00Z",
  account: { uuid: account },
  chat_messages: Array.from({ length: messages }, (_, i) => ({ uuid: `${uuid}-m${i}`, sender: i % 2 ? "assistant" : "human", text: `message ${i}`, created_at: `2026-10-01T10:0${i}:00Z` })),
});
const users = [
  { uuid: "acc-owner", full_name: "Owner", email_address: "owner@kaizenmarketing.agency" },
  { uuid: "acc-buyer", full_name: "Buyer", email_address: "buyer@kaizenmarketing.agency" },
];

describe("Claude's export manifest", () => {
  it("is recognized by its export links, and by its name", () => {
    expect(parseManifest(sample)).not.toBeNull();
    expect(parseManifest([chat("a", "x")])).toBeNull();
    expect(parseManifest({ data_files: [{ filename: "x.zip", export_url: "javascript:alert(1)" }] })).toBeNull();
    expect(looksLikeManifestName("member-manifest-1b2c-1730057650-abc-2026-10-27-19-34-10.json")).toBe(true);
    expect(looksLikeManifestName("conversations.json")).toBe(false);
  });

  it("lists the chat parts in order, who's who as needed, projects as optional, and the rest as not needed", () => {
    const m = parseManifest(sample)!;
    expect(m.createdAt).toBe("2026-10-27T19:34:10.884Z");
    expect(m.expiresAt).toBe("2026-10-28T19:34:10.884Z");
    expect(wantedFiles(m).map((f) => [f.filename, f.label, f.required])).toEqual([
      ["conversations-000.zip", "Your chats, part 1 of 3", true],
      ["conversations-001.zip", "Your chats, part 2 of 3", true],
      ["conversations-002.zip", "Your chats, part 3 of 3", true],
      ["light_metadata-000.zip", "Who's who (needed to keep only your chats)", true],
      ["projects-000.zip", "Projects (optional)", false],
    ]);
    expect(m.files.filter((f) => f.role === "other").map((f) => f.filename)).toEqual(["artifact_data-000.zip", "design_chats-000.zip", "frames-000.zip", "memories-000.zip"]);
    expect(m.files.find((f) => f.filename === "conversations-001.zip")!.url).toBe(link(7));
  });

  it("says which needed files are still missing, counting a browser's renamed second download", () => {
    const m = parseManifest(sample)!;
    expect(missingFiles(m, ["conversations-000.zip", "conversations-002.zip", "projects-000.zip"]).map((f) => f.filename)).toEqual(["conversations-001.zip", "light_metadata-000.zip"]);
    expect(missingFiles(m, ["conversations-000.zip", "conversations-001 (1).zip", "Conversations-002.ZIP", "light_metadata-000.zip"])).toEqual([]);
    expect(sameFile("C:\\fakepath\\light_metadata-000 (2).zip", "light_metadata-000.zip")).toBe(true);
    expect(sameFile("conversations-0001.zip", "conversations-001.zip")).toBe(false);
  });

  it("knows when the links are past their 24 hours", () => {
    const m = parseManifest(sample)!;
    expect(linksExpired(m, Date.parse("2026-10-28T10:00:00Z"))).toBe(false);
    expect(linksExpired(m, Date.parse("2026-10-28T19:35:00Z"))).toBe(true);
  });

  it("is spotted among dropped files without being read as data", async () => {
    const file = new File([JSON.stringify(sample)], "member-manifest-abc-2026-10-27-19-34-10.json", { type: "application/json" });
    expect((await readManifest(file))?.files).toHaveLength(9);
    expect(await readManifest(new File([JSON.stringify([chat("a", "x")])], "conversations.json"))).toBeNull();
  });
});

describe("reading what's inside the parts", () => {
  it("picks JSON and JSON Lines files about conversations, users or projects, at any depth", () => {
    expect(isWantedEntry("conversations.json")).toBe(true);
    expect(isWantedEntry("export/data/conversations-000.jsonl")).toBe(true);
    expect(isWantedEntry("light_metadata/users.json")).toBe(true);
    expect(isWantedEntry("projects/projects.json")).toBe(true);
    expect(isWantedEntry("memories.json")).toBe(false);
    expect(isWantedEntry("frames/conversations.png")).toBe(false);
  });

  it("tells what a file holds by its content, not its name", () => {
    const found = classifyExportJson([chat("a", "x"), users[0], { uuid: "p1", name: "Project", docs: [] }, { uuid: "light", name: "metadata only" }]);
    expect(found.conversations).toHaveLength(1);
    expect(found.users).toHaveLength(1);
    expect(found.projects).toHaveLength(1);
    expect(classifyExportJson({ users }).users).toHaveLength(2);
    expect(classifyExportJson({ uuid: "p2", prompt_template: "Be brief" }).projects).toHaveLength(1);
  });

  it("reads JSON Lines", () => {
    const text = `${JSON.stringify(chat("a", "x"))}\n${JSON.stringify(chat("b", "x"))}\n`;
    expect(classifyExportJson(parseJsonOrLines(text, "conversations.jsonl")).conversations).toHaveLength(2);
    expect(() => parseJsonOrLines("{nope", "x.json")).toThrow(/isn't readable JSON/);
  });

  it("merges chats across parts, each once (the fullest copy)", () => {
    const merged = mergeExport([
      { conversations: [chat("a", "x", 1), chat("b", "x")], projects: [], users: null },
      { conversations: [chat("a", "x", 3), chat("c", "x")], projects: [{ uuid: "p1", docs: [] }], users: [users[0]] },
      { conversations: [chat("a", "x", 2)], projects: [{ uuid: "p1", docs: [] }], users: [users[0], users[1]] },
    ]);
    expect(merged.conversations.map((c) => (c as { uuid: string }).uuid).sort()).toEqual(["a", "b", "c"]);
    expect((merged.conversations.find((c) => (c as { uuid: string }).uuid === "a") as { chat_messages: unknown[] }).chat_messages).toHaveLength(3);
    expect(merged.projects).toHaveLength(1);
    expect(merged.users).toHaveLength(2);
    expect(mergeExport([{ conversations: [], projects: [], users: [] }]).users).toBeNull();
  });

  it("reads several downloaded ZIPs at once, then keeps only my chats", async () => {
    const zip = (name: string, files: Record<string, unknown>) => new File([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(typeof v === "string" ? v : JSON.stringify(v))])))], name);
    const files = [
      zip("conversations-000.zip", { "conversations.json": [chat("o1", "acc-owner"), chat("b1", "acc-buyer")] }),
      zip("conversations-001.zip", { "data/conversations-001.jsonl": [chat("o2", "acc-owner"), chat("o1", "acc-owner")].map((c) => JSON.stringify(c)).join("\n") }),
      zip("light_metadata-000.zip", { "users.json": users, "conversations.json": [{ uuid: "o1", name: "metadata only" }] }),
      zip("projects-000.zip", { "projects.json": [{ uuid: "p1", name: "Mine", creator: { uuid: "acc-owner" }, docs: [{ filename: "a.md", content: "notes" }] }] }),
      zip("memories-000.zip", { "memories.json": [{ text: "skip me" }] }),
      new File([JSON.stringify(sample)], "member-manifest-abc.json"),
    ];
    const read = await readClaudeExportFiles(files);
    expect(read.files.map((f) => [f.name, f.chats, f.people, f.projects])).toEqual([
      ["conversations-000.zip", 2, 0, 0],
      ["conversations-001.zip", 2, 0, 0],
      ["light_metadata-000.zip", 0, 2, 0],
      ["projects-000.zip", 0, 0, 1],
      ["memories-000.zip", 0, 0, 0],
    ]);
    expect(read.conversations).toHaveLength(3);
    const own = ownChats(read, "Owner@KaizenMarketing.agency");
    expect(own.ok && own.kind).toBe("org");
    expect(own.ok && parseConversations(own.conversations).map((c) => c.uuid).sort()).toEqual(["o1", "o2"]);
    expect(own.ok && own.projects).toHaveLength(1);
  });

  it("finds nothing in parts without chats (the caller names the files read)", async () => {
    const read = await readClaudeExportFiles([new File([zipSync({ "projects.json": strToU8("[]") })], "projects-000.zip")]);
    expect(read.conversations).toEqual([]);
    expect(read.files.map((f) => f.name)).toEqual(["projects-000.zip"]);
  });
});
