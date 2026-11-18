import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MailAttachment } from "@/lib/assistant/messages";
import { documentFile, documentHref, readableDocuments } from "./server";

// Kaizen documents on an email: which ones the person may attach (their own session decides), their PDFs read for a
// multipart message, and, when the app can't write to their Gmail, the note that goes with a prefilled compose
// ("attach the PDF you downloaded").

export type DraftFile = { documentId: string; name: string };

/** The documents named by id that this person may attach, as they're kept on a draft */
export async function draftFiles(db: SupabaseClient, ids: unknown): Promise<DraftFile[]> {
  const wanted = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? "").trim()).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const docs = await readableDocuments(db, [...new Set(wanted)]);
  return docs.map((d) => ({ documentId: d.id, name: d.file_name ?? `${d.title}.pdf` }));
}

/** The files themselves, read with the server's rights (only ids already checked by draftFiles) */
export async function mailFiles(admin: SupabaseClient, files: readonly DraftFile[]): Promise<{ attached: MailAttachment[]; missing: string[] }> {
  if (!files.length) return { attached: [], missing: [] };
  const { data } = await admin.from("kaizen_documents").select("id, bucket, path").in("id", files.map((f) => f.documentId));
  const attached: MailAttachment[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const row = (data ?? []).find((d) => d.id === f.documentId);
    const bytes = row?.path ? await documentFile(admin, { bucket: row.bucket as string, path: row.path as string }).catch(() => null) : null;
    if (bytes) attached.push({ name: f.name, mime: "application/pdf", data: bytes });
    else missing.push(f.name);
  }
  return { attached, missing };
}

/** The card's view of the files: each with its download link */
export const fileViews = (files: readonly DraftFile[] | undefined) => (files ?? []).map((f) => ({ documentId: f.documentId, name: f.name, download: documentHref(f.documentId, true) }));

/** What a prefilled compose says at the bottom when the PDF can't be attached for them */
export const attachNote = (files: readonly DraftFile[]) => (files.length ? `\n\n[Attach before sending: ${files.map((f) => f.name).join(", ")}]` : "");
