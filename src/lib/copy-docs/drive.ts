import "server-only";
import type { FolderDrive } from "@/lib/creative-drive-paths";

// Google Drive as a given person (domain-wide delegation with the full drive scope), for approved copy: the person who
// approves it makes the folder and the Google Doc, so Drive shows them as the owner. When Google won't act as them (not
// in the Workspace, delegation not allowed), it's made as the Drive user every other Drive feature writes as
// (GOOGLE_DRIVE_USER). Needs GOOGLE_SERVICE_ACCOUNT_JSON and, in the Workspace Admin console, the service account's
// domain-wide delegation with https://www.googleapis.com/auth/drive.

const SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const ALL = { supportsAllDrives: "true" };

export const copyDriveConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

export class CopyDriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const tokens = new Map<string, { token: string; until: number }>();
async function tokenFor(subject: string) {
  const hit = tokens.get(subject);
  if (hit && hit.until > Date.now()) return hit.token;
  const { JWT } = await import("google-auth-library");
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  const t = (await new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject }).getAccessToken()).token;
  if (!t) throw new CopyDriveError("Drive gave no token", 401);
  tokens.set(subject, { token: t, until: Date.now() + 45 * 60_000 });
  return t;
}

export type CopyDrive = FolderDrive & {
  /** Who Drive is acting as */
  as: string;
  /** A new Google Doc in a folder, from HTML (Drive converts it) */
  createDoc(parent: string, name: string, html: string): Promise<{ id: string; url: string }>;
  /** A folder's name, to check it can be opened */
  folderName(id: string): Promise<string>;
};

function driveAs(subject: string): CopyDrive {
  const call = async <T>(method: string, url: string, init: { params?: Record<string, string>; json?: unknown; body?: BodyInit; type?: string } = {}): Promise<T> => {
    const t = await tokenFor(subject);
    const qs = init.params ? `?${new URLSearchParams(init.params)}` : "";
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${url}${qs}`, {
        method,
        cache: "no-store",
        headers: { authorization: `Bearer ${t}`, ...(init.json !== undefined ? { "content-type": "application/json; charset=UTF-8" } : init.type ? { "content-type": init.type } : {}) },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      });
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, [1500, 4000][attempt]));
        continue;
      }
      throw new CopyDriveError(`Drive ${method}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
    }
  };
  return {
    as: subject,
    async listFolders(parent) {
      const out: { id: string; name: string }[] = [];
      let pageToken = "";
      do {
        const data = await call<{ files?: { id: string; name: string }[]; nextPageToken?: string }>("GET", API, {
          params: { q: `'${parent.replace(/'/g, "")}' in parents and mimeType = '${FOLDER}' and trashed = false`, fields: "nextPageToken, files(id, name)", pageSize: "1000", orderBy: "createdTime", corpora: "allDrives", includeItemsFromAllDrives: "true", ...ALL, ...(pageToken ? { pageToken } : {}) },
        });
        out.push(...(data.files ?? []));
        pageToken = data.nextPageToken ?? "";
      } while (pageToken);
      return out;
    },
    async createFolder(parent, name) {
      return (await call<{ id: string }>("POST", API, { params: { fields: "id", ...ALL }, json: { name, mimeType: FOLDER, parents: [parent] } })).id;
    },
    async trashFolder(id) {
      await call("PATCH", `${API}/${id}`, { params: { fields: "id", ...ALL }, json: { trashed: true } });
    },
    async folderName(id) {
      return (await call<{ name: string }>("GET", `${API}/${id}`, { params: { fields: "name", ...ALL } })).name;
    },
    async createDoc(parent, name, html) {
      const boundary = `kzn${crypto.randomUUID().replace(/-/g, "")}`;
      const meta = JSON.stringify({ name, mimeType: "application/vnd.google-apps.document", parents: [parent] });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
      const made = await call<{ id: string; webViewLink?: string }>("POST", UPLOAD, { params: { uploadType: "multipart", fields: "id, webViewLink", ...ALL }, body, type: `multipart/related; boundary=${boundary}` });
      return { id: made.id, url: made.webViewLink ?? `https://docs.google.com/document/d/${made.id}/edit` };
    },
  };
}

/**
 * Drive as this person when Google allows it, else as the shared Drive user. Checked by opening the folder it will
 * write in, so a refusal shows up here, not halfway through.
 */
export async function driveFor(email: string | null, folder: string): Promise<{ drive: CopyDrive; asPerson: boolean }> {
  if (!copyDriveConfigured()) throw new CopyDriveError("Drive isn't connected (the Google service account isn't set up)", 0);
  const tries = [email, process.env.GOOGLE_DRIVE_USER].filter((x, i, a): x is string => Boolean(x) && a.indexOf(x) === i);
  let last: unknown = null;
  for (const who of tries) {
    try {
      const d = driveAs(who);
      await d.folderName(folder);
      return { drive: d, asPerson: who === email };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new CopyDriveError("Drive refused", 403);
}
