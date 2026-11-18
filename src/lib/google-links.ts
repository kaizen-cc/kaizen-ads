// Google Docs, Sheets, Slides and Drive links: which file a link points at and what kind it is, so it can be opened
// through the Drive API as the person. Pure: no keys, no network, so the tests hold it.

export type GoogleLinkKind = "doc" | "sheet" | "slides" | "form" | "drawing" | "file" | "folder";
export type GoogleLink = { id: string; kind: GoogleLinkKind; url: string; /** A Sheets tab (gid) when the link names one */ gid?: string };

const ID = "([A-Za-z0-9_-]{20,})";
const PATHS: [RegExp, GoogleLinkKind][] = [
  [new RegExp(`^/document/(?:u/\\d+/)?d/${ID}`), "doc"],
  [new RegExp(`^/spreadsheets/(?:u/\\d+/)?d/${ID}`), "sheet"],
  [new RegExp(`^/presentation/(?:u/\\d+/)?d/${ID}`), "slides"],
  [new RegExp(`^/forms/(?:u/\\d+/)?d/(?:e/)?${ID}`), "form"],
  [new RegExp(`^/drawings/(?:u/\\d+/)?d/${ID}`), "drawing"],
  [new RegExp(`^/(?:file/)?(?:u/\\d+/)?d/${ID}`), "file"],
  [new RegExp(`^/drive/(?:u/\\d+/)?(?:mobile/)?folders/${ID}`), "folder"],
  [new RegExp(`^/(?:drive/)?(?:u/\\d+/)?folders/${ID}`), "folder"],
];

/** The Google file a link points at, or null when it isn't a Docs, Sheets, Slides or Drive link */
export function parseGoogleLink(raw: string): GoogleLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/[).,;:!?'"\]>]+$/, ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "docs.google.com" && host !== "drive.google.com" && host !== "sheets.google.com" && host !== "slides.google.com") return null;
  const gid = u.hash.match(/gid=(\d+)/)?.[1] ?? u.searchParams.get("gid") ?? undefined;
  for (const [re, kind] of PATHS) {
    const m = u.pathname.match(re);
    if (m) return { id: m[1], kind, url: u.toString(), ...(kind === "sheet" && gid ? { gid } : {}) };
  }
  // drive.google.com/open?id=…, uc?id=…, /file?id=…
  const id = u.searchParams.get("id");
  if (id && new RegExp(`^${ID}$`).test(id)) return { id, kind: "file", url: u.toString() };
  return null;
}

/** Every Google file link in a message (each file once, in the order they appear) */
export function findGoogleLinks(text: string): GoogleLink[] {
  const out: GoogleLink[] = [];
  for (const m of text.matchAll(/https?:\/\/(?:docs|drive|sheets|slides)\.google\.com\/[^\s<>()"']+/gi)) {
    const l = parseGoogleLink(m[0]);
    if (l && !out.some((o) => o.id === l.id)) out.push(l);
  }
  return out;
}

/** How a native Google file is exported as text (Docs and Slides as plain text, Sheets as a workbook to read every tab) */
export function exportTypeFor(mimeType: string): { mime: string; as: "text" | "xlsx" | "csv" } | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return { mime: "text/plain", as: "text" };
    case "application/vnd.google-apps.presentation":
      return { mime: "text/plain", as: "text" };
    case "application/vnd.google-apps.spreadsheet":
      return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", as: "xlsx" };
    case "application/vnd.google-apps.drawing":
      return null;
    case "application/vnd.google-apps.script":
      return { mime: "application/vnd.google-apps.script+json", as: "text" };
    default:
      return null;
  }
}

/** A sheet's rows as CSV (quoted where needed) */
export function rowsToCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map((v) => cell(String(v ?? ""))).join(",")).join("\n");
}

/** What a missing permission means, for the person and the admin (Drive refused, or the scope isn't delegated) */
export function googleReadProblem(message: string): { kind: "scope" | "no_access" | "not_found" | "api_off" | "other"; say: string } {
  const m = message.toLowerCase();
  if (m.includes("unauthorized_client") || m.includes("access_denied") || m.includes("invalid_scope"))
    return {
      kind: "scope",
      say: "Kaizen OS isn't allowed to read Google files as you yet. An admin needs to add the https://www.googleapis.com/auth/drive.readonly scope to the Kaizen service account's domain-wide delegation in the Google Admin console (Security, API controls, Domain-wide delegation).",
    };
  if (m.includes("accessnotconfigured") || m.includes("has not been used in project")) return { kind: "api_off", say: "The Google Drive API is turned off for Kaizen's Google Cloud project. An admin needs to turn it on." };
  if (m.includes(": 404")) return { kind: "not_found", say: "Google says that file doesn't exist or isn't shared with you. Check the link, or ask the owner to share it with your Kaizen account." };
  if (m.includes(": 403")) return { kind: "no_access", say: "Your Google account can't open that file. Ask the owner to share it with your Kaizen email, then try again." };
  return { kind: "other", say: `Google couldn't open it (${message.slice(0, 160)}).` };
}
