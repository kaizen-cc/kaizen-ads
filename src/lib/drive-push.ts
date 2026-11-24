import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveTokenAs } from "./drive-destination";
import { driveQuote, multipartBody } from "./drive-push-core";

// Into the person's Google Drive, as them (the Workspace's delegated access, full Drive scope as for the Google Doc
// exports): upload a file Kaizen OS made into the folder the destination rule settled on (src/lib/drive-destination.ts:
// the folder they named, or the remembered one they confirmed; never a guess, never My Drive's root).

const DRIVE = "https://www.googleapis.com/drive/v3";
const ALL = { supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" };

/** Uploads a file into a folder, as the person; a file of the same name there is replaced (a new version) */
export async function uploadToFolder(email: string, folderId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; link: string | null }> {
  const token = await driveTokenAs(email);
  const same = await fetch(`${DRIVE}/files?${new URLSearchParams({ ...ALL, q: `${driveQuote(folderId)} in parents and name = ${driveQuote(name)} and trashed = false`, fields: "files(id)", pageSize: "1" })}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ files?: { id: string }[] }>) : { files: [] }))
    .catch(() => ({ files: [] as { id: string }[] }));
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
export async function documentBytes(db: SupabaseClient, admin: SupabaseClient, id: string): Promise<{ name: string; bytes: Uint8Array; clientId: string | null; kind: string } | null> {
  // Their own document, or one on a client they can see (their session decides)
  const { data: d } = await db.from("kaizen_documents").select("bucket, path, file_name, client_id, kind").eq("id", id).maybeSingle();
  if (!d) return null;
  const { data: blob } = await admin.storage.from(d.bucket as string).download(d.path as string);
  if (!blob) return null;
  return { name: String(d.file_name), bytes: new Uint8Array(await blob.arrayBuffer()), clientId: (d.client_id as string | null) ?? null, kind: String(d.kind ?? "document") };
}
