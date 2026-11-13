import { platformName } from "./format";
import { whiteLabelFileName } from "./white-label";

// Saving a report to the client's Drive: the pieces with no server code (shared by the studio, the server action and
// the tests). The folders and their names live in creative-drive-paths.ts.

/** What the studio shows after "Saved to Drive", kept on the report (reports.drive_save) */
export type DriveSave = { url: string | null; name: string; at: string; by: string | null; byName: string | null; folderUrl?: string | null };

/** The report's file name, as the client gets it and as it's saved in Drive ("OceanBox - Meta report - Nov 6 - Nov 12.pdf") */
export function reportFileName(p: { client: string; whiteLabel: boolean; built: boolean; kind: string; platform: string; periodLabel: string }) {
  return p.whiteLabel
    ? whiteLabelFileName(p.client, p.built ? "built" : p.kind, p.periodLabel, p.built ? null : platformName(p.platform))
    : `${p.client} - ${p.built ? "Report" : `${platformName(p.platform).replace(" Ads", "")} report`} - ${p.periodLabel}.pdf`;
}

/** A name safe on every computer Drive syncs to (slashes and reserved characters out) */
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
