import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asanaAsUser } from "@/lib/asana";

// Each person's own Asana (owner, Nov 23 2026): they connect it once (OAuth, /api/asana/connect), and from then on
// "Next for me in Asana" reads exactly their Asana > My tasks (private tasks too) and every change they make from
// Kaizen OS goes out as them. Tokens live in asana_user_tokens (server only) and refresh themselves.
// Needs ASANA_CLIENT_ID and ASANA_CLIENT_SECRET (an Asana OAuth app whose redirect URL is <site>/api/asana/callback).

export const asanaOAuthConfigured = () => Boolean(process.env.ASANA_CLIENT_ID && process.env.ASANA_CLIENT_SECRET);

type TokenRow = { profile_id: string; asana_user_gid: string; email: string | null; name: string | null; access_token: string; refresh_token: string | null; expires_at: string | null; workspaces: { gid: string; name: string }[]; connected_at: string };

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

/** Back from Asana's sign-in: the code for their tokens, who they are and their workspaces, kept for them */
export async function connectAsana(admin: SupabaseClient, profileId: string, code: string, redirectUri: string): Promise<{ name: string | null }> {
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
    },
    { onConflict: "profile_id" },
  );
  return { name: me.name ?? null };
}

/** Their connection, refreshed when it's about to run out (null: not connected, or Asana took it back) */
export async function asanaTokenFor(admin: SupabaseClient, profileId: string): Promise<TokenRow | null> {
  const { data } = await admin.from("asana_user_tokens").select("*").eq("profile_id", profileId).maybeSingle();
  const row = data as TokenRow | null;
  if (!row) return null;
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

/** Runs fn as the person in Asana when they've connected (their token), else with the shared token */
export async function withMyAsana<T>(admin: SupabaseClient, profileId: string, fn: (connected: boolean) => Promise<T>): Promise<T> {
  const row = await asanaTokenFor(admin, profileId).catch(() => null);
  return row ? asanaAsUser(row.access_token, () => fn(true)) : fn(false);
}

/** For Settings › My connections and the Asana block: whether they're connected, as whom, since when */
export async function asanaConnection(admin: SupabaseClient, profileId: string): Promise<{ configured: boolean; connected: boolean; name: string | null; email: string | null; since: string | null }> {
  const { data } = await admin.from("asana_user_tokens").select("name, email, connected_at").eq("profile_id", profileId).maybeSingle();
  return { configured: asanaOAuthConfigured(), connected: Boolean(data), name: (data?.name as string | null) ?? null, email: (data?.email as string | null) ?? null, since: (data?.connected_at as string | null) ?? null };
}

export async function disconnectAsana(admin: SupabaseClient, profileId: string) {
  await admin.from("asana_user_tokens").delete().eq("profile_id", profileId);
}
