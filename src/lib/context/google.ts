import "server-only";
import { JWT } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact, trimBody, type CollectResult, type ContextItem } from "./shared";

// Reads Gmail and the client Drive folders with a Workspace service account (domain-wide delegation).
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account's JSON key
//   GOOGLE_SHARED_DRIVE_ID       the umbrella folder (or shared drive) with one folder per client
//   GOOGLE_DRIVE_USER            someone who can open those folders; Drive is read as them
//   GOOGLE_ADMIN_USER            optional: a Workspace admin to list mailboxes as (defaults to GOOGLE_DRIVE_USER)
//   GMAIL_MAILBOXES              optional: comma-separated mailboxes. Unset means everyone in the org,
//                                looked up on every run, so new people are included automatically.
// Scopes granted in the Admin console: gmail.readonly, drive.readonly, admin.directory.user.readonly.

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";

export const googleConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

function tokenFor(subject: string, scope: string) {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  return new JWT({ email: key.client_email, key: key.private_key, scopes: [scope], subject }).getAccessToken().then((r) => r.token!);
}

async function google<T>(token: string, url: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Google ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// ─── Who to read ────────────────────────────────────────────────────────────

/** Everyone in the Workspace with a working mailbox, unless GMAIL_MAILBOXES names specific people. */
export async function gmailMailboxes(): Promise<string[]> {
  const listed = (process.env.GMAIL_MAILBOXES ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length && !listed.includes("all")) return listed;

  const adminUser = process.env.GOOGLE_ADMIN_USER || process.env.GOOGLE_DRIVE_USER;
  if (!adminUser) throw new Error("Set GOOGLE_ADMIN_USER (a Workspace admin) to read every mailbox");
  const token = await tokenFor(adminUser, DIRECTORY_SCOPE);
  const out: string[] = [];
  let pageToken = "";
  do {
    const page = await google<{ users?: { primaryEmail: string; suspended?: boolean; archived?: boolean; isMailboxSetup?: boolean }[]; nextPageToken?: string }>(
      token,
      "https://admin.googleapis.com/admin/directory/v1/users",
      { customer: "my_customer", maxResults: "500", ...(pageToken ? { pageToken } : {}) },
    );
    for (const u of page.users ?? []) if (!u.suspended && !u.archived && u.isMailboxSetup !== false) out.push(u.primaryEmail.toLowerCase());
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** Client contact emails → the creative-package clients they belong to. */
export async function contactMap(admin: SupabaseClient) {
  const { data: links } = await admin
    .from("contact_clients")
    .select("client_id, contacts(email), clients!inner(creative_package)")
    .eq("clients.creative_package", true);
  const map = new Map<string, string[]>();
  for (const l of links ?? []) {
    const email = (l.contacts as unknown as { email: string } | null)?.email?.toLowerCase();
    if (email) map.set(email, [...(map.get(email) ?? []), l.client_id]);
  }
  return map;
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = { id: string; threadId: string; snippet?: string; internalDate: string; payload: GmailPart & { headers: { name: string; value: string }[] } };

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function plainText(part: GmailPart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  return null;
}

/** Drop quoted history so we store what was actually said in this email. */
const withoutQuotes = (s: string) => s.split(/\n(?:On .{5,120} wrote:|-----Original Message-----|From: .+\nSent: )/)[0];

const addresses = (header: string | null) => (header?.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);

/** Emails to or from any client contact in one mailbox since the cursor. */
export async function collectGmail(mailbox: string, since: Date, contacts: Map<string, string[]>): Promise<CollectResult> {
  const token = await tokenFor(mailbox, GMAIL_SCOPE);
  const after = Math.floor(since.getTime() / 1000);
  const emails = [...contacts.keys()];

  // A few searches cover every contact; each lists matching emails once
  const ids = new Set<string>();
  for (let i = 0; i < emails.length; i += 30) {
    const who = emails.slice(i, i + 30).join(" OR ");
    const list = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", {
      q: `{from:(${who}) to:(${who}) cc:(${who})} after:${after}`,
      maxResults: "100",
    });
    for (const m of list.messages ?? []) ids.add(m.id);
  }

  const items: ContextItem[] = [];
  for (const id of ids) {
    const m = await google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
    const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
    const clients = new Set(["from", "to", "cc"].flatMap((h) => addresses(header(h))).flatMap((a) => contacts.get(a) ?? []));
    const body = trimBody(withoutQuotes(plainText(m.payload) ?? m.snippet ?? ""));
    for (const clientId of clients) {
      items.push({
        client_id: clientId,
        source: "gmail",
        // The same email lands in several team mailboxes; Message-ID keeps one copy per client
        external_id: `${header("message-id") ?? `${mailbox}:${m.id}`}#${clientId}`,
        thread_id: m.threadId,
        occurred_at: new Date(Number(m.internalDate)).toISOString(),
        author: header("from"),
        title: header("subject"),
        body,
        url: `https://mail.google.com/mail/u/${mailbox}/#all/${m.id}`,
        meta: { mailbox, to: header("to") },
      });
    }
  }
  return { items, notes: { emails: ids.size } };
}

// ─── Drive ──────────────────────────────────────────────────────────────────

type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; driveId?: string; createdTime: string; webViewLink?: string; lastModifyingUser?: { displayName?: string } };
const FOLDER = "application/vnd.google-apps.folder";
const ALL = { supportsAllDrives: "true", includeItemsFromAllDrives: "true" };

async function listFiles(token: string, q: string, fields: string, driveId?: string) {
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const page = await google<{ files: DriveFile[]; nextPageToken?: string }>(token, "https://www.googleapis.com/drive/v3/files", {
      q,
      ...ALL,
      ...(driveId ? { corpora: "drive", driveId } : { corpora: "allDrives" }),
      pageSize: "1000",
      fields: `nextPageToken, files(${fields})`,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...page.files);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/** Every folder under the root, with its parent, found level by level. */
async function folderTree(token: string, root: string, driveId?: string) {
  const parentOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  let level = [root];
  for (let depth = 0; level.length && depth < 8; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 40) {
      const parents = level.slice(i, i + 40).map((id) => `'${id}' in parents`).join(" or ");
      for (const f of await listFiles(token, `(${parents}) and mimeType = '${FOLDER}' and trashed = false`, "id, name, parents", driveId)) {
        if (parentOf.has(f.id)) continue;
        parentOf.set(f.id, f.parents?.[0] ?? root);
        nameOf.set(f.id, f.name);
        next.push(f.id);
      }
    }
    level = next;
  }
  return { parentOf, nameOf };
}

export async function collectDrive(admin: SupabaseClient, since: Date): Promise<CollectResult> {
  const root = process.env.GOOGLE_SHARED_DRIVE_ID;
  const user = process.env.GOOGLE_DRIVE_USER;
  if (!root || !user) return { items: [], notes: { skipped: "GOOGLE_SHARED_DRIVE_ID or GOOGLE_DRIVE_USER not set" } };
  const token = await tokenFor(user, DRIVE_SCOPE);

  // The ID can be a whole shared drive or a folder (in a shared drive or someone's My Drive)
  let driveId: string | undefined;
  try {
    await google(token, `https://www.googleapis.com/drive/v3/drives/${root}`);
    driveId = root;
  } catch {
    const f = await google<DriveFile>(token, `https://www.googleapis.com/drive/v3/files/${root}`, { supportsAllDrives: "true", fields: "id, driveId" });
    driveId = f.driveId;
  }

  const { parentOf, nameOf } = await folderTree(token, root, driveId);

  // Folders directly under the root are clients: link any that aren't linked yet, by name
  const { data: clients } = await admin.from("clients").select("id, name, drive_folder_id").eq("creative_package", true);
  const topLevel = [...parentOf].filter(([, p]) => p === root).map(([id]) => ({ id, name: nameOf.get(id)! }));
  let matched = 0;
  for (const c of clients ?? []) {
    if (c.drive_folder_id) continue;
    const key = compact(c.name);
    const hits = topLevel.filter((f) => compact(f.name) === key || compact(f.name).includes(key) || (compact(f.name).length >= 6 && key.includes(compact(f.name))));
    if (hits.length === 1) {
      await admin.from("clients").update({ drive_folder_id: hits[0].id }).eq("id", c.id);
      c.drive_folder_id = hits[0].id;
      matched++;
    }
  }
  const clientOfFolder = new Map((clients ?? []).filter((c) => c.drive_folder_id).map((c) => [c.drive_folder_id as string, c.id as string]));

  const files = await listFiles(
    token,
    `mimeType != '${FOLDER}' and trashed = false and createdTime > '${since.toISOString()}'`,
    "id, name, mimeType, parents, createdTime, webViewLink, lastModifyingUser(displayName)",
    driveId,
  );
  const items: ContextItem[] = [];
  for (const f of files) {
    // Walk up the folders until we reach a client's folder; files outside the umbrella never match
    const path: string[] = [];
    let at: string | undefined = f.parents?.[0];
    let clientId: string | undefined;
    for (let depth = 0; at && depth < 12 && !clientId; depth++) {
      clientId = clientOfFolder.get(at);
      if (!clientId) path.unshift(nameOf.get(at) ?? "");
      at = parentOf.get(at);
    }
    if (!clientId) continue;
    items.push({
      client_id: clientId,
      source: "drive",
      external_id: f.id,
      thread_id: null,
      occurred_at: f.createdTime,
      author: f.lastModifyingUser?.displayName ?? null,
      title: f.name,
      body: null,
      url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      meta: { mimeType: f.mimeType, folder: path.filter(Boolean).join(" / ") },
    });
  }
  return { items, notes: { foldersMatched: matched, folders: parentOf.size, newFiles: files.length, clientFiles: items.length } };
}
