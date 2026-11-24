import { requireStaff } from "@/lib/auth";

// GET /api/workspace-mcp/check: execs only. After Google's Workspace MCP servers are enabled in the Cloud project, this
// asks each one (as the person opening it, read only) for its tools, so the switch to WORKSPACE_MCP=on can be checked
// before agents rely on it: which servers answer, what they're called, and the arguments each tool takes. Nothing is
// read from the mailbox or Drive. docs/WORKSPACE-MCP.md.
export async function GET() {
  let me;
  try {
    me = await requireStaff();
  } catch {
    return Response.json({ error: "Sign in first" }, { status: 401 });
  }
  if (!me.isExec) return Response.json({ error: "Execs only" }, { status: 403 });
  const { workspaceToolList, workspaceMcpMode } = await import("@/lib/workspace-mcp");
  const servers = ["gmail", "drive", "calendar", "docs", "sheets", "slides"] as const;
  const results = await Promise.all(
    servers.map(async (s) => {
      try {
        const tools = await workspaceToolList(s, me.email);
        return { server: s, ok: true, tools: tools.map((t) => ({ name: t.name, input: t.inputSchema ?? null, annotations: (t as { annotations?: unknown }).annotations ?? null })) };
      } catch (e) {
        return { server: s, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
      }
    }),
  );
  return Response.json({ mode: workspaceMcpMode(), as: me.email, results }, { headers: { "cache-control": "no-store" } });
}
