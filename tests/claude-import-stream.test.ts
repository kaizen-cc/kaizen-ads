import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { JsonItemSplitter, readClaudeExportFiles, type ReadProgress } from "@/lib/kaizen-ai/claude-import-file";
import { ownChats, parseConversations } from "@/lib/kaizen-ai/claude-import";

// An organization's export can hold over a gigabyte of chats in one conversations.json: too big for the browser to
// turn into one string. It's split into its chats as it streams, and only the person's own are parsed and kept.

/** Feeds the bytes in pieces of the given size and returns each item's text */
function split(text: string | Uint8Array, piece: number) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const out: string[] = [];
  const s = new JsonItemSplitter((t) => out.push(t));
  for (let i = 0; i < bytes.length; i += piece) s.push(bytes.subarray(i, i + piece));
  s.end();
  return out;
}

const chat = (uuid: string, account: string | null, messages = 1) => ({
  uuid,
  name: `Chat ${uuid}`,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:05:00Z",
  ...(account ? { account: { uuid: account } } : {}),
  chat_messages: Array.from({ length: messages }, (_, i) => ({ uuid: `${uuid}-m${i}`, sender: i % 2 ? "assistant" : "human", text: `message ${i} of ${uuid}`, created_at: `2026-10-01T10:0${i}:00Z` })),
});
const users = [
  { uuid: "acc-owner", full_name: "Owner", email_address: "owner@kaizenmarketing.agency" },
  { uuid: "acc-buyer", full_name: "Buyer", email_address: "buyer@kaizenmarketing.agency" },
  { uuid: "acc-editor", full_name: "Editor", email_address: "editor@kaizenmarketing.agency" },
];
const zip = (name: string, files: Record<string, unknown>) =>
  new File([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(typeof v === "string" ? v : JSON.stringify(v))])))], name);
const uuids = (list: unknown[]) => list.map((c) => (c as { uuid: string }).uuid).sort();

describe("splitting streamed JSON into items", () => {
  it("isn't fooled by braces, brackets and escaped quotes inside strings", () => {
    const items = [{ a: 'he said "}{][" and left \\ with a backslash' }, { b: [1, { c: "]}" }], d: "\\\"" }, { e: "{" }];
    const text = JSON.stringify(items);
    for (const piece of [1, 2, 3, 7, 1000]) expect(split(text, piece).map((t) => JSON.parse(t) as unknown)).toEqual(items);
  });

  it("decodes characters split across chunks", () => {
    const items = [{ t: "café ☕ 日本語 🎉 naïve" }, { t: "😀😀😀" }];
    // One byte at a time cuts every multi-byte character in half
    expect(split(JSON.stringify(items), 1).map((t) => JSON.parse(t) as unknown)).toEqual(items);
  });

  it("reads the array inside a wrapper object, skipping the rest of the wrapper", () => {
    const text = JSON.stringify({ version: "1.0", meta: { conversations: "not this" }, conversations: [{ uuid: "a" }, { uuid: "b" }], total: 2 });
    expect(split(text, 5).map((t) => (JSON.parse(t) as { uuid: string }).uuid)).toEqual(["a", "b"]);
  });

  it("gives a lone object that isn't a wrapper back whole", () => {
    const one = chat("solo", "x", 2);
    expect(split(`  \n${JSON.stringify(one)}\n`, 4).map((t) => JSON.parse(t) as unknown)).toEqual([one]);
  });

  it("reads JSON Lines, one object per line", () => {
    const lines = [chat("a", "x"), chat("b", "y"), chat("c", "x")];
    const text = `${lines.map((l) => JSON.stringify(l)).join("\r\n")}\n`;
    expect(split(text, 9).map((t) => JSON.parse(t) as unknown)).toEqual(lines);
  });

  it("says when the JSON stops partway through", () => {
    expect(() => split('[{"a": "b"}, {"c": ', 4)).toThrow(/partway/);
  });

  it("splits a large-ish input in many uneven chunks", () => {
    const list = Array.from({ length: 3000 }, (_, i) => chat(`c${i}`, i % 3 ? "acc-buyer" : "acc-owner", 1 + (i % 4)));
    const bytes = new TextEncoder().encode(JSON.stringify(list, null, "\t"));
    const out: string[] = [];
    const s = new JsonItemSplitter((t) => out.push(t));
    let at = 0;
    for (let k = 0; at < bytes.length; k++) {
      const n = 1 + ((k * 7919) % 4096);
      s.push(bytes.subarray(at, at + n));
      at += n;
    }
    s.end();
    expect(out).toHaveLength(3000);
    expect(JSON.parse(out[2999])).toEqual(list[2999]);
    expect(out.map((t) => (JSON.parse(t) as { uuid: string }).uuid)).toEqual(list.map((c) => c.uuid));
  });
});

describe("reading a big organization export, keeping only my chats as it streams", () => {
  const big = [chat("o1", "acc-owner", 3), chat("b1", "acc-buyer"), chat("e1", "acc-editor"), chat("o2", "acc-owner"), chat("n1", null), chat("b2", "acc-buyer")];

  it("reads who's who first even when it comes last, then keeps only mine from the streamed parts", async () => {
    const files = [
      zip("conversations-000.zip", { "conversations.json": big.slice(0, 3) }),
      zip("conversations-001.zip", { "conversations.json": { conversations: big.slice(3) } }),
      zip("projects-000.zip", { "projects.json": [{ uuid: "p1", name: "Mine", creator: { uuid: "acc-owner" }, docs: [{ filename: "a.md", content: "notes" }] }, { uuid: "p2", name: "Theirs", creator: { uuid: "acc-buyer" }, docs: [] }] }),
      zip("light_metadata-000.zip", { "users.json": users }),
    ];
    const progress: ReadProgress[] = [];
    const read = await readClaudeExportFiles(files, { email: "Owner@KaizenMarketing.agency", streamOver: 0, onProgress: (p) => progress.push(p) });
    expect(uuids(read.conversations)).toEqual(["o1", "o2"]);
    expect(read.projects.map((p) => (p as { uuid: string }).uuid)).toEqual(["p1"]);
    // The others' chats (and the one with no account) are counted, never kept; files listed in the order given
    expect(read.skipped).toEqual({ chats: 4, projects: 1, accounts: ["acc-buyer", "acc-editor"] });
    expect(read.files.map((f) => [f.name, f.chats, f.people])).toEqual([
      ["conversations-000.zip", 1, 0],
      ["conversations-001.zip", 1, 0],
      ["projects-000.zip", 0, 0],
      ["light_metadata-000.zip", 0, 3],
    ]);
    const own = ownChats(read, "owner@kaizenmarketing.agency");
    expect(own.ok && [own.kind, own.account, own.otherPeople, own.skippedChats, own.skippedProjects]).toEqual(["org", "acc-owner", 2, 4, 1]);
    expect(own.ok && parseConversations(own.conversations).map((c) => c.uuid).sort()).toEqual(["o1", "o2"]);
    // Who's who read first; progress per file, ending with everything read
    expect(progress[0].file).toBe("light_metadata-000.zip");
    expect(progress.at(-1)!.done).toBe(progress.at(-1)!.total);
    const conv1 = progress.filter((p) => p.file === "conversations-001.zip").at(-1)!;
    expect(conv1.fileDone).toBe(conv1.fileTotal);
  });

  it("filters an older single ZIP whose chats come before its users", async () => {
    const file = zip("data-2026-10-27.zip", { "conversations.json": big, "projects.json": [], "users.json": users });
    const read = await readClaudeExportFiles([file], { email: "buyer@kaizenmarketing.agency", streamOver: 0 });
    expect(uuids(read.conversations)).toEqual(["b1", "b2"]);
    expect(read.skipped.chats).toBe(4);
  });

  it("filters the same way when the files are small enough to read whole", async () => {
    const files = [zip("conversations-000.zip", { "conversations.json": big }), zip("light_metadata-000.zip", { "users.json": users })];
    const read = await readClaudeExportFiles(files, { email: "editor@kaizenmarketing.agency" });
    expect(uuids(read.conversations)).toEqual(["e1"]);
    const own = ownChats(read, "editor@kaizenmarketing.agency");
    expect(own.ok && [own.kind, own.otherPeople, own.skippedChats]).toEqual(["org", 2, 5]);
  });

  it("counts a chat skipped in two parts once", async () => {
    const files = [zip("conversations-000.zip", { "conversations.json": [chat("b1", "acc-buyer")] }), zip("conversations-001.zip", { "conversations.jsonl": [chat("b1", "acc-buyer", 2), chat("o1", "acc-owner")].map((c) => JSON.stringify(c)).join("\n") }), zip("light_metadata-000.zip", { "users.json": users })];
    const read = await readClaudeExportFiles(files, { email: "owner@kaizenmarketing.agency", streamOver: 0 });
    expect(uuids(read.conversations)).toEqual(["o1"]);
    expect(read.skipped.chats).toBe(1);
  });

  it("reads no chats when the person isn't in the export, and says so", async () => {
    const files = [zip("conversations-000.zip", { "conversations.json": big }), zip("light_metadata-000.zip", { "users.json": users })];
    const read = await readClaudeExportFiles(files, { email: "someone@else.com", streamOver: 0 });
    expect(read.conversations).toEqual([]);
    const own = ownChats(read, "someone@else.com");
    expect(!own.ok && own.reason).toBe("not-in-export");
  });

  it("stops when there's no who's who and a second account turns up", async () => {
    const files = [zip("conversations-000.zip", { "conversations.json": big }), zip("conversations-001.zip", { "conversations.json": [chat("x1", "acc-owner")] })];
    const read = await readClaudeExportFiles(files, { email: "owner@kaizenmarketing.agency", streamOver: 0 });
    // Stopped at the buyer's chat: nothing after it was read
    expect(uuids(read.conversations)).toEqual(["b1", "o1"]);
    const own = ownChats(read, "owner@kaizenmarketing.agency");
    expect(!own.ok && own.reason).toBe("unknown-owners");
  });

  it("keeps a personal export whole (one account, no who's who)", async () => {
    const mine = [chat("a", "acc-me"), chat("b", "acc-me"), chat("c", null)];
    const read = await readClaudeExportFiles([new File([mine.map((c) => JSON.stringify(c)).join("\n")], "conversations.jsonl")], { email: "me@x.com", streamOver: 0 });
    expect(uuids(read.conversations)).toEqual(["a", "b", "c"]);
    const own = ownChats(read, "me@x.com");
    expect(own.ok && [own.kind, own.conversations.length]).toEqual(["personal", 3]);
  });

  it("names the file when a streamed one isn't readable JSON", async () => {
    await expect(readClaudeExportFiles([zip("conversations-000.zip", { "conversations.json": '[{"uuid": "a", "chat_messages": [}]' })], { streamOver: 0 })).rejects.toThrow(/conversations.json in conversations-000.zip isn't readable JSON/);
    await expect(readClaudeExportFiles([zip("conversations-000.zip", { "conversations.json": '[{"uuid": "a"' })], { streamOver: 0 })).rejects.toThrow(/isn't readable JSON/);
  });

  it("says a cut-short ZIP isn't complete", async () => {
    const whole = zipSync({ "conversations.json": strToU8(JSON.stringify(big)) });
    await expect(readClaudeExportFiles([new File([whole.subarray(0, whole.length - 30)], "conversations-000.zip")])).rejects.toThrow(/isn't a complete ZIP/);
  });
});
