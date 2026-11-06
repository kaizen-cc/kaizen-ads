import { describe, expect, it } from "vitest";
import { batches, foreignItems, notImported, ownChats, parseConversation, parseConversations, parseProjects, partsOf, suggestClient } from "@/lib/kaizen-ai/claude-import";

// Reading Claude's data export into Kaizen AI threads: both the older shape (text per message) and the newer one
// (content blocks with tool calls and thinking, branches from edits), skipping what's already imported, and the
// client each chat is about.

const older = [
  {
    uuid: "c-old",
    name: "Crust Pizza holiday ads",
    created_at: "2024-11-02T15:00:00.000000+00:00",
    updated_at: "2024-11-02T16:00:00.000000+00:00",
    chat_messages: [
      { uuid: "m1", sender: "human", text: "Write three hooks for the holiday promo", created_at: "2024-11-02T15:00:01.000000+00:00", attachments: [{ file_name: "brief.txt", file_type: "txt", file_size: 20, extracted_content: "Holiday promo: 20% off" }], files: [{ file_name: "brief.txt" }, { file_name: "photo.png" }] },
      { uuid: "m2", sender: "assistant", text: "1. Hook one\n2. Hook two\n3. Hook three", created_at: "2024-11-02T15:00:05.000000+00:00" },
      { uuid: "m3", sender: "human", text: "", created_at: "2024-11-02T15:01:00Z" },
    ],
  },
  { uuid: "c-empty", name: "Nothing", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", chat_messages: [] },
  { name: "No id", chat_messages: [{ sender: "human", text: "hi" }] },
];

const newer = [
  {
    uuid: "c-new",
    name: "",
    summary: "**Conversation overview**\nThe person asked about Meta budgets.",
    created_at: "2026-05-01T10:00:00Z",
    updated_at: "2026-05-01T10:30:00Z",
    current_leaf_message_uuid: "n4",
    chat_messages: [
      { uuid: "n1", parent_message_uuid: "00000000-0000-4000-8000-000000000000", sender: "human", text: "ignored", content: [{ type: "text", text: "How should I split budget?" }], created_at: "2026-05-01T10:00:00Z" },
      {
        uuid: "n2",
        parent_message_uuid: "n1",
        sender: "assistant",
        text: "",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "tool_use", name: "web_search", input: { query: "meta budget" } },
          { type: "tool_result", content: [{ type: "text", text: "search results" }] },
          { type: "text", text: "Split 70/30 between prospecting and retargeting." },
        ],
        created_at: "2026-05-01T10:00:10Z",
      },
      // An edit made a branch: n3a was abandoned, n3b is where it ended
      { uuid: "n3a", parent_message_uuid: "n2", sender: "human", content: [{ type: "text", text: "Old follow-up" }], created_at: "2026-05-01T10:05:00Z" },
      { uuid: "n3b", parent_message_uuid: "n2", sender: "human", content: [{ type: "text", text: "What about Dump Daddy?" }], created_at: "2026-05-01T10:06:00Z" },
      { uuid: "n4", parent_message_uuid: "n3b", sender: "assistant", content: [{ type: "text", text: "For them, 60/40." }], created_at: "2026-05-01T10:06:00Z", project_uuid: null },
    ],
    project: { uuid: "p1", name: "Agency work" },
  },
];

describe("reading a Claude export", () => {
  it("reads the older shape: text, attachments with their text, file names", () => {
    const c = parseConversation(older[0])!;
    expect(c.uuid).toBe("c-old");
    expect(c.title).toBe("Crust Pizza holiday ads");
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c.messages[0].text).toBe("Write three hooks for the holiday promo");
    expect(c.messages[0].files).toEqual([
      { name: "brief.txt", text: "Holiday promo: 20% off" },
      { name: "photo.png", text: null },
    ]);
    expect(c.messages[0].at).toBe("2024-11-02T15:00:01.000Z");
    expect(c.createdAt).toBe("2024-11-02T15:00:00.000Z");
  });

  it("skips conversations with no id or nothing said", () => {
    const list = parseConversations(older);
    expect(list.map((c) => c.uuid)).toEqual(["c-old"]);
  });

  it("reads the newer shape: text blocks over text, thinking and tool internals left out, the branch it ended on", () => {
    const c = parseConversations(newer)[0];
    expect(c.title).toBe("Conversation overview");
    expect(c.projectUuid).toBe("p1");
    expect(c.messages.map((m) => m.text)).toEqual(["How should I split budget?", "Split 70/30 between prospecting and retargeting.\n\n_(On the way, Claude searched the web.)_", "What about Dump Daddy?", "For them, 60/40."]);
    expect(JSON.stringify(c)).not.toContain("secret reasoning");
    expect(JSON.stringify(c)).not.toContain("search results");
    // Same timestamp twice: kept in order, a millisecond apart
    expect(c.messages[3].at > c.messages[2].at).toBe(true);
  });

  it("accepts a wrapped list and falls back to the first message for a title", () => {
    const list = parseConversations({ conversations: [{ uuid: "x", chat_messages: [{ sender: "human", text: "Draft a launch email for the spring sale with three subject lines please" }] }] });
    expect(list[0].title.endsWith("…")).toBe(true);
    expect(list[0].title.length).toBeLessThanOrEqual(60);
  });

  it("reads project docs as notes, with the project's instructions first", () => {
    const projects = parseProjects([
      { uuid: "p1", name: "Agency work", prompt_template: "Be concise", docs: [{ filename: "voice.md", content: "Our voice" }, { filename: "empty.md", content: "" }] },
      { uuid: "p2", name: "No docs", docs: [] },
    ]);
    expect(projects).toEqual([{ uuid: "p1", name: "Agency work", docs: [{ name: "Project instructions", text: "Be concise" }, { name: "voice.md", text: "Our voice" }], creator: null }]);
  });
});

describe("importing once", () => {
  it("skips conversations already imported by this person", () => {
    const list = parseConversations([...older, ...newer]);
    expect(notImported(list, ["c-old"]).map((c) => c.uuid)).toEqual(["c-new"]);
    expect(notImported(list, []).length).toBe(2);
  });

  it("splits a long conversation into parts and keeps requests under the size limit", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: "x".repeat(1000), at: new Date(1e12 + i).toISOString(), files: [] }));
    const parts = partsOf({ uuid: "u", kind: "chat", title: "t", createdAt: "", updatedAt: "", clientId: null, notes: [{ name: "n", text: "note" }] }, messages, 3500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i));
    expect(parts.filter((p) => p.last).length).toBe(1);
    expect(parts.at(-1)!.last).toBe(true);
    expect(parts.slice(1).every((p) => p.notes.length === 0)).toBe(true);
    expect(parts.flatMap((p) => p.messages).length).toBe(10);
    const b = batches(parts, 3500);
    expect(b.flat().length).toBe(parts.length);
    // A project with docs and no messages is still one item
    expect(partsOf({ uuid: "project:p", kind: "project", title: "p", createdAt: "", updatedAt: "", clientId: null, notes: [{ name: "d", text: "doc" }] }, [])).toHaveLength(1);
  });
});

describe("the client a chat is about", () => {
  const clients = [
    { id: "crust", name: "Crust Pizza Co." },
    { id: "dump", name: "Dump Daddy" },
    { id: "elev", name: "Elevate" },
  ];
  it("matches the client named in the title", () => {
    expect(suggestClient(parseConversation(older[0])!, clients)?.id).toBe("crust");
  });
  it("matches the client named in how the chat starts", () => {
    expect(suggestClient(parseConversations(newer)[0], clients)?.id).toBe("dump");
  });
  it("suggests nothing when no client is named", () => {
    expect(suggestClient({ title: "Weekend plans", messages: [{ role: "user", text: "What should I cook?", at: "", files: [] }] }, clients)).toBeNull();
    expect(suggestClient({ title: "Crust Pizza", messages: [] }, [])).toBeNull();
  });
});

describe("only the importer's own chats", () => {
  const chat = (uuid: string, account: string | null) => ({
    uuid,
    name: `Chat ${uuid}`,
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:05:00Z",
    ...(account ? { account: { uuid: account } } : {}),
    chat_messages: [{ uuid: `${uuid}-m`, sender: "human", text: "hello", created_at: "2026-10-01T10:00:00Z" }],
  });
  const project = (uuid: string, creator: string | null) => ({
    uuid,
    name: `Project ${uuid}`,
    ...(creator ? { creator: { uuid: creator, full_name: "Someone" } } : {}),
    docs: [{ filename: "notes.md", content: "Some notes" }],
  });
  const users = [
    { uuid: "acc-owner", full_name: "Owner", email_address: "Owner@KaizenMarketing.agency" },
    { uuid: "acc-buyer", full_name: "Buyer", email_address: "buyer@kaizenmarketing.agency" },
    { uuid: "acc-designer", full_name: "Designer", email_address: "designer@kaizenmarketing.agency" },
  ];
  const orgConvs = [chat("o1", "acc-owner"), chat("b1", "acc-buyer"), chat("o2", "acc-owner"), chat("d1", "acc-designer"), chat("x1", null)];

  it("keeps only my chats from an organization's export with three accounts (email matched in any case)", () => {
    const r = ownChats({ conversations: orgConvs, projects: [], users }, "owner@kaizenmarketing.agency");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("org");
    expect(r.account).toBe("acc-owner");
    expect(parseConversations(r.conversations).map((c) => c.uuid).sort()).toEqual(["o1", "o2"]);
    expect(r.otherPeople).toBe(2);
    expect(r.skippedChats).toBe(3);
    expect(parseConversations(r.conversations).every((c) => c.account === "acc-owner")).toBe(true);
  });

  it("brings only the projects I made from an organization's export", () => {
    const r = ownChats({ conversations: orgConvs, projects: [project("p-mine", "acc-owner"), project("p-buyer", "acc-buyer"), project("p-unknown", null)], users }, "owner@kaizenmarketing.agency");
    expect(r.ok && parseProjects(r.projects).map((p) => [p.uuid, p.creator])).toEqual([["p-mine", "acc-owner"]]);
    expect(r.ok && r.skippedProjects).toBe(2);
  });

  it("refuses chats from several accounts with no users.json to say whose is whose", () => {
    const r = ownChats({ conversations: orgConvs, projects: null, users: null }, "owner@kaizenmarketing.agency");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unknown-owners");
  });

  it("refuses when my email isn't in the export, listing the accounts that are and none of the chats", () => {
    const r = ownChats({ conversations: orgConvs, projects: [], users }, "someone@kaizenmarketing.agency");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-in-export");
    expect(r.message).toContain("someone@kaizenmarketing.agency");
    expect(r.emails).toEqual(["buyer@kaizenmarketing.agency", "designer@kaizenmarketing.agency", "owner@kaizenmarketing.agency"]);
    expect(ownChats({ conversations: [chat("o1", "acc-owner")], projects: [], users }, "").ok).toBe(false);
  });

  it("treats several members in users.json as an organization's export even when only one of them has chats", () => {
    const r = ownChats({ conversations: [chat("b1", "acc-buyer")], projects: [], users }, "owner@kaizenmarketing.agency");
    expect(r.ok && r.conversations).toEqual([]);
  });

  it("keeps a personal export whole, whatever the Claude account's email", () => {
    const mine = [chat("a", "acc-me"), chat("b", "acc-me"), chat("c", null)];
    const r = ownChats({ conversations: mine, projects: [project("p1", "acc-me"), project("p2", null)], users: [{ uuid: "acc-me", full_name: "Me", email_address: "me@gmail.com" }] }, "me@kaizenmarketing.agency");
    expect(r.ok && r.kind).toBe("personal");
    expect(r.ok && r.account).toBe("acc-me");
    expect(r.ok && r.conversations.length).toBe(3);
    expect(r.ok && r.projects.length).toBe(2);
    // conversations.json on its own, older shape with no account at all
    const bare = ownChats({ conversations: older, projects: null, users: null }, "me@kaizenmarketing.agency");
    expect(bare.ok && bare.kind === "personal" && bare.account === null && bare.conversations.length === older.length).toBe(true);
  });

  it("flags items from another account than the one declared", () => {
    expect(foreignItems([{ account: "acc-owner" }, { account: null }, {}], "acc-owner")).toBe(0);
    expect(foreignItems([{ account: "acc-owner" }, { account: "acc-buyer" }], "acc-owner")).toBe(1);
  });
});
