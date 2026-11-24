import { requireStaff } from "@/lib/auth";

// GET /api/workspace-mcp/check: execs only. After Google's Workspace MCP servers are enabled in the Cloud project, this
// asks each one (as the person opening it, read only) for its tools, so the switch to WORKSPACE_MCP=on can be checked
// before agents rely on it: which servers answer, what they're called, and the arguments each tool takes. Nothing is
// read from the mailbox or Drive. ?project: only which Cloud project the service account belongs to. docs/WORKSPACE-MCP.md.
export async function GET(request: Request) {
  let me;
  try {
    me = await requireStaff();
  } catch {
    return Response.json({ error: "Sign in first" }, { status: 401 });
  }
  if (!me.isExec) return Response.json({ error: "Execs only" }, { status: 403 });
  // Which Cloud project Kaizen OS's Google access lives in: the service account's project and address (never its key)
  let project: { project_id: string | null; service_account: string | null; client_id: string | null } = { project_id: null, service_account: null, client_id: null };
  try {
    const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "{}") as { project_id?: string; client_email?: string; client_id?: string };
    project = { project_id: key.project_id ?? null, service_account: key.client_email ?? null, client_id: key.client_id ?? null };
  } catch {
    /* not set or unreadable: shown as nulls */
  }
  if (new URL(request.url).searchParams.get("project") !== null) return Response.json({ project }, { headers: { "cache-control": "no-store" } });
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
  return Response.json({ project, mode: workspaceMcpMode(), as: me.email, results }, { headers: { "cache-control": "no-store" } });
}
