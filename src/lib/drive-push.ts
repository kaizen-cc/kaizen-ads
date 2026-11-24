import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveQuote, multipartBody, parseFolderRef } from "./drive-push-core";

// Into the person's Google Drive, as them (the Workspace's delegated access, full Drive scope as for the Google Doc
// exports): find the folder they named (a link, or a path whose first part is a shared drive or any folder they can
// reach), make a subfolder when asked ("Case Studies"), and upload a file Kaizen OS made there. Their own Drive rights
// decide everything: a folder they can't reach isn't found.

const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";

async function tokenAs(email: string) {
  const { googleConfigured, googleTokenFor } = await import("@/lib/context/google");
  if (!googleConfigured()) throw new Error("Google isn't connected to Kaizen OS yet.");
  return googleTokenFor(email, "https://www.googleapis.com/auth/drive");
}

async function get<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${DRIVE}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Drive said no (${res.status}).`);
  return (await res.json()) as T;
}

const ALL = { supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" };
type Item = { id: string; name: string; webViewLink?: string; driveId?: string };

/** The folder named by its path: a shared drive or any folder for the first part, then each subfolder by name */
async function folderByPath(token: string, path: string[]): Promise<Item | { error: string }> {
  const [first, ...rest] = path;
  let parent: Item | null = null;
  const drives = await get<{ drives?: { id: string; name: string }[] }>(token, "drives", { pageSize: "100", q: `name = ${driveQuote(first)}` }).catch(() => ({ drives: [] }));
  const drive = (drives.drives ?? [])[0];
  if (drive) parent = { id: drive.id, name: drive.name };
  else {
    const found = await get<{ files?: Item[] }>(token, "files", { ...ALL, q: `name = ${driveQuote(first)} and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id, name, webViewLink)", pageSize: "10" });
    if (!found.files?.length) return { error: `No folder or shared drive called "${first}" that you can reach in Drive.` };
    if (found.files.length > 1) return { error: `More than one folder is called "${first}". Paste the folder's link instead.` };
    parent = found.files[0];
  }
  for (const name of rest) {
    const next = await child(token, parent.id, name);
    if (!next) return { error: `"${parent.name}" has no folder called "${name}".` };
    parent = next;
  }
  return parent;
}

async function child(token: string, parentId: string, name: string): Promise<Item | null> {
  const r = await get<{ files?: Item[] }>(token, "files", { ...ALL, q: `${driveQuote(parentId)} in parents and name = ${driveQuote(name)} and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id, name, webViewLink)", pageSize: "5" });
  return r.files?.[0] ?? null;
}

/** The folder they pointed to (and the subfolder in it, made when it isn't there yet) */
export async function driveFolder(email: string, ref: string, subfolder?: string | null): Promise<{ id: string; name: string; link: string | null; made: boolean } | { error: string }> {
  const parsed = parseFolderRef(ref);
  if (!parsed) return { error: "Which folder? Paste its Drive link, or its path (Shared drive/Folder/Subfolder)." };
  const token = await tokenAs(email);
  let folder: Item;
  if ("id" in parsed) {
    const f = await get<Item & { mimeType: string }>(token, `files/${parsed.id}`, { supportsAllDrives: "true", fields: "id, name, mimeType, webViewLink" }).catch(() => null);
    if (!f || f.mimeType !== FOLDER) return { error: "That link isn't a Drive folder you can reach." };
    folder = f;
  } else {
    const f = await folderByPath(token, parsed.path);
    if ("error" in f) return f;
    folder = f;
  }
  const sub = String(subfolder ?? "").trim();
  if (!sub) return { id: folder.id, name: folder.name, link: folder.webViewLink ?? null, made: false };
  const had = await child(token, folder.id, sub);
  if (had) return { id: had.id, name: had.name, link: had.webViewLink ?? null, made: false };
  const res = await fetch(`${DRIVE}/files?supportsAllDrives=true&fields=id,name,webViewLink`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: sub, mimeType: FOLDER, parents: [folder.id] }) });
  if (!res.ok) return { error: `Couldn't make "${sub}" in "${folder.name}" (Drive said ${res.status}).` };
  const made = (await res.json()) as Item;
  return { id: made.id, name: made.name, link: made.webViewLink ?? null, made: true };
}

/** Uploads a file into a folder, as the person; a file of the same name there is replaced (a new version) */
export async function uploadToFolder(email: string, folderId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; link: string | null }> {
  const token = await tokenAs(email);
  const same = await get<{ files?: Item[] }>(token, "files", { ...ALL, q: `${driveQuote(folderId)} in parents and name = ${driveQuote(name)} and trashed = false`, fields: "files(id)", pageSize: "1" }).catch(() => ({ files: [] }));
  const existing = same.files?.[0]?.id ?? null;
  const boundary = `kz${crypto.randomUUID().replace(/-/g, "")}`;
  const meta = existing ? { name } : { name, parents: [folderId] };
  const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink` : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`;
  const res = await fetch(url, { method: existing ? "PATCH" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` }, body: multipartBody(meta, bytes, mime, boundary) as unknown as BodyInit });
  if (!res.ok) throw new Error(`Drive wouldn't take the file (${res.status}).`);
  const f = (await res.json()) as { id: string; webViewLink?: string };
  return { id: f.id, link: f.webViewLink ?? null };
}

/** A document Kaizen OS made (kaizen_documents), its bytes and name, for the person who may see it */
export async function documentBytes(db: SupabaseClient, admin: SupabaseClient, id: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  // Their own document, or one on a client they can see (their session decides)
  const { data: d } = await db.from("kaizen_documents").select("bucket, path, file_name").eq("id", id).maybeSingle();
  if (!d) return null;
  const { data: blob } = await admin.storage.from(d.bucket as string).download(d.path as string);
  if (!blob) return null;
  return { name: String(d.file_name), bytes: new Uint8Array(await blob.arrayBuffer()) };
}
