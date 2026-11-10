import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import {
  classifyDriveError,
  driveFileName,
  ensureAdCreative,
  ensureFolderPath,
  findOrCreateFolder,
  isOldLayoutPath,
  locateAdCreative,
  NO_DRIVE,
  nextAttempt,
  REPLACED,
  relocateFile,
  rootPlan,
  slotOf,
  ticketPath,
  ticketSteps,
  type FolderCache,
  type FolderDrive,
  type MoveDrive,
} from "@/lib/creative-drive-paths";

// Creative uploaded on a ticket, copied into the client's Google Drive ("Ad Creatives / 2026 / 11 - November / #1234 Title").
// Everything here runs after the response or on the schedule: the upload itself never waits for Drive.
//
// Needs (Vercel env): GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_USER (a Workspace person who can open every client
// folder; Drive is written as them), and in the Workspace Admin console the service account's domain-wide delegation
// must include https://www.googleapis.com/auth/drive (full Drive, not only drive.readonly).

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER = "application/vnd.google-apps.folder";
const BUCKET = "creative";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
/** Copied through the function's memory: past this, the file stays on the ticket and says so */
const MAX_BYTES = 1_500_000_000;

export const driveWriteConfigured = () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_DRIVE_USER);

class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let cached: { token: string; until: number } | null = null;
async function token() {
  if (!driveWriteConfigured()) throw new Error("Drive isn't connected");
  if (cached && cached.until > Date.now()) return cached.token;
  const { JWT } = await import("google-auth-library");
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!) as { client_email: string; private_key: string };
  const t = (await new JWT({ email: key.client_email, key: key.private_key, scopes: [DRIVE_SCOPE], subject: process.env.GOOGLE_DRIVE_USER! }).getAccessToken()).token;
  if (!t) throw new Error("Drive gave no token (unauthorized_client?)");
  cached = { token: t, until: Date.now() + 45 * 60_000 };
  return t;
}

const ALL = { supportsAllDrives: "true" };

async function call<T>(method: string, url: string, opts: { params?: Record<string, string>; json?: unknown; raw?: { body: BodyInit; type: string }; headers?: Record<string, string> } = {}): Promise<{ data: T; res: Response }> {
  const t = await token();
  const qs = opts.params ? `${url.includes("?") ? "&" : "?"}${new URLSearchParams(opts.params)}` : "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url}${qs}`, {
      method,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${t}`,
        ...(opts.json !== undefined ? { "content-type": "application/json; charset=UTF-8" } : {}),
        ...(opts.raw ? { "content-type": opts.raw.type } : {}),
        ...opts.headers,
      },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.raw?.body,
    });
    if (res.ok) {
      const text = await res.text();
      return { data: (text ? JSON.parse(text) : {}) as T, res };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, [1500, 4000][attempt]));
      continue;
    }
    throw new DriveError(`Drive ${method} ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  }
}

/** The Drive calls this feature makes, as GOOGLE_DRIVE_USER with the full drive scope */
export const drive = {
  async listFolders(parent: string) {
    const out: { id: string; name: string }[] = [];
    let pageToken = "";
    do {
      const { data } = await call<{ files?: { id: string; name: string }[]; nextPageToken?: string }>("GET", API, {
        params: {
          q: `'${parent.replace(/'/g, "")}' in parents and mimeType = '${FOLDER}' and trashed = false`,
          fields: "nextPageToken, files(id, name)",
          pageSize: "1000",
          orderBy: "createdTime",
          corpora: "allDrives",
          includeItemsFromAllDrives: "true",
          ...ALL,
          ...(pageToken ? { pageToken } : {}),
        },
      });
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    return out;
  },
  async createFolder(parent: string, name: string) {
    const { data } = await call<{ id: string }>("POST", API, { params: { fields: "id", ...ALL }, json: { name, mimeType: FOLDER, parents: [parent] } });
    return data.id;
  },
  /** A folder this run just made that lost a race (empty): to the trash, never deleted */
  async trashFolder(id: string) {
    await call("PATCH", `${API}/${id}`, { params: { fields: "id", ...ALL }, json: { trashed: true } });
  },
  /** Folder or file: whether it's there, what it is, where it sits */
  async meta(id: string) {
    const { data } = await call<{ id: string; mimeType: string; trashed?: boolean; parents?: string[]; webViewLink?: string; name: string }>("GET", `${API}/${id}`, { params: { fields: "id, name, mimeType, trashed, parents, webViewLink", ...ALL } });
    return data;
  },
  /** Resumable (any size): a new file, or with fileId a new revision of that file (kept forever, renamed if the concept changed) */
  async upload(p: { parent?: string; fileId?: string; name: string; mime: string; bytes: Blob }) {
    const url = p.fileId ? `${UPLOAD}/${p.fileId}` : UPLOAD;
    const params = { uploadType: "resumable", fields: "id, webViewLink", ...ALL, ...(p.fileId ? { keepRevisionForever: "true" } : {}) };
    const { res } = await call(p.fileId ? "PATCH" : "POST", url, {
      params,
      json: p.fileId ? { name: p.name } : { name: p.name, parents: [p.parent] },
      headers: { "x-upload-content-type": p.mime, "x-upload-content-length": String(p.bytes.size) },
    });
    const session = res.headers.get("location");
    if (!session) throw new DriveError("Drive gave no upload session", 500);
    const up = await fetch(session, { method: "PUT", headers: { "content-type": p.mime }, body: p.bytes });
    if (!up.ok) throw new DriveError(`Drive upload: ${up.status} ${(await up.text()).slice(0, 200)}`, up.status);
    return (await up.json()) as { id: string; webViewLink?: string };
  },
  /** New parents (and a new name when given): the same file, never a copy */
  async move(id: string, to: string, from: string[], name?: string) {
    await call("PATCH", `${API}/${id}`, { params: { addParents: to, ...(from.length ? { removeParents: from.join(",") } : {}), fields: "id", ...ALL }, json: name ? { name } : {} });
  },
  async rename(id: string, name: string) {
    await call("PATCH", `${API}/${id}`, { params: { fields: "id", ...ALL }, json: { name } });
  },
};

const folderDrive: FolderDrive = { listFolders: drive.listFolders, createFolder: drive.createFolder, trashFolder: drive.trashFolder };
const moveDrive: MoveDrive = {
  ...folderDrive,
  async where(id) {
    try {
      const m = await drive.meta(id);
      return { parents: m.parents ?? [], name: m.name, trashed: Boolean(m.trashed) };
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return null;
      throw e;
    }
  },
  move: drive.move,
  rename: drive.rename,
};

/** client_drive_folders as the folder cache for one client's Ad Creative folder */
export function folderCache(admin: SupabaseClient, clientId: string, root: string): FolderCache {
  return {
    async get(path) {
      const { data } = await admin.from("client_drive_folders").select("folder_id").eq("client_id", clientId).eq("root_id", root).eq("path", path).maybeSingle();
      return (data?.folder_id as string | undefined) ?? null;
    },
    async put(path, id) {
      await admin.from("client_drive_folders").upsert({ client_id: clientId, root_id: root, path, folder_id: id }, { onConflict: "client_id,root_id,path", ignoreDuplicates: true });
      return (await this.get(path)) ?? id;
    },
    async forget() {
      await admin.from("client_drive_folders").delete().eq("client_id", clientId).eq("root_id", root);
    },
  };
}

// ─── The Ad Creative folder ───────────────────────────────────────────────────────────────────────────────────────

class NoFolder extends Error {}

/** The ticket's plain message when the client has no Drive folder: the file stays in Kaizen Ads, nothing stray is made */
const NO_DRIVE_TEXT = `${NO_DRIVE}. The file is saved here; add their Drive folder on the client page and it's copied over.`;

/**
 * The client's Ad Creatives folder: the one set by hand on the client page (remembered per client), one found earlier,
 * or looked for now in their Drive folder ("20 - Ad Creatives", one level down too), and made there when they have
 * none. No Drive folder at all: nothing is made anywhere, the ticket says Drive isn't connected.
 */
async function adCreativeRoot(admin: SupabaseClient, clientId: string) {
  const { data: c } = await admin.from("clients").select("drive_folder_id, ad_creative_folder_id").eq("id", clientId).maybeSingle();
  const plan = rootPlan(c as { ad_creative_folder_id: string | null; drive_folder_id: string | null } | null);
  if ("use" in plan) return plan.use;
  if ("noDrive" in plan) throw new NoFolder(NO_DRIVE_TEXT);
  let found: string;
  try {
    found = (await ensureAdCreative(folderDrive, plan.lookIn)).id;
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) throw new NoFolder(`${NO_DRIVE}: Kaizen's Drive account can't open their Drive folder. Share it, or set the Ad Creatives folder on the client page.`);
    throw e;
  }
  // Only if nobody set one by hand meanwhile
  await admin.from("clients").update({ ad_creative_folder_id: found, ad_creative_folder_source: "found" }).eq("id", clientId).is("ad_creative_folder_id", null);
  const { data: now } = await admin.from("clients").select("ad_creative_folder_id").eq("id", clientId).maybeSingle();
  return (now?.ad_creative_folder_id as string | null) ?? found;
}

// ─── What should be in Drive ──────────────────────────────────────────────────────────────────────────────────────

type FileRow = { id: string; design_id: string; version_id: string; original_name: string; mime: string; bytes: number; aspect: string | null; card: number | null; path: string };
type SlotRow = {
  id: string;
  client_id: string;
  request_id: string | null;
  design_id: string;
  slot: string;
  op: "upload" | "retire";
  status: string;
  want_file_id: string | null;
  synced_file_id: string | null;
  synced_bytes: number | null;
  synced_name: string | null;
  drive_file_id: string | null;
  drive_url: string | null;
  attempts: number;
  locked_at: string | null;
  retired_at: string | null;
  drive_name?: string | null;
  drive_path?: string | null;
};

type RequestPlace = { id: string; number: number; title: string | null; created_at: string };
const PLACE_COLUMNS = "id, number, title, created_at";

/** Where a ticket's creative lives under Ad Creatives: its year, month and "#1234 Title" folder */
function placeOf(root: string, r: RequestPlace) {
  return { title: r.title ?? "", steps: ticketSteps(folderDrive, root, { createdAt: r.created_at, number: r.number, title: r.title }), path: ticketPath(r.created_at, r.number) };
}

/**
 * Lines a design's Drive files up with what's on the ticket now: each file of its current version wanted in its slot
 * (a new round: the same Drive file gets a new revision), and a slot with nothing current anymore (the design or the file
 * deleted, or a round without that size) moved to _Replaced. Mid-upload (a version with no files yet) waits.
 */
export async function resyncDesign(admin: SupabaseClient, designId: string) {
  const [{ data: d }, { data: slots }] = await Promise.all([
    admin.from("designs").select("id, client_id, request_id, current_version, requests(deleted_at)").eq("id", designId).maybeSingle(),
    admin.from("creative_drive_files").select("id, slot, op, status, want_file_id, synced_file_id").eq("design_id", designId),
  ]);
  const now = new Date().toISOString();
  const rows = (slots ?? []) as Pick<SlotRow, "id" | "slot" | "op" | "status" | "want_file_id" | "synced_file_id">[];
  // Not already in _Replaced, nor on its way there
  const live = (r: (typeof rows)[number]) => r.status !== "retired" && !(r.op === "retire" && (r.status === "pending" || r.status === "syncing"));
  const retire = async (ids: string[]) => {
    if (ids.length) await admin.from("creative_drive_files").update({ op: "retire", status: "pending", attempts: 0, error: null, error_kind: null, next_attempt_at: now, updated_at: now }).in("id", ids);
  };

  if (!d || (d.requests as unknown as { deleted_at: string | null } | null)?.deleted_at) {
    // The design is gone: everything it had in Drive goes to _Replaced
    await retire(rows.filter(live).map((r) => r.id));
    return;
  }
  const { data: v } = await admin.from("design_versions").select("id").eq("design_id", designId).eq("version", d.current_version).maybeSingle();
  if (!v) return;
  const { data: files } = await admin.from("design_files").select("id, original_name, aspect, card").eq("version_id", v.id);
  if (!files?.length) return;

  const want = new Map<string, string>();
  for (const f of files as { id: string; original_name: string; aspect: string | null; card: number | null }[]) want.set(slotOf(f), f.id);
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const upserts = [];
  for (const [slot, fileId] of want) {
    const r = bySlot.get(slot);
    if (r && r.op === "upload" && r.want_file_id === fileId && r.status !== "error") continue; // already wanted (or there)
    upserts.push({ client_id: d.client_id, request_id: d.request_id, design_id: designId, slot, op: "upload", status: "pending", want_file_id: fileId, attempts: 0, error: null, error_kind: null, next_attempt_at: now, updated_at: now });
  }
  if (upserts.length) await admin.from("creative_drive_files").upsert(upserts, { onConflict: "design_id,slot" });
  await retire(rows.filter((r) => !want.has(r.slot) && live(r)).map((r) => r.id));
}

/** Files that stopped on an error (no folder, no access) try again now: after the folder is set or access allowed */
export async function retryErrors(admin: SupabaseClient, clientId: string | null) {
  const now = new Date().toISOString();
  let q = admin.from("creative_drive_files").update({ status: "pending", attempts: 0, error: null, error_kind: null, next_attempt_at: now, updated_at: now }).eq("status", "error");
  if (clientId) q = q.eq("client_id", clientId);
  await q;
}

/** Every design of a client (or of every client) lined up for Drive: the backfill. Returns how many designs. */
export async function queueBackfill(admin: SupabaseClient, clientId: string | null) {
  await retryErrors(admin, clientId);
  let q = admin.from("designs").select("id, requests!inner(deleted_at)").is("requests.deleted_at", null).order("created_at", { ascending: true }).limit(5000);
  if (clientId) q = q.eq("client_id", clientId);
  const { data } = await q;
  const ids = (data ?? []).map((d) => d.id as string);
  for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map((id) => resyncDesign(admin, id)));
  return ids.length;
}

// ─── Doing it ─────────────────────────────────────────────────────────────────────────────────────────────────────

const STUCK_MS = 15 * 60_000;

/**
 * Works the queue: due rows (new, retrying, or stuck mid-sync past 15 minutes), oldest first, until the time is up.
 * Scoped to one design or client when an upload or the backfill kicks it off; the schedule does everything.
 */
export async function processDriveQueue(admin: SupabaseClient, opts: { designId?: string; clientId?: string; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  const out = { synced: 0, retired: 0, failed: 0, skipped: 0 };
  if (!driveWriteConfigured()) {
    // Say so on every waiting file, once, instead of "Syncing…" forever
    let q = admin.from("creative_drive_files").update({ status: "error", error_kind: "no_access", error: "Drive isn't connected (GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_USER)" }).eq("status", "pending");
    if (opts.designId) q = q.eq("design_id", opts.designId);
    if (opts.clientId) q = q.eq("client_id", opts.clientId);
    await q;
    return { ...out, note: "Drive isn't connected" };
  }
  const now = new Date();
  let q = admin
    .from("creative_drive_files")
    .select("*")
    .or(`and(status.eq.pending,next_attempt_at.lte.${now.toISOString()}),and(status.eq.syncing,locked_at.lt.${new Date(now.getTime() - STUCK_MS).toISOString()})`)
    .order("next_attempt_at", { ascending: true })
    .limit(opts.limit ?? 40);
  if (opts.designId) q = q.eq("design_id", opts.designId);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  const { data: due } = await q;
  const noFolder = new Map<string, string>(); // clients found to have no Drive or Ad Creatives folder this run, and why

  for (const row of (due ?? []) as SlotRow[]) {
    if (Date.now() - started > budget) break;
    // Claim it (two runs never work the same row)
    let claim = admin.from("creative_drive_files").update({ status: "syncing", locked_at: new Date().toISOString() }).eq("id", row.id).eq("status", row.status);
    claim = row.locked_at ? claim.eq("locked_at", row.locked_at) : claim.is("locked_at", null);
    const { data: claimed } = await claim.select("id").maybeSingle();
    if (!claimed) continue;
    try {
      if (noFolder.has(row.client_id)) throw new NoFolder(noFolder.get(row.client_id));
      const r = row.op === "retire" ? await retireOne(admin, row) : await uploadOne(admin, row);
      out[r]++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.failed++;
      if (e instanceof NoFolder) {
        noFolder.set(row.client_id, message);
        await admin.from("creative_drive_files").update({ status: "error", error_kind: "no_folder", error: message, locked_at: null, updated_at: new Date().toISOString() }).eq("id", row.id);
        continue;
      }
      const c = classifyDriveError(message);
      const attempts = row.attempts + 1;
      const next = c.retry ? nextAttempt(attempts) : null;
      console.error("[creative-drive]", row.id, message);
      await admin
        .from("creative_drive_files")
        .update({
          status: next ? "pending" : "error",
          error_kind: c.kind,
          error: c.text,
          attempts,
          next_attempt_at: (next ?? new Date()).toISOString(),
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      // No access is the same for every file: stop rather than fail the rest one by one
      if (c.kind === "no_access") break;
    }
  }
  return out;
}

async function uploadOne(admin: SupabaseClient, row: SlotRow): Promise<"synced" | "skipped"> {
  const done = async (patch: Record<string, unknown> & { synced_file_id: string }) => {
    await admin
      .from("creative_drive_files")
      .update({ status: "synced", error: null, error_kind: null, attempts: 0, locked_at: null, updated_at: new Date().toISOString(), ...patch })
      .eq("id", row.id);
    // A newer round landed (or the file was deleted) while this one was copying: that goes next
    await admin
      .from("creative_drive_files")
      .update({ status: "pending", next_attempt_at: new Date().toISOString() })
      .eq("id", row.id)
      .or(`op.eq.retire,want_file_id.neq.${patch.synced_file_id}`);
  };
  const { data: f } = row.want_file_id ? await admin.from("design_files").select("id, design_id, version_id, original_name, mime, bytes, aspect, card, path").eq("id", row.want_file_id).maybeSingle() : { data: null };
  const file = f as FileRow | null;
  if (!file) {
    // The file went before it was copied: line the design up again (it may now want another file, or nothing)
    await admin.from("creative_drive_files").update({ status: row.drive_file_id ? "synced" : "retired", locked_at: null, updated_at: new Date().toISOString() }).eq("id", row.id);
    await resyncDesign(admin, row.design_id);
    return "skipped";
  }
  // A carousel's carried-over card is the same file as before: nothing to send
  if (row.drive_file_id && !row.retired_at && row.synced_bytes === file.bytes && row.synced_name === file.original_name) {
    await done({ synced_file_id: file.id });
    return "skipped";
  }
  if (file.bytes > MAX_BYTES) throw new Error(`Too large to copy to Drive automatically (${Math.round(file.bytes / 1e9)} GB): put it in Drive by hand`);

  const [{ data: d }, { data: r }, { data: c }] = await Promise.all([
    admin.from("designs").select("position").eq("id", file.design_id).single(),
    admin.from("requests").select(PLACE_COLUMNS).eq("id", row.request_id!).single(),
    admin.from("clients").select("name").eq("id", row.client_id).single(),
  ]);
  if (!d || !r || !c) throw new Error("The ticket or client isn't there anymore");

  const root = await adCreativeRoot(admin, row.client_id);
  const { title, steps, path } = placeOf(root, r as unknown as RequestPlace);
  const cache = folderCache(admin, row.client_id, root);
  let parent: string;
  try {
    parent = await ensureFolderPath(folderDrive, cache, root, steps);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      // The Ad Creative folder itself is gone or moved out of reach: look for it again next time
      await admin.from("clients").update({ ad_creative_folder_id: null, ad_creative_folder_source: null }).eq("id", row.client_id).eq("ad_creative_folder_source", "found");
      await cache.forget();
    }
    throw e;
  }

  const { data: blob, error } = await admin.storage.from(BUCKET).download(file.path);
  if (!blob) throw new Error(`Not in storage: ${error?.message ?? file.path}`);
  const bytes = blob;
  const name = driveFileName({ client: c.name as string, title, position: d.position as number, card: file.card, aspect: file.aspect, originalName: file.original_name, mime: file.mime });

  let uploaded: { id: string; webViewLink?: string } | null = null;
  if (row.drive_file_id && !row.retired_at) {
    try {
      const m = await drive.meta(row.drive_file_id);
      if (!m.trashed) {
        uploaded = await drive.upload({ fileId: row.drive_file_id, name, mime: file.mime, bytes });
        // Filed under an earlier layout (or the folder was set elsewhere since): the file follows
        if (m.parents?.length && !m.parents.includes(parent)) await drive.move(row.drive_file_id, parent, m.parents);
      }
    } catch (e) {
      if (!(e instanceof DriveError && e.status === 404)) throw e;
      uploaded = null; // deleted from Drive by hand: a new file
    }
  }
  if (!uploaded) {
    try {
      uploaded = await drive.upload({ parent, name, mime: file.mime, bytes });
    } catch (e) {
      // A cached folder deleted by hand: forget the cache and make the folders again next try
      if (e instanceof DriveError && e.status === 404) await cache.forget();
      throw e;
    }
  }
  await done({
    synced_file_id: file.id,
    synced_bytes: file.bytes,
    synced_name: file.original_name,
    drive_file_id: uploaded.id,
    drive_url: uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`,
    drive_name: name,
    drive_path: path,
    synced_at: new Date().toISOString(),
    retired_at: null,
  });
  return "synced";
}

/** Deleted on the ticket: into "_Replaced" next to where it was (never deleted) */
async function retireOne(admin: SupabaseClient, row: SlotRow): Promise<"retired" | "skipped"> {
  const finish = () =>
    admin.from("creative_drive_files").update({ status: "retired", retired_at: new Date().toISOString(), error: null, error_kind: null, attempts: 0, locked_at: null, updated_at: new Date().toISOString() }).eq("id", row.id);
  if (!row.drive_file_id || row.retired_at) {
    await finish();
    return "skipped";
  }
  let m;
  try {
    m = await drive.meta(row.drive_file_id);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      await finish();
      return "skipped";
    }
    throw e;
  }
  const from = m.parents ?? [];
  if (!from.length) {
    await finish();
    return "skipped";
  }
  const { id: replaced } = await findOrCreateFolder(folderDrive, from[0], REPLACED);
  if (!from.includes(replaced)) await drive.move(row.drive_file_id, replaced, from);
  await finish();
  return "retired";
}

// ─── Keeping files where the layout says ──────────────────────────────────────────────────────────────────────────

/**
 * Files already in Drive put where they belong now (Year / Month / "#1234 Title"): everything synced under an earlier
 * layout (Year / Month / Concept / Format, then Avatar / Angle / Concept) and any ticket whose title changed since (a
 * trigger clears drive_path, and the file is renamed). Each file is moved, never copied, re-uploaded or deleted; files
 * taken off the ticket go to "_Replaced" in their ticket folder. The earlier layout's top folders are left where they
 * are and listed, for someone to tidy by hand once they're empty.
 */
export async function relayoutDrive(admin: SupabaseClient, opts: { clientId?: string; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 120_000;
  const out = { moved: 0, renamed: 0, inPlace: 0, gone: 0, failed: 0, waiting: 0, oldFolders: [] as { client_id: string; path: string; folder_id: string }[] };
  if (!driveWriteConfigured()) return out;

  // Not checked yet (null), or filed under the avatar layout (anything but "2026/11/#1234")
  const due = (old: boolean) => {
    let q = admin
      .from("creative_drive_files")
      .select("id, client_id, request_id, design_id, status, synced_file_id, drive_file_id, drive_name, drive_path")
      .not("drive_file_id", "is", null)
      .in("status", ["synced", "retired"])
      .order("updated_at", { ascending: true })
      .limit(opts.limit ?? 500);
    // Not null and not "" (no ticket) either: SQL comparisons leave nulls out
    if (old) q = q.filter("drive_path", "neq", "").filter("drive_path", "not.like", "2___/__/#%");
    else q = q.is("drive_path", null);
    if (opts.clientId) q = q.eq("client_id", opts.clientId);
    return q;
  };
  const [{ data: fresh }, { data: earlier }] = await Promise.all([due(false), due(true)]);
  type Row = Pick<SlotRow, "id" | "client_id" | "request_id" | "design_id" | "status" | "synced_file_id" | "drive_file_id" | "drive_name" | "drive_path">;
  const list = [...(fresh ?? []), ...(earlier ?? [])].slice(0, opts.limit ?? 500) as Row[];
  /** The row, only if nothing changed meanwhile (an upload took it, or the ticket was edited again) */
  const update = (row: Row, patch: Record<string, unknown>) => {
    const q = admin.from("creative_drive_files").update(patch).eq("id", row.id);
    return row.drive_path == null ? q.is("drive_path", null) : q.eq("drive_path", row.drive_path);
  };

  const requestIds = [...new Set(list.map((r) => r.request_id).filter((x): x is string => Boolean(x)))];
  const clientIds = [...new Set(list.map((r) => r.client_id))];
  const fileIds = [...new Set(list.map((r) => r.synced_file_id).filter((x): x is string => Boolean(x)))];
  const designIds = [...new Set(list.map((r) => r.design_id))];
  const [{ data: reqs }, { data: clients }, { data: files }, { data: designs }] = await Promise.all([
    requestIds.length ? admin.from("requests").select(PLACE_COLUMNS).in("id", requestIds) : Promise.resolve({ data: [] }),
    clientIds.length ? admin.from("clients").select("id, name").in("id", clientIds) : Promise.resolve({ data: [] }),
    fileIds.length ? admin.from("design_files").select("id, original_name, mime, aspect, card").in("id", fileIds) : Promise.resolve({ data: [] }),
    designIds.length ? admin.from("designs").select("id, position").in("id", designIds) : Promise.resolve({ data: [] }),
  ]);
  const reqById = new Map(((reqs ?? []) as unknown as RequestPlace[]).map((r) => [r.id, r]));
  const clientName = new Map(((clients ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const fileById = new Map(((files ?? []) as { id: string; original_name: string; mime: string | null; aspect: string | null; card: number | null }[]).map((f) => [f.id, f]));
  const position = new Map(((designs ?? []) as { id: string; position: number }[]).map((d) => [d.id, d.position]));

  const places = new Map<string, ReturnType<typeof placeOf>>();
  const roots = new Map<string, string | null>(); // null: no Ad Creative folder, those wait
  for (const row of list) {
    if (Date.now() - started > budget) break;
    const r = row.request_id ? reqById.get(row.request_id) : undefined;
    if (!r) {
      // No ticket to place it by: left where it is, and not looked at again
      await update(row, { drive_path: "" });
      continue;
    }
    try {
      if (!roots.has(row.client_id)) {
        try {
          roots.set(row.client_id, await adCreativeRoot(admin, row.client_id));
        } catch (e) {
          if (!(e instanceof NoFolder)) throw e;
          roots.set(row.client_id, null);
        }
      }
      const root = roots.get(row.client_id);
      if (!root) {
        out.waiting++;
        continue;
      }
      if (!places.has(r.id)) places.set(r.id, placeOf(root, r));
      const place = places.get(r.id)!;
      const f = row.synced_file_id ? fileById.get(row.synced_file_id) : undefined;
      const pos = position.get(row.design_id);
      const name =
        f && pos != null && clientName.has(row.client_id)
          ? driveFileName({ client: clientName.get(row.client_id)!, title: place.title, position: pos, card: f.card, aspect: f.aspect, originalName: f.original_name, mime: f.mime })
          : null;
      const cache = folderCache(admin, row.client_id, root);
      const { result } = await relocateFile(moveDrive, cache, root, { fileId: row.drive_file_id!, steps: place.steps, replaced: row.status === "retired", name });
      if (result === "moved") out.moved++;
      else if (result === "renamed") out.renamed++;
      else if (result === "gone") out.gone++;
      else out.inPlace++;
      const renamed = name && (result === "moved" || result === "renamed") ? { drive_name: name } : {};
      await update(row, { drive_path: place.path, ...renamed }).eq("status", row.status);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.failed++;
      console.error("[creative-drive] relayout", row.id, message);
      // A cached folder deleted by hand: forget the cache, the folders are found or made again next run
      const root = roots.get(row.client_id);
      if (e instanceof DriveError && e.status === 404 && root) await folderCache(admin, row.client_id, root).forget();
      if (classifyDriveError(message).kind === "no_access") break;
    }
  }

  // The avatar layout's top folders: left in place (never deleted), listed so someone can tidy them by hand
  let old = admin.from("client_drive_folders").select("client_id, path, folder_id").not("path", "like", "%/%").limit(2000);
  if (opts.clientId) old = old.eq("client_id", opts.clientId);
  const { data: oldRows } = await old;
  out.oldFolders = ((oldRows ?? []) as { client_id: string; path: string; folder_id: string }[]).filter((f) => isOldLayoutPath(f.path)).slice(0, 100);
  return out;
}

/**
 * After the response: the designs' files copied into the client's Drive, a new round as a new revision of the same Drive
 * file, deleted files moved to _Replaced. What doesn't finish here (or fails) the schedule picks up with retries; the
 * upload never waits for Drive.
 */
export function driveAfterResponse(designIds: string[]) {
  if (!adminConfigured() || !designIds.length) return;
  after(async () => {
    const admin = createAdminClient();
    for (const id of designIds) {
      try {
        await resyncDesign(admin, id);
        await processDriveQueue(admin, { designId: id, budgetMs: 200_000 });
      } catch (e) {
        console.error("[creative-drive] after upload", id, e instanceof Error ? e.message : e);
      }
    }
  });
}

// ─── For the ticket and the client page ───────────────────────────────────────────────────────────────────────────

export type DriveState = { status: "synced" | "syncing" | "error"; url: string | null; error: string | null; kind: string | null; fixUrl?: string | null; fixLabel?: string | null };

/** Each file's Drive state, by design_files id: in Drive (with its link), syncing, or what went wrong */
export type DriveStateRow = Pick<SlotRow, "want_file_id" | "synced_file_id" | "status" | "drive_url" | "op" | "attempts"> & { error: string | null; error_kind: string | null };
export function driveStates(rows: DriveStateRow[]) {
  const out = new Map<string, DriveState>();
  for (const r of rows) {
    if (r.op === "retire") continue;
    if (r.want_file_id && r.want_file_id !== r.synced_file_id && (r.status === "pending" || r.status === "syncing"))
      out.set(r.want_file_id, { status: "syncing", url: r.drive_url, error: r.attempts ? r.error : null, kind: null });
    else if (r.want_file_id && r.status === "error") out.set(r.want_file_id, { status: "error", url: r.drive_url, error: r.error, kind: r.error_kind });
    else if (r.synced_file_id && (r.status === "synced" || r.status === "pending" || r.status === "syncing")) out.set(r.synced_file_id, { status: r.status === "synced" ? "synced" : "syncing", url: r.drive_url, error: null, kind: null });
  }
  return out;
}

/** A client's Drive sync at a glance, for the client page */
/**
 * Every client's Ad Creatives folder filled in on its own: the onboarding Zap makes it inside the client's Drive folder,
 * so once the Drive folder is known (from enrollment or the Drive sync), this finds it ("20 - Ad Creatives", one level
 * down too) and sets it on the client, the way a person would on the client page. Only found, never made here (an
 * upload makes one if a client truly has none), and never over a folder set by hand. Runs with the Drive queue.
 */
export async function fillAdCreativeFolders(admin: SupabaseClient, opts: { limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const { data } = await admin
    .from("clients")
    .select("id, drive_folder_id")
    .is("archived_at", null)
    .is("ad_creative_folder_id", null)
    .not("drive_folder_id", "is", null)
    .limit(500);
  // A different slice each run, so a client whose folder isn't there yet never holds up the rest
  const todo = (data ?? []).sort(() => Math.random() - 0.5).slice(0, opts.limit ?? 40);
  let found = 0;
  let missing = 0;
  let failed = 0;
  for (const c of todo) {
    if (Date.now() - started > (opts.budgetMs ?? 60_000)) break;
    try {
      const id = await locateAdCreative(folderDrive, c.drive_folder_id as string);
      if (!id) {
        missing++;
        continue;
      }
      const { error } = await admin.from("clients").update({ ad_creative_folder_id: id, ad_creative_folder_source: "found" }).eq("id", c.id).is("ad_creative_folder_id", null);
      if (error) failed++;
      else found++;
    } catch {
      failed++;
    }
  }
  return { checked: todo.length, found, missing, failed };
}

export async function clientDriveSummary(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, { data: rows }] = await Promise.all([
    admin.from("clients").select("drive_folder_id, ad_creative_folder_id, ad_creative_folder_source").eq("id", clientId).maybeSingle(),
    admin.from("creative_drive_files").select("status, op, error, error_kind").eq("client_id", clientId).limit(5000),
  ]);
  const list = rows ?? [];
  const errors = list.filter((r) => r.status === "error");
  return {
    folderId: (c?.ad_creative_folder_id as string | null) ?? null,
    source: (c?.ad_creative_folder_source as string | null) ?? null,
    hasClientFolder: Boolean(c?.drive_folder_id),
    synced: list.filter((r) => r.status === "synced").length,
    syncing: list.filter((r) => r.status === "pending" || r.status === "syncing").length,
    replaced: list.filter((r) => r.status === "retired").length,
    errors: errors.length,
    error: (errors[0]?.error as string | undefined) ?? null,
    errorKind: (errors[0]?.error_kind as string | undefined) ?? null,
    connected: driveWriteConfigured(),
  };
}
export type ClientDriveSummary = Awaited<ReturnType<typeof clientDriveSummary>>;

/** Check a pasted Ad Creative folder before saving it */
export async function checkFolder(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!driveWriteConfigured()) return { ok: true }; // can't check; saved as given
  try {
    const m = await drive.meta(id);
    if (m.mimeType !== FOLDER) return { ok: false, error: "That link is a file, not a folder." };
    if (m.trashed) return { ok: false, error: "That folder is in the Drive trash." };
    return { ok: true };
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) return { ok: false, error: `Kaizen's Drive account (${process.env.GOOGLE_DRIVE_USER}) can't open that folder. Share it with them first.` };
    const c = classifyDriveError(e instanceof Error ? e.message : String(e));
    return c.kind === "no_access" ? { ok: false, error: c.text } : { ok: true };
  }
}
