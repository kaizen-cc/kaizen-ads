import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asanaAsUser, asanaForPerson } from "@/lib/asana";

// Each person's own Asana (owner, Nov 23 2026): they connect it once (OAuth, /api/asana/connect), and from then on
// "Next for me in Asana" reads exactly their Asana > My tasks (private tasks too) and every change they make from
// Kaizen OS goes out as them. Tokens live in asana_user_tokens (server only) and refresh themselves.
// Needs ASANA_CLIENT_ID and ASANA_CLIENT_SECRET (an Asana OAuth app whose redirect URL is <site>/api/asana/callback).

export const asanaOAuthConfigured = () => Boolean(process.env.ASANA_CLIENT_ID && process.env.ASANA_CLIENT_SECRET);

type TokenRow = { profile_id: string; asana_user_gid: string; email: string | null; name: string | null; access_token: string; refresh_token: string | null; expires_at: string | null; workspaces: { gid: string; name: string }[]; connected_at: string; confirmed?: boolean; extra_workspaces?: string[]; last_synced_at?: string | null };

/** Whether the Asana account signed in is the person's own (their Kaizen email), compared loosely */
export const sameEmail = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

type Exchange = { access_token: string; refresh_token?: string; expires_in?: number; data?: { gid?: string; name?: string; email?: string } };

async function oauthToken(body: Record<string, string>): Promise<Exchange> {
  const res = await fetch("https://app.asana.com/-/oauth_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.ASANA_CLIENT_ID!, client_secret: process.env.ASANA_CLIENT_SECRET!, ...body }),
    cache: "no-store",
  });
  const j = (await res.json().catch(() => ({}))) as Exchange & { error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(j.error_description ?? j.error ?? `Asana sign-in failed (${res.status})`);
  return j;
}

/**
 * Back from Asana's sign-in: the code for their tokens, who they are and their workspaces, kept for them. Signed in to
 * Asana as someone else (a browser logged into a colleague's Asana, owner Nov 24 2026): kept but not used until they
 * confirm it in Settings (mismatch: that account's email).
 */
export async function connectAsana(admin: SupabaseClient, profileId: string, code: string, redirectUri: string, kaizenEmail?: string | null): Promise<{ name: string | null; mismatch: string | null }> {
  const t = await oauthToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const meRes = await fetch("https://app.asana.com/api/1.0/users/me?opt_fields=name,email,workspaces.name", { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/json" }, cache: "no-store" });
  const me = ((await meRes.json().catch(() => ({}))) as { data?: { gid: string; name?: string; email?: string; workspaces?: { gid: string; name: string }[] } }).data;
  if (!me?.gid) throw new Error("Asana didn't say who you are");
  await admin.from("asana_user_tokens").upsert(
    {
      profile_id: profileId,
      asana_user_gid: me.gid,
      email: me.email ?? null,
      name: me.name ?? null,
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? null,
      expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
      workspaces: (me.workspaces ?? []).map((w) => ({ gid: w.gid, name: w.name })),
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confirmed: !kaizenEmail || sameEmail(me.email, kaizenEmail),
      extra_workspaces: [],
      last_synced_at: null,
    },
    { onConflict: "profile_id" },
  );
  return { name: me.name ?? null, mismatch: kaizenEmail && !sameEmail(me.email, kaizenEmail) ? (me.email ?? me.name ?? "another account") : null };
}

/** Their connection, refreshed when it's about to run out (null: not connected, or Asana took it back) */
export async function asanaTokenFor(admin: SupabaseClient, profileId: string): Promise<TokenRow | null> {
  const { data } = await admin.from("asana_user_tokens").select("*").eq("profile_id", profileId).maybeSingle();
  const row = data as TokenRow | null;
  // Not theirs and not confirmed yet: never used
  if (!row || row.confirmed === false) return null;
  if (row.expires_at && Date.parse(row.expires_at) - Date.now() > 60_000) return row;
  if (!row.refresh_token || !asanaOAuthConfigured()) return row.expires_at ? null : row;
  try {
    const t = await oauthToken({ grant_type: "refresh_token", refresh_token: row.refresh_token });
    const next = { access_token: t.access_token, expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString() };
    await admin.from("asana_user_tokens").update(next).eq("profile_id", profileId);
    return { ...row, ...next };
  } catch (e) {
    console.error("[asana] refresh", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Work the person asked for: every Asana write inside goes out as them (their own token). Reads still work without it
 * (the shared connection), but a write without their token is refused with AsanaConnectNeeded, so the screen asks
 * them to connect instead of posting as someone else.
 */
export async function asanaAsPerson<T>(admin: SupabaseClient, profileId: string, fn: () => Promise<T>): Promise<T> {
  const row = await asanaTokenFor(admin, profileId).catch(() => null);
  return asanaForPerson(profileId, row?.access_token ?? null, fn);
}

/** Whether the person has their own Asana connected (and usable) */
export async function hasMyAsana(admin: SupabaseClient, profileId: string): Promise<boolean> {
  return Boolean(await asanaTokenFor(admin, profileId).catch(() => null));
}

/** Runs fn as the person in Asana when they've connected (their token), else with the shared token (reads only: writes inside asanaAsPerson) */
export async function withMyAsana<T>(admin: SupabaseClient, profileId: string, fn: (connected: boolean) => Promise<T>): Promise<T> {
  const row = await asanaTokenFor(admin, profileId).catch(() => null);
  return row ? asanaAsUser(row.access_token, () => fn(true)) : fn(false);
}

export type AsanaConn = {
  configured: boolean;
  /** Connected and in use (theirs, or confirmed) */
  connected: boolean;
  /** Signed in as an account whose email isn't theirs, waiting for them to confirm or switch */
  pending: boolean;
  name: string | null;
  email: string | null;
  since: string | null;
  lastSync: string | null;
  /** Every workspace the account belongs to: Kaizen's always on (locked), the others only when ticked */
  workspaces: { gid: string; name: string; on: boolean; locked: boolean }[];
};

/** For Settings › Connections and the Asana block: connected as whom, which workspaces count, last sync */
export async function asanaConnection(admin: SupabaseClient, profileId: string): Promise<AsanaConn> {
  const { kaizenWorkspace } = await import("@/lib/asana");
  const [{ data }, k] = await Promise.all([admin.from("asana_user_tokens").select("name, email, connected_at, confirmed, workspaces, extra_workspaces, last_synced_at").eq("profile_id", profileId).maybeSingle(), kaizenWorkspace().catch(() => null)]);
  const row = data as Pick<TokenRow, "name" | "email" | "connected_at" | "workspaces" | "confirmed" | "extra_workspaces" | "last_synced_at"> | null;
  const extra = row?.extra_workspaces ?? [];
  const workspaces = (row?.workspaces ?? []).map((w) => ({ gid: w.gid, name: w.name, on: w.gid === k || extra.includes(w.gid) || !k, locked: w.gid === k || !k })).sort((a, b) => Number(b.locked) - Number(a.locked));
  return { configured: asanaOAuthConfigured(), connected: Boolean(row) && row?.confirmed !== false, pending: row?.confirmed === false, name: row?.name ?? null, email: row?.email ?? null, since: row?.connected_at ?? null, lastSync: row?.last_synced_at ?? null, workspaces };
}

/** They checked who's signed in and want it anyway */
export async function confirmAsana(admin: SupabaseClient, profileId: string) {
  await admin.from("asana_user_tokens").update({ confirmed: true, updated_at: new Date().toISOString() }).eq("profile_id", profileId);
}

/** The other workspaces they ticked on (Kaizen's is always on and never stored here) */
export async function asanaExtraWorkspaces(admin: SupabaseClient, profileId: string): Promise<string[]> {
  const { data } = await admin.from("asana_user_tokens").select("extra_workspaces").eq("profile_id", profileId).maybeSingle();
  return ((data?.extra_workspaces as string[] | null) ?? []).filter(Boolean);
}

/** Ticks only from the workspaces the account belongs to */
export async function setAsanaWorkspaces(admin: SupabaseClient, profileId: string, gids: string[]) {
  const { kaizenWorkspace } = await import("@/lib/asana");
  const [{ data }, k] = await Promise.all([admin.from("asana_user_tokens").select("workspaces").eq("profile_id", profileId).maybeSingle(), kaizenWorkspace().catch(() => null)]);
  const known = new Set(((data?.workspaces as { gid: string }[] | null) ?? []).map((w) => w.gid));
  const extra = [...new Set(gids)].filter((g) => known.has(g) && g !== k);
  await admin.from("asana_user_tokens").update({ extra_workspaces: extra, updated_at: new Date().toISOString() }).eq("profile_id", profileId);
}

/** Their tasks were just read with their own Asana (at most once a minute) */
export async function markAsanaSynced(admin: SupabaseClient, profileId: string) {
  const now = new Date();
  await admin.from("asana_user_tokens").update({ last_synced_at: now.toISOString() }).eq("profile_id", profileId).or(`last_synced_at.is.null,last_synced_at.lt.${new Date(now.getTime() - 60_000).toISOString()}`);
}

export async function disconnectAsana(admin: SupabaseClient, profileId: string) {
  await admin.from("asana_user_tokens").delete().eq("profile_id", profileId);
}
