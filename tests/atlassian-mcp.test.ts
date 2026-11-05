import { describe, expect, it } from "vitest";
import { AtlassianMcpError, argsFor, findTool, loomVideosIn, needsCloudId, nextPageCursor, parseSse, rpcAnswer, sitesIn, toolData, transcriptIn, userLabelIn, type McpTool } from "@/lib/atlassian-mcp";

const A = "64ab914990654627836faa953282f302";
const B = "23f08cf6a8a648b8b17c55c551548cab";
const CLOUD = "1f2e3d4c-5b6a-4789-8abc-def012345678";

const text = (v: unknown) => ({ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) });

describe("the wire", () => {
  it("reads JSON-RPC messages from an event stream", () => {
    const body = `event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\ndata: {"jsonrpc":"2.0","id":3,\ndata: "result":{"tools":[]}}\n\n: keep-alive\n\n`;
    const msgs = parseSse(body);
    expect(msgs).toHaveLength(2);
    expect(rpcAnswer(body, "text/event-stream", 3)?.result).toEqual({ tools: [] });
  });

  it("reads a plain JSON answer, a batch, and an unlabeled stream", () => {
    expect(rpcAnswer(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`, "application/json", 1)?.result).toEqual({ ok: true });
    expect(rpcAnswer(`[{"jsonrpc":"2.0","id":1,"result":1},{"jsonrpc":"2.0","id":2,"result":2}]`, "application/json", 2)?.result).toBe(2);
    expect(rpcAnswer(`data: {"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"bad"}}\n\n`, "application/json", 5)?.error?.message).toBe("bad");
    expect(rpcAnswer(`{"jsonrpc":"2.0","id":9,"result":{}}`, "application/json", 1)).toBeNull();
  });
});

describe("tool results", () => {
  it("parses JSON text, fenced JSON, structured content and keeps plain text", () => {
    const data = toolData({
      structuredContent: { a: 1 },
      content: [text({ b: 2 }), text("Here you go:\n```json\n{\"c\":3}\n```"), text("just words"), { type: "image", data: "x" }, { type: "resource", resource: { text: '{"d":4}' } }],
    });
    expect(data).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, "just words", { d: 4 }]);
    expect(toolData(null)).toEqual([]);
  });

  it("finds Loom videos however the objects are shaped, once each, skipping folders", () => {
    const data = toolData({
      content: [
        text({
          objects: [
            { ari: `ari:cloud:loom:${CLOUD}:video/${A}`, type: "VIDEO", title: "Account walkthrough", createdAt: "2026-11-01T10:00:00Z", owner: { name: "x" } },
            { id: B, type: "video", name: "Second", created_at: 1_793_000_000, shareUrl: `https://www.loom.com/share/${B}?sid=1` },
            { id: "f".repeat(32), type: "FOLDER", name: "A folder" },
            { video: { url: `https://www.loom.com/share/${A}` } },
          ],
          pageInfo: { hasNextPage: true, endCursor: "eyJwIjoyfQ==" },
        }),
      ],
    });
    const v = loomVideosIn(data);
    expect(v.map((x) => x.id)).toEqual([A, B]);
    expect(v[0]).toMatchObject({ url: `https://www.loom.com/share/${A}`, title: "Account walkthrough", createdAt: "2026-11-01T10:00:00.000Z", ari: `ari:cloud:loom:${CLOUD}:video/${A}` });
    expect(v[1].title).toBe("Second");
    expect(v[1].createdAt).toBe(new Date(1_793_000_000 * 1000).toISOString());
    expect(nextPageCursor(data)).toBe("eyJwIjoyfQ==");
  });

  it("finds share links in a markdown answer", () => {
    const data = toolData({ content: [text(`1. **Weekly audit** https://www.loom.com/share/${A}\n2. https://loom.com/embed/${B.toUpperCase()}\nnextCursor: abc123def`)] });
    expect(loomVideosIn(data).map((x) => x.id)).toEqual([A, B]);
    expect(nextPageCursor(data)).toBe("abc123def");
  });

  it("knows the last page", () => {
    expect(nextPageCursor([{ items: [], pageInfo: { hasNextPage: false, endCursor: "zzz" } }])).toBeNull();
    expect(nextPageCursor([{ items: [], nextCursor: null }])).toBeNull();
    expect(nextPageCursor([{ next_cursor: "p2" }])).toBe("p2");
    expect(nextPageCursor([{ next: "https://example.com/page2" }])).toBeNull();
  });

  it("reads a transcript as phrases with times, as a string, or under a markdown heading", () => {
    const phrases = toolData({
      content: [text({ objects: [{ ari: `ari:cloud:loom:${CLOUD}:video/${A}`, title: "T", transcript: { phrases: [{ text: "First we open the account.", start: 0 }, { text: "Then frequency.", startMs: 75_000 }] } }] })],
    });
    expect(transcriptIn(phrases, A)).toBe("[0:00] First we open the account.\n[1:15] Then frequency.");
    expect(transcriptIn(phrases, B)).toBeNull();
    expect(transcriptIn([{ transcript: "A long enough transcript to count as one." }])).toBe("A long enough transcript to count as one.");
    expect(transcriptIn(["# Weekly audit\n\n## Transcript\nHey team, today we look at the CPA trend.\nIt went up.\n\n## Comments\nnice"])).toBe("Hey team, today we look at the CPA trend.\nIt went up.");
    expect(transcriptIn([{ title: "no transcript" }])).toBeNull();
  });

  it("reads the sites and who the token is", () => {
    const sites = sitesIn(toolData({ content: [text([{ id: CLOUD, name: "kaizen", url: "https://kaizen.atlassian.net", scopes: ["read:jira-work", "read:loom:agent-interface"] }, { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "other", url: "https://other.atlassian.net", scopes: [] }])] }));
    expect(sites).toEqual([
      { id: CLOUD, name: "kaizen", url: "https://kaizen.atlassian.net", loom: true },
      { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "other", url: "https://other.atlassian.net", loom: false },
    ]);
    expect(userLabelIn([{ account_id: "123", name: "Ops", email: "ops@example.com" }])).toBe("ops@example.com");
    expect(userLabelIn([{ accountId: "123", displayName: "Ops" }])).toBe("Ops");
  });
});

describe("arguments from a tool's schema", () => {
  const list: McpTool = {
    name: "listLoomObjects",
    inputSchema: {
      type: "object",
      properties: {
        cloudId: { type: "string" },
        scope: { type: "string", enum: ["OWNED", "SHARED_WITH_ME", "WORKSPACE"] },
        contentTypes: { type: "array", items: { type: "string", enum: ["VIDEO", "FOLDER"] } },
        createdAfter: { type: "string", format: "date-time" },
        cursor: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["cloudId"],
    },
  };

  it("fills a listing by the names the tool declares", () => {
    expect(argsFor(list, { cloudId: CLOUD, createdAfter: "2026-10-06T00:00:00.000Z", cursor: "p2", limit: 50, videos: true, wideScope: true })).toEqual({
      cloudId: CLOUD,
      scope: "WORKSPACE",
      contentTypes: ["VIDEO"],
      createdAfter: "2026-10-06T00:00:00.000Z",
      cursor: "p2",
      limit: 50,
    });
    expect(needsCloudId(list)).toBe(true);
  });

  it("leaves out what it doesn't want, and says when a required argument can't be filled", () => {
    expect(argsFor(list, { cloudId: CLOUD })).toEqual({ cloudId: CLOUD });
    expect(() => argsFor(list, {})).toThrow(AtlassianMcpError);
    expect(() => argsFor(list, {})).toThrow(/needs cloudId/);
  });

  it("handles other spellings: snake case, a date-only field, a nested filter", () => {
    const t: McpTool = { name: "x", inputSchema: { properties: { cloud_id: { type: "string" }, created_from: { type: "string", format: "date" }, page_token: { type: "string" }, page_size: { type: "number" } } } };
    expect(argsFor(t, { cloudId: CLOUD, createdAfter: "2026-10-06T08:00:00.000Z", cursor: "n", limit: 25 })).toEqual({ cloud_id: CLOUD, created_from: "2026-10-06", page_token: "n", page_size: 25 });
    const nested: McpTool = { name: "y", inputSchema: { properties: { filter: { type: "object", properties: { createdAfter: { type: "string" }, contentType: { type: "string", enum: ["video", "folder"] } } } } } };
    expect(argsFor(nested, { createdAfter: "2026-10-06T00:00:00.000Z", videos: true })).toEqual({ filter: { createdAfter: "2026-10-06T00:00:00.000Z", contentType: "video" } });
  });

  it("asks for the transcript of known objects", () => {
    const flag: McpTool = { name: "getLoomObjectsContent", inputSchema: { properties: { cloudId: { type: "string" }, objects: { type: "array", items: { type: "string" } }, includeTranscript: { type: "boolean" } }, required: ["objects"] } };
    expect(argsFor(flag, { cloudId: CLOUD, objects: [`https://www.loom.com/share/${A}`], transcript: true })).toEqual({ cloudId: CLOUD, objects: [`https://www.loom.com/share/${A}`], includeTranscript: true });
    const list2: McpTool = { name: "getLoomObjectsContent", inputSchema: { properties: { ids: { type: "array" }, include: { type: "array", items: { type: "string", enum: ["TRANSCRIPT", "AGENT_BRIEF", "COMMENTS"] } } } } };
    expect(argsFor(list2, { objects: ["u"], transcript: true })).toEqual({ ids: ["u"], include: ["TRANSCRIPT"] });
    const single: McpTool = { name: "z", inputSchema: { properties: { url: { type: "string" } } } };
    expect(argsFor(single, { objects: ["u"] })).toEqual({ url: "u" });
  });

  it("finds tools by name or pattern", () => {
    const tools: McpTool[] = [{ name: "getAccessibleAtlassianResources" }, { name: "loom_listLoomObjects" }];
    expect(findTool(tools, "listLoomObjects", /loom.*(list|search).*object|list.*loom/i)?.name).toBe("loom_listLoomObjects");
    expect(findTool(tools, "getaccessibleatlassianresources")?.name).toBe("getAccessibleAtlassianResources");
    expect(findTool(tools, "nope")).toBeNull();
  });
});
