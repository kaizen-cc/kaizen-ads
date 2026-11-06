import "server-only";
import type { Tracker } from "@/lib/progress";
import { JWT } from "google-auth-library";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compact, saveItems, trimBody, type CollectResult, type ContextItem } from "./shared";
import { LIVE } from "@/lib/live";
import { gmailLink, isCalendarEmail, isInternalOnly } from "@/lib/email-filters";

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

/** A Gmail read token for one person's mailbox (watching for messages they owe a reply). */
export const gmailToken = (mailbox: string) => tokenFor(mailbox, GMAIL_SCOPE);

/** A Drive read token as someone in the Workspace (their own Drive: Gemini meeting notes). */
export const googleDriveToken = (user: string) => tokenFor(user, DRIVE_SCOPE);

/** A Drive read token as GOOGLE_DRIVE_USER, for opening reference files linked in requests. */
export const driveToken = () => {
  const user = process.env.GOOGLE_DRIVE_USER;
  if (!googleConfigured() || !user) throw new Error("Google Drive isn't connected");
  return tokenFor(user, DRIVE_SCOPE);
};

const BACKOFF_MS = [1000, 3000];

export async function google<T>(token: string, url: string, params: Record<string, string> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (res.ok) return res.json() as Promise<T>;
    // Google's own blips (rate limits, "Service unavailable") pass in a moment: try again before giving up
    if ((res.status === 429 || res.status >= 500) && attempt < BACKOFF_MS.length) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      continue;
    }
    throw new Error(`Google ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
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

/** Client contact emails → the live clients they belong to (every active and onboarding client, creative or not). */
export async function contactMap(admin: SupabaseClient) {
  const { data: links } = await admin
    .from("contact_clients")
    .select("client_id, contacts(email), clients!inner(archived_at, status)")
    .is("clients.archived_at", null)
    .in("clients.status", LIVE);
  const map = new Map<string, string[]>();
  for (const l of links ?? []) {
    const email = (l.contacts as unknown as { email: string } | null)?.email?.toLowerCase();
    if (email) map.set(email, [...(map.get(email) ?? []), l.client_id]);
  }
  return map;
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

export type GmailPart = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: GmailPart[] };
export type GmailMessage = { id: string; threadId: string; snippet?: string; internalDate: string; payload: GmailPart & { headers: { name: string; value: string }[] } };

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

export function plainText(part: GmailPart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  return null;
}

/** Drop quoted history so we store what was actually said in this email. */
export const withoutQuotes = (s: string) => s.split(/\n(?:On .{5,120} wrote:|-----Original Message-----|From: .+\nSent: )/)[0];

export const addresses = (header: string | null) => (header?.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);

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
  // A busy inbox's first 30-day read is capped; after that each run only has a few hours of mail
  const capped = [...ids].slice(0, 200);

  const items: ContextItem[] = [];
  for (const id of capped) {
    const m = await google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
    const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
    // Calendar invites and RSVPs, and mail only between us, aren't the client talking
    const everyone = ["from", "to", "cc"].flatMap((h) => addresses(header(h)));
    if (isCalendarEmail(header("subject"), m.payload) || isInternalOnly(everyone)) continue;
    const clients = new Set(everyone.flatMap((a) => contacts.get(a) ?? []));
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
        url: gmailLink(mailbox, m.threadId),
        meta: { mailbox, to: header("to") },
      });
    }
  }
  return { items, notes: { emails: ids.size } };
}

// ─── A client's whole email history ─────────────────────────────────────────

// Free mail and our own domain: an address there is matched as itself, never as a whole domain
const SHARED_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "comcast.net", "att.net", "verizon.net", "ymail.com", "kaizenmarketing.agency"]);
const domainOf = (s: string | null | undefined) => {
  const host = (s ?? "").toLowerCase().trim().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const d = host.includes("@") ? host.split("@")[1] : host;
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !SHARED_DOMAINS.has(d) ? d : null;
};

/** What a client's email is matched on: each contact's address, and their business domains (from contacts and website). */
export async function emailKeys(admin: SupabaseClient, clientIds?: string[]) {
  let cq = admin.from("clients").select("id, name, status, created_at, website, email_history_covered").is("archived_at", null).in("status", ["onboarding", "active", "paused"]);
  if (clientIds) cq = cq.in("id", clientIds);
  const [{ data: clients }, { data: links }] = await Promise.all([cq, admin.from("contact_clients").select("client_id, contacts(email)")]);
  const keys = new Map<string, Set<string>>();
  for (const c of clients ?? []) {
    const d = domainOf(c.website as string | null);
    keys.set(c.id as string, new Set(d ? [d] : []));
  }
  for (const l of links ?? []) {
    const set = keys.get(l.client_id as string);
    const email = (l.contacts as unknown as { email: string } | null)?.email?.toLowerCase().trim();
    if (!set || !email?.includes("@")) continue;
    set.add(email);
    const d = domainOf(email);
    if (d) set.add(d);
  }
  return (clients ?? []).map((c) => {
    const all = [...(keys.get(c.id as string) ?? [])];
    const covered = new Set((c.email_history_covered as string[] | null) ?? []);
    return { id: c.id as string, name: c.name as string, onboarding: c.status === "onboarding", created: c.created_at as string, all, pending: all.filter((k) => !covered.has(k)) };
  });
}

/** Still to pull for this client (a new contact, or never pulled): the Bible waits for it, so the sales emails are in. */
export async function emailHistoryPending(admin: SupabaseClient, clientId: string) {
  if (!googleConfigured()) return false;
  const [c] = await emailKeys(admin, [clientId]);
  return Boolean(c?.pending.length);
}

/**
 * Every email between anyone at Kaizen and a client, as far back as the mailboxes go: the sales emails before the
 * close included, so whoever picks the client up has the whole conversation. Runs once per address or domain (a
 * contact added later is pulled on its own), onboarding clients first; the ongoing read keeps it current after that.
 * Their calls from before they signed are filed to them in the same pass.
 */
export async function pullEmailHistory(admin: SupabaseClient, deadline: number, perMailbox = 300) {
  const clients = (await emailKeys(admin)).filter((c) => c.pending.length);
  clients.sort((a, b) => Number(b.onboarding) - Number(a.onboarding) || b.created.localeCompare(a.created));
  if (!clients.length) return { pulled: {}, waiting: 0 };
  const { pool } = await import("./run");
  const mailboxes = await gmailMailboxes();
  const pulled: Record<string, number> = {};
  let done = 0;
  for (const c of clients) {
    if (Date.now() > deadline - 120_000) break;
    const terms = c.pending;
    const q = (t: string[]) => `{${["from", "to", "cc"].map((h) => `${h}:(${t.join(" OR ")})`).join(" ")}}`;
    const items: ContextItem[] = [];
    let complete = true;
    await pool(mailboxes, 6, async (mailbox) => {
      try {
        const token = await tokenFor(mailbox, GMAIL_SCOPE);
        const ids: string[] = [];
        for (let i = 0; i < terms.length; i += 20) {
          let pageToken = "";
          do {
            const page = await google<{ messages?: { id: string }[]; nextPageToken?: string }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", {
              q: q(terms.slice(i, i + 20)),
              maxResults: "100",
              ...(pageToken ? { pageToken } : {}),
            });
            ids.push(...(page.messages ?? []).map((m) => m.id));
            pageToken = ids.length < perMailbox ? (page.nextPageToken ?? "") : "";
          } while (pageToken);
        }
        // Newest first: a mailbox with years of this client keeps its latest few hundred
        const list = [...new Set(ids)].slice(0, perMailbox);
        for (let i = 0; i < list.length; i += 8) {
          const got = await Promise.all(list.slice(i, i + 8).map((id) => google<GmailMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" }).catch(() => null)));
          for (const m of got) {
            if (!m) continue;
            const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
            // Calendar invites and RSVPs, and mail only between us, aren't the client's history
            if (isCalendarEmail(header("subject"), m.payload) || isInternalOnly(["from", "to", "cc"].flatMap((h) => addresses(header(h))))) continue;
            items.push({
              client_id: c.id,
              source: "gmail",
              external_id: `${header("message-id") ?? `${mailbox}:${m.id}`}#${c.id}`,
              thread_id: m.threadId,
              occurred_at: new Date(Number(m.internalDate)).toISOString(),
              author: header("from"),
              title: header("subject"),
              body: trimBody(withoutQuotes(plainText(m.payload) ?? m.snippet ?? "")),
              url: gmailLink(mailbox, m.threadId),
              meta: { mailbox, to: header("to"), history: true },
            });
          }
        }
      } catch {
        complete = false; // tried again next run: what was read is saved, and repeats are ignored
      }
    });
    await saveItems(admin, items);
    await relinkCalls(admin, c.id, c.name, c.all);
    if (complete) {
      const { data: now } = await admin.from("clients").select("email_history_covered").eq("id", c.id).single();
      const covered = [...new Set([...((now?.email_history_covered as string[] | null) ?? []), ...terms])];
      await admin.from("clients").update({ email_history_covered: covered, email_history_at: new Date().toISOString() }).eq("id", c.id);
      done++;
    }
    pulled[c.name] = new Set(items.map((i) => i.external_id)).size;
  }
  return { pulled, waiting: clients.length - done };
}

/** A client's calls from before they signed (sales calls read as internal or unmatched): filed to them and read again. */
async function relinkCalls(admin: SupabaseClient, clientId: string, name: string, keys: string[]) {
  const emails = new Set(keys.filter((k) => k.includes("@")));
  const domains = keys.filter((k) => !k.includes("@"));
  const { data: calls } = await admin.from("client_calls").select("id, attendees, title").is("client_id", null).limit(5000);
  const n = compact(name);
  const ours = (calls ?? []).filter((c) => {
    const at = ((c.attendees as string[] | null) ?? []).map((a) => a.toLowerCase());
    return at.some((a) => emails.has(a) || domains.some((d) => a.endsWith(`@${d}`))) || (n.length >= 5 && compact(String(c.title ?? "")).includes(n));
  });
  for (let i = 0; i < ours.length; i += 200) await admin.from("client_calls").update({ client_id: clientId, status: "new" }).in("id", ours.slice(i, i + 200).map((c) => c.id));
  return ours.length;
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

/** Every folder under the given folders, with its parent, found level by level. */
async function folderTree(token: string, roots: string[], driveId?: string) {
  const parentOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  let level = roots;
  for (let depth = 0; level.length && depth < 6; depth++) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 40) {
      const parents = level.slice(i, i + 40).map((id) => `'${id}' in parents`).join(" or ");
      for (const f of await listFiles(token, `(${parents}) and mimeType = '${FOLDER}' and trashed = false`, "id, name, parents", driveId)) {
        if (parentOf.has(f.id)) continue;
        parentOf.set(f.id, f.parents?.[0] ?? "");
        nameOf.set(f.id, f.name);
        next.push(f.id);
      }
    }
    level = next;
  }
  return { parentOf, nameOf };
}

/** reread: client folders to read again in full, as if new (a client back from a pause or the archive) */
export async function collectDrive(admin: SupabaseClient, since: Date, t?: Tracker, reread?: Set<string>): Promise<CollectResult> {
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

  // Folders directly under the root are clients: link any client that isn't linked yet, by name (every client, not
  // only those with a creative package: their docs and assets are context too)
  const topLevel = await listFiles(token, `'${root}' in parents and mimeType = '${FOLDER}' and trashed = false`, "id, name", driveId);
  const { data: clients } = await admin.from("clients").select("id, name, drive_folder_id").is("archived_at", null).in("status", LIVE);
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
  const unmatched = (clients ?? []).filter((c) => !c.drive_folder_id).map((c) => c.name);

  // Only the creative-package clients' folders are walked and searched
  const { parentOf, nameOf } = await folderTree(token, [...clientOfFolder.keys()], driveId);
  // A client folder linked since the last run (new client, upgrade, pasted by hand) gets its last 30 days;
  // the rest only what's new since the last run
  const topOf = (folder: string) => {
    let at: string | undefined = folder;
    for (let depth = 0; at && depth < 8; depth++) {
      if (clientOfFolder.has(at)) return at;
      at = parentOf.get(at);
    }
    return undefined;
  };
  const { data: seen } = await admin.from("sync_state").select("source").or("source.like.drive:%,source.like.assets:%");
  const known = new Set((seen ?? []).filter((r) => (r.source as string).startsWith("drive:")).map((r) => (r.source as string).slice(6)).filter((f) => !reread?.has(f)));
  // A client folder whose assets haven't been catalogued yet is listed in full once (every photo, video and design
  // file it holds); after that only what's new is read
  const catalogued = new Set((seen ?? []).filter((r) => (r.source as string).startsWith("assets:")).map((r) => (r.source as string).slice(7)).filter((f) => !reread?.has(f)));
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  const feedFrom = (top: string | undefined) => (top && known.has(top) ? since : monthAgo).toISOString();
  const groups = new Map<string, string[]>(); // since → folders
  for (const f of [...clientOfFolder.keys(), ...parentOf.keys()]) {
    const top = topOf(f);
    const from = top && !catalogued.has(top) ? "2000-01-01T00:00:00Z" : feedFrom(top);
    groups.set(from, [...(groups.get(from) ?? []), f]);
  }
  const files: DriveFile[] = [];
  for (const [from, folders] of groups)
    for (let i = 0; i < folders.length; i += 40) {
      const parents = folders.slice(i, i + 40).map((id) => `'${id}' in parents`).join(" or ");
      files.push(
        ...(await listFiles(
          token,
          `(${parents}) and mimeType != '${FOLDER}' and trashed = false and createdTime > '${from}'`,
          "id, name, mimeType, parents, createdTime, webViewLink, lastModifyingUser(displayName)",
          driveId,
        )),
      );
    }

  const items: ContextItem[] = [];
  const assets: { file_id: string; client_id: string; name: string; mime: string; kind: string; folder: string | null; url: string; created_at: string; seen_at: string }[] = [];
  const kindOf = (mime: string, name: string) =>
    mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : /photoshop|illustrator|figma|\.(psd|ai|fig|sketch|indd)$/i.test(`${mime} ${name}`) ? "design" : null;
  t?.phase("Filing new files under their clients", files.length);
  for (const f of files) {
    t?.tick(f.name);
    // Walk up to the client's folder, keeping the subfolder path (e.g. "Headquarters / Photos")
    const path: string[] = [];
    let at: string | undefined = f.parents?.[0];
    let clientId: string | undefined;
    let top: string | undefined;
    for (let depth = 0; at && depth < 8 && !clientId; depth++) {
      clientId = clientOfFolder.get(at);
      if (clientId) top = at;
      else path.unshift(nameOf.get(at) ?? "");
      at = parentOf.get(at);
    }
    if (!clientId) continue;
    const url = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;
    const kind = kindOf(f.mimeType, f.name);
    if (kind) assets.push({ file_id: f.id, client_id: clientId, name: f.name, mime: f.mimeType, kind, folder: path.filter(Boolean).join(" / ") || null, url, created_at: f.createdTime, seen_at: new Date().toISOString() });
    // The feed of what's new only takes files from its own window (the full catalogue run reads further back)
    if (f.createdTime <= feedFrom(top)) continue;
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
  // Save first, then mark every client folder as read, so a failure never skips a folder's backfill
  await saveItems(admin, items);
  for (let i = 0; i < assets.length; i += 500) await admin.from("client_assets").upsert(assets.slice(i, i + 500), { onConflict: "file_id" });
  const now = new Date().toISOString();
  await admin.from("sync_state").upsert([...clientOfFolder.keys()].map((f) => ({ source: `drive:${f}`, cursor_at: now, last_run_at: now, last_result: {} })));
  await admin.from("sync_state").upsert([...clientOfFolder.keys()].filter((f) => !catalogued.has(f)).map((f) => ({ source: `assets:${f}`, cursor_at: now, last_run_at: now, last_result: {} })));
  return {
    items: [],
    notes: { saved: items.length, assets: assets.length, clientFolders: clientOfFolder.size, foldersMatched: matched, noFolder: unmatched, subfolders: parentOf.size, backfilled: [...clientOfFolder.keys()].filter((f) => !known.has(f)).length },
  };
}

// ─── Setup check ────────────────────────────────────────────────────────────

const explain = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("unauthorized_client")) return `${m} (domain-wide delegation isn't authorized for this scope yet; check the scopes in the Admin console, it can take a few minutes)`;
  if (m.includes("accessNotConfigured") || m.includes("has not been used in project")) return `${m} (turn this API on in Google Cloud)`;
  return m;
};

/** Setup check for Drive, the mailbox lookup and Gmail. Reads names and counts only. */
export async function checkGoogle() {
  const fail = (detail: string) => ({ ok: false, detail });
  if (!googleConfigured()) {
    const missing = fail("GOOGLE_SERVICE_ACCOUNT_JSON is missing");
    return { drive: missing, mailboxes: missing, gmail: missing };
  }
  try {
    JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  } catch {
    const bad = fail("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON; paste the whole key file, braces included");
    return { drive: bad, mailboxes: bad, gmail: bad };
  }

  let drive;
  try {
    const root = process.env.GOOGLE_SHARED_DRIVE_ID;
    const user = process.env.GOOGLE_DRIVE_USER;
    if (!root || !user) throw new Error("GOOGLE_SHARED_DRIVE_ID or GOOGLE_DRIVE_USER is missing");
    const token = await tokenFor(user, DRIVE_SCOPE);
    let name: string;
    let driveId: string | undefined;
    try {
      name = (await google<{ name: string }>(token, `https://www.googleapis.com/drive/v3/drives/${root}`)).name;
      driveId = root;
    } catch {
      const f = await google<{ name: string; driveId?: string }>(token, `https://www.googleapis.com/drive/v3/files/${root}`, { supportsAllDrives: "true", fields: "name, driveId" });
      name = f.name;
      driveId = f.driveId;
    }
    const top = await listFiles(token, `'${root}' in parents and mimeType = '${FOLDER}' and trashed = false`, "id, name", driveId);
    drive = { ok: true, detail: `Reading "${name}" as ${user}: ${top.length} client folders directly inside` };
  } catch (e) {
    drive = fail(explain(e));
  }

  let mailboxes;
  let first: string | undefined;
  try {
    const list = await gmailMailboxes();
    first = list[0];
    mailboxes = { ok: list.length > 0, detail: `${list.length} mailboxes will be read${list.length ? ` (e.g. ${list.slice(0, 3).join(", ")})` : ""}` };
  } catch (e) {
    mailboxes = fail(`${explain(e)}. Is GOOGLE_DRIVE_USER (or GOOGLE_ADMIN_USER) a Workspace admin, and is the Admin SDK API on?`);
  }

  let gmail;
  try {
    const who = first ?? process.env.GOOGLE_DRIVE_USER;
    if (!who) throw new Error("No mailbox to test");
    const token = await tokenFor(who, GMAIL_SCOPE);
    const p = await google<{ emailAddress: string; messagesTotal: number }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
    gmail = { ok: true, detail: `Can read ${p.emailAddress} (${p.messagesTotal.toLocaleString()} emails)` };
  } catch (e) {
    gmail = fail(explain(e));
  }
  return { drive, mailboxes, gmail };
}
