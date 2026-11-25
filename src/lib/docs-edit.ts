import "server-only";
import { type GDocJson } from "./docs-edit-core";
import { workspaceMcpMode } from "./workspace-mcp-core";

// An agent editing a Google Doc as the person (the service account acting as them, with
// https://www.googleapis.com/auth/documents): only docs they can edit themselves, never as anyone else. Through
// Google's Docs MCP server when WORKSPACE_MCP is on (read_doc for the structure, update_doc with the same batchUpdate
// requests), REST as the fallback. Writes run only after the person's yes (the tool decides that). docs/WORKSPACE-MCP.md.

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const API = "https://docs.googleapis.com/v1/documents";

export class DocsEditError extends Error {}

/** Google's refusal in words the person can act on */
export function docsError(msg: string, email: string): string {
  if (/unauthorized_client|access_denied/i.test(msg)) return "Google hasn't allowed Kaizen OS to edit Docs yet: an admin adds https://www.googleapis.com/auth/documents to the service account's domain-wide delegation.";
  if (/\b404\b|not found/i.test(msg)) return "That doc wasn't found: check the link.";
  if (/\b403\b|permission|forbidden/i.test(msg)) return `You can't edit that doc as ${email}: ask its owner for edit access (Share, Editor).`;
  return `Google Docs had a problem: ${msg.slice(0, 160)}`;
}

async function viaMcp<T>(label: string, run: () => Promise<T | null>): Promise<T | null> {
  const mode = workspaceMcpMode();
  if (mode === "off") return null;
  try {
    return await run();
  } catch (e) {
    const { isViewAsMessage } = await import("./view-as-core");
    if (mode === "only" || isViewAsMessage(e instanceof Error ? e.message : null)) throw e;
    console.warn(`[workspace-mcp] ${label} fell back to REST:`, e instanceof Error ? e.message : e);
    return null;
  }
}

const isDoc = (v: unknown): v is GDocJson => Boolean(v && typeof v === "object" && Array.isArray((v as GDocJson).body?.content));

/** The doc as the Docs API's document (its structure, for indexes), read as the person */
export async function readDocAs(email: string, docId: string): Promise<GDocJson> {
  const mcp = await viaMcp("read google doc", async () => {
    const { workspaceCall } = await import("./workspace-mcp");
    const got = await workspaceCall("docs", email, "read_doc", { id: { names: ["documentId", "document_id", "docId", "id"], value: docId }, fmt: { names: ["format"], value: "json" } });
    const doc = isDoc(got) ? got : isDoc((got as { document?: unknown })?.document) ? (got as { document: GDocJson }).document : null;
    // Google's read_doc may answer with text, not the structure an edit needs: REST then (logged)
    if (!doc) throw new Error("read_doc gave no document structure");
    return doc;
  });
  if (mcp) return mcp;
  const { googleTokenFor } = await import("@/lib/context/google");
  const token = await googleTokenFor(email, DOCS_SCOPE);
  const res = await fetch(`${API}/${docId}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new DocsEditError(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as GDocJson;
}

/** The edit's batchUpdate requests run on the doc as the person */
export async function updateDocAs(email: string, docId: string, requests: unknown[]): Promise<void> {
  const mcp = await viaMcp("edit google doc", async () => {
    const { workspaceCall, workspaceToolInputs } = await import("./workspace-mcp");
    const props = await workspaceToolInputs("docs", email, "update_doc");
    if (props && !props.includes("requests")) throw new Error("update_doc takes no batchUpdate requests");
    await workspaceCall("docs", email, "update_doc", { id: { names: ["documentId", "document_id", "docId", "id"], value: docId }, requests: { names: ["requests"], value: requests } }, { write: true });
    return true;
  });
  if (mcp) return;
  const { googleTokenFor } = await import("@/lib/context/google");
  const token = await googleTokenFor(email, DOCS_SCOPE);
  const res = await fetch(`${API}/${docId}:batchUpdate`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ requests }), cache: "no-store" });
  if (!res.ok) throw new DocsEditError(`${res.status} ${(await res.text()).slice(0, 200)}`);
}
