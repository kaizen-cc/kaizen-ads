import { describe, expect, it } from "vitest";
import { chatDraftKey, chatSizeKey, clearDraft, DRAFT_TTL_MS, readChatSize, readDraft, writeChatSize, writeDraft } from "@/lib/chat-drafts";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };

describe("chat drafts", () => {
  it("keys per person and thread", () => {
    expect(chatDraftKey("p1", "assistant")).toBe("kz:draft:p1:assistant");
    expect(chatDraftKey(null, "ai:new")).toBe("kz:draft:me:ai:new");
    expect(chatSizeKey("p1")).not.toBe(chatSizeKey("p2"));
  });

  it("keeps the words and uploaded attachments until sent or deleted", () => {
    const s = memory();
    writeDraft("k", "Hi Lucas,\nthe handover", [{ path: "a/b.pdf" }], 1000, s);
    expect(readDraft("k", 2000, s)).toEqual({ text: "Hi Lucas,\nthe handover", attachments: [{ path: "a/b.pdf" }], at: 1000 });
    // Deleting everything (or sending) removes it
    writeDraft("k", "   ", [], 3000, s);
    expect(s.m.has("k")).toBe(false);
    expect(readDraft("k", 3000, s).text).toBe("");
  });

  it("keeps attachments on their own", () => {
    const s = memory();
    writeDraft("k", "", [{ path: "x" }], 1, s);
    expect(readDraft("k", 2, s).attachments).toHaveLength(1);
  });

  it("drops a stale draft", () => {
    const s = memory();
    writeDraft("k", "old", [], 0, s);
    expect(readDraft("k", DRAFT_TTL_MS + 1, s).text).toBe("");
    expect(s.m.has("k")).toBe(false);
  });

  it("survives junk and blocked storage", () => {
    const s = memory();
    s.setItem("k", "{not json");
    expect(readDraft("k", 0, s)).toEqual({ text: "", attachments: [], at: 0 });
    expect(readDraft("k", 0, broken)).toEqual({ text: "", attachments: [], at: 0 });
    expect(() => writeDraft("k", "x", [], 0, broken)).not.toThrow();
    expect(() => clearDraft("k", broken)).not.toThrow();
    expect(readDraft("k", 0, null).text).toBe("");
  });

  it("remembers the chat size", () => {
    const s = memory();
    expect(readChatSize("c", s)).toBe("dock");
    writeChatSize("c", "large", s);
    expect(readChatSize("c", s)).toBe("large");
    writeChatSize("c", "dock", s);
    expect(readChatSize("c", s)).toBe("dock");
    expect(readChatSize("c", broken)).toBe("dock");
  });
});
