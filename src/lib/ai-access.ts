import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { channelMaySee } from "@/lib/kaizen-ai/channel-access";
import { isChannelOnly } from "@/lib/roles";
import { servicesOf } from "@/lib/services";
import { mayOpen, type AccessWho, type Gate } from "./ai-access-core";

// The server side of what an assistant or Kaizen AI may reach for the person (pure rules: src/lib/ai-access-core.ts).
// A tool reads with the person's own session (db: the database's access rules decide) wherever it can. When it must
// use the server's rights (admin), it asks here first, with the same rules the app's pages use:
//   assertMaySee(ctx, clientId)  before reading one client's data
//   visibleClientIds(ctx)        before reading across clients (keep only these)
//   mayOpenPath(ctx, href)       before opening or linking a page
// tests/ai-access-lint.test.ts fails when a tool file reads client tables with admin without importing these.

export type AccessCtx = { me: AccessWho & { id: string }; db: SupabaseClient; admin: SupabaseClient };

export class AccessError extends Error {}

/** Whether the person can see this client, exactly as in the app: their session's access rules, then the channel rule */
export async function maySeeClient(ctx: AccessCtx, clientId: string | null | undefined): Promise<boolean> {
  if (!clientId) return false;
  const { data } = await ctx.db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!data) return false;
  if (!isChannelOnly(ctx.me.role)) return true;
  const [{ data: c }, { data: seats }] = await Promise.all([
    ctx.admin.from("clients").select("archived_at, services, services_extra, services_removed, strategy_only").eq("id", clientId).maybeSingle(),
    ctx.admin.from("client_assignments").select("profile_id").eq("client_id", clientId),
  ]);
  if (!c) return false;
  return channelMaySee({ id: ctx.me.id, role: ctx.me.role }, { archived: Boolean(c.archived_at), services: servicesOf(c), seatHolders: (seats ?? []).map((a) => String(a.profile_id)) });
}

/** Throws a plain "you can't see this client" when they can't */
export async function assertMaySee(ctx: AccessCtx, clientId: string | null | undefined): Promise<void> {
  if (!(await maySeeClient(ctx, clientId))) throw new AccessError("That client isn't one you can see.");
}

/** Every client the person can see (their session decides, then the channel rule) */
export async function visibleClientIds(ctx: AccessCtx): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await ctx.db.from("clients").select("id").range(from, from + 999);
    for (const r of data ?? []) ids.add(r.id as string);
    if (!data || data.length < 1000) break;
  }
  if (!isChannelOnly(ctx.me.role) || !ids.size) return ids;
  const [{ data: cs }, { data: seats }] = await Promise.all([
    ctx.admin.from("clients").select("id, archived_at, services, services_extra, services_removed, strategy_only").in("id", [...ids]),
    ctx.admin.from("client_assignments").select("client_id, profile_id").in("client_id", [...ids]),
  ]);
  const keep = new Set<string>();
  for (const c of cs ?? []) {
    const holders = (seats ?? []).filter((s) => s.client_id === c.id).map((s) => String(s.profile_id));
    if (channelMaySee({ id: ctx.me.id, role: ctx.me.role }, { archived: Boolean(c.archived_at), services: servicesOf(c), seatHolders: holders })) keep.add(c.id as string);
  }
  return keep;
}

/** Only the rows about clients the person can see (rows without a client pass) */
export async function keepVisible<T extends { client_id?: string | null }>(ctx: AccessCtx, rows: readonly T[]): Promise<T[]> {
  if (!rows.some((r) => r.client_id)) return [...rows];
  const ok = await visibleClientIds(ctx);
  return rows.filter((r) => !r.client_id || ok.has(r.client_id));
}

/** Whether the person may open this page: the role rules, then the record behind it (a client, a Kaizen AI thread, a handoff) */
export async function mayOpenPath(ctx: AccessCtx, href: string): Promise<Gate> {
  const rule = mayOpen(href, ctx.me);
  if (!rule.ok) return rule;
  let u: URL;
  try {
    u = new URL(href, "https://app.local");
  } catch {
    return { ok: false, why: "That isn't a page in the app." };
  }
  const slug = u.pathname.match(/^\/clients\/([^/?#]+)/)?.[1];
  if (slug) {
    const { data } = await ctx.db.from("clients").select("id").eq("slug", decodeURIComponent(slug)).maybeSingle();
    if (!data || !(await maySeeClient(ctx, data.id as string))) return { ok: false, why: "That client isn't one you can see." };
  }
  const thread = u.pathname === "/ai" ? u.searchParams.get("t") : null;
  if (thread) {
    // Their own threads, and the ones shared with them (the database's access rules decide)
    const { data } = await ctx.db.from("ai_threads").select("id").eq("id", thread).maybeSingle();
    if (!data) return { ok: false, why: "That Kaizen AI chat isn't yours or shared with you." };
  }
  const handoff = u.pathname.match(/^\/handoff\/([0-9a-f-]{36})/i)?.[1];
  if (handoff) {
    const { data } = await ctx.db.from("account_handoffs").select("id").eq("id", handoff).maybeSingle();
    if (!data) return { ok: false, why: "That handoff isn't one you can see." };
  }
  return { ok: true };
}
