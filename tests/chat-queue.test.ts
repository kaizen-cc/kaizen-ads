import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession, type ChatLine } from "@/lib/agent-call/chat-engine";

// Typing while the assistant answers queues the message: shown as queued, answered after the current answer, and it
// can be taken back (Edit / Remove) until its turn starts.

afterEach(() => vi.unstubAllGlobals());

function session() {
  vi.stubGlobal("window", { location: { pathname: "/pipeline", search: "" } });
  const lines = new Map<number, ChatLine>();
  const removed: number[] = [];
  const s = new ChatSession({ onLine: (l) => lines.set(l.id, l), onRemove: (id) => removed.push(id), onBusy: () => undefined, onError: () => undefined });
  return { s, lines, removed };
}

describe("queued messages", () => {
  it("a message sent while an answer is being written is queued, then sent in its turn", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<Response>((ok) => (release = ok)));
    vi.stubGlobal("fetch", fetch);
    const { s, lines } = session();
    s.send("first");
    s.send("second");
    expect([...lines.values()].find((l) => l.text === "first")?.queued).toBeFalsy();
    expect([...lines.values()].find((l) => l.text === "second")?.queued).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect([...lines.values()].find((l) => l.text === "second")?.queued).toBe(false);
    s.close();
  });

  it("a queued message can be taken back before its turn, and never reaches the assistant", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<Response>((ok) => (release = ok)));
    vi.stubGlobal("fetch", fetch);
    const { s, lines, removed } = session();
    s.send("first");
    s.send("never mind");
    const queued = [...lines.values()].find((l) => l.text === "never mind")!;
    expect(s.unqueue(queued.id)).toBe("never mind");
    expect(removed).toEqual([queued.id]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(new Response(null, { status: 500 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.unqueue(queued.id)).toBeNull();
    s.close();
  });
});
