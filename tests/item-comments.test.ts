import { describe, expect, it } from "vitest";
import { cleanComment, commentAudience, readPause } from "@/lib/item-comments-core";

const since = "2026-11-20T15:00:00Z";
const now = new Date("2026-11-21T15:00:00Z");

describe("waiting on client", () => {
  it("is paused while nothing new has happened", () => {
    expect(readPause({ waiting_on_client: true, waiting_since: since, due_at: "2026-11-25T00:00:00Z" }, {}, now)).toEqual({ paused: true });
  });
  it("ends when the client writes after it was marked", () => {
    expect(readPause({ waiting_on_client: true, waiting_since: since, due_at: null }, { lastClientMessageAt: "2026-11-20T16:00:00Z" }, now)).toEqual({ paused: false, ended: "message" });
  });
  it("ignores a client message from before it was marked", () => {
    expect(readPause({ waiting_on_client: true, waiting_since: since, due_at: null }, { lastClientMessageAt: "2026-11-20T14:00:00Z" }, now)).toEqual({ paused: true });
  });
  it("ends on a new asset", () => {
    expect(readPause({ waiting_on_client: true, waiting_since: since, due_at: null }, { lastAssetAt: "2026-11-21T09:00:00Z" }, now)).toEqual({ paused: false, ended: "asset" });
  });
  it("ends when the due date passes", () => {
    expect(readPause({ waiting_on_client: true, waiting_since: since, due_at: "2026-11-21T12:00:00Z" }, {}, now)).toEqual({ paused: false, ended: "due" });
  });
  it("isn't paused when nobody marked it", () => {
    expect(readPause(null)).toEqual({ paused: false, ended: null });
    expect(readPause({ waiting_on_client: false, waiting_since: null, due_at: null })).toEqual({ paused: false, ended: null });
  });
});

describe("who hears a comment", () => {
  it("is everyone it reached and who commented, never the author, each once", () => {
    expect(commentAudience({ author: "me", reached: ["a", "me", "b"], commenters: ["b", "c"], owners: ["d", null] }).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("a comment as typed", () => {
  it("is trimmed and capped", () => {
    expect(cleanComment("  hi\n\n\n\nthere  ")).toBe("hi\n\nthere");
    expect(cleanComment("x".repeat(3000))).toHaveLength(2000);
  });
});
