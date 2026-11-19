// The plain parts of Kaizen AI's workspace tools (Gmail, Drive, Calendar, and hands-on work in a client's Klaviyo),
// kept apart from the network so they're tested: which Klaviyo requests may run at all, how a change is described for
// the person's yes, and how Google answers become short rows.

export type KlaviyoMethod = "GET" | "POST" | "PATCH";

/**
 * Requests that never run from a chat, whatever anyone says: deleting anything, privacy erasure, bulk deletes and
 * suppressions, account-level settings and keys. Everything else in Klaviyo's API (templates, campaigns and their
 * messages, flows, segments, lists, forms, universal content, images, metrics) is open, writes only after a yes.
 */
const BLOCKED: RegExp[] = [/delete/i, /data-privacy/i, /suppression/i, /\/api\/accounts\b/i, /\/api\/webhooks?\b/i, /api-key/i, /\/api\/tracking-settings\b/i];

/** A Klaviyo API path a chat may call: /api/…, no host, no climbing out, nothing on the blocked list */
export function klaviyoPathOk(path: unknown, method: KlaviyoMethod): { ok: true; path: string } | { ok: false; why: string } {
  const p = String(path ?? "").trim();
  if (!/^\/api\/[A-Za-z0-9\-_/?=&.,:%'()!*+ ]*$/.test(p)) return { ok: false, why: "Give a Klaviyo API path starting with /api/ (no full URL)." };
  if (p.includes("..")) return { ok: false, why: "That path isn't allowed." };
  const bare = p.split("?")[0];
  if (BLOCKED.some((r) => r.test(bare))) return { ok: false, why: "Deleting, privacy erasure, suppressions and account settings never run from a chat: do that in Klaviyo itself." };
  if (method !== "GET" && !/^\/api\/[a-z0-9-]+\/?([A-Za-z0-9_-]+\/?)?([a-z-]+\/?)?$/i.test(bare)) return { ok: false, why: "A change goes to one resource path (like /api/templates/ or /api/campaign-messages/<id>/)." };
  return { ok: true, path: p };
}

/** What a write will do, in plain words, for the person to approve: the resource, the object and the fields it sets */
export function describeWrite(method: KlaviyoMethod, path: string, body: unknown): string {
  const bare = path.split("?")[0].replace(/\/$/, "");
  const parts = bare.split("/").filter(Boolean).slice(1); // after "api"
  const resource = (parts[0] ?? "").replace(/-/g, " ");
  const id = parts[1] && !/^[a-z-]+$/.test(parts[1]) ? parts[1] : null;
  const data = (body as { data?: { type?: string; attributes?: Record<string, unknown>; relationships?: Record<string, unknown> } } | null)?.data;
  const attrs = data?.attributes ?? {};
  const fields = Object.entries(attrs).map(([k, v]) => `${k.replace(/_/g, " ")}: ${short(v)}`);
  const rel = Object.keys(data?.relationships ?? {});
  const verb = method === "PATCH" ? "Change" : /jobs?$|-jobs\b/.test(parts[0] ?? "") ? "Run" : "Create";
  return [`${verb} ${resource}${id ? ` ${id}` : ""}`, fields.length ? `setting ${fields.join("; ")}` : null, rel.length ? `linked to ${rel.join(", ")}` : null].filter(Boolean).join(", ");
}

/** A value, short: long text (a template's HTML) by its size and its start */
export function short(v: unknown, max = 160): string {
  if (v == null) return "nothing";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length.toLocaleString("en-US")} characters)` : flat;
}

/** The current values of the fields a PATCH will set, from the object read just before (for a before → after) */
export function beforeAfter(current: unknown, body: unknown): { field: string; now: string; becomes: string }[] {
  const was = ((current as { data?: { attributes?: Record<string, unknown> } } | null)?.data?.attributes ?? {}) as Record<string, unknown>;
  const set = ((body as { data?: { attributes?: Record<string, unknown> } } | null)?.data?.attributes ?? {}) as Record<string, unknown>;
  return Object.keys(set).map((k) => ({ field: k, now: short(was[k]), becomes: short(set[k]) }));
}

/** Who may change a client's Klaviyo from a chat: the email team, leads and execs (anyone on the client may read) */
export const KLAVIYO_EDITORS = ["head_of_email", "email_strategist", "email_designer", "email_builder"];
export const mayEditKlaviyo = (me: { role: string; isExec?: boolean; isLead?: boolean }) => Boolean(me.isExec || me.isLead || KLAVIYO_EDITORS.includes(me.role));

// ─── Google ──────────────────────────────────────────────────────────────────

type Header = { name: string; value: string };
/** A Gmail message (metadata format) as a row */
export function gmailRow(m: { id: string; threadId: string; snippet?: string; internalDate?: string; payload?: { headers?: Header[] } }) {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? null;
  return { message_id: m.id, thread_id: m.threadId, from: h("from"), to: h("to"), subject: h("subject"), date: m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ") : h("date"), snippet: String(m.snippet ?? "").slice(0, 240) };
}

/** A Drive search: the person's words as a Drive query (in the name or the text), never trashed */
export function driveQuery(words: string): string {
  const w = words.replace(/['\\]/g, " ").replace(/\s+/g, " ").trim();
  return `(name contains '${w}' or fullText contains '${w}') and trashed = false`;
}

/** A calendar event as a row */
export function eventRow(e: { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email?: string; displayName?: string; responseStatus?: string }[]; hangoutLink?: string; htmlLink?: string; description?: string; location?: string }) {
  return {
    title: e.summary ?? "(no title)",
    starts: e.start?.dateTime ?? e.start?.date ?? null,
    ends: e.end?.dateTime ?? e.end?.date ?? null,
    who: (e.attendees ?? []).slice(0, 12).map((a) => a.displayName || a.email).filter(Boolean),
    where: e.location ?? (e.hangoutLink ? "Google Meet" : null),
    meet: e.hangoutLink ?? null,
    link: e.htmlLink ?? null,
    notes: e.description ? short(e.description, 400) : null,
  };
}

/** Google refusing a scope the service account isn't allowed yet: the one Admin console setting to add */
export function scopeHelp(message: string, scope: string): string | null {
  return /unauthorized_client|access_denied|insufficient|scope/i.test(message) ? `Add ${scope} to the service account's domain-wide delegation (Google Admin console, Security, API controls, Domain-wide delegation).` : null;
}
