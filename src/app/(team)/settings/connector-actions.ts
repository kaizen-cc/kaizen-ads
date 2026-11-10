"use server";

import { revalidatePath } from "next/cache";
import { requireExec, requireStaff } from "@/lib/auth";
import { AUTH_KINDS, KEY_RE, keyFrom, validServerUrl, type AuthKind } from "@/lib/connectors/core";
import { ROLES } from "@/lib/roles";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings › Connectors (execs keep the catalog) and Settings › Your connections (everyone connects their own).
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

/** What the server says about signing in: reachable, asks for a sign in, registers apps itself */
export async function checkConnectorUrl(raw: string): Promise<{ ok: true; reachable: boolean; signIn: boolean; dcr: boolean; suggested: AuthKind } | { ok: false; error: string }> {
  await requireExec();
  const url = validServerUrl(raw);
  if (!url) return { ok: false, error: "The server URL must be a full https address." };
  const { discover } = await import("@/lib/connectors/server");
  const d = await discover(url);
  return { ok: true, reachable: d.reachable, signIn: d.signIn, dcr: d.dcr, suggested: !d.signIn ? "none" : d.dcr ? "oauth" : d.meta ? "oauth_client" : "token" };
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

// ─── Execs: the live catalog ───────────────────────────────────────────────

/**
 * Offer a registry server to the team: how it signs in is read from the server (OAuth with dynamic registration when
 * it supports it; a server that asks for a sign in without registering apps needs the client id and secret of an app
 * an exec registered, so the screen asks for them and calls again).
 */
export async function offerFromRegistry(name: string, roles: string[], client?: { id: string; secret: string }): Promise<{ ok: true; key: string } | { ok: false; error: string; needsClient?: boolean }> {
  const me = await requireExec();
  const admin = createAdminClient();
  const { data: e } = await admin.from("ai_connector_registry").select("name, title, description, url, version, icon_url, available").eq("name", name).maybeSingle();
  if (!e) return { ok: false, error: "That server isn't in the catalog any more." };
  const { discover } = await import("@/lib/connectors/server");
  const { data: was } = await admin.from("ai_connectors").select("id, key, auth").eq("registry_name", name).maybeSingle();
  let auth: AuthKind = (was?.auth as AuthKind | undefined) ?? "oauth";
  if (!was) {
    const d = await discover(e.url as string);
    if (!d.reachable) return { ok: false, error: "The server didn't answer. Try again later." };
    auth = !d.signIn ? "none" : d.dcr ? "oauth" : d.meta ? "oauth_client" : "token";
    if (auth === "oauth_client" && !client?.id?.trim()) return { ok: false, needsClient: true, error: "This server signs in with OAuth but doesn't register apps itself. Register an app with the service and paste its client id and secret." };
  }
  const roleList = (roles ?? []).filter((r) => ROLES.some((x) => x.value === r));
  if (was) {
    const { error } = await admin.from("ai_connectors").update({ enabled: true, roles: roleList.length ? roleList : null, updated_at: new Date().toISOString() }).eq("id", was.id);
    revalidatePath("/settings");
    return error ? { ok: false, error: error.message } : { ok: true, key: was.key as string };
  }
  // A key from its title, unique among the connectors
  const { data: keys } = await admin.from("ai_connectors").select("key");
  const taken = new Set((keys ?? []).map((k) => k.key as string));
  const base = keyFrom(String(e.title || String(e.name).split("/").pop() || "connector")).slice(0, 34);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  const r = await saveConnector({
    key,
    name: String(e.title || e.name).slice(0, 60),
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
  return { ok: true, key };
}

/** The exec looked at the catalog: "New" and "Updated" count from now on */
export async function markCatalogSeen(): Promise<void> {
  const me = await requireExec();
  await createAdminClient().from("ai_connector_registry_seen").upsert({ profile_id: me.id, seen_at: new Date().toISOString() }, { onConflict: "profile_id" });
}
