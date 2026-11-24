import { describe, expect, it } from "vitest";
import { argsFor, field, headerOf, listOf, readRpc, toolValue, workspaceMcpMode, WORKSPACE_MCP_URL } from "@/lib/workspace-mcp-core";
import { nyDay, UsageBuckets, workspaceApiOf } from "@/lib/google-usage-core";
import { bodyKeepDays, trimmedBody } from "@/lib/workspace-retention-core";

describe("workspace MCP mode", () => {
  it("is off unless switched on", () => {
    expect(workspaceMcpMode(undefined)).toBe("off");
    expect(workspaceMcpMode("")).toBe("off");
    expect(workspaceMcpMode("on")).toBe("on");
    expect(workspaceMcpMode("TRUE")).toBe("on");
    expect(workspaceMcpMode("only")).toBe("only");
  });
  it("points at Google's MCP endpoints", () => {
    expect(WORKSPACE_MCP_URL.gmail).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(WORKSPACE_MCP_URL.drive).toBe("https://drivemcp.googleapis.com/mcp/v1");
  });
});

describe("reading MCP answers", () => {
  it("reads a JSON body and an event stream", () => {
    expect(readRpc("application/json", JSON.stringify({ jsonrpc: "2.0", id: 4, result: { ok: 1 } }), 4)?.result).toEqual({ ok: 1 });
    const sse = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"x":2}}\n\n`;
    expect(readRpc("text/event-stream", sse, 7)?.result).toEqual({ x: 2 });
    expect(readRpc("application/json", "nope", 1)).toBeNull();
  });
  it("takes structured content, else JSON text, else text", () => {
    expect(
      toolValue({
        structuredContent: { a: 1 },
        content: [{ type: "text", text: "x" }],
      }),
    ).toEqual({ a: 1 });
    expect(
      toolValue({
        content: [{ type: "text", text: '{"threads":[{"id":"1"}]}' }],
      }),
    ).toEqual({ threads: [{ id: "1" }] });
    expect(toolValue({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
    expect(toolValue({ content: [] })).toBeNull();
  });
  it("finds lists, fields and headers whatever the shape", () => {
    expect(listOf({ threads: [{ id: "a" }, 3] }, "threads")).toEqual([{ id: "a" }]);
    expect(listOf([{ id: "b" }])).toEqual([{ id: "b" }]);
    expect(field({ threadId: "t1" }, "id", "threadId")).toBe("t1");
    expect(headerOf({ payload: { headers: [{ name: "Subject", value: "Hi" }] } }, "subject")).toBe("Hi");
    expect(headerOf({ from: "a@b.co" }, "from")).toBe("a@b.co");
  });
  it("puts arguments under the names the tool's schema uses", () => {
    const want = {
      q: { names: ["query", "q"], value: "from:x" },
      n: { names: ["pageSize", "maxResults"], value: 5 },
      t: { names: ["threadId"], value: undefined },
    };
    expect(argsFor({ properties: { q: {}, maxResults: {} } }, want)).toEqual({
      q: "from:x",
      maxResults: 5,
    });
    expect(argsFor(null, want)).toEqual({ query: "from:x", pageSize: 5 });
  });
});

describe("Workspace request counting", () => {
  it("knows which Workspace API a URL is", () => {
    expect(workspaceApiOf("https://gmail.googleapis.com/gmail/v1/users/me/messages")).toEqual({ api: "gmail", via: "rest" });
    expect(workspaceApiOf("https://www.googleapis.com/drive/v3/files")).toEqual({ api: "drive", via: "rest" });
    expect(workspaceApiOf("https://www.googleapis.com/upload/drive/v3/files")).toEqual({ api: "drive", via: "rest" });
    expect(workspaceApiOf("https://slides.googleapis.com/v1/presentations/x")).toEqual({ api: "slides", via: "rest" });
    expect(workspaceApiOf("https://admin.googleapis.com/admin/directory/v1/users")).toEqual({ api: "directory", via: "rest" });
    expect(workspaceApiOf("https://gmailmcp.googleapis.com/mcp/v1")).toEqual({
      api: "gmail",
      via: "mcp",
    });
    expect(workspaceApiOf("https://oauth2.googleapis.com/token")).toBeNull();
    expect(workspaceApiOf("https://speech.googleapis.com/v1/x")).toBeNull();
    expect(workspaceApiOf("https://api.anthropic.com/v1/messages")).toBeNull();
  });
  it("buckets by New York day, API and path, and gives back what failed to write", () => {
    const b = new UsageBuckets();
    const at = Date.parse("2026-11-25T03:00:00Z"); // still Nov 24 in New York
    b.add("gmail", "rest", true, at);
    b.add("gmail", "rest", false, at);
    b.add("drive", "mcp", true, at);
    expect(nyDay(at)).toBe("2026-11-24");
    const rows = b.drain();
    expect(rows).toContainEqual({
      day: "2026-11-24",
      api: "gmail",
      via: "rest",
      requests: 2,
      errors: 1,
    });
    expect(b.pending).toBe(0);
    b.restore(rows);
    expect(b.pending).toBe(3);
  });
});

describe("Workspace data retention", () => {
  it("keeps 90 days unless set", () => {
    expect(bodyKeepDays(undefined)).toBe(90);
    expect(bodyKeepDays("45")).toBe(45);
    expect(bodyKeepDays("3")).toBe(14);
  });
  it("trims an old body to a short gist", () => {
    expect(trimmedBody("short")).toBe("short");
    const long = "word ".repeat(400);
    const t = trimmedBody(long);
    expect(t.length).toBeLessThanOrEqual(601);
    expect(t.endsWith("…")).toBe(true);
  });
});
