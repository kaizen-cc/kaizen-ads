import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { AI_BUCKET } from "@/lib/kaizen-ai/files";
import { channelMaySee } from "@/lib/kaizen-ai/channel-access";
import { isChannelOnly } from "@/lib/roles";
import { servicesOf } from "@/lib/services";

// Where Kaizen AI's email designs are kept: in the private ai-files bucket, one folder per design
// (email-designs/<id>/), holding what it is (meta.json: the client, the title, every version with its subject,
// preheader and what changed) and each version's production HTML (v1.html, v2.html...). Pictures placed in it are
// copied next to it (img/) and linked with year-long signed addresses, so the email shows them wherever it's opened.
// Each person's recent designs are listed in email-designs/by/<profile id>.json, so "make the hero bigger" finds the
// last one. No table: a design is a few files, and the bucket's rules already keep them private.

const ROOT = "email-designs";
const YEAR = 365 * 86_400;

export type DesignVersion = {
  n: number;
  at: string;
  /** The layout's name ("Hero first", "Editorial", "Product grid") */
  name: string;
  /** Why it's built this way, or what changed from the version before */
  note: string;
  subject: string | null;
  preheader: string | null;
  /** What the person asked for (a revision) */
  ask?: string | null;
};

export type DesignMeta = {
  id: string;
  owner: string;
  clientId: string | null;
  clientName: string | null;
  title: string;
  createdAt: string;
  /** Designs made together as layout options share a group (the first one's id) */
  group: string;
  versions: DesignVersion[];
};

type IndexRow = { id: string; clientId: string | null; title: string; at: string };

const metaPath = (id: string) => `${ROOT}/${id}/meta.json`;
const htmlPath = (id: string, n: number) => `${ROOT}/${id}/v${n}.html`;
const indexPath = (owner: string) => `${ROOT}/by/${owner}.json`;

async function readJson<T>(admin: SupabaseClient, path: string): Promise<T | null> {
  const { data } = await admin.storage.from(AI_BUCKET).download(path);
  if (!data) return null;
  try {
    return JSON.parse(await data.text()) as T;
  } catch {
    return null;
  }
}

async function writeFile(admin: SupabaseClient, path: string, body: string | Buffer, contentType: string) {
  const { error } = await admin.storage.from(AI_BUCKET).upload(path, typeof body === "string" ? Buffer.from(body, "utf8") : body, { contentType, upsert: true });
  if (error) throw new Error(`The design couldn't be saved: ${error.message}`);
}

export const loadDesign = (admin: SupabaseClient, id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? readJson<DesignMeta>(admin, metaPath(id)) : Promise.resolve(null));

export async function loadDesignHtml(admin: SupabaseClient, id: string, n: number): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(n) || n < 1) return null;
  const { data } = await admin.storage.from(AI_BUCKET).download(htmlPath(id, n));
  return data ? data.text() : null;
}

/** Saves a version (a new design when meta has one version) and lists it in the owner's recent designs */
export async function saveVersion(admin: SupabaseClient, meta: DesignMeta, html: string) {
  const v = meta.versions.at(-1)!;
  await writeFile(admin, htmlPath(meta.id, v.n), html, "text/html; charset=utf-8");
  await writeFile(admin, metaPath(meta.id), JSON.stringify(meta), "application/json");
  const list = ((await readJson<IndexRow[]>(admin, indexPath(meta.owner))) ?? []).filter((r) => r.id !== meta.id);
  list.unshift({ id: meta.id, clientId: meta.clientId, title: meta.title, at: v.at });
  await writeFile(admin, indexPath(meta.owner), JSON.stringify(list.slice(0, 60)), "application/json").catch(() => null);
}

/** The person's newest design (for this client when one is given) */
export async function latestDesign(admin: SupabaseClient, owner: string, clientId: string | null): Promise<DesignMeta | null> {
  const list = (await readJson<IndexRow[]>(admin, indexPath(owner))) ?? [];
  const hit = list.find((r) => !clientId || r.clientId === clientId) ?? null;
  return hit ? loadDesign(admin, hit.id) : null;
}

/** A picture copied next to the design, with an address that works in any inbox for a year */
export async function hostImage(admin: SupabaseClient, id: string, bytes: Buffer, mime: string, name: string): Promise<string> {
  const ext = (mime.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  const path = `${ROOT}/${id}/img/${name.replace(/[^\w-]+/g, "-").slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await writeFile(admin, path, bytes, mime);
  const { data, error } = await admin.storage.from(AI_BUCKET).createSignedUrl(path, YEAR);
  if (error || !data) throw new Error("The picture was saved but couldn't be linked.");
  return data.signedUrl;
}

/**
 * Whether this person may open the design: its maker, an exec, or anyone who can see its client (their own session
 * decides, and the email and social teams only their own clients).
 */
export async function mayOpenDesign(me: Staff, meta: DesignMeta, db: SupabaseClient, admin: SupabaseClient): Promise<boolean> {
  if (meta.owner === me.id || me.isExec) return true;
  if (!meta.clientId) return false;
  const { data } = await db.from("clients").select("id").eq("id", meta.clientId).maybeSingle();
  if (!data) return false;
  if (!isChannelOnly(me.role)) return true;
  const [{ data: c }, { data: seats }] = await Promise.all([
    admin.from("clients").select("archived_at, services, services_extra, services_removed").eq("id", meta.clientId).maybeSingle(),
    admin.from("client_assignments").select("profile_id").eq("client_id", meta.clientId),
  ]);
  if (!c) return false;
  return channelMaySee({ id: me.id, role: me.role }, { archived: Boolean(c.archived_at), services: servicesOf(c), seatHolders: (seats ?? []).map((a) => String(a.profile_id)) });
}
