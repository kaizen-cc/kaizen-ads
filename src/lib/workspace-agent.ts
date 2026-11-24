import "server-only";
import { withoutQuotes } from "@/lib/context/google";
import { isViewAsMessage } from "@/lib/view-as-core";
import { field, headerOf, listOf, workspaceMcpMode } from "./workspace-mcp-core";
import { workspaceCall } from "./workspace-mcp";

// The agent tools' Workspace actions through Google's Workspace MCP servers (search and read Gmail, make a Gmail draft,
// read a Drive file), shaped like the REST answers they replace so the tools keep their names and what they return.
// Each returns null when WORKSPACE_MCP is off or the MCP call failed while it's "on" (the tool then uses REST, as
// before, and the fallback is logged); with "only" a failure is thrown. docs/WORKSPACE-MCP.md.

const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  const mode = workspaceMcpMode();
  if (mode === "off") return null;
  try {
    return await run();
  } catch (e) {
    // Refused while the owner views as someone: never retried on REST
    if (mode === "only" || isViewAsMessage(e instanceof Error ? e.message : null)) throw e;
    console.warn(`[workspace-mcp] ${label} fell back to REST:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export type EmailHit = { from: string; to: string; subject: string; when: string; snippet: string; thread_id: string };

/** search_my_email: their Gmail searched with Gmail's syntax (search_threads) */
export const mcpSearchEmail = (mailbox: string, query: string, limit: number) =>
  attempt("search_my_email", async () => {
    const got = await workspaceCall("gmail", mailbox, "search_threads", { query: { names: ["query", "q"], value: query }, limit: { names: ["pageSize", "maxResults", "limit"], value: limit } });
    const threads = listOf(got, "threads", "results", "items").slice(0, limit);
    const emails: EmailHit[] = threads.map((t) => {
      const m = listOf(t, "messages")[0] ?? t;
      return {
        from: headerOf(m, "from"),
        to: headerOf(m, "to"),
        subject: headerOf(m, "subject"),
        when: field(m, "date", "internalDate", "receivedTime").slice(0, 25),
        snippet: clip(field(t, "snippet") || field(m, "snippet"), 300),
        thread_id: field(t, "threadId", "id"),
      };
    });
    return { total: emails.length, emails };
  });

/** read_my_email_thread: one thread's emails as text lines (get_thread), quoted history left out */
export const mcpThreadLines = (mailbox: string, threadId: string) =>
  attempt("read_my_email_thread", async () => {
    const got = await workspaceCall("gmail", mailbox, "get_thread", { id: { names: ["threadId", "thread_id", "id"], value: threadId } });
    const msgs = listOf(got, "messages");
    if (!msgs.length) return [typeof got === "string" ? got : JSON.stringify(got ?? "").slice(0, 60_000)];
    return msgs.map(
      (m) => `From ${headerOf(m, "from")} to ${headerOf(m, "to")} (${field(m, "date", "internalDate").slice(0, 25)})\nSubject: ${headerOf(m, "subject")}\n${withoutQuotes(field(m, "plaintextBody", "body", "text", "snippet")).trim()}`,
    );
  });

/** A Gmail draft (create_draft; no attachments: Google's tool can't attach files, so those stay on REST) */
export const mcpGmailDraft = (e: { mailbox: string; to: string; cc?: string | null; subject: string; body: string; threadId?: string | null }) =>
  attempt("gmail draft", async () => {
    const got = await workspaceCall(
      "gmail",
      e.mailbox,
      "create_draft",
      {
        to: { names: ["to", "recipients"], value: e.to },
        cc: { names: ["cc"], value: e.cc ?? undefined },
        subject: { names: ["subject"], value: e.subject },
        body: { names: ["body", "plaintextBody", "text"], value: e.body },
        thread: { names: ["threadId", "thread_id"], value: e.threadId ?? undefined },
      },
      { write: true },
    );
    const o = (got && typeof got === "object" ? got : {}) as Record<string, unknown>;
    const msg = (o.message && typeof o.message === "object" ? o.message : {}) as Record<string, unknown>;
    return { draftId: field(o, "id", "draftId") || "draft", messageId: field(msg, "id") || field(o, "messageId") || null };
  });

export type McpFileRead = { title: string; url: string; modified: string | null; mime: string; text: string; folder: boolean };

/** read_google_file: a Drive file's metadata and text (get_file_metadata, read_file_content); a folder lists its files */
export const mcpReadDriveFile = (email: string, fileId: string, link: string) =>
  attempt("read_google_file", async (): Promise<McpFileRead> => {
    const id = { names: ["fileId", "file_id", "id"], value: fileId };
    const metaRaw = await workspaceCall("drive", email, "get_file_metadata", { id });
    const meta = (metaRaw && typeof metaRaw === "object" ? metaRaw : {}) as Record<string, unknown>;
    const mime = field(meta, "mimeType", "mime_type");
    const base = { title: field(meta, "name", "title") || "Google file", url: field(meta, "webViewLink", "url") || link, modified: field(meta, "modifiedTime") || null, mime };
    if (mime === "application/vnd.google-apps.folder") {
      const got = await workspaceCall("drive", email, "search_files", { q: { names: ["query", "q"], value: `'${fileId}' in parents and trashed = false` }, n: { names: ["pageSize", "maxResults"], value: 200 } });
      const files = listOf(got, "files", "results", "items");
      const text = files.length ? files.map((f) => `- ${field(f, "name", "title")} (${field(f, "mimeType").replace("application/vnd.google-apps.", "Google ")}, ${field(f, "modifiedTime").slice(0, 10)}): ${field(f, "webViewLink", "url")}`).join("\n") : "(empty)";
      return { ...base, text, folder: true };
    }
    const got = await workspaceCall("drive", email, "read_file_content", { id });
    const text = typeof got === "string" ? got : field((got ?? {}) as Record<string, unknown>, "content", "text", "body") || JSON.stringify(got ?? "");
    return { ...base, text, folder: false };
  });
