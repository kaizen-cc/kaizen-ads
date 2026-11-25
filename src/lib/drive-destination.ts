import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveQuote, parseFolderRef } from "./drive-push-core";
import { candidatesLine, confirmLine, destinationClientKey, nextStep, pathText, sameFolderName, subPath, type Destination, type DestinationKey } from "./drive-destination-core";

// The Drive side of the destination rule (src/lib/drive-destination-core.ts), one helper for every tool that saves or
// moves a file in Drive (the assistant, Kaizen AI, the agents, Kaizen documents' filing):
//   findDestination(): the folder the person named, as them (their own Drive rights decide what's found), with its
//     whole path from the drive's root; candidates when several match; "not found" said plainly. mode "preview" finds
//     the parent of a missing last subfolder and reports willCreate (nothing made); "make" makes it; "find" never makes.
//   ensureDestination(): makes a previewed folder, after the yes.
//   destinationForSave(): the whole rule before a save from a conversation (named → saved; remembered → one quick
//     confirm; nothing → ask).
//   backgroundDestination(): background work (a cron, a job) saves only into a remembered folder, never a guess.
//   moveToDestination(): moving a filed file goes through the same rule.
//   recallDestination() / rememberDestination(): the folder confirmed per person, client (or prospect) and document kind.

const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const ALL = { supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" };
type Item = { id: string; name: string; webViewLink?: string; parents?: string[]; driveId?: string; mimeType?: string };

export async function driveTokenAs(email: string) {
  const { googleConfigured, googleTokenFor } = await import("@/lib/context/google");
  if (!googleConfigured()) throw new Error("Google isn't connected to Kaizen OS yet.");
  return googleTokenFor(email, "https://www.googleapis.com/auth/drive");
}

async function get<T>(token: string, path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${DRIVE}/${path}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Drive said no (${res.status}).`);
  return (await res.json()) as T;
}

const FIELDS = "id, name, mimeType, webViewLink, parents, driveId";
const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** A folder by id, or a shared drive by its id (its root folder, named as the drive) */
async function folderById(token: string, id: string): Promise<Item | null> {
  const f = await get<Item>(token, `files/${id}`, { supportsAllDrives: "true", fields: FIELDS }).catch(() => null);
  if (f && f.driveId && f.id === f.driveId) {
    const d = await get<{ name: string }>(token, `drives/${id}`, {}).catch(() => null);
    return { ...f, name: d?.name ?? f.name, mimeType: FOLDER };
  }
  if (f) return f;
  const d = await get<{ id: string; name: string }>(token, `drives/${id}`, {}).catch(() => null);
  return d ? { id: d.id, name: d.name, driveId: d.id, mimeType: FOLDER, webViewLink: folderLink(d.id) } : null;
}

/** A folder seen as the person: its name, link, whole path and the ids above it (nearest first), or null */
export async function folderWhere(email: string, id: string): Promise<{ id: string; name: string; link: string; path: string[]; ancestors: string[] } | null> {
  const token = await driveTokenAs(email);
  const f = await folderById(token, id);
  if (!f) return null;
  const ancestors: string[] = [];
  let cur: Item | null = f;
  for (let i = 0; i < 12 && cur?.parents?.length; i++) {
    ancestors.push(cur.parents[0]);
    cur = await folderById(token, cur.parents[0]);
  }
  return { id: f.id, name: f.name, link: f.webViewLink ?? folderLink(f.id), path: await fullPath(token, f), ancestors };
}

/** Moves a file or folder (as the person) from its parents into another folder */
export async function moveInto(email: string, fileId: string, folderId: string): Promise<void> {
  const token = await driveTokenAs(email);
  const f = await get<{ parents?: string[] }>(token, `files/${fileId}`, { supportsAllDrives: "true", fields: "parents" });
  const params = new URLSearchParams({ supportsAllDrives: "true", addParents: folderId, fields: "id" });
  const old = (f.parents ?? []).filter((p) => p !== folderId);
  if (old.length) params.set("removeParents", old.join(","));
  const res = await fetch(`${DRIVE}/files/${fileId}?${params}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", cache: "no-store" });
  if (!res.ok) throw new Error(`Drive wouldn't move it (${res.status}).`);
}

/** The files and folders directly inside a folder */
export async function childrenOf(email: string, folderId: string): Promise<{ id: string; name: string; mimeType: string }[]> {
  const token = await driveTokenAs(email);
  const r = await get<{ files?: { id: string; name: string; mimeType: string }[] }>(token, "files", { ...ALL, q: `'${folderId.replace(/'/g, "")}' in parents and trashed = false`, fields: "files(id, name, mimeType)", pageSize: "200" });
  return r.files ?? [];
}

/** The folder's whole path, from its drive's root ("Shared drives › Kaizen HQ › …" or "My Drive › …") */
async function fullPath(token: string, f: Item): Promise<string[]> {
  if (f.driveId && f.id === f.driveId) return ["Shared drives", f.name];
  const names = [f.name];
  let cur = f;
  for (let i = 0; i < 12 && cur.parents?.length; i++) {
    const up = await folderById(token, cur.parents[0]);
    if (!up) break;
    if (up.driveId && up.id === up.driveId) {
      names.unshift("Shared drives", up.name);
      return names;
    }
    if (!up.parents?.length) {
      names.unshift("My Drive");
      return names;
    }
    names.unshift(up.name);
    cur = up;
  }
  return names;
}

async function children(token: string, parentId: string, name: string): Promise<Item[]> {
  const r = await get<{ files?: Item[] }>(token, "files", { ...ALL, q: `${driveQuote(parentId)} in parents and name = ${driveQuote(name)} and mimeType = '${FOLDER}' and trashed = false`, fields: `files(${FIELDS})`, pageSize: "5" });
  if (r.files?.length) return r.files;
  // The same name written differently ("08-Kaizen Content" for "08 - Kaizen Content"): only an exact match once
  // spacing, dashes and case are set aside, never a nearby name
  const all = await get<{ files?: Item[] }>(token, "files", { ...ALL, q: `${driveQuote(parentId)} in parents and mimeType = '${FOLDER}' and trashed = false`, fields: `files(${FIELDS})`, pageSize: "200" }).catch(() => ({ files: [] as Item[] }));
  return (all.files ?? []).filter((f) => sameFolderName(f.name, name));
}

async function makeFolder(token: string, parentId: string, name: string): Promise<Item> {
  const res = await fetch(`${DRIVE}/files?supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) });
  if (!res.ok) throw new Error(`Couldn't make the folder "${name}" (Drive said ${res.status}).`);
  return (await res.json()) as Item;
}

/** Walks the names below a folder; only the last one may be missing (reported, or made when `make`) */
async function walk(token: string, from: Item, names: string[], make: boolean): Promise<{ item: Item; made: boolean } | { missing: string; under: Item; last: boolean }> {
  let cur = from;
  for (let i = 0; i < names.length; i++) {
    const hit = await children(token, cur.id, names[i]);
    if (hit.length) {
      cur = hit[0];
      continue;
    }
    const last = i === names.length - 1;
    if (make && last) return { item: await makeFolder(token, cur.id, names[i]), made: true };
    return { missing: names[i], under: cur, last };
  }
  return { item: cur, made: false };
}

export type Found = { dest: Destination } | { ask: Destination[]; say: string } | { notFound: string };
export type FindMode = "find" | "preview" | "make";

/**
 * The folder they named (a link, "id:<folder or shared drive id>", or a path whose first part is a shared drive or
 * any folder they can reach), then `below` inside it ("08-Kaizen Content/Case Studies"). Only the last name of
 * `below` may be missing: "find" says not found, "preview" returns its parent with willCreate (nothing made), "make"
 * makes it. Never a guess: several matches come back as candidates.
 */
export async function findDestination(email: string, named: string, below?: string | null, mode: FindMode = "find"): Promise<Found> {
  const ref = parseFolderRef(named);
  if (!ref) return { notFound: "Which folder? Paste its Drive link, or say its path (Shared drive/Folder/Subfolder)." };
  const token = await driveTokenAs(email);
  const rest = subPath(below);
  let starts: { item: Item; names: string[] }[] = [];
  if ("root" in ref) {
    // Their own My Drive, top level (they asked for it); a subfolder under it as for any folder
    const r = await folderById(token, "root");
    if (!r) return { notFound: "I couldn't open your My Drive." };
    const top: Item = { ...r, name: "My Drive", parents: [], webViewLink: "https://drive.google.com/drive/my-drive" };
    if (!rest.length) return { dest: { id: r.id, path: ["My Drive"], link: top.webViewLink ?? null, root: true } };
    starts = [{ item: top, names: rest }];
  } else if ("id" in ref) {
    const f = await folderById(token, ref.id);
    if (!f || f.mimeType !== FOLDER) return { notFound: "That link isn't a Drive folder you can reach (check it's a folder link and shared with you)." };
    starts = [{ item: f, names: rest }];
  } else {
    const [first, ...tail] = ref.path;
    const [drives, folders] = await Promise.all([
      get<{ drives?: { id: string; name: string }[] }>(token, "drives", { pageSize: "10", q: `name = ${driveQuote(first)}` }).catch(() => ({ drives: [] })),
      get<{ files?: Item[] }>(token, "files", { ...ALL, q: `name = ${driveQuote(first)} and mimeType = '${FOLDER}' and trashed = false`, fields: `files(${FIELDS})`, pageSize: "10" }).catch(() => ({ files: [] })),
    ]);
    starts = [
      ...(drives.drives ?? []).map((d) => ({ item: { id: d.id, name: d.name, driveId: d.id, mimeType: FOLDER, webViewLink: folderLink(d.id) } as Item, names: [...tail, ...rest] })),
      ...(folders.files ?? []).map((f) => ({ item: f, names: [...tail, ...rest] })),
    ];
    if (!starts.length) return { notFound: `No folder or shared drive called "${first}" that you can reach in Drive. Paste the folder's link.` };
  }
  // Walk every start without making anything, so a match is known before anything is made
  const full: Item[] = [];
  const near: { under: Item; name: string }[] = [];
  let why = "";
  for (const s of starts.slice(0, 6)) {
    const w = await walk(token, s.item, s.names, false);
    if ("item" in w) full.push(w.item);
    else if (mode !== "find" && w.last) near.push({ under: w.under, name: w.missing });
    else why = `"${w.under.name}" has no folder called "${w.missing}".`;
  }
  const dest = async (f: Item, made = false): Promise<Destination> => ({ id: f.id, path: await fullPath(token, f), link: f.webViewLink ?? folderLink(f.id), made });
  if (full.length > 1) {
    const ask = await Promise.all(full.slice(0, 5).map((f) => dest(f)));
    return { ask, say: candidatesLine(ask) };
  }
  if (full.length === 1) return { dest: await dest(full[0]) };
  if (near.length > 1) {
    const ask = await Promise.all(near.slice(0, 5).map(async (n) => ({ ...(await dest(n.under)), willCreate: { parentId: n.under.id, name: n.name } })));
    return { ask: ask.map((a) => ({ ...a, path: [...a.path, a.willCreate.name] })), say: candidatesLine(ask.map((a) => ({ ...a, path: [...a.path, `${a.willCreate.name} (new)`] }))) };
  }
  if (near.length === 1) {
    const n = near[0];
    if (mode === "make") return { dest: await dest(await makeFolder(token, n.under.id, n.name), true) };
    const parent = await dest(n.under);
    return { dest: { id: "", path: [...parent.path, n.name], link: parent.link, willCreate: { parentId: n.under.id, name: n.name } } };
  }
  return { notFound: why || "That folder wasn't found in your Drive. Paste its link." };
}

/** Makes a previewed folder (willCreate) once they said yes; a found folder comes back as it is */
export async function ensureDestination(email: string, d: Destination): Promise<Destination> {
  if (!d.willCreate) return d;
  const token = await driveTokenAs(email);
  // Made meanwhile by someone else: use it rather than a second one
  const had = (await children(token, d.willCreate.parentId, d.willCreate.name))[0];
  const f = had ?? (await makeFolder(token, d.willCreate.parentId, d.willCreate.name));
  return { id: f.id, path: d.path, link: f.webViewLink ?? folderLink(f.id), made: !had };
}

/** The folder this person confirmed last time for this client (or prospect) and kind of document */
export async function recallDestination(admin: SupabaseClient, key: DestinationKey): Promise<Destination | null> {
  const { data } = await admin.from("drive_destinations").select("folder_id, path, link").eq("profile_id", key.profileId).eq("client_key", destinationClientKey(key)).eq("doc_type", key.docType).maybeSingle();
  return data ? { id: String(data.folder_id), path: (data.path as string[]) ?? [], link: (data.link as string | null) ?? null } : null;
}

/** Remembers the folder they used, for the next "Saving to <path>, OK?" (a previewed folder is remembered once made) */
export async function rememberDestination(admin: SupabaseClient, key: DestinationKey, d: Destination) {
  if (!d.id || d.willCreate) return;
  await admin.from("drive_destinations").upsert(
    { profile_id: key.profileId, client_id: key.clientId, client_key: destinationClientKey(key), prospect: key.clientId ? null : (key.prospect?.trim() ?? null), doc_type: key.docType, folder_id: d.id, path: d.path, link: d.link, confirmed_at: new Date().toISOString() },
    { onConflict: "profile_id,client_key,doc_type" },
  );
}

/** Background work (a cron, a queued job) with nobody to ask: only a remembered folder, never a guess; null means skip and ask the person */
export const backgroundDestination = (admin: SupabaseClient, key: DestinationKey) => recallDestination(admin, key);

export type ForSave = { save: Destination } | { reply: Record<string, unknown> };

/**
 * Before any save into Drive from a conversation: the folder named in this conversation (found, or the candidates,
 * or "not found"; its last subfolder made), else the remembered one as a quick confirm (confirmed: true once they
 * said yes), else ask which folder. `reply` goes straight back to the model; `save` is the folder to write into.
 */
export async function destinationForSave(admin: SupabaseClient, o: { email: string; key: DestinationKey; folder?: unknown; subfolder?: unknown; confirmed?: unknown }): Promise<ForSave> {
  const named = typeof o.folder === "string" ? o.folder.trim().slice(0, 500) : "";
  const below = typeof o.subfolder === "string" ? o.subfolder.trim().slice(0, 200) : "";
  const remembered = named ? null : await recallDestination(admin, o.key);
  const step = nextStep({ named, remembered, confirmed: o.confirmed === true });
  if (step.step === "ask_folder") return { reply: { saved: false, needs_folder: true, note: "Ask which Drive folder to save it in (its link, or its path like Shared drive/Folder; \"my drive\" is the top level of their My Drive). Never pick one yourself, and never My Drive unless they ask for it." } };
  if (step.step === "confirm_remembered") return { reply: { saved: false, needs_yes: true, destination: { path: pathText(step.dest.path), link: step.dest.link }, say: confirmLine(step.dest), note: "Ask exactly that once; on their yes call again with confirmed: true (or with the folder they name instead)." } };
  if (step.step === "use_remembered") return { save: step.dest };
  const found = await findDestination(o.email, named, below, below ? "make" : "find");
  // My Drive's top level, when they asked for it: confirmed once like a remembered folder
  if ("dest" in found && found.dest.root && o.confirmed !== true) return { reply: { saved: false, needs_yes: true, destination: { path: pathText(found.dest.path), link: found.dest.link }, say: confirmLine(found.dest), note: "Ask exactly that once; on their yes call again with the same folder and confirmed: true." } };
  if ("dest" in found) return { save: found.dest };
  if ("ask" in found) return { reply: { saved: false, candidates: found.ask.map((d) => ({ path: pathText(d.path), link: d.link })), say: found.say, note: "Ask which one; call again with that folder's link." } };
  return { reply: { saved: false, folder_not_found: true, say: found.notFound } };
}

/** Moves a file already in Drive into a destination the rule settled on (named, confirmed or remembered), as the person */
export async function moveToDestination(email: string, fileId: string, d: Destination): Promise<{ id: string; link: string | null; dest: Destination }> {
  const dest = await ensureDestination(email, d);
  const token = await driveTokenAs(email);
  const f = await get<{ parents?: string[] }>(token, `files/${fileId}`, { supportsAllDrives: "true", fields: "parents" });
  const params = new URLSearchParams({ supportsAllDrives: "true", addParents: dest.id, fields: "id, webViewLink" });
  const old = (f.parents ?? []).filter((p) => p !== dest.id);
  if (old.length) params.set("removeParents", old.join(","));
  const res = await fetch(`${DRIVE}/files/${fileId}?${params}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(`Drive wouldn't move the file (${res.status}).`);
  const out = (await res.json()) as { id: string; webViewLink?: string };
  return { id: out.id, link: out.webViewLink ?? null, dest };
}
