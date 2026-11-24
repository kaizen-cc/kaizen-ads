import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreateFolder, folderIdOf } from "@/lib/creative-drive-paths";
import { footerText, kdocHtml } from "./html";
import { deckRequests, PAGE } from "./slides";
import { fileName, type KDoc } from "./templates";

// A Kaizen document made in Google, as the person who asked (Kaizen's service account acting for them, domain-wide
// delegation): a Google Doc from the house-style HTML (Drive converts it; the footer is set through the Docs API) or
// Google Slides built through the Slides API. Filed where it belongs:
//   a client's document → the client's Headquarters folder › "Proposals & SOWs" (made when missing)
//   a prospect's        → the shared "Kaizen Sales" › "Prospects" › <name> (moved to the HQ once they're a client)
//   anything else       → the person's own Drive
// and a PDF copy exported for email attachments. Needs, in the Google Admin console, the service account's domain-wide
// delegation with https://www.googleapis.com/auth/drive, https://www.googleapis.com/auth/presentations and
// https://www.googleapis.com/auth/documents.

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";
const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const PROPOSALS_FOLDER = "Proposals & SOWs";
export const SALES_FOLDER = "Kaizen Sales";
export const PROSPECTS_FOLDER = "Prospects";

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
function folders(g: GoogleAs) {
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
      await folders(g).folderName(probe);
      return { g, asPerson: who === email };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export type Where = { kind: "client"; clientId: string } | { kind: "prospect"; name: string } | { kind: "mine" };
export type Filed = { folderId: string; folderUrl: string; place: string; asPerson: boolean; g: GoogleAs; note: string | null };

/** The shared "Kaizen Sales" folder: app_settings kaizen_sales_folder, else found (or made) in the shared drive */
async function salesRoot(admin: SupabaseClient, g: GoogleAs): Promise<string> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "kaizen_sales_folder").maybeSingle();
  const set = (data?.value as { folder?: string } | null)?.folder;
  if (set) return folderIdOf(set);
  const root = process.env.GOOGLE_SHARED_DRIVE_ID;
  if (!root) throw new GoogleError("There's no shared Kaizen Sales folder set, and no shared drive to make it in.", 0);
  const id = (await findOrCreateFolder(folders(g), root, SALES_FOLDER)).id;
  await admin.from("app_settings").upsert({ key: "kaizen_sales_folder", value: { folder: id } });
  return id;
}

/** Where a document goes, and the Google identity that writes it there */
export async function fileFor(admin: SupabaseClient, me: { email: string }, where: Where): Promise<Filed> {
  if (where.kind === "client") {
    const [{ clientFacts }, { findHq }] = await Promise.all([import("@/lib/copy-docs/server"), import("@/lib/copy-docs/hq-path")]);
    const facts = await clientFacts(admin as never, where.clientId);
    const root = process.env.GOOGLE_SHARED_DRIVE_ID ?? null;
    const probe = [...facts.hqLinks, facts.clientFolder, root].map((x) => (x ? folderIdOf(x) : null)).find(Boolean) ?? null;
    if (probe) {
      try {
        const look = await googleFor(me.email, probe);
        const hq = await findHq(folders(look.g), { client: { name: facts.name, kaizenId: facts.kaizenId }, stored: facts.hqLinks, clientFolder: facts.clientFolder, root });
        if (hq.ok) {
          const { g, asPerson } = await googleFor(me.email, hq.id);
          const id = (await findOrCreateFolder(folders(g), hq.id, PROPOSALS_FOLDER)).id;
          return { folderId: id, folderUrl: `https://drive.google.com/drive/folders/${id}`, place: `${facts.name}'s Headquarters › ${PROPOSALS_FOLDER}`, asPerson, g, note: null };
        }
      } catch {
        // falls through to their own Drive, said in the note
      }
    }
    const mine = await googleFor(me.email);
    return { folderId: "root", folderUrl: "https://drive.google.com/drive/my-drive", place: "your own Drive", asPerson: mine.asPerson, g: mine.g, note: `${facts.name}'s Headquarters folder couldn't be found or opened, so it's in your own Drive for now: paste the HQ link on the client page (account sheet) and new ones file there.` };
  }
  if (where.kind === "prospect") {
    const shared = await googleFor(process.env.GOOGLE_DRIVE_USER ?? me.email, process.env.GOOGLE_SHARED_DRIVE_ID ?? "root");
    const sales = await salesRoot(admin, shared.g);
    const prospects = (await findOrCreateFolder(folders(shared.g), sales, PROSPECTS_FOLDER)).id;
    const id = (await findOrCreateFolder(folders(shared.g), prospects, where.name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Prospect")).id;
    const { g, asPerson } = await googleFor(me.email, id).catch(() => ({ g: shared.g, asPerson: false }));
    return { folderId: id, folderUrl: `https://drive.google.com/drive/folders/${id}`, place: `${SALES_FOLDER} › ${PROSPECTS_FOLDER} › ${where.name}`, asPerson, g, note: null };
  }
  const { g, asPerson } = await googleFor(me.email);
  return { folderId: "root", folderUrl: "https://drive.google.com/drive/my-drive", place: "your own Drive", asPerson, g, note: null };
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

/** A prospect's documents moved into their Headquarters › Proposals & SOWs once they're a client */
export async function moveToFolder(g: GoogleAs, fileId: string, folderId: string) {
  const meta = await g.call<{ parents?: string[] }>("GET", `${DRIVE}/${fileId}${q({ fields: "parents" })}`);
  await g.call("PATCH", `${DRIVE}/${fileId}${q({ addParents: folderId, removeParents: (meta.parents ?? []).join(","), fields: "id" })}`, { json: {} });
}
