import "server-only";
import type { Destination } from "@/lib/drive-destination-core";
import { footerText, kdocHtml } from "./html";
import { deckRequests, PAGE } from "./slides";
import { fileName, type KDoc } from "./templates";

// A Kaizen document made in Google, as the person who asked (Kaizen's service account acting for them, domain-wide
// delegation): a Google Doc from the house-style HTML (Drive converts it; the footer is set through the Docs API) or
// Google Slides built through the Slides API, in the folder the Drive rule settled on (src/lib/kaizen-docs/destination.ts:
// named, confirmed or remembered; never a guess), and a PDF copy exported for email attachments. Needs, in the Google Admin console, the service account's domain-wide
// delegation with https://www.googleapis.com/auth/drive, https://www.googleapis.com/auth/presentations and
// https://www.googleapis.com/auth/documents.

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// A token asks for the scopes it needs; when the Workspace hasn't allowed Slides or Docs yet, Drive alone still works
// (a Doc is made by Drive's converter; only the footer needs the Docs scope)
const SCOPE_SETS = [[DRIVE_SCOPE, SLIDES_SCOPE, DOCS_SCOPE], [DRIVE_SCOPE, SLIDES_SCOPE], [DRIVE_SCOPE, DOCS_SCOPE], [DRIVE_SCOPE]];
const tokens = new Map<string, { token: string; scopes: string[]; until: number }>();
async function tokenFor(subject: string): Promise<{ token: string; scopes: string[] }> {
  const hit = tokens.get(subject);
  if (hit && hit.until > Date.now()) return hit;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Google isn't connected (the service account isn't set up).");
  const { JWT } = await import("google-auth-library");
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  let last: unknown = null;
  for (const scopes of SCOPE_SETS) {
    try {
      const t = (await new JWT({ email: key.client_email, key: key.private_key, scopes, subject }).getAccessToken()).token;
      if (!t) continue;
      const got = { token: t, scopes, until: Date.now() + 45 * 60_000 };
      tokens.set(subject, got);
      return got;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("Google gave no token.");
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type GoogleAs = {
  as: string;
  /** Whether the Workspace lets Kaizen use Slides / Docs as this person (Drive is always there) */
  can(scope: "slides" | "docs"): Promise<boolean>;
  call<T>(method: string, url: string, init?: { json?: unknown; body?: BodyInit; type?: string }): Promise<T>;
  raw(url: string): Promise<Buffer>;
};

function googleAs(subject: string): GoogleAs {
  const call = async <T>(method: string, url: string, init: { json?: unknown; body?: BodyInit; type?: string } = {}): Promise<T> => {
    const t = (await tokenFor(subject)).token;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
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
      throw new GoogleError(`Google ${method} ${new URL(url).hostname}: ${res.status} ${(await res.text()).slice(0, 240)}`, res.status);
    }
  };
  return {
    as: subject,
    can: async (scope) => (await tokenFor(subject)).scopes.includes(scope === "slides" ? SLIDES_SCOPE : DOCS_SCOPE),
    call,
    async raw(url) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${(await tokenFor(subject)).token}` }, cache: "no-store" });
      if (!res.ok) throw new GoogleError(`Google export: ${res.status}`, res.status);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

const q = (params: Record<string, string>) => `?${new URLSearchParams({ supportsAllDrives: "true", ...params })}`;

/** Folder helpers for one Google identity (the shape findHq and findOrCreateFolder take) */
export function folderHelpers(g: GoogleAs) {
  return {
    async listFolders(parent: string) {
      const out: { id: string; name: string }[] = [];
      let pageToken = "";
      do {
        const data = await g.call<{ files?: { id: string; name: string }[]; nextPageToken?: string }>("GET", `${DRIVE}${q({ q: `'${parent.replace(/'/g, "")}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "nextPageToken, files(id, name)", pageSize: "1000", orderBy: "createdTime", corpora: "allDrives", includeItemsFromAllDrives: "true", ...(pageToken ? { pageToken } : {}) })}`);
        out.push(...(data.files ?? []));
        pageToken = data.nextPageToken ?? "";
      } while (pageToken);
      return out;
    },
    async createFolder(parent: string, name: string) {
      return (await g.call<{ id: string }>("POST", `${DRIVE}${q({ fields: "id" })}`, { json: { name, mimeType: "application/vnd.google-apps.folder", parents: [parent] } })).id;
    },
    async folderName(id: string) {
      return (await g.call<{ name: string }>("GET", `${DRIVE}/${id}${q({ fields: "name" })}`)).name;
    },
  };
}

/** The person when Google lets Kaizen act as them, else the shared Drive user; checked by opening `probe` */
export async function googleFor(email: string | null, probe = "root"): Promise<{ g: GoogleAs; asPerson: boolean }> {
  const tries = [email, process.env.GOOGLE_DRIVE_USER].filter((x, i, a): x is string => Boolean(x) && a.indexOf(x) === i);
  let last: unknown = new GoogleError("Google isn't connected", 0);
  for (const who of tries) {
    try {
      const g = googleAs(who);
      await folderHelpers(g).folderName(probe);
      return { g, asPerson: who === email };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export type Filed = { folderId: string; folderUrl: string; place: string; asPerson: boolean; g: GoogleAs };

/** The Google identity that writes into a settled destination (the person when Google allows it) */
export async function filedAt(email: string, d: Destination): Promise<Filed> {
  const { pathText } = await import("@/lib/drive-destination-core");
  const { g, asPerson } = await googleFor(email, d.id);
  return { folderId: d.id, folderUrl: d.link ?? `https://drive.google.com/drive/folders/${d.id}`, place: pathText(d.path), asPerson, g };
}

export type MadeGoogle = { id: string; url: string; kind: "doc" | "slides"; pdf: Buffer | null; footer: boolean };

/** The document made in Google in its folder, its footer set, a PDF exported; shared with the person when made for them */
export async function makeGoogleFile(doc: KDoc, filed: Filed, me: { email: string }): Promise<MadeGoogle> {
  const g = filed.g;
  const name = fileName(doc);
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency").replace(/\/$/, "");
  let made: { id: string; url: string; kind: "doc" | "slides" };
  let footer = true;
  if (doc.template === "proposal" || doc.template === "deck") {
    if (!(await g.can("slides"))) throw new GoogleError("Google won't let Kaizen OS make Slides yet: an admin needs to allow https://www.googleapis.com/auth/presentations for Kaizen's service account (Google Admin, Security, API controls, Domain-wide delegation).", 403);
    const pres = await g.call<{ presentationId: string; slides?: { objectId: string }[] }>("POST", "https://slides.googleapis.com/v1/presentations", { json: { title: name, pageSize: { width: { magnitude: PAGE.w * 12700, unit: "EMU" }, height: { magnitude: PAGE.h * 12700, unit: "EMU" } } } });
    const first = pres.slides?.[0]?.objectId;
    const { requests } = deckRequests(doc, `kz${Date.now().toString(36)}`);
    // Order matters (a slide before what's on it), so the batches run one after another
    for (let i = 0; i < requests.length; i += 400) await g.call("POST", `https://slides.googleapis.com/v1/presentations/${pres.presentationId}:batchUpdate`, { json: { requests: requests.slice(i, i + 400) } });
    if (first) await g.call("POST", `https://slides.googleapis.com/v1/presentations/${pres.presentationId}:batchUpdate`, { json: { requests: [{ deleteObject: { objectId: first } }] } }).catch(() => undefined);
    if (filed.folderId !== "root") {
      const meta = await g.call<{ parents?: string[] }>("GET", `${DRIVE}/${pres.presentationId}${q({ fields: "parents" })}`);
      await g.call("PATCH", `${DRIVE}/${pres.presentationId}${q({ addParents: filed.folderId, removeParents: (meta.parents ?? []).join(","), fields: "id" })}`, { json: {} });
    }
    made = { id: pres.presentationId, url: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`, kind: "slides" };
  } else {
    const boundary = `kzn${crypto.randomUUID().replace(/-/g, "")}`;
    const meta = JSON.stringify({ name, mimeType: "application/vnd.google-apps.document", parents: [filed.folderId] });
    const html = kdocHtml(doc, { logo: `${base}/kaizen-logo.png`, markWhite: `${base}/kaizen-mark-white.png` });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
    const up = await g.call<{ id: string; webViewLink?: string }>("POST", `${UPLOAD}${q({ uploadType: "multipart", fields: "id, webViewLink" })}`, { body, type: `multipart/related; boundary=${boundary}` });
    made = { id: up.id, url: up.webViewLink ?? `https://docs.google.com/document/d/${up.id}/edit`, kind: "doc" };
    // The footer ("Kaizen x Client | Scope of Work"), through the Docs API; skipped when that scope isn't allowed yet
    try {
      if (!(await g.can("docs"))) throw new Error("no Docs scope");
      const r = await g.call<{ replies?: { createFooter?: { footerId: string } }[] }>("POST", `https://docs.googleapis.com/v1/documents/${up.id}:batchUpdate`, { json: { requests: [{ createFooter: { type: "DEFAULT" } }] } });
      const footerId = r.replies?.[0]?.createFooter?.footerId;
      if (footerId) {
        const text = footerText(doc);
        await g.call("POST", `https://docs.googleapis.com/v1/documents/${up.id}:batchUpdate`, {
          json: {
            requests: [
              { insertText: { location: { segmentId: footerId, index: 0 }, text } },
              { updateTextStyle: { range: { segmentId: footerId, startIndex: 0, endIndex: text.length }, textStyle: { fontSize: { magnitude: 8, unit: "PT" }, foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } } }, weightedFontFamily: { fontFamily: "Arial" } }, fields: "fontSize,foregroundColor,weightedFontFamily" } },
            ],
          },
        });
      }
    } catch {
      footer = false;
    }
  }
  if (!filed.asPerson) await g.call("POST", `${DRIVE}/${made.id}/permissions${q({ sendNotificationEmail: "false" })}`, { json: { role: "writer", type: "user", emailAddress: me.email } }).catch(() => undefined);
  const pdf = await g.raw(`${DRIVE}/${made.id}/export?mimeType=application/pdf`).catch(() => null);
  return { ...made, pdf, footer };
}
