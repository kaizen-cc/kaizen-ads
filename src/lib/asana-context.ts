// What an Asana task carries beyond its title, read from the mirror for the board sheets (and kept for the migration).

export type AsanaAttachment = { gid: string; name: string; url: string | null; host: string | null; size: number | null; at: string | null };
export type AsanaSubtask = { gid: string; name: string; done: boolean; assignee: string | null; dueOn: string | null; url: string | null };
export type AsanaHistoryItem =
  | { at: string; kind: "moved"; from: string | null; to: string | null; by: string | null }
  | { at: string; kind: "assigned"; to: string | null; by: string | null }
  | { at: string; kind: "due"; from: string | null; to: string | null; by: string | null };
export type AsanaComment = { at: string; by: string | null; text: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const web = (v: unknown) => {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

/** An attachment from Asana's API. The download link expires within minutes, so the permanent page is kept. */
export function mapAttachments(raw: unknown): AsanaAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a): AsanaAttachment[] => {
    const r = (a ?? {}) as Record<string, unknown>;
    const name = str(r.name);
    if (!name || !r.gid) return [];
    return [{ gid: String(r.gid), name: name.slice(0, 200), url: web(r.permanent_url) ?? web(r.view_url) ?? web(r.url) ?? null, host: str(r.host) ?? str(r.resource_subtype), size: typeof r.size === "number" ? r.size : null, at: str(r.created_at) }];
  });
}

/** Subtasks from Asana's API */
export function mapSubtasks(raw: unknown): AsanaSubtask[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): AsanaSubtask[] => {
    const r = (t ?? {}) as Record<string, unknown>;
    const name = str(r.name);
    if (!name || !r.gid) return [];
    return [{ gid: String(r.gid), name: name.slice(0, 250), done: r.completed === true || r.done === true, assignee: str((r.assignee as { name?: unknown } | null)?.name) ?? str(r.assignee), dueOn: str(r.due_on) ?? str(r.dueOn), url: web(r.permalink_url) ?? web(r.url) }];
  });
}

/** The stored jsonb read back safely (older rows may not have it) */
export const readList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export type TextPart = { text: string; href?: string };

/** Splits text into plain parts and http(s) links, so notes render with working links and their own line breaks */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    if (trail) url = url.slice(0, -trail.length);
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: url, href: url });
    last = at + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function fileSize(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function historyLine(h: AsanaHistoryItem): string {
  if (h.kind === "moved") return `Moved from ${h.from ?? "nowhere"} to ${h.to ?? "nowhere"}`;
  if (h.kind === "assigned") return h.to ? `Assigned to ${h.to}` : "Unassigned";
  return `Due date ${h.from ?? "none"} to ${h.to ?? "none"}`;
}
