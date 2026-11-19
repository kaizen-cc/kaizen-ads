"use server";

import { cookies } from "next/headers";
import { createSessionClient } from "@/lib/supabase/session";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { adminConfigured } from "@/lib/supabase/admin";
import { unguardedFetch } from "@/lib/view-as-fetch";
import { ROLES, roleLabel, type TeamRole } from "@/lib/roles";
import { formatViewAsCookie, representativeFor, VIEW_AS_BLOCKED_COOKIE, VIEW_AS_COOKIE } from "@/lib/view-as-core";

// View as (lib/view-as-core.ts): the owner picks a teammate or a role, sees exactly their app, and exits with one tap.
// Every step checks who is really signed in (their own profile's can_view_as), never who they're viewing as.

/** How long a view as lasts before it ends on its own (so nobody is left read only by a forgotten tab) */
const MAX_AGE = 12 * 60 * 60;

type Owner = { id: string; fullName: string };

/** The person really signed in, when they may view as (profiles.can_view_as) */
async function realOwner(): Promise<Owner | null> {
  const db = await createSessionClient();
  const { data: claims } = await db.auth.getClaims();
  const uid = claims?.claims?.sub;
  if (!uid) return null;
  const { data: me } = await db.from("profiles").select("id, full_name, can_view_as").eq("auth_user_id", uid).eq("is_active", true).maybeSingle();
  return me?.can_view_as ? { id: me.id as string, fullName: me.full_name as string } : null;
}

type PersonRow = { id: string; full_name: string; role: string; avatar_url: string | null; is_active: boolean; clients: number };

async function teammates(ownerId: string): Promise<PersonRow[]> {
  const db = await createSessionClient();
  const [{ data: people }, { data: seats }] = await Promise.all([
    db.from("profiles").select("id, full_name, role, avatar_url, is_active").eq("is_active", true).neq("id", ownerId),
    db.from("client_assignments").select("profile_id"),
  ]);
  const count = new Map<string, number>();
  for (const s of seats ?? []) count.set(s.profile_id as string, (count.get(s.profile_id as string) ?? 0) + 1);
  return (people ?? []).map((p) => ({ id: p.id as string, full_name: p.full_name as string, role: p.role as string, avatar_url: (p.avatar_url as string | null) ?? null, is_active: true, clients: count.get(p.id as string) ?? 0 }));
}

export type ViewAsPerson = { id: string; name: string; role: TeamRole; roleLabel: string; avatarUrl: string | null; clients: number };
export type ViewAsRole = { role: TeamRole; label: string; through: { id: string; name: string } | null };

/** What the picker offers: every role (each shown through a representative teammate) and every active teammate */
export async function viewAsOptions(): Promise<{ ok: true; roles: ViewAsRole[]; people: ViewAsPerson[] } | { ok: false; error: string }> {
  const owner = await realOwner();
  if (!owner) return { ok: false, error: "View as is only for the owner." };
  const people = await teammates(owner.id);
  const roles = ROLES.map((r) => {
    const rep = representativeFor(r.value, people);
    return { role: r.value, label: r.label, through: rep ? { id: rep.id, name: rep.full_name } : null };
  });
  return {
    ok: true,
    roles,
    people: people
      .map((p) => ({ id: p.id, name: p.full_name, role: p.role as TeamRole, roleLabel: roleLabel(p.role as TeamRole), avatarUrl: p.avatar_url, clients: p.clients }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The audit's own connection: full rights and no view-as guard, because a start or stop is written while a choice may
 * still be in the cookie. Used for view_as_log only.
 */
function auditDb() {
  return createSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: unguardedFetch() },
  });
}

/** Closes the owner's open view-as rows (the audit) */
async function closeOpen(ownerId: string) {
  if (!adminConfigured()) return;
  await auditDb().from("view_as_log").update({ ended_at: new Date().toISOString() }).eq("actor_id", ownerId).is("ended_at", null);
}

/** Starts viewing as a teammate, or as a role (shown through its representative teammate). The page reloads after. */
export async function startViewAs(pick: { personId: string } | { role: TeamRole }): Promise<{ ok: true } | { ok: false; error: string }> {
  const owner = await realOwner();
  if (!owner) return { ok: false, error: "View as is only for the owner." };
  const people = await teammates(owner.id);
  let target: PersonRow | null = null;
  let role: TeamRole | null = null;
  if ("personId" in pick) {
    target = people.find((p) => p.id === pick.personId) ?? null;
  } else {
    if (!ROLES.some((r) => r.value === pick.role)) return { ok: false, error: "That isn't a role." };
    role = pick.role;
    target = representativeFor(pick.role, people);
    if (!target) return { ok: false, error: `Nobody active is a ${roleLabel(pick.role)} yet, so there's no one to show it through.` };
  }
  if (!target) return { ok: false, error: "That teammate isn't active." };
  const jar = await cookies();
  await closeOpen(owner.id);
  if (adminConfigured()) {
    const { error } = await auditDb().from("view_as_log").insert({ actor_id: owner.id, target_id: target.id, mode: role ? "role" : "person", role });
    if (error) return { ok: false, error: "Couldn't record the view as, so it didn't start." };
  }
  jar.set(VIEW_AS_COOKIE, formatViewAsCookie({ id: target.id, role, name: target.full_name }), {
    path: "/",
    maxAge: MAX_AGE,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // The browser's own Supabase reads carry it too (lib/supabase/client.ts); the database checks the owner anyway
    httpOnly: false,
  });
  return { ok: true };
}

/** Back to their own view (one tap). Clears a leftover choice for anyone; only the owner's is in the audit. */
export async function exitViewAs(): Promise<{ ok: true }> {
  const jar = await cookies();
  jar.delete(VIEW_AS_COOKIE);
  jar.delete(VIEW_AS_BLOCKED_COOKIE);
  const owner = await realOwner();
  if (owner) await closeOpen(owner.id).catch(() => undefined);
  return { ok: true };
}
