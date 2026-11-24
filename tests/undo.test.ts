import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isClosedLocally } from "@/lib/closed-items";
import { deferClear, flushPending, pendingCount, undoAll, undoLast, UNDO_MS } from "@/lib/undo";

// Owner, Nov 24 2026: everything that clears an Overview item offers Undo. Nothing is written until the window closes,
// so Undo puts it back exactly as it was and nothing (no write, no notice to the asker or the new owner) happens.

describe("Undo on anything cleared", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    undoAll();
    vi.useRealTimers();
  });

  it("Undo inside the window: back on screen, nothing written, the caller restores its own state", async () => {
    const commit = vi.fn(async () => ({ ok: true }));
    const onUndo = vi.fn();
    deferClear({ keys: ["ask:1"], label: "Marked done", commit, onUndo });
    expect(isClosedLocally("ask:1")).toBe(true);
    expect(pendingCount()).toBe(1);
    expect(undoLast()).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(isClosedLocally("ask:1")).toBe(false);
    expect(pendingCount()).toBe(0);
  });

  it("no Undo: written once when the window closes, and it stays off", async () => {
    const commit = vi.fn(async () => ({ ok: true }));
    deferClear({ keys: ["ask:2"], label: "Marked done", commit });
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit).toHaveBeenCalledOnce();
    expect(isClosedLocally("ask:2")).toBe(true);
    expect(undoLast()).toBe(false);
  });

  it("several quick ones: Undo all brings every one back, newest first; leaving the page writes what's waiting", async () => {
    const order: string[] = [];
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    deferClear({ keys: ["x:1"], label: "Marked done", commit: a, onUndo: () => order.push("1") });
    deferClear({ keys: ["x:2", "x:3"], label: "Done, and its reminder with it", commit: b, onUndo: () => order.push("2") });
    undoAll();
    expect(order).toEqual(["2", "1"]);
    expect(["x:1", "x:2", "x:3"].some(isClosedLocally)).toBe(false);
    const c = vi.fn(async () => undefined);
    deferClear({ keys: ["x:4"], label: "Back tomorrow", commit: c });
    flushPending();
    await vi.advanceTimersByTimeAsync(0);
    expect(c).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
  });

  it("a write that fails puts it back and says so", async () => {
    const onUndo = vi.fn();
    const onError = vi.fn();
    deferClear({ keys: ["ask:3"], label: "Transferred to Pat", commit: async () => ({ ok: false, error: "That teammate isn't active." }), onUndo, onError });
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    expect(isClosedLocally("ask:3")).toBe(false);
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("That teammate isn't active.");
  });
});
