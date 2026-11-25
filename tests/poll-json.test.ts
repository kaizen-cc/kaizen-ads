import { afterEach, describe, expect, it, vi } from "vitest";
import { pollJson } from "@/lib/fail-fast";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pollJson (background polls never abort after the fact, #155)", () => {
  it("returns the JSON and stops its timer once the answer is read", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => ((signal = init.signal ?? undefined), new Response(JSON.stringify({ a: 1 })))));
    expect(await pollJson<{ a: number }>("/x", {}, 10_000)).toEqual({ a: 1 });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(signal?.aborted).toBe(false);
  });

  it("lets go of a non-ok answer's body and returns null", async () => {
    vi.useFakeTimers();
    const res = new Response("nope", { status: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => res));
    expect(await pollJson("/x", {}, 10_000)).toBeNull();
    expect(res.bodyUsed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up with null (not a thrown TimeoutError) when the server is too slow", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("signal timed out", "TimeoutError"))))),
    );
    const out = pollJson("/x", {}, 10_000);
    vi.advanceTimersByTime(10_000);
    expect(await out).toBeNull();
  });

  it("returns null on a dropped connection or bad JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await pollJson("/x", {}, 10_000)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>")));
    expect(await pollJson("/x", {}, 10_000)).toBeNull();
  });
});
