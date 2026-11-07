import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { asana } from "@/lib/asana";

const oops = { errors: [{ message: "Oops! An unexpected error occurred while processing this request." }] };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("asana() reads", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries Asana's transient server errors and returns the data", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(500, oops)).mockResolvedValueOnce(reply(503, oops)).mockResolvedValueOnce(reply(200, { data: [{ gid: "1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const p = asana<{ gid: string }[]>("/workspaces");
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ data: [{ gid: "1" }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up with Asana's message when the error persists", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply(500, oops));
    vi.stubGlobal("fetch", fetchMock);
    const p = asana("/workspaces");
    const done = expect(p).rejects.toThrow(/^Asana: Oops!/);
    await vi.runAllTimersAsync();
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("doesn't retry a request Asana rejects as bad", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(400, { errors: [{ message: "Bad gid" }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(asana("/tasks/x")).rejects.toThrow("Asana: Bad gid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
