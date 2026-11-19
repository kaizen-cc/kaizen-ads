// Figma through its REST API with the person's own personal access token (owner, Nov 19 2026): Figma's hosted MCP
// connector only lets apps Figma approved register, so Kaizen AI reads files, frames, text and comments this way. The
// plain parts (reading a link, walking a file into text) are pure and tested; the calls need the token.

const API = "https://api.figma.com/v1";

/** A figma.com link as its file key and node (frame) id: /design/<key>/…?node-id=12-34 (also /file/, /board/, /proto/) */
export function parseFigmaLink(raw: string): { key: string; node: string | null; kind: string } | null {
  try {
    const u = new URL(raw.trim());
    if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(design|file|board|proto|slides|deck)\/([A-Za-z0-9]{10,})/);
    if (!m) return null;
    const id = u.searchParams.get("node-id");
    return { key: m[2], node: id ? id.replace(/-/g, ":") : null, kind: m[1] };
  } catch {
    return null;
  }
}

type Node = { id: string; name: string; type: string; characters?: string; children?: Node[]; absoluteBoundingBox?: { width: number; height: number } };

/** A file or a frame as readable text: pages and frames as headings, every text layer's words under its frame */
export function nodeText(root: Node, maxChars = 60_000): { text: string; frames: { id: string; name: string; page: string; size: string | null }[] } {
  const lines: string[] = [];
  const frames: { id: string; name: string; page: string; size: string | null }[] = [];
  let page = "";
  const walk = (n: Node, depth: number) => {
    if (lines.join("\n").length > maxChars) return;
    if (n.type === "CANVAS") {
      page = n.name;
      lines.push(`\n# Page: ${n.name}`);
    } else if (n.type === "FRAME" || n.type === "SECTION" || n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
      if (depth <= 3) {
        const b = n.absoluteBoundingBox;
        const size = b ? `${Math.round(b.width)}×${Math.round(b.height)}` : null;
        frames.push({ id: n.id, name: n.name, page, size });
        lines.push(`\n## ${n.type === "SECTION" ? "Section" : "Frame"}: ${n.name}${size ? ` (${size})` : ""} [node ${n.id}]`);
      }
    } else if (n.type === "TEXT" && n.characters?.trim()) {
      lines.push(`- ${n.characters.replace(/\s+/g, " ").trim()}`);
    }
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return { text: lines.join("\n").trim(), frames: frames.slice(0, 200) };
}

async function figma<T>(token: string, path: string): Promise<{ ok: true; json: T } | { ok: false; status: number; error: string }> {
  const r = await fetch(`${API}${path}`, { headers: { "X-Figma-Token": token }, cache: "no-store", signal: AbortSignal.timeout(45_000) }).catch(() => null);
  if (!r) return { ok: false, status: 0, error: "Figma didn't answer." };
  if (r.ok) return { ok: true, json: (await r.json()) as T };
  const err = r.status === 403 || r.status === 401 ? "Figma refused the token (expired, revoked, or it lacks File content read)." : r.status === 404 ? "Figma can't find that file, or your account can't open it." : r.status === 429 ? "Figma is rate limiting: try again in a minute." : `Figma answered ${r.status}.`;
  return { ok: false, status: r.status, error: err };
}

/** The token's owner: checks a pasted token works */
export async function figmaMe(token: string): Promise<{ ok: true; handle: string } | { ok: false; error: string }> {
  const r = await figma<{ handle?: string; email?: string }>(token, "/me");
  return r.ok ? { ok: true, handle: r.json.handle ?? r.json.email ?? "your account" } : { ok: false, error: r.status === 403 || r.status === 401 ? "Figma didn't accept that token. Make a new one with File content read and Current user read (Figma, Settings, Security, Personal access tokens)." : r.error };
}

/** A whole file (or one frame of it) as text and its frames */
export async function readFigma(token: string, link: { key: string; node: string | null }) {
  if (link.node) {
    const r = await figma<{ name: string; lastModified: string; nodes: Record<string, { document: Node } | null> }>(token, `/files/${link.key}/nodes?ids=${encodeURIComponent(link.node)}`);
    if (!r.ok) return r;
    const doc = Object.values(r.json.nodes ?? {})[0]?.document;
    if (!doc) return { ok: false as const, status: 404, error: "That frame isn't in the file any more." };
    return { ok: true as const, file: r.json.name, modified: r.json.lastModified, ...nodeText(doc) };
  }
  const r = await figma<{ name: string; lastModified: string; document: Node }>(token, `/files/${link.key}?depth=4`);
  if (!r.ok) return r;
  return { ok: true as const, file: r.json.name, modified: r.json.lastModified, ...nodeText(r.json.document) };
}

/** Rendered images of frames (links Figma keeps for a while) */
export async function figmaImages(token: string, key: string, ids: string[], scale = 1) {
  const r = await figma<{ images: Record<string, string | null> }>(token, `/images/${key}?ids=${encodeURIComponent(ids.slice(0, 10).join(","))}&format=png&scale=${scale}`);
  return r.ok ? { ok: true as const, images: r.json.images } : r;
}

/** The file's comments, newest first */
export async function figmaComments(token: string, key: string) {
  const r = await figma<{ comments: { message: string; created_at: string; resolved_at: string | null; user?: { handle?: string }; client_meta?: { node_id?: string } }[] }>(token, `/files/${key}/comments`);
  if (!r.ok) return r;
  return { ok: true as const, comments: r.json.comments.slice(0, 60).map((c) => ({ by: c.user?.handle ?? null, at: c.created_at.slice(0, 16).replace("T", " "), text: c.message, resolved: Boolean(c.resolved_at), node: c.client_meta?.node_id ?? null })) };
}
