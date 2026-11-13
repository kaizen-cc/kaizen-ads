import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDriveError, ensureReportFolder, folderIdOf, type FolderDrive } from "@/lib/creative-drive-paths";
import { drive, driveWriteConfigured } from "@/lib/creative-drive";
import { monthLabel } from "./format";
import { rangeLabel, todayIn } from "./period";
import { isWhiteLabel } from "./white-label";
import { reportFileName, safeFileName, type DriveSave } from "./drive-save-core";
import { loadReport } from "./share";
import { renderReportPdf } from "./pdf";

// "Save to Drive": the report as a PDF with the buyer's write-up as a last section ("Our notes"), put in the client's
// Drive: <client folder> / 30 - Reports / 2026 / November 01 2026 / <file name>. The month is the one we're in when it's
// saved. Saved again, it's a new version of the same Drive file (never a copy, never a delete). The client's own PDF,
// the preview and the shared link never carry the notes.

export type SaveResult = { ok: true; save: DriveSave; newVersion: boolean; recorded: boolean } | { ok: false; error: string; fixHref?: string };

const folderDrive: FolderDrive = { listFolders: drive.listFolders, createFolder: drive.createFolder, trashFolder: drive.trashFolder };

/** Plain words for what went wrong in Drive */
function plainError(message: string) {
  const c = classifyDriveError(message);
  if (c.kind === "other" && /\b(404|403)\b|not found|forbidden/i.test(message)) return "Kaizen's Drive account can't open this client's Drive folder. Share the folder with it, or check the folder on the client page.";
  return c.text;
}

export async function saveReportToDrive(admin: SupabaseClient, reportId: string, by: { id: string; fullName: string }, now = new Date()): Promise<SaveResult> {
  const { data: r } = await admin
    .from("reports")
    .select("id, client_id, platform, kind, period_start, period_end, bundle_id, clients(name, slug, client_type, drive_folder_id)")
    .eq("id", reportId)
    .maybeSingle();
  if (!r) return { ok: false, error: "Report not found." };
  const client = r.clients as unknown as { name: string; slug: string; client_type: string | null; drive_folder_id: string | null } | null;
  if (!client) return { ok: false, error: "This report has no client." };
  const fixHref = `/clients/${client.slug}`;
  const clientFolder = client.drive_folder_id ? folderIdOf(client.drive_folder_id) : "";
  if (!clientFolder) return { ok: false, error: `${client.name} has no Drive folder yet. Add it on the client page, then save again.`, fixHref };
  if (!driveWriteConfigured()) return { ok: false, error: "Drive isn't connected yet (an admin needs to add the Google service account and the Drive user in the app's settings)." };

  // The document: the whole report when it's a joint one (every service, one PDF), else this report (with the TikTok part riding on it)
  let joint = false;
  let ranges: { label: string }[] = [];
  if (r.kind === "built" && r.bundle_id) {
    const [{ data: b }, { data: parts }] = await Promise.all([
      admin.from("report_bundles").select("ranges").eq("id", r.bundle_id).maybeSingle(),
      admin.from("reports").select("id").eq("bundle_id", r.bundle_id).neq("status", "skipped"),
    ]);
    ranges = ((b?.ranges ?? []) as { label: string }[]) ?? [];
    joint = (parts?.length ?? 0) > 1;
  }
  const own = rangeLabel({ start: r.period_start as string, end: r.period_end as string }, todayIn());
  const periodLabel = r.kind === "built" && ranges.length ? [own, ...ranges.slice(1).map((x) => x.label)].join(" + ") : r.kind === "monthly" ? monthLabel(r.period_start as string) : own;
  const name = safeFileName(reportFileName({ client: client.name, whiteLabel: isWhiteLabel(client.client_type), built: r.kind === "built", kind: r.kind as string, platform: r.platform as string, periodLabel }));

  let input;
  if (joint) {
    const { builtInput } = await import("./builder");
    input = await builtInput(admin, r.bundle_id as string);
  } else {
    const loaded = await loadReport(admin, reportId);
    if (!loaded) return { ok: false, error: "This report hasn't been written yet." };
    input = loaded.input;
  }
  let pdf: Uint8Array;
  try {
    pdf = await renderReportPdf({ ...input, withNotes: true });
  } catch (e) {
    return { ok: false, error: `The PDF couldn't be drawn: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}` };
  }

  let file: { id: string; webViewLink?: string };
  let newVersion = false;
  try {
    const folder = await ensureReportFolder(folderDrive, clientFolder, now);
    const existing = await drive.findFile(folder, name);
    newVersion = Boolean(existing);
    file = await drive.upload({ parent: folder, fileId: existing?.id, name, mime: "application/pdf", bytes: new Blob([pdf as BlobPart], { type: "application/pdf" }) });
  } catch (e) {
    return { ok: false, error: plainError(e instanceof Error ? e.message : String(e)), fixHref };
  }

  const save: DriveSave = { url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`, name, at: now.toISOString(), by: by.id, byName: by.fullName };
  const { error } = await admin.from("reports").update({ drive_save: save }).eq("id", reportId);
  return { ok: true, save, newVersion, recorded: !error };
}
