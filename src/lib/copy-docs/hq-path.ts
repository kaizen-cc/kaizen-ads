// Where approved copy goes in Drive. Our tree: the Clients root folder > "<Kaizen ID>-<Client name>" (the client's
// folder) > "<Client name>-Headquarters" > "Email Marketing" (or the social line's folder). Only that last folder is
// ever made, and only when it's missing; the client's folder and its Headquarters are never created: when they can't
// be found, the answer says so and asks for the Headquarters link (a pasted link is taken the same way). Names match
// loosely ("1234 - Ocean Box", "1234-OceanBox", "OceanBox - Headquarters", "Ocean Box HQ"). Pure apart from the Drive
// reads it is handed, so it's tested with a stand-in Drive.

import { folderIdOf } from "@/lib/creative-drive-paths";

/** Case, spaces, dashes, punctuation and "&"/"and" don't matter */
export const looseKey = (s: string) =>
  String(s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");

export type HqClient = { name: string; kaizenId: number | null };

const sameName = (a: string, b: string) => {
  const x = looseKey(a);
  const y = looseKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "OceanBox" and "OceanBox Co", "The Ocean Box": one starts with the other, long enough not to be a lead word
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && (long.startsWith(short) || long.endsWith(short)) && long.length - short.length <= 6;
};

/** The client's own folder: "<Kaizen ID>-<Client name>" (the ID must be theirs when we know it) */
export function isClientFolder(name: string, c: HqClient): boolean {
  const m = String(name ?? "").match(/^\s*#?\s*(\d{1,7})\s*[-\u2013\u2014_:.|]*\s*(.+?)\s*$/);
  if (!m) return false;
  if (c.kaizenId != null && Number(m[1]) !== Number(c.kaizenId)) return false;
  return sameName(m[2], c.name);
}

/** The client's Headquarters folder: "<Client name>-Headquarters" (or "Headquarters"/"HQ" alone, inside their folder) */
export function isHqFolder(name: string, c: Pick<HqClient, "name">): boolean {
  const k = looseKey(name).replace(/^\d+/, "");
  const tail = k.endsWith("headquarters") ? "headquarters" : k.endsWith("hq") ? "hq" : null;
  if (!tail) return false;
  const lead = k.slice(0, -tail.length);
  return !lead || sameName(lead, c.name);
}

export type HqDrive = {
  listFolders(parent: string): Promise<{ id: string; name: string }[]>;
  folderName(id: string): Promise<string>;
};

export type HqInput = {
  client: HqClient;
  /** A link or ID the person pasted this turn: tried first */
  pasted?: string | null;
  /** The client's stored HQ links or IDs (the account sheet's tabs), best first */
  stored?: (string | null | undefined)[];
  /** The client's own folder (clients.drive_folder_id) */
  clientFolder?: string | null;
  /** The Clients root folder (GOOGLE_SHARED_DRIVE_ID) */
  root?: string | null;
};

export type HqResult = { ok: true; id: string; name: string; via: "pasted" | "stored" | "client_folder" | "root" } | { ok: false; error: string; askForLink: true };

const idOf = (v: string | null | undefined) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^https?:/i.test(s) && !/drive\.google\.com|docs\.google\.com/i.test(s)) return null;
  const id = folderIdOf(s);
  return /^[\w-]{10,}$/.test(id) ? id : null;
};

/** Finds the client's Headquarters folder; never makes a folder */
export async function findHq(drive: HqDrive, input: HqInput): Promise<HqResult> {
  const c = input.client;
  const safeName = async (id: string) => drive.folderName(id).catch(() => null);
  const safeList = async (id: string) => drive.listFolders(id).catch(() => [] as { id: string; name: string }[]);
  const hqIn = async (parent: string) => (await safeList(parent)).find((f) => isHqFolder(f.name, c)) ?? null;
  let pastedWrong: string | null = null;

  /** A link given or stored: the HQ itself, or the client's folder with the HQ in it */
  const fromLink = async (raw: string | null | undefined, via: "pasted" | "stored"): Promise<HqResult | null> => {
    const id = idOf(raw);
    if (!id) return null;
    const name = await safeName(id);
    if (name == null) {
      if (via === "pasted") pastedWrong = "Drive won't open that link (share it with the Kaizen Drive user, or check it's a folder link)";
      return null;
    }
    if (isHqFolder(name, c)) return { ok: true, id, name, via };
    if (isClientFolder(name, c)) {
      const hq = await hqIn(id);
      if (hq) return { ok: true, id: hq.id, name: hq.name, via };
    }
    // A pasted link named like nothing we know: its own Headquarters child, else taken as given (they chose it)
    if (via === "pasted") {
      const hq = await hqIn(id);
      if (hq) return { ok: true, id: hq.id, name: hq.name, via };
      if (/headquarters|\bhq\b/i.test(name)) return { ok: true, id, name, via };
      pastedWrong = `That link is the folder "${name}", not ${c.name}'s Headquarters`;
    }
    return null;
  };

  const pasted = await fromLink(input.pasted, "pasted");
  if (pasted) return pasted;
  for (const s of input.stored ?? []) {
    const hit = await fromLink(s, "stored");
    if (hit) return hit;
  }
  const own = idOf(input.clientFolder);
  if (own) {
    const name = await safeName(own);
    if (name != null && isHqFolder(name, c)) return { ok: true, id: own, name, via: "client_folder" };
    if (name != null) {
      const hq = await hqIn(own);
      if (hq) return { ok: true, id: hq.id, name: hq.name, via: "client_folder" };
    }
  }
  const root = idOf(input.root);
  if (root) {
    const folders = (await safeList(root)).filter((f) => isClientFolder(f.name, c));
    for (const f of folders) {
      const hq = await hqIn(f.id);
      if (hq) return { ok: true, id: hq.id, name: hq.name, via: "root" };
    }
  }
  const where = `Clients > "${c.kaizenId ?? "<ID>"}-${c.name}" > "${c.name}-Headquarters"`;
  return {
    ok: false,
    askForLink: true,
    error: `${pastedWrong ? `${pastedWrong}. ` : ""}I couldn't find ${c.name}'s Headquarters folder in Drive (${where}), and I don't create the client or Headquarters folders. Paste the link to their Headquarters folder and I'll put it there.`,
  };
}

/** The folder under the HQ for a line: email "Email Marketing"; social the team's own ("Organic Social", "Social Media"), else "Organic Social" */
export function lineFolderStep(line: string | undefined, folder: string) {
  if (line === "social") {
    const names = ["organicsocial", "organicsocialmedia", "socialmedia", "social", "organic"];
    return { key: "Organic Social", match: (n: string) => names.includes(looseKey(n).replace(/^\d+/, "")), name: () => "Organic Social" };
  }
  const want = looseKey(folder);
  return { key: folder, match: (n: string) => looseKey(n).replace(/^\d+/, "") === want, name: () => folder };
}
