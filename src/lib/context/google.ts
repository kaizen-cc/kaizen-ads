import "server-only";
import { JWT } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact, trimBody, type CollectResult, type ContextItem } from "./shared";

// Reads Gmail and the shared Clients drive with a Workspace service account (domain-wide delegation).
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account's JSON key
//   GOOGLE_SHARED_DRIVE_ID       the shared drive with one folder per client
//   GOOGLE_DRIVE_USER            someone with access to that drive, to read it as
//   GMAIL_MAILBOXES              comma-separated mailboxes to read client email from
// Scopes granted in the Admin console: gmail.readonly, drive.readonly.

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export const googleConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
export const gmailMailboxes = () =>
  (process.env.GMAIL_MAILBOXES ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);

function tokenFor(subject: string, scope: string) {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  return new JWT({ email: key.client_email, key: key.private_key, scopes: [scope], subject }).getAccessToken().then((r) => r.token!);
}

async function google<T>(token: string, url: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Google ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
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

export async function collectGmail(admin: SupabaseClient, mailbox: string, since: Date): Promise<CollectResult> {
  const token = await tokenFor(mailbox, GMAIL_SCOPE);
  const { data: links } = await admin
    .from("contact_clients")
    .select("client_id, contacts(email), clients!inner(creative_package)")
    .eq("clients.creative_package", true);
  const byClient = new Map<string, string[]>();
  for (const l of links ?? []) {
    const email = (l.contacts as unknown as { email: string } | null)?.email;
    if (email) byClient.set(l.client_id, [...(byClient.get(l.client_id) ?? []), email.toLowerCase()]);
  }

  const items: ContextItem[] = [];
  const after = Math.floor(since.getTime() / 1000);
  for (const [clientId, emails] of byClient) {
    const who = emails.slice(0, 15).join(" OR ");
    const list = await google<{ messages?: { id: string }[] }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages`, {
      q: `{from:(${who}) to:(${who}) cc:(${who})} after:${after}`,
      maxResults: "25",
    });
    for (const { id } of list.messages ?? []) {
      const m = await google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
      const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
      items.push({
        client_id: clientId,
        source: "gmail",
        // The same email lands in several team mailboxes; Message-ID keeps one copy
        external_id: header("message-id") ?? `${mailbox}:${m.id}`,
        thread_id: m.threadId,
        occurred_at: new Date(Number(m.internalDate)).toISOString(),
        author: header("from"),
        title: header("subject"),
        body: trimBody(withoutQuotes(plainText(m.payload) ?? m.snippet ?? "")),
        url: `https://mail.google.com/mail/u/${mailbox}/#all/${m.id}`,
        meta: { mailbox, to: header("to") },
      });
    }
  }
  return { items, notes: { clientsWithContacts: byClient.size } };
}

// ─── Drive ──────────────────────────────────────────────────────────────────

type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; createdTime: string; modifiedTime: string; webViewLink?: string; lastModifyingUser?: { displayName?: string } };
const FOLDER = "application/vnd.google-apps.folder";

async function listAll(token: string, q: string, fields: string) {
  const out: DriveFile[] = [];
  let pageToken = "";
  do {
    const page = await google<{ files: DriveFile[]; nextPageToken?: string }>(token, "https://www.googleapis.com/drive/v3/files", {
      q,
      corpora: "drive",
      driveId: process.env.GOOGLE_SHARED_DRIVE_ID!,
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      pageSize: "1000",
      fields: `nextPageToken, files(${fields})`,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...page.files);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

export async function collectDrive(admin: SupabaseClient, since: Date): Promise<CollectResult> {
  const driveId = process.env.GOOGLE_SHARED_DRIVE_ID;
  const user = process.env.GOOGLE_DRIVE_USER;
  if (!driveId || !user) return { items: [], notes: { skipped: "GOOGLE_SHARED_DRIVE_ID or GOOGLE_DRIVE_USER not set" } };
  const token = await tokenFor(user, DRIVE_SCOPE);

  const folders = await listAll(token, `mimeType = '${FOLDER}' and trashed = false`, "id, name, parents");
  const parentOf = new Map(folders.map((f) => [f.id, f.parents?.[0] ?? null]));
  const nameOf = new Map(folders.map((f) => [f.id, f.name]));

  // Top-level folders are clients: match any that aren't linked yet by name
  const { data: clients } = await admin.from("clients").select("id, name, drive_folder_id").eq("creative_package", true);
  const topLevel = folders.filter((f) => f.parents?.[0] === driveId);
  let matched = 0;
  for (const c of clients ?? []) {
    if (c.drive_folder_id) continue;
    const key = compact(c.name);
    const hits = topLevel.filter((f) => compact(f.name) === key || compact(f.name).includes(key));
    if (hits.length === 1) {
      await admin.from("clients").update({ drive_folder_id: hits[0].id }).eq("id", c.id);
      c.drive_folder_id = hits[0].id;
      matched++;
    }
  }
  const clientOfFolder = new Map((clients ?? []).filter((c) => c.drive_folder_id).map((c) => [c.drive_folder_id as string, c.id as string]));

  const files = await listAll(
    token,
    `mimeType != '${FOLDER}' and trashed = false and createdTime > '${since.toISOString()}'`,
    "id, name, mimeType, parents, createdTime, modifiedTime, webViewLink, lastModifyingUser(displayName)",
  );
  const items: ContextItem[] = [];
  for (const f of files) {
    // Walk up the folders until we reach a client's folder
    const path: string[] = [];
    let at = f.parents?.[0] ?? null;
    let clientId: string | undefined;
    for (let depth = 0; at && depth < 12 && !clientId; depth++) {
      clientId = clientOfFolder.get(at);
      if (!clientId) path.unshift(nameOf.get(at) ?? "");
      at = parentOf.get(at) ?? null;
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
  return { items, notes: { foldersMatched: matched, files: files.length } };
}
