import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { can, clientPerms, type AdPlatform, type ClientPerms, type PermAction, type PermCtx, type Verdict, type Who } from "./chat-permissions";

// The server side of src/lib/chat-permissions.ts: the same matrix, with the client's buyer seats loaded from the
// database. Every server action and library function that writes to or launches in an ad account, or writes a brief or
// copy, asks this before it does anything (then the client's live-writes switch, for ad accounts).

export type Person = Who & { id: string };

/**
 * The buyer seats this person holds on the client: their client_assignments seat (meta_buyer, google_buyer), or the
 * client's KPI card on that platform being theirs (the account's owner on the KPI board).
 */
export async function seatsOn(admin: SupabaseClient, profileId: string, clientId: string | null | undefined): Promise<AdPlatform[]> {
  if (!clientId || !profileId) return [];
  const [{ data: seats }, { data: owned }] = await Promise.all([
    admin.from("client_assignments").select("role").eq("client_id", clientId).eq("profile_id", profileId).in("role", ["meta_buyer", "google_buyer"]),
    admin.from("kpi_targets").select("platform").eq("client_id", clientId).eq("owner_id", profileId).in("platform", ["meta", "google"]),
  ]);
  const out = new Set<AdPlatform>();
  for (const s of (seats ?? []) as { role: string }[]) out.add(s.role === "google_buyer" ? "google" : "meta");
  for (const t of (owned ?? []) as { platform: string }[]) out.add(t.platform === "google" ? "google" : "meta");
  return [...out];
}

/** Someone by profile id (for library functions that are handed only an id), null when they're not active staff */
export async function personById(admin: SupabaseClient, profileId: string | null | undefined): Promise<Person | null> {
  if (!profileId) return null;
  const { data } = await admin.from("profiles").select("id, role, is_exec").eq("id", profileId).maybeSingle();
  if (!data) return null;
  return { id: data.id as string, role: data.role as string, isExec: Boolean(data.is_exec) };
}

/** can(), with the buyer seats on ctx.clientId loaded (only when they matter: a buyer's ad account action) */
export async function canOn(admin: SupabaseClient, me: Person, action: PermAction, ctx: PermCtx = {}): Promise<Verdict> {
  const needsSeats = (action === "ads.change" || action === "ads.launch") && (me.role === "media_buyer" || me.role === "google_buyer") && !ctx.seats;
  const seats = needsSeats ? await seatsOn(admin, me.id, ctx.clientId) : ctx.seats;
  return can(me, action, { ...ctx, seats });
}

/** The same, for someone handed by id (a library function): an unknown or inactive person may do nothing */
export async function canIdOn(admin: SupabaseClient, profileId: string | null | undefined, action: PermAction, ctx: PermCtx = {}): Promise<Verdict> {
  const me = await personById(admin, profileId);
  if (!me) return { ok: false, reason: "Only active team members can do this." };
  return canOn(admin, me, action, ctx);
}

/** Everything this person may do on this client, for the page (cards, buttons, quick actions, the chat's prompt) */
export async function permsOn(admin: SupabaseClient, me: Person, clientId: string | null | undefined): Promise<ClientPerms> {
  const buyer = me.role === "media_buyer" || me.role === "google_buyer";
  return clientPerms(me, buyer ? await seatsOn(admin, me.id, clientId) : []);
}

/** The buyer seats this person holds on many clients at once (the KPI board), by client id */
export async function seatsByClient(admin: SupabaseClient, profileId: string): Promise<Map<string, AdPlatform[]>> {
  const [{ data: seats }, { data: owned }] = await Promise.all([
    admin.from("client_assignments").select("client_id, role").eq("profile_id", profileId).in("role", ["meta_buyer", "google_buyer"]),
    admin.from("kpi_targets").select("client_id, platform").eq("owner_id", profileId).in("platform", ["meta", "google"]),
  ]);
  const out = new Map<string, Set<AdPlatform>>();
  const add = (c: string, p: AdPlatform) => out.set(c, (out.get(c) ?? new Set()).add(p));
  for (const s of (seats ?? []) as { client_id: string; role: string }[]) add(s.client_id, s.role === "google_buyer" ? "google" : "meta");
  for (const t of (owned ?? []) as { client_id: string; platform: string }[]) if (t.client_id) add(t.client_id, t.platform === "google" ? "google" : "meta");
  return new Map([...out].map(([k, v]) => [k, [...v]]));
}
