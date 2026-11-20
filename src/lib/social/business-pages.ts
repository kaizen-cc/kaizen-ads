import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGraphAs } from "@/lib/context/meta";
import { partnerTokens } from "@/lib/meta-tokens";

// Social connections start from a Business Manager (owner, Nov 20 2026), like the client's Meta ad account: the team picks
// the Business Manager, and only that Business Manager's Facebook Pages (and the Instagram account on each) are offered.
// Asked with that Business Manager's own token (Kaizen's from Vercel, a partner's as stored, never shown): the Pages
// assigned to its system user, then the business's owned and client Pages when Meta lets the token list them.

export type BusinessPage = { id: string; name: string; ig: { id: string; username: string | null } | null; how: "owned" | "client" | "assigned" };
type Row = { id: string; name?: string; instagram_business_account?: { id: string; username?: string } };

const FIELDS = "id,name,instagram_business_account{id,username}";
const toPage = (r: Row, how: BusinessPage["how"]): BusinessPage => ({ id: r.id, name: r.name ?? r.id, ig: r.instagram_business_account ? { id: r.instagram_business_account.id, username: r.instagram_business_account.username ?? null } : null, how });

/** The token for a Business Manager (null or Kaizen's: the system user's); null when it isn't connected */
export async function businessToken(admin: SupabaseClient, bmId: string | null): Promise<{ token: string; name: string; id: string | null } | null> {
  if (bmId) {
    const { data } = await admin.from("meta_business_tokens").select("id, name, is_default").eq("id", bmId).maybeSingle();
    if (!data) return null;
    if (!data.is_default) {
      const t = (await partnerTokens()).find((x) => x.id === bmId);
      return t ? { token: t.token, name: t.name, id: bmId } : null;
    }
  }
  const token = process.env.META_SYSTEM_USER_TOKEN;
  return token ? { token, name: "Kaizen", id: null } : null;
}

async function pages(token: string, path: string, how: BusinessPage["how"], max = 6): Promise<BusinessPage[]> {
  const out: BusinessPage[] = [];
  let after: string | null = null;
  for (let i = 0; i < max; i++) {
    const r: { data?: Row[]; paging?: { cursors?: { after?: string }; next?: string } } = await metaGraphAs(token, path, { fields: FIELDS, limit: "100", ...(after ? { after } : {}) });
    out.push(...(r.data ?? []).map((x) => toPage(x, how)));
    after = r.paging?.next ? (r.paging.cursors?.after ?? null) : null;
    if (!after) break;
  }
  return out;
}

/**
 * Every Facebook Page a Business Manager's token reaches, with its Instagram account: the business's own Pages first,
 * then the Pages its clients shared with it, then any assigned to its system user only. error: why nothing could be
 * listed (the token's own answer), null when the list is just what it is.
 */
export async function businessManagerPages(admin: SupabaseClient, bmId: string | null): Promise<{ bm: string; pages: BusinessPage[]; error: string | null }> {
  const t = await businessToken(admin, bmId);
  if (!t) return { bm: "that Business Manager", pages: [], error: "That Business Manager isn't connected: an executive connects it in Settings › Sync health." };
  const seen = new Map<string, BusinessPage>();
  let error: string | null = null;
  const add = (list: BusinessPage[]) => {
    for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  };
  // The businesses the token belongs to, then their owned and client Pages
  const businesses = await metaGraphAs<{ data?: { id: string }[] }>(t.token, "me/businesses", { fields: "id", limit: "25" }).then((r) => r.data ?? [], () => [] as { id: string }[]);
  for (const b of businesses.slice(0, 5)) {
    add(await pages(t.token, `${b.id}/owned_pages`, "owned").catch(() => []));
    add(await pages(t.token, `${b.id}/client_pages`, "client").catch(() => []));
  }
  add(
    await pages(t.token, "me/accounts", "assigned").catch((e: unknown) => {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      return [];
    }),
  );
  return { bm: t.name, pages: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)), error: seen.size ? null : error };
}

/** A Page's own token through the Business Manager it was linked with (null when that Business Manager can't act on it) */
export async function pageTokenVia(admin: SupabaseClient, bmId: string | null, pageId: string): Promise<string | null> {
  const t = await businessToken(admin, bmId);
  if (!t) return null;
  const r = await metaGraphAs<{ access_token?: string }>(t.token, pageId, { fields: "access_token" }).catch(() => null);
  return r?.access_token ?? null;
}

/** A Page's name and Instagram account, asked through a Business Manager */
export async function pageVia(admin: SupabaseClient, bmId: string | null, pageId: string): Promise<{ name: string | null; ig: { id: string; username: string | null } | null }> {
  const t = await businessToken(admin, bmId);
  if (!t) throw new Error("That Business Manager isn't connected.");
  const r = await metaGraphAs<Row>(t.token, pageId, { fields: FIELDS });
  return { name: r.name ?? null, ig: r.instagram_business_account ? { id: r.instagram_business_account.id, username: r.instagram_business_account.username ?? null } : null };
}
