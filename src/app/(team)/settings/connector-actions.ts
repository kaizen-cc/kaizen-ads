"use server";

import { revalidatePath } from "next/cache";
import { requireExec, requireStaff } from "@/lib/auth";
import { AUTH_KINDS, authFromProbe, KEY_RE, keyFrom, uniqueKey, validServerUrl, type AuthKind } from "@/lib/connectors/core";
import { directoryOrder, faviconForUrl, featuredVendor, VENDORS } from "@/lib/connectors/registry";
import { ROLES } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings › Connections › Team connectors (execs: the Directory, custom connectors, editing what's offered) and Your
// accounts (everyone connects their own). Secrets are written, never read back: the screen only learns whether one
// is set.

type Ok = { ok: true } | { ok: false; error: string };
const NOT_READY = "Connectors need the latest database update first.";

export type ConnectorInput = {
  id?: string | null;
  key?: string;
  name: string;
  icon_url?: string | null;
  url: string;
  auth: AuthKind;
  client_id?: string | null;
  /** Undefined: keep the one saved; "": clear it */
  client_secret?: string;
  scopes?: string | null;
  note?: string | null;
  roles?: string[] | null;
  enabled?: boolean;
};

export async function saveConnector(input: ConnectorInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give it a name." };
  const key = String(input.key || keyFrom(name)).trim().toLowerCase();
  if (!KEY_RE.test(key)) return { ok: false, error: "The key is lowercase letters, numbers and dashes, starting with a letter (like shopify)." };
  const url = validServerUrl(String(input.url ?? ""));
  if (!url) return { ok: false, error: "The server URL must be a full https address." };
  if (!AUTH_KINDS.some((a) => a.key === input.auth)) return { ok: false, error: "Pick how it signs in." };
  const icon = input.icon_url?.trim() ? validServerUrl(input.icon_url) : null;
  if (input.icon_url?.trim() && !icon) return { ok: false, error: "The icon must be an https image address." };
  if (input.auth === "oauth_client" && !input.client_id?.trim()) return { ok: false, error: "Add the OAuth client id from the app you registered." };
  const roles = (input.roles ?? []).filter((r) => ROLES.some((x) => x.value === r));
  const row = {
    key,
    name,
    icon_url: icon,
    url,
    auth: input.auth,
    client_id: input.auth === "oauth_client" ? input.client_id!.trim().slice(0, 300) : null,
    scopes: input.scopes?.trim().slice(0, 500) || null,
    note: input.note?.trim().slice(0, 600) || null,
    roles: roles.length ? roles : null,
    enabled: input.enabled !== false,
    updated_at: new Date().toISOString(),
  };
  const admin = createAdminClient();
  const res = input.id ? await admin.from("ai_connectors").update(row).eq("id", input.id).select("id").single() : await admin.from("ai_connectors").insert({ ...row, created_by: me.id }).select("id").single();
  if (res.error || !res.data) return { ok: false, error: res.error?.code === "23505" ? "Another connector already uses that key." : res.error?.code === "42P01" ? NOT_READY : (res.error?.message ?? "Couldn't save.") };
  const id = res.data.id as string;
  const { setClientSecret } = await import("@/lib/connectors/server");
  try {
    if (input.auth !== "oauth_client") await setClientSecret(admin, id, null);
    else if (input.client_secret !== undefined) await setClientSecret(admin, id, input.client_secret.trim() || null);
    // A new URL means new OAuth endpoints and a new registration
    if (input.id) await admin.from("ai_connector_secrets").update({ auth_meta: null, auth_meta_at: null, ...(input.auth === "oauth" ? {} : { reg_client_id: null, reg_redirect_uri: null }) }).eq("connector_id", id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "The secret couldn't be saved." };
  }
  revalidatePath("/settings");
  return { ok: true, id };
}

export async function deleteConnector(id: string): Promise<Ok> {
  await requireExec();
  const { error } = await createAdminClient().from("ai_connectors").delete().eq("id", id);
  revalidatePath("/settings");
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** What the server says about signing in: reachable, asks for a sign in, registers apps itself */
export async function checkConnectorUrl(raw: string): Promise<{ ok: true; reachable: boolean; signIn: boolean; dcr: boolean; suggested: AuthKind } | { ok: false; error: string }> {
  await requireExec();
  const url = validServerUrl(raw);
  if (!url) return { ok: false, error: "The server URL must be a full https address." };
  const { discover } = await import("@/lib/connectors/server");
  const d = await discover(url);
  return { ok: true, reachable: d.reachable, signIn: d.signIn, dcr: d.dcr, suggested: authFromProbe(d) ?? "token" };
}

const needsClientText = (name: string) =>
  `${name} signs people in with OAuth but doesn't let apps register themselves, so it needs an app registered with ${name} first. Register one in ${name}'s developer settings with the redirect URL below, then paste its client ID and secret.`;

/**
 * Add custom connector: a name and the server's URL, and the rest is worked out. The key comes from the name, how it
 * signs in is read from the server (OAuth with dynamic registration, no sign in, or a personal token), the icon is the
 * URL's site, and it's offered to everyone. Only a server with OAuth but no registration needs more: the client ID and
 * secret of an app registered with it (the screen asks, then calls again with them).
 */
export async function addCustomConnector(input: { name: string; url: string; client?: { id: string; secret: string } }): Promise<{ ok: true; key: string; name: string } | { ok: false; error: string; needsClient?: boolean }> {
  await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give it a name." };
  const url = validServerUrl(String(input.url ?? ""));
  if (!url) return { ok: false, error: "The server URL must be a full https address, like https://mcp.example.com/mcp." };
  const admin = createAdminClient();
  const { data: all, error: listErr } = await admin.from("ai_connectors").select("key, name, url");
  if (listErr) return { ok: false, error: listErr.code === "42P01" ? NOT_READY : listErr.message };
  const same = (all ?? []).find((c) => c.url === url);
  if (same) return { ok: false, error: `That server is already offered as ${same.name}.` };
  const { discover } = await import("@/lib/connectors/server");
  const auth = authFromProbe(await discover(url));
  if (!auth) return { ok: false, error: "The server didn't answer at that address. Check the URL and try again." };
  if (auth === "oauth_client" && !input.client?.id?.trim()) return { ok: false, needsClient: true, error: needsClientText(name) };
  const key = uniqueKey(name, (all ?? []).map((c) => c.key as string));
  const r = await saveConnector({
    key,
    name,
    icon_url: faviconForUrl(url),
    url,
    auth,
    client_id: auth === "oauth_client" ? input.client!.id : null,
    client_secret: auth === "oauth_client" ? (input.client?.secret ?? "") : undefined,
    roles: [],
    enabled: true,
  });
  return r.ok ? { ok: true, key, name } : r;
}

// ─── Everyone: their own connections ───────────────────────────────────────

export async function savePersonalTokenAction(key: string, token: string): Promise<Ok> {
  const me = await requireStaff();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  try {
    const { savePersonalToken } = await import("@/lib/connectors/server");
    await savePersonalToken(me, key, token);
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save the token." };
  }
}

export async function disconnectAction(key: string): Promise<Ok> {
  const me = await requireStaff();
  try {
    const { disconnect } = await import("@/lib/connectors/server");
    await disconnect(me, key);
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't disconnect." };
  }
}

// ─── Execs: the Directory ──────────────────────────────────────────────────

/**
 * Offer a Directory server to the team (everyone, unless roles are given): how it signs in is read from the server
 * (OAuth with dynamic registration when it supports it; a server that asks for a sign in without registering apps needs
 * the client id and secret of an app an exec registered, so the screen asks for them and calls again).
 */
export async function offerFromRegistry(name: string, roles: string[] = [], client?: { id: string; secret: string }): Promise<{ ok: true; key: string; name: string } | { ok: false; error: string; needsClient?: boolean }> {
  const me = await requireExec();
  const admin = createAdminClient();
  const { data: e } = await admin.from("ai_connector_registry").select("name, title, description, url, version, icon_url, available").eq("name", name).maybeSingle();
  if (!e) return { ok: false, error: "That server isn't in the catalog any more." };
  const title = String(e.title || e.name).slice(0, 60);
  const { discover } = await import("@/lib/connectors/server");
  const { data: was } = await admin.from("ai_connectors").select("id, key, auth").eq("registry_name", name).maybeSingle();
  let auth: AuthKind = (was?.auth as AuthKind | undefined) ?? "oauth";
  if (!was) {
    const found = authFromProbe(await discover(e.url as string));
    if (!found) return { ok: false, error: `${title} didn't answer. Try again in a bit.` };
    auth = found;
    if (auth === "oauth_client" && !client?.id?.trim()) return { ok: false, needsClient: true, error: needsClientText(title) };
  }
  const roleList = (roles ?? []).filter((r) => ROLES.some((x) => x.value === r));
  if (was) {
    const { error } = await admin.from("ai_connectors").update({ enabled: true, roles: roleList.length ? roleList : null, updated_at: new Date().toISOString() }).eq("id", was.id);
    revalidatePath("/settings");
    return error ? { ok: false, error: error.message } : { ok: true, key: was.key as string, name: title };
  }
  const { data: keys } = await admin.from("ai_connectors").select("key");
  const key = uniqueKey(String(e.title || String(e.name).split("/").pop() || "connector"), (keys ?? []).map((k) => k.key as string));
  const r = await saveConnector({
    key,
    name: title,
    icon_url: (e.icon_url as string | null) ?? null,
    url: e.url as string,
    auth,
    client_id: auth === "oauth_client" ? client!.id : null,
    client_secret: auth === "oauth_client" ? (client?.secret ?? "") : undefined,
    note: ((e.description as string | null) ?? "").slice(0, 600) || null,
    roles: roleList,
    enabled: true,
  });
  if (!r.ok) return r;
  await admin.from("ai_connectors").update({ registry_name: e.name, registry_version: e.version, created_by: me.id }).eq("id", r.id);
  revalidatePath("/settings");
  return { ok: true, key, name: title };
}

/** The exec looked at the Directory: "New" and "Updated" count from now on */
export async function markCatalogSeen(): Promise<void> {
  const me = await requireExec();
  await createAdminClient().from("ai_connector_registry_seen").upsert({ profile_id: me.id, seen_at: new Date().toISOString() }, { onConflict: "profile_id" });
}

export type DirectoryItem = {
  name: string;
  title: string;
  description: string | null;
  url: string;
  icon_url: string | null;
  website_url: string | null;
  featured: boolean;
  vendor: string | null;
  badge: "new" | "updated" | null;
  offered: "on" | "off" | null;
};

const DIR_COLS = "name, title, description, url, icon_url, website_url, first_seen_at, changed_at";
type DirRow = { name: string; title: string | null; description: string | null; url: string; icon_url: string | null; website_url: string | null; first_seen_at: string; changed_at: string | null; featured?: boolean | null; vendor?: string | null };

/**
 * The Directory's connectors: the featured vendors first, then the newest, searched by name, vendor and description.
 * Before the directory migration (no featured column) the featured ones are found by their URLs instead.
 */
export async function directory(q: string, limit = 60): Promise<{ items: DirectoryItem[]; total: number; ready: boolean }> {
  const me = await requireExec();
  if (!adminConfigured()) return { items: [], total: 0, ready: false };
  const admin = createAdminClient();
  const n = Math.max(20, Math.min(600, Math.round(Number(limit) || 60)));
  const search = String(q ?? "")
    .replace(/[%_,()*\\"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const match = (cols: string[]) => cols.map((c) => `${c}.ilike.%${search}%`).join(",");
  let rows: DirRow[] = [];
  let total = 0;
  let withFeatured = admin.from("ai_connector_registry").select(`${DIR_COLS}, featured, vendor`, { count: "exact" }).eq("available", true);
  if (search) withFeatured = withFeatured.or(match(["title", "name", "description", "vendor"]));
  const first = await withFeatured.order("featured", { ascending: false }).order("first_seen_at", { ascending: false }).limit(n);
  if (!first.error) {
    rows = (first.data ?? []) as unknown as DirRow[];
    total = first.count ?? rows.length;
  } else {
    // Before the migration: the plain list, plus the vendors' servers found by their URLs
    let plainQ = admin.from("ai_connector_registry").select(DIR_COLS, { count: "exact" }).eq("available", true);
    if (search) plainQ = plainQ.or(match(["title", "name", "description"]));
    const plain = await plainQ.order("first_seen_at", { ascending: false }).limit(n);
    if (plain.error) return { items: [], total: 0, ready: false };
    let vendorQ = admin
      .from("ai_connector_registry")
      .select(DIR_COLS)
      .eq("available", true)
      .or(VENDORS.flatMap((v) => v.domains).map((d) => `url.ilike.%${d}/%`).join(","));
    if (search) vendorQ = vendorQ.or(match(["title", "name", "description"]));
    const vendorRows = ((await vendorQ.limit(200)).data ?? []) as unknown as DirRow[];
    const tag = (x: DirRow): DirRow => {
      const v = featuredVendor(x.name, x.url);
      return { ...x, featured: Boolean(v), vendor: v };
    };
    const seen = new Set<string>();
    rows = [...vendorRows.map(tag).filter((x) => x.featured), ...((plain.data ?? []) as unknown as DirRow[]).map(tag)]
      .filter((x) => {
        if (seen.has(x.name)) return false;
        seen.add(x.name);
        return true;
      })
      .slice(0, n);
    total = Math.max(plain.count ?? 0, rows.length);
  }
  // One card per server: the connectors checked for Kaizen's directory win over the same server listed in the registry
  const urlKey = (u: string) => u.toLowerCase().replace(/\/+$/, "").replace(/\/(sse|mcp)$/, "");
  const ours = new Set(rows.filter((x) => x.name.startsWith("kaizen.directory/")).map((x) => urlKey(x.url)));
  rows = rows.filter((x) => x.name.startsWith("kaizen.directory/") || !ours.has(urlKey(x.url)));
  const [{ data: offered }, { data: seenRow }] = await Promise.all([
    admin.from("ai_connectors").select("registry_name, url, enabled"),
    admin.from("ai_connector_registry_seen").select("seen_at").eq("profile_id", me.id).maybeSingle(),
  ]);
  const seenAt = (seenRow?.seen_at as string | undefined) ?? null;
  const offers = (offered ?? []) as { registry_name: string | null; url: string; enabled: boolean }[];
  const items = directoryOrder(rows).map((x): DirectoryItem => {
    const o = offers.find((c) => c.registry_name === x.name) ?? offers.find((c) => c.url === x.url);
    return {
      name: x.name,
      title: x.title || x.name,
      description: x.description,
      url: x.url,
      icon_url: x.icon_url,
      website_url: x.website_url,
      featured: Boolean(x.featured),
      vendor: x.vendor ?? null,
      badge: seenAt && x.first_seen_at > seenAt ? "new" : seenAt && x.changed_at && x.changed_at > seenAt ? "updated" : null,
      offered: o ? (o.enabled ? "on" : "off") : null,
    };
  });
  return { items, total, ready: true };
}
