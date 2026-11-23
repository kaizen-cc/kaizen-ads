import { platformName } from "./format";
import { whiteLabelFileName } from "./white-label";

// Saving a report to the client's Drive: the pieces with no server code (shared by the studio, the server action and
// the tests). The folders and their names live in creative-drive-paths.ts.

/** What the studio shows after "Saved to Drive", kept on the report (reports.drive_save) */
export type DriveSave = { url: string | null; name: string; at: string; by: string | null; byName: string | null; folderUrl?: string | null; /** What the report said when it was saved (contentBasis): a copy in Drive doesn't follow later edits, so the studio says when it's behind */ basis?: string | null };

// Keys in a fixed order, so the same report read from the database or from the studio's state gives the same text
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v as Record<string, unknown>)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);

/** A short fingerprint of the report's words (its sections, message and notes): different when anything in them changed */
export function contentBasis(r: { sections?: unknown; message?: string | null; extras?: string | null }): string {
  const text = stable({ s: r.sections ?? null, m: String(r.message ?? "").trim(), e: String(r.extras ?? "").trim() });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** A Drive copy made before the report's last change: it doesn't have that change until it's saved again */
export const driveBehind = (save: DriveSave | null | undefined, now: string) => Boolean(save?.basis && save.basis !== now);

/** The report's file name, as the client gets it and as it's saved in Drive ("OceanBox - Meta report - Nov 6 - Nov 12.pdf") */
export function reportFileName(p: { client: string; whiteLabel: boolean; built: boolean; kind: string; platform: string; periodLabel: string }) {
  return p.whiteLabel
    ? whiteLabelFileName(p.client, p.built ? "built" : p.kind, p.periodLabel, p.built ? null : platformName(p.platform))
    : `${p.client} - ${p.built ? "Report" : `${platformName(p.platform).replace(" Ads", "")} report`} - ${p.periodLabel}.pdf`;
}

/** A name safe on every computer Drive syncs to (slashes and reserved characters out) */
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
