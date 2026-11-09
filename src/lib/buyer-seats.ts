import type { SupabaseClient } from "@supabase/supabase-js";

// Several people can hold one seat on a client (two Meta buyers, say): client_assignments has a row each, and
// is_primary tells the primary (true) from the secondaries (false). The primary is the one a task picks when it needs a
// single owner (the KPI card, a report part, a sprint, a ticket's buyer); everyone on the seat sees the client, its KPI
// cards and reports, can do what the seat allows from the chat, and hears the updates and alerts.

export type AdPlatform = "meta" | "google" | "tiktok";
export type BuyerRole = "meta_buyer" | "google_buyer" | "tiktok_buyer";

export const BUYER_ROLES: readonly BuyerRole[] = ["meta_buyer", "google_buyer", "tiktok_buyer"];
export const buyerRole = (platform: string): BuyerRole => (platform === "google" ? "google_buyer" : platform === "tiktok" ? "tiktok_buyer" : "meta_buyer");
export const platformOf = (role: string): AdPlatform => (role === "google_buyer" ? "google" : role === "tiktok_buyer" ? "tiktok" : "meta");
export const isBuyerRole = (role: string | null | undefined): role is BuyerRole => role === "meta_buyer" || role === "google_buyer" || role === "tiktok_buyer";

/** The seats to read for a platform: TikTok's and the Meta seat it falls back to */
export const seatRolesToRead = (platform: string): BuyerRole[] => (platform === "tiktok" ? ["tiktok_buyer", "meta_buyer"] : [buyerRole(platform)]);

/**
 * The seat that owns a platform's work on a client: TikTok's own buyer seat when someone holds it, else the Meta buyer
 * (who buys TikTok until a TikTok buyer is set). Meta and Google are their own seats.
 */
export function seatRoleFor<T extends SeatRow>(rows: readonly T[], platform: string, clientId?: string | null): BuyerRole {
  const role = buyerRole(platform);
  if (role !== "tiktok_buyer") return role;
  return rows.some((r) => r.role === "tiktok_buyer" && (clientId == null || r.client_id === clientId)) ? "tiktok_buyer" : "meta_buyer";
}

export type SeatRow = { client_id?: string | null; profile_id: string; role: string; is_primary?: boolean | null; created_at?: string | null };

/** A seat's holders in order: the primary first (a row not marked secondary counts as primary), then by when they joined */
export function orderSeats<T extends SeatRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(b.is_primary !== false) - Number(a.is_primary !== false) || (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

/** The primary holder's row of a seat (the first one when none is marked), or null when nobody holds it */
export function primaryOf<T extends SeatRow>(rows: readonly T[], role: string, clientId?: string | null): T | null {
  return orderSeats(rows.filter((r) => r.role === role && (clientId == null || r.client_id === clientId)))[0] ?? null;
}

/** Everyone on a seat, primary first, each once */
export function holdersOf(rows: readonly SeatRow[], role: string, clientId?: string | null): string[] {
  return unique(orderSeats(rows.filter((r) => r.role === role && (clientId == null || r.client_id === clientId))).map((r) => r.profile_id));
}

/** The secondaries on a seat (everyone but the primary) */
export function secondariesOf(rows: readonly SeatRow[], role: string, clientId?: string | null): string[] {
  return holdersOf(rows, role, clientId).slice(1);
}

/** Each id once, in order, without blanks: the recipients of a notice */
export function unique(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((x): x is string => Boolean(x)))];
}

/** The platforms someone holds a buyer seat on, from seat rows (primary or secondary alike) */
export function seatPlatforms(rows: readonly SeatRow[], profileId: string, clientId?: string | null): AdPlatform[] {
  return unique(rows.filter((r) => r.profile_id === profileId && isBuyerRole(r.role) && (clientId == null || r.client_id === clientId)).map((r) => platformOf(r.role))) as AdPlatform[];
}

/** `${client}:${platform}` for every buyer seat a person holds (primary or secondary) */
export function seatKeys(rows: readonly SeatRow[], profileId: string): Set<string> {
  return new Set(rows.filter((r) => r.profile_id === profileId && isBuyerRole(r.role) && r.client_id).map((r) => `${r.client_id}:${platformOf(r.role)}`));
}

/**
 * Whether a KPI card (or a "needs a KPI" row) belongs in a buyer's filtered view: they own it, or they hold the client's
 * buyer seat for its platform as primary or secondary.
 */
export function onCard(who: string, card: { ownerKey: string | null; buyerIds?: readonly string[] | null }) {
  return card.ownerKey === who || Boolean(card.buyerIds?.includes(who));
}

/** `${client}:${platform}` for every buyer seat someone holds as a secondary (their own accounts they don't own) */
export async function secondarySeatKeys(db: SupabaseClient, profileId: string): Promise<Set<string>> {
  const { data } = await db.from("client_assignments").select("client_id, profile_id, role").eq("profile_id", profileId).eq("is_primary", false).in("role", [...BUYER_ROLES]);
  return seatKeys((data ?? []) as SeatRow[], profileId);
}

/** The buyer seats on these clients (or every client), primary first */
export async function loadBuyerSeats(db: SupabaseClient, clientIds?: readonly string[] | null) {
  if (clientIds && !clientIds.length) return [] as Required<Omit<SeatRow, "created_at">>[];
  let q = db.from("client_assignments").select("client_id, profile_id, role, is_primary, created_at").in("role", [...BUYER_ROLES]);
  if (clientIds) q = q.in("client_id", [...clientIds]);
  const { data } = await q;
  return orderSeats((data ?? []) as (SeatRow & { client_id: string })[]);
}

/** A client's buyers on a platform (both when none is given), primary first */
export async function clientBuyers(db: SupabaseClient, clientId: string, platform?: AdPlatform | string | null) {
  const { data } = await db
    .from("client_assignments")
    .select("profile_id, role, is_primary, created_at")
    .eq("client_id", clientId)
    .in("role", platform ? seatRolesToRead(platform) : [...BUYER_ROLES]);
  const all = (data ?? []) as SeatRow[];
  const rows = orderSeats(platform ? all.filter((r) => r.role === seatRoleFor(all, platform)) : all);
  return unique(rows.map((r) => r.profile_id));
}

/** The primary on a client's seat (any role), or null */
export async function primarySeat(db: SupabaseClient, clientId: string, role: string): Promise<string | null> {
  const { data } = await db.from("client_assignments").select("profile_id, role, is_primary, created_at").eq("client_id", clientId).eq("role", role);
  return primaryOf((data ?? []) as SeatRow[], role)?.profile_id ?? null;
}

/**
 * Puts someone in a seat as its primary (or clears the primary): the old primary leaves the seat, the secondaries stay.
 * A secondary picked as primary moves up; clearing the primary moves the longest-serving secondary up. Returns the
 * primary before and after, for the handoff (a client with one person on the seat works exactly as before).
 */
export async function setPrimarySeat(db: SupabaseClient, clientId: string, role: string, toId: string | null): Promise<{ ok: true; from: string | null; to: string | null } | { ok: false; error: string }> {
  const { data } = await db.from("client_assignments").select("profile_id, role, is_primary, created_at").eq("client_id", clientId).eq("role", role);
  const rows = (data ?? []) as SeatRow[];
  const from = primaryOf(rows, role)?.profile_id ?? null;
  if (toId === from && rows.filter((r) => r.is_primary !== false).length <= 1) return { ok: true, from, to: from };
  // The old primary (any row still marked primary) leaves the seat; the new one leaves the secondaries if they were one
  const del = await db.from("client_assignments").delete().eq("client_id", clientId).eq("role", role).eq("is_primary", true);
  if (del.error) return { ok: false, error: del.error.message };
  const next = toId ?? secondariesOf(rows, role).find((id) => id !== from) ?? null;
  if (next) {
    const onSeat = rows.some((r) => r.profile_id === next && r.is_primary === false);
    const res = onSeat
      ? await db.from("client_assignments").update({ is_primary: true }).eq("client_id", clientId).eq("role", role).eq("profile_id", next)
      : await db.from("client_assignments").insert({ client_id: clientId, role, profile_id: next, is_primary: true });
    if (res.error) return { ok: false, error: res.error.message };
  }
  return { ok: true, from, to: next };
}

/** A client's secondary buyers on a platform (both when none is given): everyone on the seat but its primary */
export async function coBuyers(db: SupabaseClient, clientId: string, platform?: AdPlatform | string | null): Promise<string[]> {
  const { data } = await db
    .from("client_assignments")
    .select("profile_id, role, is_primary, created_at")
    .eq("client_id", clientId)
    .in("role", platform ? seatRolesToRead(platform) : [...BUYER_ROLES]);
  const rows = (data ?? []) as SeatRow[];
  return unique((platform ? [seatRoleFor(rows, platform)] : BUYER_ROLES).flatMap((role) => secondariesOf(rows, role)));
}

/** withCoBuyers, from seat rows already loaded:the ids a notice goes to, with the seat's secondaries copied in, each person once */
export function ccFrom(rows: readonly SeatRow[], platform: AdPlatform | string | null | undefined, ids: readonly (string | null | undefined)[]): string[] {
  const base = unique(ids);
  if (!base.length) return base;
  // rows are one client's seats: TikTok's secondaries are its own seat's, or the Meta seat's while it has no TikTok buyer
  const roles = platform ? [seatRoleFor(rows, platform)] : BUYER_ROLES;
  return unique([...base, ...roles.flatMap((role) => secondariesOf(rows, role))]);
}

/**
 * Who hears about an account: whoever a notice already goes to (the KPI owner, the report's or sprint's owner), with the
 * client's secondary buyers on that platform copied in, each person once. Nobody is added when no one was being told,
 * and a client with one buyer hears exactly as before.
 */
export async function withCoBuyers(db: SupabaseClient, clientId: string | null | undefined, platform: AdPlatform | string | null | undefined, ids: readonly (string | null | undefined)[]): Promise<string[]> {
  const base = unique(ids);
  if (!base.length || !clientId) return base;
  return unique([...base, ...(await coBuyers(db, clientId, platform))]);
}
