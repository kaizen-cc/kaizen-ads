import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { WANTS_DELIVERABLE, chatCardOf, deliverableNote } from "@/lib/deliverables/kaizen-core";
import { LINES } from "@/lib/deliverables/lines";
import type { CallCopyDoc } from "@/lib/agent-call/core";

const copy: CallCopyDoc = { id: "11111111-1111-1111-1111-111111111111", kind: "social", title: "November posts", client: "Tejas", version: 1, status: "draft", href: "/copy/11111111-1111-1111-1111-111111111111", emails: [], docUrl: null, asanaUrl: null };

describe("deliverable cards in Kaizen AI", () => {
  it("shows a copy document as a document card and everything else as a link card", () => {
    expect(chatCardOf({ title: "x", detail: "Tejas · 3 posts", href: copy.href, external: false, cta: "Open", copy })).toEqual({ type: "copy_doc", detail: "Tejas · 3 posts", copy });
    expect(chatCardOf({ title: "The copy (Google Doc)", detail: "d", href: "https://docs.google.com/x", external: true, cta: "Open the Doc" })).toEqual({ type: "link", title: "The copy (Google Doc)", detail: "d", href: "https://docs.google.com/x", cta: "Open the Doc", external: true });
  });
});

describe("the flow's note", () => {
  it("names each line's lead and writer and asks for labeled speakers", () => {
    const note = deliverableNote(LINES, "Strategist");
    for (const l of LINES) expect(note).toContain(l.lead.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase()));
    expect(note).toMatch(/bold label/);
    expect(note).toMatch(/typed?|clear yes/);
  });
  it("is sent for deliverable asks only", () => {
    expect(WANTS_DELIVERABLE.test("Can you write 3 email campaigns for Tejas?")).toBe(true);
    expect(WANTS_DELIVERABLE.test("Make a carousel for next week")).toBe(true);
    expect(WANTS_DELIVERABLE.test("How is spend pacing?")).toBe(false);
  });
});

describe("tool registration in Kaizen AI", () => {
  it("offers the flow's tools only on a thread, with the writes gated and the persona field", async () => {
    const { deliverableChatTools, DELIVERABLE_TOOL_NAMES } = await import("@/lib/deliverables/kaizen");
    const cards: unknown[] = [];
    const base = { me: { id: "p", fullName: "Pat", email: null, role: "head_of_creative", isExec: false, isLead: true }, db: {}, admin: {}, clientId: null, messageId: "m", cards, files: [] } as never;
    expect(await deliverableChatTools(base)).toEqual([]);
    const tools = await deliverableChatTools({ ...(base as object), threadId: "22222222-2222-2222-2222-222222222222", said: "not yet, show me the copy first", agent: "strategist" } as never);
    expect(tools.map((t) => t.name).sort()).toEqual([...DELIVERABLE_TOOL_NAMES].sort());
    for (const l of LINES) expect(DELIVERABLE_TOOL_NAMES).toEqual(expect.arrayContaining([l.tools.request, l.tools.update]));
    const flow = tools.find((t) => t.name === "deliverable")!;
    expect(JSON.stringify(flow.input_schema)).toContain("\"as\"");
    // A request without a typed yes does nothing
    const r = (await tools.find((t) => t.name === "create_social_request")!.run({ where: "asana", confirmed: true })) as { created: boolean };
    expect(r.created).toBe(false);
  });
});
