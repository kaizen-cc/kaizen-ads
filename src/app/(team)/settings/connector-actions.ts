"use server";

import { revalidatePath } from "next/cache";
import { requireExec, requireStaff } from "@/lib/auth";
import { appStepText, AUTH_KINDS, authFromProbe, KEY_RE, keyFrom, uniqueKey, validServerUrl, type AuthKind } from "@/lib/connectors/core";
import { faviconForUrl } from "@/lib/connectors/registry";
import { rolesAfterEnable } from "@/lib/connectors/requests-core";
import { ROLES } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings › Connections › Team connectors (execs enable connectors for the team: the Directory, custom connectors,
// editing what's enabled, and the team's requests to enable one). People connect their own accounts in Kaizen AI.
// Secrets are written, never read back: the screen only learns whether one is set.

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

/** What the server says about signing in: reachable, asks for a sign in, gives Kaizen AI a client id itself */
export async function checkConnectorUrl(raw: string): Promise<{ ok: true; reachable: boolean; signIn: boolean; dcr: boolean; suggested: AuthKind } | { ok: false; error: string }> {
  await requireExec();
  const url = validServerUrl(raw);
  if (!url) return { ok: false, error: "The server URL must be a full https address." };
  const { discover } = await import("@/lib/connectors/server");
  const d = await discover(url);
  return { ok: true, reachable: d.reachable, signIn: d.signIn, dcr: d.dcr || d.cimd, suggested: authFromProbe(d) ?? "token" };
}

const needsClientText = appStepText;

/**
 * Add custom connector: a name and the server's URL, and the rest is worked out. The key comes from the name, how it
 * signs in is read from the server (a sign in that needs no setup, no sign in, or a personal token), the icon is the
 * URL's site, and it's enabled for everyone. Only a server that gives apps no client id on its own needs more: the
 * client ID of an app set up with it once (the screen asks, then calls again with it; a secret only if it has one).
 */
export async function addCustomConnector(input: { name: string; url: string; client?: { id: string; secret?: string } }): Promise<{ ok: true; key: string; name: string } | { ok: false; error: string; needsClient?: boolean }> {
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
  if (same) return { ok: false, error: `That server is already enabled as ${same.name}.` };
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
 * Enable a Directory server for the team (everyone, unless roles are given): how it signs in is read from the server
 * (a sign in that needs no setup when it gives Kaizen AI a client id itself; one that doesn't needs the client id of an
 * app an exec sets up once, so the screen asks for it and calls again). Anyone who asked for it hears it's ready.
 */
export async function offerFromRegistry(name: string, roles: string[] = [], client?: { id: string; secret?: string }): Promise<{ ok: true; key: string; name: string } | { ok: false; error: string; needsClient?: boolean; url?: string }> {
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
    if (auth === "oauth_client" && !client?.id?.trim()) return { ok: false, needsClient: true, error: needsClientText(title), url: e.url as string };
  }
  const roleList = (roles ?? []).filter((r) => ROLES.some((x) => x.value === r));
  if (was) {
    const { error } = await admin.from("ai_connectors").update({ enabled: true, roles: roleList.length ? roleList : null, updated_at: new Date().toISOString() }).eq("id", was.id);
    revalidatePath("/settings");
    if (error) return { ok: false, error: error.message };
    await settle(name, { key: was.key as string, name: title }, me.id);
    return { ok: true, key: was.key as string, name: title };
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
  await settle(name, { key, name: title }, me.id);
  return { ok: true, key, name: title };
}

/** Everyone waiting on this connector hears it's ready (never fails the enabling) */
async function settle(ref: string, c: { key: string; name: string }, by: string) {
  const { settleEnabled } = await import("@/lib/connectors/requests");
  await settleEnabled(createAdminClient(), ref, c, by).catch((e) => console.error("[connectors] settle", e));
}

// ─── Execs: requests to enable ─────────────────────────────────────────────

/**
 * Enable what someone asked for (from Settings, or the bell's Enable, which passes the request's id): a Directory
 * entry is enabled for everyone (a connector limited to some roles gains the roles of the people who asked), and
 * everyone who asked hears it's ready. A service that needs its one-time app says so and the screen asks for it.
 */
export async function enableRequest(p: { ref?: string; id?: string; client?: { id: string; secret?: string } }): Promise<{ ok: true; key: string; name: string } | { ok: false; error: string; needsClient?: boolean; ref?: string; url?: string }> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const admin = createAdminClient();
  const { askerRoles, refOfRequest } = await import("@/lib/connectors/requests");
  const ref = p.ref ?? (p.id ? await refOfRequest(admin, p.id) : null);
  if (!ref) return { ok: false, error: "That request isn't there any more." };
  const asked = await askerRoles(admin, ref);
  if (ref.startsWith("connector:")) {
    const { data: c } = await admin.from("ai_connectors").select("id, key, name, roles").eq("id", ref.slice(10)).maybeSingle();
    if (!c) return { ok: false, error: "That connector was removed." };
    const roles = rolesAfterEnable({ roles: (c.roles as string[] | null) ?? null }, asked);
    const { error } = await admin.from("ai_connectors").update({ enabled: true, roles: roles.length ? roles : null, updated_at: new Date().toISOString() }).eq("id", c.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/settings");
    await settle(ref, { key: c.key as string, name: c.name as string }, me.id);
    return { ok: true, key: c.key as string, name: c.name as string };
  }
  const { data: was } = await admin.from("ai_connectors").select("roles").eq("registry_name", ref).maybeSingle();
  const r = await offerFromRegistry(ref, rolesAfterEnable(was ? { roles: (was.roles as string[] | null) ?? null } : null, asked), p.client);
  return r.ok ? r : { ...r, ref };
}

/** Decline what someone asked for: the reason goes back to everyone who asked */
export async function declineRequest(ref: string, reason: string): Promise<Ok> {
  const me = await requireExec();
  if (!adminConfigured()) return { ok: false, error: "Server key missing." };
  const { settleDeclined } = await import("@/lib/connectors/requests");
  const r = await settleDeclined(createAdminClient(), String(ref ?? ""), reason, me.id);
  revalidatePath("/settings");
  return r.ok ? { ok: true } : r;
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

export async function directory(q: string, limit = 60): Promise<{ items: DirectoryItem[]; total: number; ready: boolean }> {
  const me = await requireExec();
  if (!adminConfigured()) return { items: [], total: 0, ready: false };
  const admin = createAdminClient();
  const { offerFor, searchDirectory } = await import("@/lib/connectors/server");
  const found = await searchDirectory(admin, q, limit);
  if (!found.ready) return { items: [], total: 0, ready: false };
  const { data: seenRow } = await admin.from("ai_connector_registry_seen").select("seen_at").eq("profile_id", me.id).maybeSingle();
  const seenAt = (seenRow?.seen_at as string | undefined) ?? null;
  const items = found.rows.map((x): DirectoryItem => {
    const o = offerFor(found.offers, x);
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
  return { items, total: found.total, ready: true };
}
